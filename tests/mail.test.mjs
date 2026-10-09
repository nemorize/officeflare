import { workerModules } from "./worker-modules.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/auth/password.ts";
import { permissionClosure } from "../src/authorization/permissions.ts";
const password = "a long password for mail backend tests";
async function fixture(t, target = "6000000000", queues = false) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: "officeflare",
          modules: workerModules,
          compatibilityDate: "2026-09-29",
          d1Databases: { DB: "mail-tests" },
          r2Buckets: ["MAIL_BUCKET"],
          durableObjects: {
            MAILBOX: { className: "MailboxDO", useSQLite: true },
            MAIL_PARTITION: { className: "MailPartitionDO", useSQLite: true },
          },
          queueProducers: { MAIL_QUEUE: "mail-work" },
          ...(queues
            ? {
                queueConsumers: {
                  "mail-work": {
                    maxBatchSize: 1,
                    maxBatchTimeout: 0,
                    maxRetries: 0,
                  },
                },
              }
            : {}),
          serviceBindings: {
            EMAIL: { name: "mail-harness", entrypoint: "FakeEmail" },
          },
          bindings: {
            AUTH_SIGNING_KEYS: JSON.stringify({
              active_kid: "test",
              keys: [{ ...(await exportJWK(privateKey)), kid: "test" }],
            }),
            MFA_ENCRYPTION_KEYS: JSON.stringify({
              active_version: 1,
              keys: { 1: randomBytes(32).toString("base64url") },
            }),
            AUTH_ISSUER: "officeflare",
            AUTH_AUDIENCE: "officeflare-api",
            MAIL_PARTITION_TARGET_BYTES: target,
            MAIL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
          },
        },
        {
          name: "mail-harness",
          modules: [
            { type: "ESModule", path: "tests/mail-harness.mjs" },
            ...workerModules,
          ],
          compatibilityDate: "2026-09-29",
          d1Databases: { DB: "mail-tests" },
          r2Buckets: ["MAIL_BUCKET"],
          durableObjects: {
            MAILBOX: {
              className: "MailboxDO",
              scriptName: "officeflare",
              useSQLite: true,
            },
            MAIL_PARTITION: {
              className: "MailPartitionDO",
              scriptName: "officeflare",
              useSQLite: true,
            },
          },
          queueProducers: { MAIL_QUEUE: "mail-work" },
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    let statement = "",
      trigger = false;
    for (const line of (await readFile("migrations/" + file, "utf8")).split(
      "\n",
    )) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      statement += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
        await db.prepare(statement).run();
        statement = "";
        trigger = false;
      }
    }
    assert.equal(statement.trim(), "");
  }
  const hashed = await hashPassword(password);
  for (const user of ["administrator", "owner", "reader", "outsider"]) {
    await db
      .prepare(
        "INSERT INTO users(id,email_address,password_hash) VALUES(?,?,?)",
      )
      .bind(user, user + "@office.test", hashed)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO user_roles(user_id,role_id) VALUES('administrator','system-administrator')",
    )
    .run();
  await db.prepare("INSERT INTO user_roles(user_id,role_id) SELECT id, 'system-mail-user' FROM users WHERE id<>'administrator'").run();
  let ip = 0;
  const raw = (path, { method = "GET", token, data, headers = {} } = {}) =>
    mf.dispatchFetch("https://office.test" + path, {
      method,
      headers: {
        "cf-connecting-ip": "192.0.2." + (++ip % 250),
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const request = async (path, { expected = 200, ...options } = {}) => {
    const result = await raw(path, options);
    assert.equal(
      result.status,
      expected,
      path + ": " + (await result.clone().text()),
    );
    return expected === 204 ? null : result.json();
  };
  const tokens = {};
  for (const user of ["administrator", "owner", "reader", "outsider"])
    tokens[user] = (
      await request("/api/auth/login", {
        method: "POST",
        data: { email_address: user + "@office.test", password },
      })
    ).access_token;
  const call = (path, options = {}) =>
    request("/api/mail" + path, { token: tokens.owner, ...options });
  const admin = (path, options = {}) =>
    call(path, { token: tokens.administrator, ...options });
  const mailbox = (
    await admin("/mailboxes", {
      method: "POST",
      data: { name: "Owner inbox", owner_user_id: "owner", kind: "shared" },
      expected: 201,
    })
  ).mailbox;
  const base = "/mailboxes/" + mailbox.id;
  const domain = (
    await admin("/domains", {
      method: "POST",
      data: {
        name: "mail.test",
        inbound_enabled: true,
        outbound_enabled: true,
      },
      expected: 201,
    })
  ).domain;
  const address = (
    await admin("/addresses", {
      method: "POST",
      data: {
        domain_id: domain.id,
        mailbox_id: mailbox.id,
        local_part: "owner",
        is_primary: true,
      },
      expected: 201,
    })
  ).address;
  const draft = async (data, headers = {}) =>
    (
      await call(base + "/drafts", {
        method: "POST",
        data: {
          subject: "A mail test",
          text: "Hello searchable mail",
          to: ["recipient@example.test"],
          ...data,
        },
        headers,
        expected: 201,
      })
    ).message;
  return {
    mf,
    db,
    tokens,
    raw,
    call,
    admin,
    mailbox,
    base,
    address,
    domain,
    draft,
  };
}
test("mail UI metadata, sharing, attachment editing and send recovery use authorized resources", async (t) => {
  const f = await fixture(t), { call, admin, base, mailbox, tokens, draft, mf, db, address } = f;
  await t.test("mail capabilities and endpoints no longer expose mailbox contacts", async () => {
    assert.equal("contacts" in (await call("/capabilities")).features, false);
    await call(base + "/contacts", { expected: 404 });
    await call(base + "/contacts", { method: "POST", data: { email_address: "contact@example.test", name: "Contact" }, expected: 404 });
    await call(base + "/contacts/removed", { method: "DELETE", expected: 404 });
  });
  await t.test("mail capabilities and endpoints no longer expose mailbox templates", async () => {
    assert.equal("templates" in (await call("/capabilities")).features, false);
    await call(base + "/templates", { expected: 404 });
    await call(base + "/templates", { method: "POST", data: { name: "Template", subject: "Welcome", text: "Template body" }, expected: 404 });
    await call(base + "/templates/removed", { method: "DELETE", expected: 404 });
  });
  await t.test("mailbox rights and the member picker expose only scoped, public account information", async () => {
    const owned = (await call("/mailboxes")).mailboxes.find((entry) => entry.id === mailbox.id);
    assert.deepEqual(owned.access, { read: true, write: true, send_as: true, send_on_behalf: true, manage: true });
    await call(base + "/members/reader", { method: "PUT", data: { read: true, send_on_behalf: true } });
    const shared = (await call("/mailboxes", { token: tokens.reader })).mailboxes[0];
    assert.deepEqual(shared.access, { read: true, write: false, send_as: false, send_on_behalf: true, manage: false });
    const directory = await call(base + "/members?search=reader");
    assert.equal(directory.members[0].email_address, "reader@office.test");
    assert.deepEqual(Object.keys(directory.candidates[0]).sort(), ["display_name", "email_address", "id"]);
    assert.equal(directory.candidates.length, 1);
    await call(base + "/members", { token: tokens.reader, expected: 403 });
    const { key } = await call("/api-keys", { method: "POST", data: { name: "read only", expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: [{ mailbox_id: mailbox.id, action: "read" }] }, expected: 201 });
    assert.deepEqual((await call("/mailboxes", { token: key.token })).mailboxes[0].access, { read: true, write: false, send_as: false, send_on_behalf: false, manage: false });
    const keys = await call("/api-keys"); assert.equal(keys.scopes[0].mailbox_id, mailbox.id); assert.equal(keys.keys.some((entry) => "token" in entry), false);
    const adminAddresses = await admin(base + "/addresses"); assert.equal(adminAddresses.addresses[0].id, address.id);
    await call(base + "/addresses", { token: tokens.outsider, expected: 403 });
    await admin(base + "/messages", { expected: 403 });
  });
  let message;
  const upload = async (name, token = tokens.owner) => {
    const response = await mf.dispatchFetch("https://office.test/api/mail" + base + "/uploads", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/octet-stream", "Content-Length": "4", "X-Filename-Encoded": encodeURIComponent(name) }, body: new Uint8Array([0, 255, 10, 128]) });
    assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).upload;
  };
  await t.test("saved drafts can add and remove attachments without changing their thread or leaking foreign uploads", async () => {
    const first = await upload("서울 첨부파일.bin"); assert.equal(first.filename, "서울 첨부파일.bin");
    message = await draft({ subject: "Editable attachments", attachment_ids: [first.id] });
    const oldId = message.attachments[0].id, second = await upload("replacement.bin");
    const patched = (await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: message.draft.version, retained_attachment_ids: [], attachment_ids: [second.id], text: "Revised attachment" } })).message;
    assert.equal(patched.id, message.id); assert.equal(patched.thread_id, message.thread_id); assert.equal(patched.attachments.length, 1); assert.equal(patched.attachments[0].filename, "replacement.bin");
    assert.equal(patched.has_attachments, 1); assert.equal(patched.draft.version, 2);
    await call(base + "/messages/" + message.id + "/attachments/" + oldId, { expected: 404 });
    await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: 1, retained_attachment_ids: [], attachment_ids: [second.id] }, expected: 409 });
    await call(base + "/members/reader", { method: "PUT", data: { read: true, write: true } });
    const foreign = await upload("foreign.bin", tokens.reader);
    await call(base + "/members/reader", { method: "PUT", data: { read: true } });
    await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: 2, retained_attachment_ids: [], attachment_ids: [foreign.id] }, expected: 400 });
    await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: 2, retained_attachment_ids: [oldId] }, expected: 400 });
    const unchanged = (await call(base + "/drafts/" + message.id)).message; assert.equal(unchanged.draft.version, 2); assert.equal(unchanged.attachments.length, 1);
    message = unchanged;
  });
  await t.test("forwarding an HTML-only message with attachments recovers the same draft on replay", async () => {
    const htmlOnly = await draft({ subject: "HTML source", text: "", html: "<p>Quoted HTML content</p>", attachment_ids: [(await upload("forward.bin")).id] });
    const options = { method: "POST", data: { to: ["forward@example.test"] }, headers: { "Idempotency-Key": "forward-ui-recovery" }, expected: 201 };
    const first = (await call(base + "/messages/" + htmlOnly.id + "/forward", options)).message;
    const replay = (await call(base + "/messages/" + htmlOnly.id + "/forward", options)).message;
    assert.equal(first.id, replay.id); assert.equal(replay.attachments.length, 1); assert.match(first.body.text, /Quoted HTML content/);
  });
  await t.test("snoozed-only queries preserve cursor filters and message details expose public send status", async () => {
    const snoozed = (await call(base + "/messages/" + message.id, { method: "PATCH", data: { version: message.version, snoozed_until: Math.floor(Date.now() / 1000) + 3600 } })).message;
    const results = await call(base + "/messages?include_snoozed=true&snoozed_only=true"); assert.deepEqual(results.messages.map((entry) => entry.id), [message.id]);
    assert.deepEqual((await call(base + "/messages?snoozed_only=true")).messages.map((entry) => entry.id), [message.id]);
    const sending = await draft({ subject: "Scheduled UI" });
    const { submission } = await call(base + "/drafts/" + sending.id + "/submissions", { method: "POST", data: { version: sending.draft.version, address_id: address.id, scheduled_at: Math.floor(Date.now() / 1000) + 3600 }, headers: { "Idempotency-Key": "ui-send" }, expected: 202 });
    const detail = (await call(base + "/messages/" + sending.id)).message;
    assert.equal(detail.submissions[0].id, submission.id); assert.equal(detail.submissions[0].status, "scheduled");
    for (const key of ["actor_auth_version", "api_key_id", "request_hash", "snapshot_r2_key"]) assert.equal(key in detail.submissions[0], false);
    await call(base + "/messages/" + sending.id, { token: tokens.reader, expected: 404 });
    await call(base + "/submissions/" + submission.id + "/cancel", { method: "POST" });
    assert.equal((await call(base + "/drafts/" + sending.id)).message.draft.state, "editable");
    assert.equal(snoozed.id, message.id);
  });
});
test("mail backend permissions, providers, drafts, search and scheduling", async (t) => {
  const { db, tokens, raw, call, admin, base, address, mailbox, draft } =
    await fixture(t);
  await t.test(
    "Cloudflare is the only adapter while connection schemas retain provider identity",
    async () => {
      assert.equal(
        (await call("/providers")).providers[0].provider,
        "cloudflare",
      );
      const domainSettings = await admin("/domains");
      assert.equal(domainSettings.domains[0].inbound_provider, "cloudflare");
      assert.equal(domainSettings.domains[0].outbound_provider, "cloudflare");
      assert.deepEqual(domainSettings.providers.map(({ provider, default_connection_id }) => ({ provider, default_connection_id })), [{ provider: "cloudflare", default_connection_id: "cloudflare-bindings" }]);
      await call("/domains", { expected: 403 });
      await admin("/provider-connections", {
        method: "POST",
        data: { provider: "ses", name: "unsupported" },
        expected: 422,
      });
      const connections = await admin("/provider-connections");
      assert.equal(connections.connections[0].provider, "cloudflare");
      await call("/provider-connections", { expected: 403 });
      await call(base + "/messages", {
        token: tokens.administrator,
        expected: 403,
      });
      await call(base + "/messages", { token: tokens.outsider, expected: 403 });
      const unauthorized = await raw("/api/mail/providers");
      assert.equal(unauthorized.status, 401);
      const selected = await db
        .prepare(
          "SELECT inbound_connection_id,outbound_connection_id FROM mail_domains",
        )
        .first();
      assert.equal(selected.inbound_connection_id, "cloudflare-bindings");
      assert.equal(selected.outbound_connection_id, "cloudflare-bindings");
    },
  );
  let firstDraft;
  await t.test(
    "draft creation is idempotent and concurrent version edits conflict",
    async () => {
      const headers = { "Idempotency-Key": "draft-one" };
      firstDraft = await draft(
        {
          subject: "Quarterly budget",
          text: "Revenue forecast and 서울 사무실",
        },
        headers,
      );
      const replay = await draft(
        {
          subject: "Quarterly budget",
          text: "Revenue forecast and 서울 사무실",
        },
        headers,
      );
      assert.equal(firstDraft.id, replay.id);
      await call(base + "/drafts", {
        method: "POST",
        data: { subject: "Different" },
        headers,
        expected: 409,
      });
      const responses = await Promise.all(
        ["One", "Two"].map((subject) =>
          raw("/api/mail" + base + "/drafts/" + firstDraft.id, {
            method: "PATCH",
            token: tokens.owner,
            data: { version: 1, subject },
          }),
        ),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        (await call(base + "/drafts/" + firstDraft.id)).message.draft.version,
        2,
      );
    },
  );
  await t.test(
    "FTS search handles operators, Korean, phrases and chunk-spanning AND",
    async () => {
      await draft({
        subject: "Invoice quarterly",
        text: "alpha " + "padding ".repeat(9000) + " omega",
      });
      for (const q of [
        "subject:Invoice",
        "alpha omega",
        '"Invoice quarterly"',
        "서울",
      ]) {
        const found = await call(base + "/search?q=" + encodeURIComponent(q));
        assert.ok(found.messages.length > 0, q);
      }
      assert.equal(
        (await call(base + "/search?q=alpha%20-omega")).messages.length,
        0,
      );
      await call(base + "/search?q=unknown:value", { expected: 400 });
      const page = await call(base + "/messages?limit=1");
      assert.ok(page.next_cursor);
      const next = await call(
        base +
          "/messages?limit=1&cursor=" +
          encodeURIComponent(page.next_cursor),
      );
      assert.notEqual(page.messages[0].id, next.messages[0].id);
      await call(
        base +
          "/messages?limit=2&cursor=" +
          encodeURIComponent(page.next_cursor),
        { expected: 400 },
      );
    },
  );
  await t.test(
    "readers cannot view another author's drafts or mutate mailbox state",
    async () => {
      await call(base + "/members/reader", {
        method: "PUT",
        data: { read: true },
      });
      assert.equal(
        (await call(base + "/messages", { token: tokens.reader })).messages
          .length,
        0,
      );
      await call(base + "/drafts/" + firstDraft.id, {
        token: tokens.reader,
        expected: 404,
      });
      await call(base + "/drafts", {
        token: tokens.reader,
        method: "POST",
        data: { subject: "Denied" },
        expected: 403,
      });
      await call(base + "/members/reader", { method: "DELETE", expected: 204 });
      await call(base + "/messages", { token: tokens.reader, expected: 403 });
    },
  );
  await t.test(
    "scheduled submissions preserve provider identity, freeze drafts and cancel safely",
    async () => {
      const message = await draft({ subject: "Scheduled" });
      const data = {
        address_id: address.id,
        version: 1,
        scheduled_at: Math.floor(Date.now() / 1000) + 3600,
        provider: "cloudflare",
        connection_id: "cloudflare-bindings",
      };
      const headers = { "Idempotency-Key": "send-one" };
      const job = (
        await call(base + "/drafts/" + message.id + "/submissions", {
          method: "POST",
          data,
          headers,
          expected: 202,
        })
      ).submission;
      assert.equal(job.provider, "cloudflare");
      assert.equal(job.connection_id, "cloudflare-bindings");
      assert.equal(job.status, "scheduled");
      const replay = (
        await call(base + "/drafts/" + message.id + "/submissions", {
          method: "POST",
          data,
          headers,
          expected: 202,
        })
      ).submission;
      assert.equal(job.id, replay.id);
      await call(base + "/drafts/" + message.id, {
        method: "PATCH",
        data: { version: 1, text: "changed" },
        expected: 409,
      });
      const canceled = (
        await call(base + "/submissions/" + job.id + "/cancel", {
          method: "POST",
        })
      ).submission;
      assert.equal(canceled.status, "canceled");
      await call(base + "/submissions/" + job.id + "/retry", {
        method: "POST",
        expected: 409,
      });
      await call(base + "/drafts/" + message.id + "/submissions", {
        method: "POST",
        data: { ...data, provider: "ses" },
        expected: 409,
      });
    },
  );
  await t.test(
    "scoped API keys follow live mailbox grants and account credential versions",
    async () => {
      await call(base + "/members/reader", {
        method: "PUT",
        data: { read: true },
      });
      const key = (
        await call("/api-keys", {
          token: tokens.reader,
          method: "POST",
          data: {
            name: "Read only",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: [{ mailbox_id: mailbox.id, action: "read" }],
          },
          expected: 201,
        })
      ).key;
      await call(base + "/messages", { token: key.token });
      await call(base + "/drafts", {
        token: key.token,
        method: "POST",
        data: { subject: "Denied" },
        expected: 403,
      });
      await call(base + "/members/reader", { method: "DELETE", expected: 204 });
      await call(base + "/messages", { token: key.token, expected: 403 });
      await db
        .prepare(
          "UPDATE users SET auth_version=auth_version+1 WHERE id='reader'",
        )
        .run();
      await call(base + "/messages", { token: key.token, expected: 401 });
    },
  );
  await t.test(
    "rules, HTML sanitization and encrypted webhook registration",
    async () => {
      const rule = (
        await call(base + "/rules", {
          method: "POST",
          data: {
            name: "Invoices",
            conditions: [
              { field: "subject", operator: "contains", value: "invoice" },
            ],
            actions: [{ type: "star" }],
          },
          expected: 201,
        })
      ).rule;
      assert.equal(
        (
          await call(base + "/rules/evaluate", {
            method: "POST",
            data: { subject: "Invoice" },
          })
        ).result.is_starred,
        true,
      );
      await call(base + "/rules", {
        method: "POST",
        data: {
          id: rule.id,
          version: 2,
          name: "Changed",
          conditions: [{ field: "from", operator: "equals", value: "a" }],
          actions: [{ type: "read" }],
        },
        expected: 409,
      });
      const unsafe = await draft({
        html: '<script>alert(1)</script><img src="https://tracker.test/p"><a href="javascript:alert(1)">Click</a><p>Hello</p>',
      });
      assert.doesNotMatch(unsafe.body.html, /script|javascript:|tracker\.test/);
      const hook = (
        await call(base + "/webhooks", {
          method: "POST",
          data: { url: "https://hooks.example.test/mail" },
          expected: 201,
        })
      ).webhook;
      const stored = await db
        .prepare("SELECT * FROM mail_webhooks WHERE id=?")
        .bind(hook.id)
        .first();
      assert.notEqual(stored.secret_ciphertext, hook.secret);
      assert.ok(stored.secret_nonce);
      await call(base + "/webhooks", {
        method: "POST",
        data: { url: "https://127.0.0.1/mail" },
        expected: 400,
      });
      await call(base + "/webhooks/" + hook.id, {
        method: "DELETE",
        expected: 204,
      });
    },
  );
});
test("mailboxes roll over storage partitions without losing search or IDs", async (t) => {
  const { call, base, draft, address } = await fixture(t, "250000");
  const messages = [];
  for (let n = 0; n < 3; n++)
    messages.push(
      await draft({
        subject: "Partition " + n,
        text: "Search survives rollover " + n,
      }),
    );
  const storage = await call(base + "/storage");
  assert.ok(storage.partitions.length >= 2);
  assert.equal((await call(base + "/search?q=rollover")).messages.length, 3);
  for (const message of messages)
    assert.equal(
      (await call(base + "/messages/" + message.id)).message.id,
      message.id,
    );
  const headers = { "Idempotency-Key": "cross-partition-send" };
  const data = {
    address_id: address.id,
    version: 1,
    scheduled_at: Math.floor(Date.now() / 1000) + 3600,
  };
  await call(base + "/drafts/" + messages[0].id + "/submissions", {
    method: "POST",
    headers,
    data,
    expected: 202,
  });
  await call(base + "/drafts/" + messages[1].id + "/submissions", {
    method: "POST",
    headers,
    data,
    expected: 409,
  });
});
async function eventually(fn, predicate, message) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await fn();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}
test("Cloudflare handler, MIME ingestion, delivery and unknown acceptance in Workers", async (t) => {
  const { mf, db, tokens, call, admin, base, mailbox, address, draft } =
    await fixture(t, "6000000000", true);
  const harness = await mf.getWorker("mail-harness"),
    bucket = await mf.getR2Bucket("MAIL_BUCKET");
  const mime = [
    "From: Sender <sender@example.test>",
    "To: owner@mail.test",
    "Subject: Native inbound",
    "Message-ID: <original@example.test>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="test"',
    "",
    "--test",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Native incoming searchable body",
    "--test",
    "Content-Type: text/plain",
    "Content-Disposition: attachment; filename=test.txt",
    "Content-Transfer-Encoding: base64",
    "",
    "YXR0YWNobWVudCBieXRlcw==",
    "--test--",
    "",
  ].join("\r\n");
  const sent = await harness.fetch("https://test/email", {
    method: "POST",
    headers: { "x-recipient": "owner+tag@mail.test" },
    body: mime,
  });
  assert.deepEqual(await sent.json(), { rejected: null });
  const page = await eventually(
    () => call(base + "/messages?folder_id=inbox"),
    (r) => r.messages.length === 1,
    "Incoming message was not processed",
  );
  const inbound = page.messages[0],
    message = (await call(base + "/messages/" + inbound.id)).message;
  assert.equal(message.provider, "cloudflare");
  assert.equal(message.connection_id, "cloudflare-bindings");
  assert.equal(message.rfc_message_id, "original@example.test");
  assert.equal(message.attachments.length, 1);
  const bytes = await mf.dispatchFetch(
    "https://office.test/api/mail" +
      base +
      "/messages/" +
      message.id +
      "/attachments/" +
      message.attachments[0].id,
    { headers: { Authorization: "Bearer " + tokens.owner } },
  );
  assert.equal(await bytes.text(), "attachment bytes");
  const pending = await bucket.list({ prefix: "pending/" });
  assert.equal(pending.objects.length, 0);
  const rejected = await harness.fetch("https://test/email", {
    method: "POST",
    headers: { "x-recipient": "unknown@mail.test" },
    body: mime,
  });
  assert.match((await rejected.json()).rejected, /Recipient/);
  const reply = (
    await call(base + "/messages/" + message.id + "/reply", {
      method: "POST",
      data: { text: "A response" },
      expected: 201,
    })
  ).message;
  assert.equal(reply.thread_id, message.thread_id);
  const job = (
    await call(base + "/drafts/" + reply.id + "/submissions", {
      method: "POST",
      data: { address_id: address.id, version: 1 },
      expected: 202,
    })
  ).submission;
  const delivered = await eventually(
    () => call(base + "/submissions/" + job.id),
    (r) => r.submission.status === "accepted",
    "Submission was not accepted",
  );
  assert.ok(delivered.submission.provider_message_id);
  const sentCopy = (await call(base + "/messages/" + reply.id)).message;
  assert.equal(sentCopy.folder_id, "sent");
  assert.equal(sentCopy.draft, null);
  assert.ok(
    (await call(base + "/search?q=from:owner@mail.test")).messages.some(
      (m) => m.id === reply.id,
    ),
  );
  const queue = await mf.getQueueProducer("MAIL_QUEUE"),
    providerMessageId = delivered.submission.provider_message_id;
  const event = (type, offset) => ({
    type: "cf.email.sending.message." + type,
    payload: {
      eventId: type + "-event",
      messageId: providerMessageId,
      sender: "owner@mail.test",
      recipient: "sender@example.test",
    },
    metadata: { eventTimestamp: new Date(Date.now() + offset).toISOString() },
  });
  // Delivery correlation survives removing the sender alias from the control plane.
  await admin("/addresses/" + address.id, { method: "DELETE", expected: 204 });
  await queue.send(event("delivered", 0));
  await eventually(
    () => call(base + "/submissions/" + job.id),
    (r) => r.submission.recipients[0].status === "delivered",
    "Delivery event not reflected",
  );
  await queue.send(event("deferred", -10000));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    (await call(base + "/submissions/" + job.id)).submission.recipients[0]
      .status,
    "delivered",
  );
  const replacement = (
    await admin("/addresses", {
      method: "POST",
      expected: 201,
      data: {
        domain_id: (
          await db
            .prepare("SELECT id FROM mail_domains WHERE name='mail.test'")
            .first()
        ).id,
        mailbox_id: mailbox.id,
        local_part: "owner",
        is_primary: true,
      },
    })
  ).address;
  await bucket.put("test-mode.json", "unknown");
  const uncertain = await draft({ subject: "Uncertain" });
  const uncertainJob = (
    await call(base + "/drafts/" + uncertain.id + "/submissions", {
      method: "POST",
      data: { address_id: replacement.id, version: 1 },
      expected: 202,
    })
  ).submission;
  await eventually(
    () => call(base + "/submissions/" + uncertainJob.id),
    (r) => r.submission.status === "unknown",
    "Unknown acceptance not recorded",
  );
  const before = (await bucket.list({ prefix: "test-sent/" })).objects.length;
  await queue.send({
    kind: "send",
    mailbox_id: mailbox.id,
    partition_id: uncertain.id.split(".")[0],
    reference_id: uncertainJob.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    (await bucket.list({ prefix: "test-sent/" })).objects.length,
    before,
  );
  await call(base + "/submissions/" + uncertainJob.id + "/retry", {
    method: "POST",
    expected: 409,
  });
});
test("imports, backups, restore, JMAP and MCP use the same permission boundary", async (t) => {
  const { mf, tokens, call, admin, base, mailbox, draft } = await fixture(
    t,
    "6000000000",
    true,
  );
  const mime =
    "From: source@example.test\r\nTo: owner@mail.test\r\nSubject: Imported content\r\nMessage-ID: <import@example.test>\r\n\r\nImported body";
  const response = await mf.dispatchFetch(
    "https://office.test/api/mail" + base + "/imports?format=eml",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.owner },
      body: mime,
    },
  );
  assert.equal(response.status, 202);
  const job = (await response.json()).job;
  await eventually(
    () => call(base + "/jobs/" + job.id),
    (r) => r.job.status === "completed",
    "Import did not complete",
  );
  assert.equal((await call(base + "/search?q=Imported")).messages.length, 1);
  const backup = (
    await call(base + "/backups", { method: "POST", expected: 202 })
  ).job;
  await eventually(
    () => call(base + "/jobs/" + backup.id),
    (r) => r.job.status === "completed",
    "Backup did not complete",
  );
  const backupDetails = await call(base + "/jobs/" + backup.id);
  assert.ok(backupDetails.files.some((file) => file.name === "manifest.json"));
  assert.ok(backupDetails.files.some((file) => file.name.endsWith(".message.json")));
  assert.equal("output_prefix" in backupDetails.job, false);
  for (const file of backupDetails.files) assert.match(file.name, /^[a-z0-9.-]{1,100}$/);
  const target = (
    await admin("/mailboxes", {
      method: "POST",
      data: { name: "Restored", owner_user_id: "owner" },
      expected: 201,
    })
  ).mailbox;
  const restore = (
    await call(base + "/backups/" + backup.id + "/restore", {
      method: "POST",
      data: { target_mailbox_id: target.id },
      expected: 202,
    })
  ).job;
  await eventually(
    () => call("/mailboxes/" + target.id + "/jobs/" + restore.id),
    (r) => r.job.status === "completed",
    "Restore did not complete",
  );
  const restored = await call("/mailboxes/" + target.id + "/search?q=Imported");
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0].provider, null);
  const exported = (
    await call(base + "/exports", { method: "POST", expected: 202 })
  ).job;
  await eventually(
    () => call(base + "/jobs/" + exported.id),
    (r) => r.job.status === "completed",
    "Export did not complete",
  );
  const mbox = await mf.dispatchFetch(
    "https://office.test/api/mail" +
      base +
      "/jobs/" +
      exported.id +
      "/download",
    { headers: { Authorization: "Bearer " + tokens.owner } },
  );
  assert.match(await mbox.text(), /Subject: Imported content/);
  const session = await call("/jmap/session");
  assert.ok(session.accounts[mailbox.id]);
  const jmap = await call("/jmap", {
    method: "POST",
    data: {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/query",
          { accountId: mailbox.id, filter: { text: "Imported" } },
          "query",
        ],
        [
          "Email/get",
          {
            accountId: mailbox.id,
            "#ids": { resultOf: "query", name: "Email/query", path: "/ids" },
          },
          "get",
        ],
        [
          "Email/changes",
          { accountId: mailbox.id, sinceState: "old" },
          "changes",
        ],
      ],
    },
  });
  assert.equal(jmap.methodResponses[1][1].list[0].subject, "Imported content");
  assert.equal(jmap.methodResponses[2][1].type, "cannotCalculateChanges");
  const message = await draft({ subject: "MCP draft" });
  const mcp = await call("/mcp", {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream" },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "request_send",
        arguments: { mailbox_id: mailbox.id, draft_id: message.id },
      },
    },
  });
  const approval = JSON.parse(mcp.result.content[0].text);
  assert.equal(approval.requires_human_approval, true);
  assert.equal(
    (await call(base + "/drafts/" + message.id)).message.draft.state,
    "editable",
  );
  await call("/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Origin: "https://attacker.test",
    },
    data: { jsonrpc: "2.0", id: 1, method: "ping" },
    expected: 403,
  });
});

