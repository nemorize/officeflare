import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
const compiled = await build({
  stdin: {
    contents:
      'export { migrate } from "./src/mail/migrations.ts"; export * from "./src/mail/read-models.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { migrate, rebuildReadModels, rebuildDirtyThreads } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const migrations = await Promise.all(
  ["partition.sql", "partition-v2.sql", "partition-v3.sql", "partition-v4.sql"].map((file) =>
    readFile(new URL(`../src/mail/${file}`, import.meta.url), "utf8"),
  ),
);
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = {
    exec(query, ...args) {
      const results = db.prepare(query).all(...args);
      return { toArray: () => results, [Symbol.iterator]: () => results[Symbol.iterator]() };
    },
  };
  let nested = 0;
  const storage = {
    sql,
    transactionSync(task) {
      const savepoint = `sp${nested++}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = task();
        db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    },
  };
  migrate(storage, migrations.slice(0, 3));
  const insert = (id, thread = id, owner = null) =>
    db
      .prepare(
        "INSERT INTO messages(id,thread_id,direction,folder_id,subject,from_address,received_at,body_r2_key,created_at,updated_at,draft_owner_id) VALUES(?,?,'inbound','inbox','','sender@example.test',100,'body',100,100,?)",
      )
      .run(id, thread, owner);
  const verify = () => {
    assert.deepEqual(
      plain(
        db
          .prepare(
            "SELECT * FROM mailbox_counts ORDER BY owner_id,folder_id,is_starred,snoozed_until",
          )
          .all(),
      ),
      plain(
        db
          .prepare(
            "SELECT coalesce(draft_owner_id,'') owner_id,folder_id,is_starred,coalesce(snoozed_until,0) snoozed_until,count(*) total,sum(1-is_read) unread FROM messages GROUP BY 1,2,3,4 ORDER BY 1,2,3,4",
          )
          .all(),
      ),
    );
    const expected = db
      .prepare(
        "SELECT thread_id,folder_id,coalesce(snoozed_until,0) snoozed_until,count(*) message_count,sum(1-is_read) unread_count,sum(is_starred) starred_count,max(has_attachments) has_attachments FROM messages WHERE draft_owner_id IS NULL GROUP BY 1,2,3 ORDER BY 1,2,3",
      )
      .all();
    const actual = db
      .prepare(
        "SELECT thread_id,folder_id,snoozed_until,message_count,unread_count,starred_count,has_attachments FROM thread_summaries ORDER BY 1,2,3",
      )
      .all();
    assert.deepEqual(plain(actual), plain(expected));
    for (const row of db.prepare("SELECT * FROM thread_summaries").all()) {
      const representative = db
        .prepare(
          "SELECT id,received_at FROM messages WHERE draft_owner_id IS NULL AND thread_id=? AND folder_id=? AND coalesce(snoozed_until,0)=? ORDER BY received_at DESC,id DESC LIMIT 1",
        )
        .get(row.thread_id, row.folder_id, row.snoozed_until);
      assert.equal(row.representative_id, representative.id);
      assert.equal(row.received_at, representative.received_at);
      const senders = db
        .prepare(
          "SELECT DISTINCT from_address FROM messages WHERE draft_owner_id IS NULL AND thread_id=? AND folder_id=? AND coalesce(snoozed_until,0)=? AND from_address<>''",
        )
        .all(row.thread_id, row.folder_id, row.snoozed_until)
        .map((value) => value.from_address)
        .sort();
      assert.deepEqual((row.participants ?? "").split(",").filter(Boolean).sort(), senders);
    }
  };
  return { db, sql, storage, insert, verify };
}

test("read-model migration backfills deployed messages and remains atomic through edits, moves, snooze, draft privacy and deletion", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 60; i++) f.insert(`m${i}`, `t${i % 7}`, i % 9 === 0 ? "alice" : null);
  migrate(f.storage, migrations);
  f.verify();
  migrate(f.storage, migrations);
  f.verify();
  for (let i = 0; i < 120; i++) {
    const id = `m${i % 60}`;
    f.db
      .prepare(
        "UPDATE messages SET folder_id=?,is_read=?,is_starred=?,snoozed_until=?,has_attachments=?,thread_id=?,received_at=?,from_address=?,draft_owner_id=? WHERE id=?",
      )
      .run(
        i % 3 === 0 ? "archive" : "inbox",
        i % 2,
        (i + 1) % 2,
        i % 4 === 0 ? 1000 : null,
        i % 2,
        `t${i % 11}`,
        100 + i,
        `sender${i % 5}@example.test`,
        i % 13 === 0 ? "bob" : null,
        id,
      );
    if (i % 10 === 0) f.verify();
  }
  f.verify();
  assert.throws(
    () =>
      f.storage.transactionSync(() => {
        f.db.exec("DELETE FROM messages");
        throw new Error("rollback");
      }),
    /rollback/,
  );
  f.verify();
  f.db.exec("DELETE FROM messages WHERE id IN ('m1','m2','m3')");
  f.verify();
  f.db.exec("DELETE FROM mailbox_counts; DELETE FROM thread_summaries");
  f.storage.transactionSync(() => rebuildReadModels(f.sql));
  f.verify();
});

test("bulk edits rebuild each dirty conversation once and rollback leaves no deferred state", (t) => {
  const f = fixture(t);
  migrate(f.storage, migrations);
  for (let i = 0; i < 50; i++) f.insert(`m${i}`, "one-conversation");
  f.storage.transactionSync(() => {
    f.db.exec(
      "UPDATE read_model_state SET defer_threads=1; UPDATE messages SET folder_id='archive',is_read=1",
    );
    assert.equal(f.db.prepare("SELECT count(*) n FROM thread_summary_dirty").get().n, 1);
    rebuildDirtyThreads(f.sql);
    f.db.exec("UPDATE read_model_state SET defer_threads=0");
  });
  f.verify();
  assert.throws(
    () =>
      f.storage.transactionSync(() => {
        f.db.exec(
          "UPDATE read_model_state SET defer_threads=1; UPDATE messages SET folder_id='trash'",
        );
        throw new Error("crash");
      }),
    /crash/,
  );
  assert.equal(f.db.prepare("SELECT defer_threads FROM read_model_state").get().defer_threads, 0);
  f.verify();
});
