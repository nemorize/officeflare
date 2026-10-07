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
  await call(base + "/contacts", {
    method: "POST",
    expected: 201,
    data: { email_address: "contact@example.test", name: "Contact" },
  });
  await call(base + "/templates", {
    method: "POST",
    expected: 201,
    data: { name: "Template", subject: "Welcome", text: "Template body" },
  });
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
  assert.equal(
    (await call(targetBase + "/contacts")).contacts[0].name,
    "Contact",
  );
  assert.equal(
    (await call(targetBase + "/templates")).templates[0].text_body,
    "Template body",
  );
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