test("domain routing, signatures, audit and attachment-safe configuration restore", async (t) => {
  const { mf, tokens, call, admin, base, domain, mailbox, draft } =
    await fixture(t, "6000000000", true);
  const harness = await mf.getWorker("mail-harness"),
    bucket = await mf.getR2Bucket("MAIL_BUCKET");
  for (const [local, action] of [
    ["blocked", "reject"],
    ["forwarded", "forward"],
  ]) {
    await admin("/domains/" + domain.id + "/rules", {
      method: "POST",
      expected: 201,
      data: {
        name: action,
        conditions: [
          { field: "to", operator: "equals", value: local + "@mail.test" },
        ],
        action,
        ...(action === "forward"
          ? { forward_to: "verified@example.test" }
          : { reject_reason: "Domain policy" }),
      },
    });
    const result = await harness.fetch("https://test/email", {
      method: "POST",
      headers: { "x-recipient": local + "@mail.test" },
      body: "Subject: Routed\r\n\r\nbody",
    });
    const response = await result.json();
    if (action === "forward")
      assert.equal(response.forwarded, "verified@example.test");
    else assert.equal(response.rejected, "Domain policy");
  }
  await call(base + "/settings", {
    method: "PATCH",
    data: { signature: "Office signature" },
  });
  const uploadResponse = await mf.dispatchFetch(
    "https://office.test/api/mail" + base + "/uploads",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tokens.owner,
        "Content-Type": "text/plain",
        "Content-Length": "16",
        "X-Filename": "document.txt",
      },
      body: "attachment bytes",
    },
  );
  assert.equal(uploadResponse.status, 201);
  const upload = (await uploadResponse.json()).upload;
  const original = await draft(
    {
      subject: "Backup file",
      text: "A backed up message",
      attachment_ids: [upload.id],
    },
    { "Idempotency-Key": "backup-draft" },
  );
  assert.match(original.body.text, /Office signature/);
  assert.equal(
    (await draft({ text: "Plain", include_signature: false })).body.text,
    "Plain",
  );
  await call(base + "/settings", {
    method: "PATCH",
    data: { signature: "Changed signature" },
  });
  const replay = await draft(
    {
      subject: "Backup file",
      text: "A backed up message",
      attachment_ids: [upload.id],
    },
    { "Idempotency-Key": "backup-draft" },
  );
  assert.equal(replay.body.text, original.body.text);
  await call(base + "/blocked-senders", {
    method: "PUT",
    expected: 204,
    data: { email_address: "blocked@example.test", blocked: true },
  });
  const folder = (
    await call(base + "/folders", {
      method: "POST",
      expected: 201,
      data: { name: "Invoices" },
    })
  ).folder;
  await call(base + "/rules", {
    method: "POST",
    expected: 201,
    data: {
      name: "Invoice routing",
      conditions: [
        { field: "subject", operator: "contains", value: "Invoice" },
      ],
      actions: [{ type: "move", folder_id: folder.id }],
    },
  });
  const events = await call(base + "/audit-logs");
  assert.ok(
    events.events.some(
      (event) =>
        event.actor_id === "owner" && event.resource_path.endsWith("/drafts"),
    ),
  );
  const backup = (
    await call(base + "/backups", { method: "POST", expected: 202 })
  ).job;
  await eventually(
    () => call(base + "/jobs/" + backup.id),
    (r) => r.job.status === "completed",
    "Attachment backup did not finish",
  );
  const manifestKey = `data-jobs/${mailbox.id}/${backup.id}/manifest.json`;
  const manifest = await (await bucket.get(manifestKey)).json();
  assert.equal("contacts" in manifest, false);
  assert.equal("templates" in manifest, false);
  // Old backups still restore mail and settings while ignoring retired contacts and templates.
  await bucket.put(manifestKey, JSON.stringify({
    ...manifest,
    contacts: [{ id: "legacy-contact", email_address: "contact@example.test", name: "Contact" }],
    templates: [{ id: "legacy-template", name: "Template", subject: "Welcome", text_body: "Template body" }],
  }));
  await call(base + "/drafts/" + original.id, {
    method: "DELETE",
    expected: 204,
  });
  for (const prefix of [
    "attachments/" + mailbox.id + "/" + original.id + "/",
    "bodies/" + mailbox.id + "/" + original.id + "/",
  ]) {
    for (const object of (await bucket.list({ prefix })).objects)
      await bucket.delete(object.key);
  }
  const target = (
    await admin("/mailboxes", {
      method: "POST",
      expected: 201,
      data: { name: "Restore files", owner_user_id: "owner" },
    })
  ).mailbox;
  const targetBase = "/mailboxes/" + target.id;
  const existingFolder = (
    await call(targetBase + "/folders", {
      method: "POST",
      expected: 201,
      data: { name: "Invoices" },
    })
  ).folder;
  const restore = (
    await call(base + "/backups/" + backup.id + "/restore", {
      method: "POST",
      expected: 202,
      data: { target_mailbox_id: target.id, restore_settings: true },
    })
  ).job;
  await eventually(
    () => call(targetBase + "/jobs/" + restore.id),
    (r) => r.job.status === "completed",
    "Configuration restore did not finish",
  );
  const restored = (await call(targetBase + "/search?q=subject:Backup"))
    .messages[0];
  assert.ok(restored);
  const details = (await call(targetBase + "/messages/" + restored.id)).message;
  assert.notEqual(details.attachments[0].id, original.attachments[0].id);
  const downloaded = await mf.dispatchFetch(
    "https://office.test/api/mail" +
      targetBase +
      "/messages/" +
      restored.id +
      "/attachments/" +
      details.attachments[0].id,
    { headers: { Authorization: "Bearer " + tokens.owner } },
  );
  assert.equal(await downloaded.text(), "attachment bytes");
  assert.equal(
    (await call(targetBase + "/settings")).settings.signature,
    "Changed signature",
  );
  await call(targetBase + "/contacts", { expected: 404 });
  await call(targetBase + "/templates", { expected: 404 });
  assert.equal(
    (await call(targetBase + "/blocked-senders"))["blocked-senders"].length,
    1,
  );
  const rules = (await call(targetBase + "/rules")).rules;
  assert.equal(
    JSON.parse(rules[0].actions_json)[0].folder_id,
    existingFolder.id,
  );
  const reindex = (
    await call(targetBase + "/search/rebuild", {
      method: "POST",
      expected: 202,
    })
  ).job;
  await eventually(
    () => call(targetBase + "/jobs/" + reindex.id),
    (r) => r.job.status === "completed",
    "Reindex did not finish",
  );
  assert.equal(
    (await call(targetBase + "/search?q=backed")).messages.length,
    1,
  );
  const discovered = await mf.dispatchFetch(
    "https://office.test/.well-known/jmap",
    { headers: { Authorization: "Bearer " + tokens.owner } },
  );
  assert.equal(discovered.status, 200);
  assert.ok((await discovered.json()).accounts[target.id]);
  const blob = await mf.dispatchFetch(
    "https://office.test/jmap/download/" +
      target.id +
      "/" +
      encodeURIComponent(restored.id + ":" + details.attachments[0].id) +
      "/document.txt",
    { headers: { Authorization: "Bearer " + tokens.owner } },
  );
  assert.equal(blob.status, 200);
  assert.equal(await blob.text(), "attachment bytes");
  await call(base + "/webhooks", {
    method: "POST",
    data: { url: "https://[::ffff:127.0.0.1]/mail" },
    expected: 400,
  });
});

