import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
const dataImport = async (result) =>
  import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
const { MailboxDO } = await dataImport(
  await build({
    entryPoints: ["src/mail/mailbox.ts"],
    bundle: true,
    write: false,
    format: "esm",
    banner: {
      js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(new URL("../package.json", import.meta.url).pathname)});`,
    },
    platform: "node",
    external: ["cloudflare:sockets"],
    loader: { ".sql": "text" },
    plugins: [
      {
        name: "durable-runtime",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "runtime",
            namespace: "test",
          }));
          build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents:
              "export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } }",
          }));
        },
      },
    ],
  }),
);
const { flushOutbox, scheduleOutbox } = await dataImport(
  await build({
    entryPoints: ["src/mail/service.ts"],
    bundle: true,
    write: false,
    format: "esm",
    banner: {
      js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(new URL("../package.json", import.meta.url).pathname)});`,
    },
    platform: "node",
    external: ["cloudflare:sockets"],
    loader: { ".sql": "text" },
    plugins: [
      {
        name: "outbox-stores",
        setup(build) {
          build.onResolve({ filter: /^\.\/mailbox$/ }, () => ({
            path: "mailbox",
            namespace: "test",
          }));
          build.onResolve({ filter: /^\.\/jobs$/ }, (args) =>
            args.importer.endsWith("/mail/service.ts")
              ? { path: "jobs", namespace: "test" }
              : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: "test" }, (args) => ({
            contents:
              args.path === "mailbox"
                ? "export const mailbox=env=>env.coordinator; export const partition=env=>env.store;"
                : "export const queueWebhooks=async (env,mailbox,id,payload,hooks)=>env.deliveries.push({id,payload,hooks});",
          }));
        },
      },
    ],
  }),
);

test("event batches authorize each actor once for 0/1/3 tabs and replay does not duplicate the event log", async (t) => {
  for (const count of [0, 1, 3])
    await t.test(`${count} sockets`, async (t) => {
      const db = new DatabaseSync(":memory:");
      t.after(() => db.close());
      let queries = 0,
        allowed = true;
      const sockets = Array.from({ length: count }, () => ({
        sent: [],
        closed: false,
        deserializeAttachment: () => ({ user_id: "actor", auth_version: 1, api_key_id: null }),
        send(value) {
          this.sent.push(JSON.parse(value));
        },
        close() {
          this.closed = true;
        },
      }));
      const storage = {
        sql: {
          exec(query, ...args) {
            const entries = db.prepare(query).all(...args);
            return { toArray: () => entries };
          },
        },
        transactionSync(fn) {
          db.exec("SAVEPOINT test");
          try {
            const result = fn();
            db.exec("RELEASE test");
            return result;
          } catch (error) {
            db.exec("ROLLBACK TO test; RELEASE test");
            throw error;
          }
        },
      };
      const env = {
        DB: {
          withSession() {
            return {
              prepare() {
                return {
                  bind() {
                    return this;
                  },
                  async first() {
                    queries++;
                    return allowed ? { id: "box" } : null;
                  },
                };
              },
            };
          },
        },
      };
      const box = new MailboxDO(
        { storage, blockConcurrencyWhile: (fn) => fn(), getWebSockets: () => sockets },
        env,
      );
      db.exec("INSERT INTO mailbox_settings(id,mailbox_id) VALUES(1,'box')");
      const messages = Array.from({ length: 50 }, (_, i) => ({
        event_id: `e${i}`,
        message_id: `m${i}`,
        operation: "updated",
      }));
      await box.emitMany(messages);
      assert.equal(queries, count ? 1 : 0);
      assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 50);
      await box.emitMany(messages);
      assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 50);
      for (const socket of sockets) {
        assert.equal(socket.sent.length, 100);
        assert.equal(socket.sent[0].sequence, socket.sent[50].sequence);
      }
      allowed = false;
      await box.emitMany([{ event_id: "revoked", message_id: "new", operation: "updated" }]);
      for (const socket of sockets) assert.equal(socket.closed, true);
    });
});