test("WebSocket tickets are single-use, private drafts stay private and revoked readers disconnect", async (t) => {
  const { mf, tokens, call, base, draft } = await fixture(t);
  await call(base + "/members/reader", { method: "PUT", data: { read: true } });
  const connect = async (token) => {
    const ticket = (
      await call(base + "/events/ticket", { method: "POST", token })
    ).ticket;
    const response = await mf.dispatchFetch(
      "https://office.test/api/mail" + base + "/events/ws?ticket=" + ticket,
      { headers: { Upgrade: "websocket" } },
    );
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    assert.ok(socket);
    socket.accept();
    t.after(() => socket.close());
    return { ticket, socket };
  };
  const owner = await connect(tokens.owner),
    reader = await connect(tokens.reader),
    ownerEvents = [],
    readerEvents = [];
  owner.socket.addEventListener("message", (event) =>
    ownerEvents.push(JSON.parse(event.data)),
  );
  reader.socket.addEventListener("message", (event) =>
    readerEvents.push(event.data),
  );
  const message = await draft({ subject: "Private WebSocket update" });
  await eventually(
    () => Promise.resolve(ownerEvents),
    (events) => events.some((event) => event.message_id === message.id),
    "Draft owner did not receive an event",
  );
  assert.equal(readerEvents.length, 0);
  const replay = await mf.dispatchFetch(
    "https://office.test/api/mail" + base + "/events/ws?ticket=" + owner.ticket,
    { headers: { Upgrade: "websocket" } },
  );
  assert.equal(replay.status, 401);
  let closeCode;
  reader.socket.addEventListener("close", (event) => {
    closeCode = event.code;
  });
  await call(base + "/members/reader", { method: "DELETE", expected: 204 });
  reader.socket.send("ping");
  await eventually(
    () => Promise.resolve(closeCode),
    (code) => code === 1008,
    "Revoked WebSocket stayed connected",
  );
});

test("Mail service entry is independent of Console administration and is checked for JWTs and scoped keys", async (t) => {
  const { db, tokens, raw, call, admin, base, mailbox } = await fixture(t);
  await db.prepare("DELETE FROM role_permissions WHERE role_id='system-administrator' AND permission_key='mail.access'").run();
  await admin("/provider-connections");
  await admin("/mailboxes?all=true");
  await admin(base + "/messages", { expected: 403 });
  await admin("/mailboxes", { expected: 403 });
  await call(base + "/messages");
  await db.prepare("INSERT INTO roles(id,key,label) VALUES('provider-reader','provider-reader','Provider reader')").run();
  for (const key of permissionClosure(["admin.mail.providers.read"])) await db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('provider-reader',?)").bind(key).run();
  await db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('reader','provider-reader')").run();
  await call("/provider-connections", { token: tokens.reader });
  await call("/provider-connections", { token: tokens.reader, method: "POST", data: { provider: "cloudflare", name: "Denied" }, expected: 403 });
  await db.prepare("DELETE FROM role_permissions WHERE role_id='provider-reader' AND permission_key='console.access'").run();
  await call("/provider-connections", { token: tokens.reader, expected: 403 });
  const { key } = await call("/api-keys", { method: "POST", data: { name: "Service-bound key", expires_at: Math.floor(Date.now()/1000)+3600, scopes: [{ mailbox_id: mailbox.id, action: "read" }] }, expected: 201 });
  await call(base + "/messages", { token: key.token });
  await db.prepare("DELETE FROM user_roles WHERE user_id='owner' AND role_id='system-mail-user'").run();
  await call(base + "/messages", { expected: 403 });
  await call("/mailboxes", { expected: 403 });
  await call("/capabilities", { expected: 403 });
  await call(base + "/messages", { token: key.token, expected: 401 });
  assert.equal((await raw("/api/me", { token: tokens.owner })).status, 200);
});