test("outbox drains 50 events with one webhook lookup, one event RPC and one acknowledgement; durable schedule failures propagate", async () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: `e${i}`,
    payload_json: JSON.stringify({ message_id: `p.m${i}`, operation: "updated" }),
  }));
  let queries = 0,
    emits = 0,
    acks = 0,
    done = false;
  const env = {
    deliveries: [],
    DB: {
      withSession() {
        return {
          prepare() {
            return {
              bind() {
                return this;
              },
              async all() {
                queries++;
                return { results: [] };
              },
            };
          },
        };
      },
    },
    store: {
      async outbox() {
        return done ? [] : items;
      },
      async markDispatchedMany(ids) {
        acks++;
        assert.equal(ids.length, 50);
        done = true;
      },
    },
    coordinator: {
      async emitMany(events) {
        emits++;
        assert.equal(events.length, 50);
      },
      async schedule() {
        throw new Error("storage unavailable");
      },
    },
  };
  await flushOutbox(env, "box", "p");
  assert.equal(queries, 1);
  assert.equal(emits, 1);
  assert.equal(acks, 1);
  assert.equal(env.deliveries.length, 50);
  await assert.rejects(scheduleOutbox(env, "box", "p"), /storage unavailable/);
});

test("mailbox maintenance inherits workspace retention and preserves explicit mailbox settings", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const applied = [];
  let defaultRetention = 7;
  const storage = {
    sql: {
      exec(query, ...args) {
        const values = db.prepare(query).all(...args);
        return { toArray: () => values };
      },
    },
    transactionSync(fn) {
      return fn();
    },
    async setAlarm() {},
  };
  const box = new MailboxDO(
    { storage, blockConcurrencyWhile: (fn) => fn() },
    {
      DB: {
        withSession: () => ({
          prepare: () => ({ first: async () => ({ default_retention_days: defaultRetention }) }),
        }),
      },
      MAIL_PARTITION: { getByName: () => ({ maintenance: async (days) => applied.push(days) }) },
    },
  );
  db.exec(
    "INSERT INTO mailbox_settings(id,mailbox_id) VALUES(1,'box'); INSERT INTO partitions(id,ordinal,status,created_at) VALUES('part',1,'active',0)",
  );
  await box.alarm();
  assert.deepEqual(applied, [7]);
  db.exec(
    "UPDATE maintenance_state SET completed_at=0; UPDATE mailbox_settings SET retention_days=30",
  );
  defaultRetention = 1;
  await box.alarm();
  assert.deepEqual(applied, [7, 30]);
  db.exec(
    "UPDATE maintenance_state SET completed_at=0; UPDATE mailbox_settings SET retention_days=NULL",
  );
  defaultRetention = null;
  await box.alarm();
  assert.deepEqual(applied, [7, 30, null]);
});

test("an unavailable mail-flow index leaves outbox events pending for durable retry", async () => {
  let emitted = false,
    acknowledged = false;
  const env = {
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
      }),
      batch: async () => {
        throw new Error("index temporarily unavailable");
      },
    },
    store: {
      outbox: async () => [
        {
          id: "event",
          payload_json: JSON.stringify({ message_id: "part.message", operation: "submitted" }),
        },
      ],
      adminFlow: async () => [
        {
          id: "submission",
          direction: "outbound",
          provider: "cloudflare",
          status: "queued",
          error_code: null,
          attempt_count: 0,
          scheduled_at: 1,
          created_at: 1,
          updated_at: 1,
          revision: 2,
        },
      ],
      markDispatchedMany: async () => {
        acknowledged = true;
      },
    },
    coordinator: {
      emitMany: async () => {
        emitted = true;
      },
    },
  };
  await assert.rejects(flushOutbox(env, "box", "part"), /index temporarily unavailable/);
  assert.equal(emitted, false);
  assert.equal(acknowledged, false);
});