test("personal mail is provisioned with users and managed through the user resource", async (t) => {
  const { mf, raw, db, admin, domain, tokens } = await fixture(t);
  const request = async (path, data, expected = 200, token = tokens.administrator, method = data === undefined ? "GET" : "POST") => {
    const response = await raw(path, { token, data, method });
    assert.equal(response.status, expected, path + ": " + await response.clone().text()); return response.json();
  };
  const create = (email, extra = {}, expected = 201) => request("/api/users", { email_address: email, password, ...extra }, expected);
  assert.equal(domain.is_default, 1);
  const created = await create("new.person@external.test", { display_name: "New Person" });
  const { user, mail } = created;
  assert.equal(user.password_reset_required, true);
  assert.equal(mail.mailbox.kind, "personal"); assert.equal(mail.mailbox.owner_user_id, user.id); assert.equal(mail.mailbox.status, "active");
  assert.equal(mail.addresses[0].email_address, "new.person@mail.test");
  const pending = await request(`/api/users/${user.id}/mailbox`);
  assert.equal(pending.mail_enabled, true);
  assert.equal(pending.mailbox.id, mail.mailbox.id);
  const challenge = await request("/api/auth/login", { email_address: user.email_address, password });
  const signedIn = await request("/api/me/password", { new_password: "a replacement password for personal mail" }, 200, challenge.challenge_token, "PUT");
  assert.equal((await request(`/api/mail/mailboxes/${mail.mailbox.id}/folders`, undefined, 200, signedIn.access_token)).folders.length, 6);
  const listed = (await request("/api/users")).users.find((entry) => entry.id === user.id);
  assert.equal(listed.mail.email_address, "new.person@mail.test"); assert.equal(listed.mail.mailbox.id, mail.mailbox.id);

  await request(`/api/users/${user.id}/mailbox`, { domain_id: domain.id, local_part: "new.person" });
  const changed = await request(`/api/users/${user.id}/mailbox`, { domain_id: domain.id, local_part: "renamed" });
  assert.equal(changed.mailbox.id, mail.mailbox.id); assert.equal(changed.addresses.length, 2);
  assert.equal(changed.addresses.find((entry) => entry.is_primary).email_address, "renamed@mail.test");
  assert.equal(changed.addresses.find((entry) => !entry.is_primary).email_address, "new.person@mail.test");
  assert.equal((await request(`/api/users/${user.id}`)).user.email_address, "new.person@external.test");
  await request(`/api/users/${user.id}`, { display_name: "Renamed Person" }, 200, tokens.administrator, "PATCH");
  assert.equal((await request(`/api/users/${user.id}/mailbox`)).mailbox.name, "Renamed Person");
  assert.equal((await request(`/api/users/${user.id}/mailbox`)).addresses.find((entry) => entry.is_primary).email_address, "renamed@mail.test");

  assert.equal((await db.prepare("SELECT count(*) n FROM mail_mailboxes WHERE owner_user_id=? AND kind='personal'").bind(user.id).first()).n, 1);

  const alternate = (await admin("/domains", { method: "POST", data: { name: "other.test", is_default: true }, expected: 201 })).domain;
  assert.equal((await admin("/domains")).domains.filter((entry) => entry.is_default).length, 1);
  const matching = await create("matching@mail.test");
  assert.equal(matching.mail.addresses[0].domain_id, domain.id);
  const explicit = await create("explicit@external.test", { mail_address: { domain_id: domain.id, local_part: "preferred" } });
  assert.equal(explicit.mail.addresses[0].email_address, "preferred@mail.test");
  const defaulted = await create("defaulted@external.test");
  assert.equal(defaulted.mail.addresses[0].domain_id, alternate.id);
  const accountOnly = await create("account-only@external.test", { role_ids: [] });
  assert.equal(accountOnly.mail, null);
  await create("illegal@external.test", { role_ids: [], mail_address: { domain_id: domain.id, local_part: "illegal" } }, 400);
  const before = (await db.prepare("SELECT count(*) n FROM mail_mailboxes").first()).n;
  await create("collision@external.test", { mail_address: { domain_id: domain.id, local_part: "renamed" } }, 409);
  assert.equal((await db.prepare("SELECT count(*) n FROM users WHERE email_address='collision@external.test'").first()).n, 0);
  assert.equal((await db.prepare("SELECT count(*) n FROM mail_mailboxes").first()).n, before);
  await request(`/api/users/${user.id}/mailbox`, { domain_id: alternate.id, local_part: "forbidden" }, 403, tokens.reader);
  await request(`/api/users/${accountOnly.user.id}/mailbox`, { domain_id: domain.id, local_part: "account-only" }, 400);
  assert.equal((await request(`/api/users/${accountOnly.user.id}/mailbox`)).enable_role.id, "system-mail-user");
  await request(`/api/users/${accountOnly.user.id}/mailbox`, { domain_id: domain.id, local_part: "renamed", enable_mail: true }, 409);
  assert.equal((await request(`/api/users/${accountOnly.user.id}/mailbox`)).mail_enabled, false);
  const activated = await request(`/api/users/${accountOnly.user.id}/mailbox`, { domain_id: domain.id, local_part: "account-only", enable_mail: true });
  assert.equal(activated.mailbox.status, "active");
  assert.equal((await request(`/api/users/${accountOnly.user.id}/mailbox`)).mail_enabled, true);

  const raced = await Promise.all(["first", "second"].map((name) => raw("/api/users", { method: "POST", token: tokens.administrator, data: { email_address: `${name}.race@external.test`, password, mail_address: { domain_id: domain.id, local_part: "one-winner" } } })));
  assert.deepEqual(raced.map((response) => response.status).sort(), [201, 409]);
  assert.equal((await db.prepare("SELECT count(*) n FROM users WHERE email_address IN ('first.race@external.test','second.race@external.test')").first()).n, 1);
  await admin(`/domains/${domain.id}`, { method: "PATCH", data: { is_default: true } });
  assert.equal((await admin("/domains")).domains.find((entry) => entry.is_default).id, domain.id);
  await admin(`/domains/${domain.id}`, { method: "PATCH", data: { is_default: false } });
  await admin(`/domains/${alternate.id}`, { method: "PATCH", data: { is_default: false } });
  const unaddressed = await create("without-domain@external.test");
  assert.equal(unaddressed.mail.mailbox.status, "active"); assert.deepEqual(unaddressed.mail.addresses, []);
  const configured = await request(`/api/users/${unaddressed.user.id}/mailbox`, { domain_id: domain.id, local_part: "without-domain" });
  assert.equal(configured.mailbox.id, unaddressed.mail.mailbox.id); assert.equal(configured.addresses[0].email_address, "without-domain@mail.test");
});

test("shared mailbox address and membership save atomically with safe retries and metadata-only access", async (t) => {
  const { db, admin, call, raw, tokens, domain } = await fixture(t);
  const data = { name: "Support", kind: "shared", address: { domain_id: domain.id, local_part: "support" }, members: [{ user_id: "reader", role: "viewer" }, { user_id: "outsider", role: "manager" }] };
  const headers = { "Idempotency-Key": "shared-setup-test" };
  const first = await admin("/mailboxes", { method: "POST", data, headers, expected: 201 });
  const id = first.mailbox.id, path = `/mailboxes/${id}/configuration`;
  const replay = await admin("/mailboxes", { method: "POST", data, headers });
  assert.equal(replay.mailbox.id, id);
  const config = await admin(path);
  assert.equal(config.addresses[0].email_address, "support@mail.test"); assert.equal(config.members.length, 2);
  const reader = config.members.find((entry) => entry.user_id === "reader"), manager = config.members.find((entry) => entry.user_id === "outsider");
  assert.equal(reader.can_read, 1); assert.equal(reader.can_send_as, 0); assert.equal(manager.can_manage, 1);
  assert.equal((await call("/mailboxes", { token: tokens.reader })).mailboxes.find((entry) => entry.id === id).access.write, false);
  await call(path, { token: tokens.reader, expected: 403 });
  await call(`/mailboxes/${id}/messages`, { token: tokens.reader });
  await call(`/mailboxes/${id}/messages`, { token: tokens.owner, expected: 403 });
  const directory = await admin("/mailbox-users");
  assert.deepEqual(Object.keys(directory.users[0]).sort(), ["display_name", "email_address", "id"]);
  assert.deepEqual(Object.keys(config.owner).sort(), ["display_name", "email_address", "id"]);
  const all = (await admin("/mailboxes?all=true")).mailboxes.find((entry) => entry.id === id);
  assert.equal(all.email_address, "support@mail.test"); assert.equal(all.member_count, 2);

  const custom = { can_read: true, can_write: false, can_send_as: false, can_send_on_behalf: true, can_manage: false };
  await admin(path, { method: "PATCH", data: { name: "Support team", address: { domain_id: domain.id, local_part: "help" }, members: [{ user_id: "reader", role: "custom", permissions: custom }] } });
  const changed = await admin(path);
  assert.equal(changed.addresses.find((entry) => entry.is_primary).email_address, "help@mail.test");
  assert.equal(changed.addresses.find((entry) => !entry.is_primary).email_address, "support@mail.test");
  assert.equal(changed.members.length, 1); assert.equal(changed.members[0].can_send_on_behalf, 1);
  await call(`/mailboxes/${id}/messages`, { token: tokens.outsider, expected: 403 });
  const alias = changed.addresses.find((entry) => !entry.is_primary);
  await admin(`/addresses/${alias.id}`, { method: "PATCH", data: { receive_enabled: false, send_enabled: true } });
  assert.equal((await admin(path)).addresses.find((entry) => entry.id === alias.id).receive_enabled, 0);
  const count = (await db.prepare("SELECT count(*) n FROM mail_mailboxes").first()).n;
  await admin("/mailboxes", { method: "POST", data: { ...data, name: "Collision" }, headers: { "Idempotency-Key": "shared-conflict-test" }, expected: 409 });
  assert.equal((await db.prepare("SELECT count(*) n FROM mail_mailboxes").first()).n, count);
  await admin(path, { method: "PATCH", data: { name: "Must not save", address: { domain_id: domain.id, local_part: "owner" }, members: [] }, expected: 409 });
  assert.equal((await admin(path)).mailbox.name, "Support team"); assert.equal((await admin(path)).members.length, 1);
  await admin(path, { method: "PATCH", data: { name: "Must not save", members: [{ user_id: "missing", role: "member" }] }, expected: 400 });
  assert.equal((await admin(path)).mailbox.name, "Support team");

  await db.prepare("INSERT INTO roles(id,key,label) VALUES('mailbox-admin','mailbox-admin','Mailbox admin')").run();
  await db.batch(permissionClosure(["admin.mail.mailboxes.manage"]).map((key) => db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('mailbox-admin',?)").bind(key)));
  await db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('owner','mailbox-admin')").run();
  const response = await raw("/api/auth/login", { method: "POST", data: { email_address: "owner@office.test", password } });
  const limited = (await response.json()).access_token;
  await call(path, { method: "PATCH", token: limited, data: { address: { domain_id: domain.id, local_part: "limited" } }, expected: 403 });
  await call(path, { method: "PATCH", token: limited, data: { name: "Limited admin saved" } });
  await call(`/mailboxes/${id}/messages`, { token: limited, expected: 403 });
  await admin(path, { method: "PATCH", data: { members: [] } });
  assert.equal((await admin(path)).members.length, 0);
  const legacy = (await admin("/mailboxes", { method: "POST", data: { name: "Legacy retry", kind: "personal" }, headers: { "Idempotency-Key": "legacy-mailbox-operation" }, expected: 201 })).mailbox;
  assert.equal((await admin("/mailboxes", { method: "POST", data: { name: "Legacy retry", kind: "personal" }, headers: { "Idempotency-Key": "legacy-mailbox-operation" } })).mailbox.id, legacy.id);
  assert.ok((await admin("/mailboxes?all=true&kind=shared")).mailboxes.every((entry) => entry.kind === "shared"));
  await admin("/mailboxes?all=true&kind=invalid", { expected: 400 });

  const accountResponse = await raw("/api/users", { method: "POST", token: tokens.administrator, data: { email_address: "to-delete@external.test", password, password_reset_required: false } });
  const deleted = await accountResponse.json();
  assert.equal(accountResponse.status, 201);
  const retained = (await admin("/mailboxes", { method: "POST", data: { name: "Retained team", owner_user_id: deleted.user.id, kind: "shared", members: [{ user_id: "reader", role: "member" }] }, expected: 201 })).mailbox;
  assert.equal((await raw(`/api/users/${deleted.user.id}`, { method: "DELETE", token: tokens.administrator })).status, 204);
  assert.equal((await db.prepare("SELECT status FROM mail_mailboxes WHERE id=?").bind(deleted.mail.mailbox.id).first()).status, "disabled");
  await call(`/mailboxes/${retained.id}/messages`, { token: tokens.reader });
  await admin(`/mailboxes/${retained.id}/configuration`, { method: "PATCH", data: { name: "Team remains available" } });

});
