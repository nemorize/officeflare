import { workerModules } from "./worker-modules.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/auth/password.ts";
import { permissionClosure } from "../src/authorization/permissions.ts";
import { maxAttachmentBytes } from "../src/mail/size.ts";
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
test("sending size limits follow the From provider and administrator configuration", async (t) => {
  const { call, admin, base, mailbox, domain, address, draft, mf, tokens } = await fixture(t, "6000000000", true);
  const providerMaximum = (await call("/providers")).providers[0].capabilities.max_send_bytes;
  const globalLimits = (await call("/capabilities")).limits;
  const oneMiB = 1024 ** 2, bucket = await mf.getR2Bucket("MAIL_BUCKET");
  let alternateDomain, alternateAddress, firstUpload, combinedDraft;
  const upload = async (size, expected = 201, name = "budget.bin") => {
    const response = await mf.dispatchFetch("https://office.test/api/mail" + base + "/uploads", { method: "POST", headers: { Authorization: "Bearer " + tokens.owner, "Content-Type": "application/octet-stream", "Content-Length": String(size), "X-Filename": name }, body: new Uint8Array(size) });
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  };
  const submit = (message, addressId, expected = 202, schedule = Math.floor(Date.now() / 1000) + 3600) => call(base + "/drafts/" + message.id + "/submissions", { method: "POST", data: { version: message.draft.version, address_id: addressId, scheduled_at: schedule }, expected });
  await t.test("domain settings validate permissions, provider ceilings and nullable defaults", async () => {
    assert.equal(domain.max_send_bytes, null);
    assert.equal((await call(base + "/addresses")).addresses[0].max_send_bytes, providerMaximum);
    assert.equal(globalLimits.max_upload_bytes, maxAttachmentBytes(globalLimits.max_send_bytes));
    assert.ok(globalLimits.max_send_bytes >= providerMaximum);
    await call("/domains/" + domain.id, { method: "PATCH", data: { max_send_bytes: oneMiB }, expected: 403 });
    for (const value of [0, -1, 1.5, "1048576", providerMaximum + 1]) {
      await admin("/domains/" + domain.id, { method: "PATCH", data: { max_send_bytes: value }, expected: 400 });
      await admin("/domains", { method: "POST", data: { name: "invalid.test", max_send_bytes: value }, expected: 400 });
    }
    await admin("/domains", { method: "POST", data: { name: "no-provider.test", outbound_connection_id: null, max_send_bytes: oneMiB }, expected: 400 });
    await admin("/domains/" + domain.id, { method: "PATCH", data: { max_send_bytes: providerMaximum } });
    await admin("/domains/" + domain.id, { method: "PATCH", data: { max_send_bytes: null } });
    assert.equal((await call(base + "/addresses")).addresses[0].max_send_bytes, providerMaximum);
    await admin("/domains/" + domain.id, { method: "PATCH", data: { max_send_bytes: oneMiB } });
    assert.equal((await admin("/domains")).domains.find((entry) => entry.id === domain.id).max_send_bytes, oneMiB);
    const connection = (await admin("/provider-connections")).connections[0];
    const disabled = (await admin("/provider-connections/" + connection.id, { method: "PATCH", data: { version: connection.version, enabled: false } })).connection;
    await admin("/domains/" + domain.id, { method: "PATCH", data: { max_send_bytes: oneMiB } });
    await admin("/provider-connections/" + connection.id, { method: "PATCH", data: { version: disabled.version, enabled: true } });
  });
  await t.test("REST, images and JMAP uploads advertise and enforce the configured budgets", async () => {
    const limits = await call(base + "/addresses"), maximum = maxAttachmentBytes(oneMiB);
    assert.equal(limits.addresses[0].max_send_bytes, oneMiB);
    assert.equal(limits.addresses[0].max_upload_bytes, maximum);
    assert.equal(limits.limits.max_upload_bytes, maximum);
    const session = await call("/jmap/session");
    assert.equal(session.capabilities["urn:ietf:params:jmap:core"].maxSizeUpload, oneMiB);
    assert.equal(session.accounts[mailbox.id].accountCapabilities["urn:ietf:params:jmap:mail"].maxSizeAttachmentsPerEmail, maximum);
    const before = (await bucket.list({ prefix: `uploads/${mailbox.id}/owner/` })).objects.length;
    await upload(maximum + 1, 413);
    const image = await mf.dispatchFetch("https://office.test/api/mail" + base + "/images", { method: "POST", headers: { Authorization: "Bearer " + tokens.owner, "Content-Type": "image/png", "Content-Length": String(maximum + 1) }, body: new Uint8Array(maximum + 1) });
    assert.equal(image.status, 413);
    const jmapUpload = await mf.dispatchFetch("https://office.test/api/mail/jmap/upload/" + mailbox.id, { method: "POST", headers: { Authorization: "Bearer " + tokens.owner, "Content-Type": "message/rfc822" }, body: new Uint8Array(oneMiB + 1) });
    assert.equal(jmapUpload.status, 413, await jmapUpload.clone().text());
    assert.equal((await bucket.list({ prefix: `uploads/${mailbox.id}/owner/` })).objects.length, before);
    firstUpload = (await upload(400 * 1024)).upload;
    await upload(maximum);
  });
  await t.test("combined attachments and multibyte bodies fail before freezing or queueing a draft", async () => {
    const second = (await upload(400 * 1024, 201, "second.bin")).upload;
    combinedDraft = await draft({ attachment_ids: [firstUpload.id, second.id] });
    await submit(combinedDraft, address.id, 413);
    const unchanged = (await call(base + "/drafts/" + combinedDraft.id)).message;
    assert.equal(unchanged.draft.state, "editable");
    assert.equal(unchanged.submissions.length, 0);
    assert.equal((await bucket.list({ prefix: "test-sent/" })).objects.length, 0);
    const unicode = await draft({ text: "서".repeat(300 * 1024), html: "" });
    await submit(unicode, address.id, 413);
    assert.equal((await call(base + "/drafts/" + unicode.id)).message.draft.state, "editable");
  });
  await t.test("each From address uses its domain limit and other addresses keep their own limit", async () => {
    alternateDomain = (await admin("/domains", { method: "POST", data: { name: "large.test", outbound_enabled: true, max_send_bytes: 2 * oneMiB }, expected: 201 })).domain;
    alternateAddress = (await admin("/addresses", { method: "POST", data: { domain_id: alternateDomain.id, mailbox_id: mailbox.id, local_part: "owner" }, expected: 201 })).address;
    const addresses = await call(base + "/addresses");
    assert.equal(addresses.addresses.find((entry) => entry.id === address.id).max_send_bytes, oneMiB);
    assert.equal(addresses.addresses.find((entry) => entry.id === alternateAddress.id).max_send_bytes, 2 * oneMiB);
    assert.equal(addresses.limits.max_upload_bytes, maxAttachmentBytes(2 * oneMiB));
    const accepted = (await submit(combinedDraft, alternateAddress.id)).submission;
    assert.equal(accepted.status, "scheduled");
    await call(base + "/submissions/" + accepted.id + "/cancel", { method: "POST" });
  });
  await t.test("inline images share the same budget and removing an image frees that space", async () => {
    const bytes = new Uint8Array(600 * 1024); bytes.set([137,80,78,71,13,10,26,10]);
    const imageResponse = await mf.dispatchFetch("https://office.test/api/mail" + base + "/images", { method: "POST", headers: { Authorization: "Bearer " + tokens.owner, "Content-Type": "image/png", "Content-Length": String(bytes.length) }, body: bytes });
    assert.equal(imageResponse.status, 201, await imageResponse.clone().text());
    const { image } = await imageResponse.json();
    const message = await draft({ text: "Body with an inline image", html: `<p>Body</p><img src="cid:${image.content_id}">`, attachment_ids: [firstUpload.id] });
    assert.equal(message.attachments.length, 2);
    await submit(message, address.id, 413);
    const edited = (await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: message.draft.version, html: "<p>Body</p>", text: "Body" } })).message;
    assert.equal(edited.attachments.length, 1);
    const accepted = (await submit(edited, address.id)).submission;
    await call(base + "/submissions/" + accepted.id + "/cancel", { method: "POST" });
  });
  await t.test("queued sends recheck a reduced limit before contacting the provider", async () => {
    const message = await draft({ attachment_ids: [firstUpload.id] });
    const job = (await submit(message, address.id, 202, Math.floor(Date.now() / 1000) + 3)).submission;
    await admin("/domains/" + domain.id, { method: "PATCH", data: { max_send_bytes: 64 * 1024 } });
    const failed = await eventually(() => call(base + "/submissions/" + job.id), (result) => result.submission.status === "failed", "The scheduled send did not apply the reduced size limit");
    assert.equal(failed.submission.error_code, "message_too_large");
    assert.equal((await bucket.list({ prefix: "test-sent/" })).objects.length, 0);
    const nowEditable = (await call(base + "/drafts/" + message.id)).message;
    assert.equal(nowEditable.draft.state, "editable");
    await admin("/domains/" + domain.id, { method: "PATCH", data: { max_send_bytes: oneMiB } });
    await call(base + "/submissions/" + job.id + "/retry", { method: "POST" });
    const accepted = await eventually(() => call(base + "/submissions/" + job.id), (result) => result.submission.status === "accepted", "The send did not recover after restoring the size limit");
    const sent = await (await bucket.get("test-sent/" + accepted.submission.provider_message_id + ".json")).json();
    assert.equal(sent.from, "owner@mail.test");
    assert.equal(sent.attachments.length, 1);
  });
});
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
    assert.deepEqual(owned.access, { read: true, write: true, send: true, manage: true });
    await call(base + "/members/reader", { method: "PUT", data: { read: true, send: true } });
    const shared = (await call("/mailboxes", { token: tokens.reader })).mailboxes[0];
    assert.deepEqual(shared.access, { read: true, write: false, send: true, manage: false });
    const directory = await call(base + "/members?search=reader");
    assert.equal(directory.members[0].email_address, "reader@office.test");
    assert.deepEqual(Object.keys(directory.candidates[0]).sort(), ["display_name", "email_address", "id"]);
    assert.equal(directory.candidates.length, 1);
    await call(base + "/members", { token: tokens.reader, expected: 403 });
    const { key } = await call("/api-keys", { method: "POST", data: { name: "read only", expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: [{ mailbox_id: mailbox.id, action: "read" }] }, expected: 201 });
    assert.deepEqual((await call("/mailboxes", { token: key.token })).mailboxes[0].access, { read: true, write: false, send: false, manage: false });
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
  const { db, tokens, raw, call, admin, base, address, mailbox, domain, draft } =
    await fixture(t);
  await t.test(
    "Provider catalog exposes direct sending adapters while preserving Cloudflare bindings",
    async () => {
      assert.equal(
        (await call("/providers")).providers[0].provider,
        "cloudflare",
      );
      const domainSettings = await admin("/domains");
      assert.equal(domainSettings.domains[0].inbound_provider, "cloudflare");
      assert.equal(domainSettings.domains[0].outbound_provider, "cloudflare");
      assert.deepEqual(domainSettings.providers.map(({ provider, default_connection_id }) => ({ provider, default_connection_id })), [
        { provider: "cloudflare", default_connection_id: "cloudflare-bindings" },
        ...domainSettings.providers.slice(1).map(({ provider }) => ({ provider, default_connection_id: null })),
      ]);
      await call("/domains", { expected: 403 });
      await admin("/provider-connections", {
        method: "POST",
        data: { provider: "ses", name: "missing config" },
        expected: 400,
      });
      const created = await admin("/provider-connections", {
        method: "POST",
        expected: 201,
        data: {
          provider: "cloudflare-rest",
          name: "Cloudflare REST",
          config: { accountId: "account-123" },
          secrets: { apiToken: "provider-secret-value" },
        },
      });
      assert.deepEqual(created.connection.config, { accountId: "account-123" });
      assert.equal(created.connection.secret_configured, true);
      assert.equal(JSON.stringify(created).includes("provider-secret-value"), false);
      const stored = await db.prepare("SELECT config_json,secret_ciphertext,secret_nonce FROM mail_provider_connections WHERE id=?").bind(created.connection.id).first();
      assert.equal(JSON.parse(stored.config_json).accountId, "account-123");
      assert.notEqual(stored.secret_ciphertext, "provider-secret-value");
      assert.ok(stored.secret_ciphertext && stored.secret_nonce);
      const secondConnection = await admin("/provider-connections", {
        method: "POST",
        expected: 201,
        data: {
          provider: "cloudflare-rest",
          name: "Domain-specific Cloudflare REST",
          config: { accountId: "domain-account-456" },
          secrets: { apiToken: "second-provider-secret" },
        },
      });
      assert.deepEqual(secondConnection.connection.config, { accountId: "domain-account-456" });
      await admin("/domains", { method: "POST", expected: 201, data: { name: "provider-one.test", inbound_connection_id: null, outbound_connection_id: created.connection.id } });
      await admin("/domains", { method: "POST", expected: 409, data: { name: "provider-two.test", inbound_connection_id: null, outbound_connection_id: created.connection.id } });
      await admin("/domains", { method: "POST", expected: 201, data: { name: "provider-two.test", inbound_connection_id: null, outbound_connection_id: secondConnection.connection.id } });
      const configuredDomains = (await admin("/domains")).domains;
      const secondProviderDomain = configuredDomains.find((entry) => entry.name === "provider-two.test");
      await admin(`/domains/${secondProviderDomain.id}`, { method: "PATCH", expected: 409, data: { outbound_connection_id: created.connection.id } });
      const catalog = await admin("/provider-catalog");
      assert.equal(catalog.providers.find((entry) => entry.provider === "cloudflare-rest").default_connection_id, null);
      const connections = await admin("/provider-connections");
      assert.equal(connections.connections.find((entry) => entry.id === created.connection.id).secret_configured, true);
      assert.equal(JSON.stringify(connections).includes("provider-secret-value"), false);
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
          "SELECT inbound_connection_id,outbound_connection_id FROM mail_domains WHERE id=?",
        )
        .bind(domain.id)
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
test("From selection uses one send permission and removes modes from APIs and saved sends", async (t) => {
  const { mf, call, admin, base, mailbox, address, domain, draft, tokens } = await fixture(t, "6000000000", true);
  const bucket = await mf.getR2Bucket("MAIL_BUCKET");
  const alias = (await admin("/addresses", { method: "POST", data: { domain_id: domain.id, mailbox_id: mailbox.id, local_part: "alias" }, expected: 201 })).address;
  const disabled = (await admin("/addresses", { method: "POST", data: { domain_id: domain.id, mailbox_id: mailbox.id, local_part: "disabled", send_enabled: false }, expected: 201 })).address;
  const addresses = (await call(base + "/addresses")).addresses;
  assert.equal((await call("/mailboxes")).mailboxes.length, 1);
  assert.equal(addresses.find((entry) => entry.id === address.id).can_send, true);
  assert.equal(addresses.find((entry) => entry.id === alias.id).can_send, true);
  assert.equal(addresses.find((entry) => entry.id === disabled.id).can_send, false);
  await call(base + "/members/reader", { method: "PUT", data: { read: true, write: true } });
  assert.ok((await call(base + "/addresses", { token: tokens.reader })).addresses.every((entry) => !entry.can_send));
  const memberDraft = (await call(base + "/drafts", { method: "POST", token: tokens.reader, data: { subject: "Shared From", to: ["recipient@example.test"] }, expected: 201 })).message;
  await call(base + "/drafts/" + memberDraft.id + "/submissions", { method: "POST", token: tokens.reader, data: { version: 1, address_id: alias.id }, expected: 403 });
  await call(base + "/members/reader", { method: "PUT", data: { read: true, write: true, send: true } });
  assert.equal((await call("/mailboxes", { token: tokens.reader })).mailboxes.find((entry) => entry.id === mailbox.id).access.send, true);
  assert.equal((await call(base + "/addresses", { token: tokens.reader })).addresses.find((entry) => entry.id === alias.id).can_send, true);
  for (const mode of ["send_as", "send_on_behalf", "send"])
    await call(base + "/drafts/" + memberDraft.id + "/submissions", { method: "POST", token: tokens.reader, data: { version: 1, address_id: alias.id, send_mode: mode }, expected: 400 });
  for (const action of ["send_as", "send_on_behalf"]) {
    await call(base + "/members/reader", { method: "PUT", data: { [action]: true }, expected: 400 });
    await call("/api-keys", { method: "POST", data: { name: "Removed send scope", expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: [{ mailbox_id: mailbox.id, action }] }, expected: 400 });
  }
  await call(base + "/drafts", { method: "POST", data: { compose_state: { to: "", cc: "", bcc: "", send_mode: "send_on_behalf" } }, expected: 400 });
  const { submission } = await call(base + "/drafts/" + memberDraft.id + "/submissions", { method: "POST", token: tokens.reader, data: { version: 1, address_id: alias.id }, expected: 202 });
  assert.equal("send_mode" in submission, false);
  const accepted = await eventually(() => call(base + "/submissions/" + submission.id, { token: tokens.reader }), (result) => result.submission.status === "accepted", "Shared From send failed");
  assert.equal("send_mode" in accepted.submission, false);
  const deliveries = await Promise.all((await bucket.list({ prefix: "test-sent/" })).objects.map(async (object) => (await bucket.get(object.key)).json()));
  assert.equal(deliveries[0].from, "alias@mail.test");
  assert.equal(deliveries[0].headers["X-Officeflare-Sent-On-Behalf-Of"], undefined);
  const aliasDraft = await draft({ subject: "Saved alias in one mailbox", compose_state: { to: "recipient@example.test", cc: "", bcc: "", address_id: alias.id } });
  const reopened = (await call(base + "/drafts/" + aliasDraft.id)).message;
  assert.equal(reopened.body.compose_state.address_id, alias.id);
  const aliasEdited = (await call(base + "/drafts/" + aliasDraft.id, { method: "PATCH", data: { version: reopened.draft.version, text: "Continue writing after reopening" } })).message;
  assert.equal(aliasEdited.body.compose_state.address_id, alias.id);
  const restored = (await call(base + "/drafts/" + aliasDraft.id)).message;
  const aliasSend = (await call(base + "/drafts/" + restored.id + "/submissions", { method: "POST", data: { version: restored.draft.version, address_id: restored.body.compose_state.address_id }, expected: 202 })).submission;
  const aliasAccepted = await eventually(() => call(base + "/submissions/" + aliasSend.id), (result) => result.submission.status === "accepted", "The reopened alias draft did not send");
  const aliasDelivery = await (await bucket.get("test-sent/" + aliasAccepted.submission.provider_message_id + ".json")).json();
  assert.equal(aliasDelivery.from, "alias@mail.test");
  await call(base + "/members/reader", { method: "PUT", data: { read: true, write: true } });
  assert.ok((await call(base + "/addresses", { token: tokens.reader })).addresses.every((entry) => !entry.can_send));

  const identities = async (token = tokens.owner) => (await call("/jmap", { method: "POST", token, data: { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:submission"], methodCalls: [["Identity/get", { accountId: mailbox.id }, "identities"]] } })).methodResponses[0][1].list;
  assert.deepEqual(new Set((await identities()).map((entry) => entry.email)), new Set(["owner@mail.test", "alias@mail.test"]));
  assert.deepEqual(await identities(tokens.reader), []);
  await admin("/domains/" + domain.id, { method: "PATCH", data: { outbound_enabled: false } });
  assert.ok((await call(base + "/addresses")).addresses.every((entry) => !entry.can_send));
  assert.deepEqual(await identities(), []);
  await admin("/domains/" + domain.id, { method: "PATCH", data: { outbound_enabled: true } });

  const { key } = await call("/api-keys", { method: "POST", data: { name: "From sender", expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: [{ mailbox_id: mailbox.id, action: "read" }, { mailbox_id: mailbox.id, action: "send" }] }, expected: 201 });
  assert.equal((await call(base + "/addresses", { token: key.token })).addresses.find((entry) => entry.id === alias.id).can_send, true);
  const keyedDraft = await draft({ subject: "Scoped From" });
  const scoped = (await call(base + "/drafts/" + keyedDraft.id + "/submissions", { method: "POST", token: key.token, data: { version: 1, address_id: alias.id }, expected: 202 })).submission;
  await eventually(() => call(base + "/submissions/" + scoped.id), (result) => result.submission.status === "accepted", "Scoped From send failed");

  const legacy = await draft({ subject: "Legacy saved mode", compose_state: { to: "recipient@example.test", cc: "", bcc: "", address_id: alias.id } });
  const object = (await bucket.list({ prefix: `bodies/${mailbox.id}/${legacy.id}/` })).objects[0];
  const oldBody = await (await bucket.get(object.key)).json();
  oldBody.compose_state.send_mode = "send_on_behalf";
  await bucket.put(object.key, JSON.stringify(oldBody));
  assert.equal("send_mode" in (await call(base + "/drafts/" + legacy.id)).message.body.compose_state, false);
  const edited = (await call(base + "/drafts/" + legacy.id, { method: "PATCH", data: { version: 1, text: "Mode removed" } })).message;
  assert.equal("send_mode" in edited.body.compose_state, false);
  const scheduled = (await call(base + "/drafts/" + legacy.id + "/submissions", { method: "POST", data: { version: edited.draft.version, address_id: alias.id, scheduled_at: Math.floor(Date.now() / 1000) + 3 }, expected: 202 })).submission;
  const snapshotObject = (await bucket.list({ prefix: `submissions/${mailbox.id}/${scheduled.id}/` })).objects[0];
  const snapshot = await (await bucket.get(snapshotObject.key)).json();
  snapshot.headers["X-Officeflare-Sent-On-Behalf-Of"] = "owner";
  await bucket.put(snapshotObject.key, JSON.stringify(snapshot));
  await eventually(() => call(base + "/submissions/" + scheduled.id), (result) => result.submission.status === "accepted", "Legacy queued snapshot did not send");
  const allSent = await Promise.all((await bucket.list({ prefix: "test-sent/" })).objects.map(async (entry) => (await bucket.get(entry.key)).json()));
  const legacySent = allSent.find((entry) => entry.subject === "Legacy saved mode");
  assert.equal(legacySent.from, "alias@mail.test");
  assert.equal(legacySent.headers["X-Officeflare-Sent-On-Behalf-Of"], undefined);
});

test("outbox keeps processing and unknown sends visible, private and safe to reconcile", async (t) => {
  const { mf, call, base, mailbox, address, draft, tokens } = await fixture(t, "6000000000", true);
  const bucket = await mf.getR2Bucket("MAIL_BUCKET"), queue = await mf.getQueueProducer("MAIL_QUEUE");
  await call(base + "/members/reader", { method: "PUT", data: { read: true } });
  await bucket.put("test-mode.json", "hold");
  const message = await draft({ subject: "Visible uncertain send" });
  const { submission } = await call(base + "/drafts/" + message.id + "/submissions", {
    method: "POST", data: { address_id: address.id, version: 1 }, expected: 202,
  });
  const processing = await eventually(
    () => call(base + "/messages?view=outbox"),
    (page) => page.messages.some((entry) => entry.id === message.id && entry.submission_status === "processing"),
    "Processing send disappeared from the outbox",
  );
  assert.equal(processing.messages[0].draft_state, "submitted");
  assert.equal(processing.messages[0].scheduled_at, null);
  assert.equal((await call(base + "/summary")).summary.outbox, 1);
  await call(base + "/submissions/" + submission.id + "/cancel", { method: "POST", expected: 409 });
  await bucket.put("test-mode.json", "unknown");
  const unknown = await eventually(
    () => call(base + "/messages?view=outbox"),
    (page) => page.messages.some((entry) => entry.id === message.id && entry.submission_status === "unknown"),
    "Unknown send disappeared from the outbox",
  );
  assert.deepEqual(unknown.messages.map((entry) => entry.id), [message.id]);
  assert.equal(unknown.messages[0].body_r2_key, undefined);
  assert.equal(unknown.messages[0].snapshot_r2_key, undefined);
  assert.equal((await call(base + "/summary")).summary.outbox, 1);
  assert.equal((await call(base + "/summary")).summary.scheduled, 0);
  assert.equal((await call(base + "/messages?view=scheduled")).messages.length, 0);
  assert.equal((await call(base + "/messages?folder_id=drafts")).messages.length, 0);
  assert.equal((await call(base + "/messages/" + message.id)).message.submissions[0].status, "unknown");
  assert.equal((await call(base + "/messages?view=outbox", { token: tokens.reader })).messages.length, 0);
  assert.equal((await call(base + "/summary", { token: tokens.reader })).summary.outbox, 0);
  await call(base + "/messages/" + message.id, { token: tokens.reader, expected: 404 });
  for (const action of ["retry", "cancel"])
    await call(base + "/submissions/" + submission.id + "/" + action, { method: "POST", expected: 409 });
  await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: 1, text: "Do not resend" }, expected: 409 });
  const scheduledDraft = await draft({ subject: "Also scheduled" });
  const scheduled = (await call(base + "/drafts/" + scheduledDraft.id + "/submissions", {
    method: "POST", data: { address_id: address.id, version: 1, scheduled_at: Math.floor(Date.now() / 1000) + 3600 }, expected: 202,
  })).submission;
  assert.equal((await call(base + "/summary")).summary.outbox, 2);
  const first = await call(base + "/messages?view=outbox&limit=1");
  assert.ok(first.next_cursor);
  const second = await call(base + "/messages?view=outbox&limit=1&cursor=" + encodeURIComponent(first.next_cursor));
  assert.equal(second.next_cursor, null);
  assert.deepEqual(new Set([...first.messages, ...second.messages].map((entry) => entry.id)), new Set([message.id, scheduledDraft.id]));
  await call(base + "/submissions/" + scheduled.id + "/cancel", { method: "POST" });
  assert.equal((await call(base + "/summary")).summary.outbox, 1);
  const sent = (await bucket.list({ prefix: "test-sent/" })).objects;
  assert.equal(sent.length, 1);
  const providerMessageId = sent[0].key.slice("test-sent/".length, -".json".length);
  await bucket.put("accepted/" + mailbox.id + "/" + submission.id + ".json", JSON.stringify({ provider_message_id: providerMessageId }));
  await queue.send({ kind: "send", mailbox_id: mailbox.id, partition_id: message.id.split(".")[0], reference_id: submission.id });
  await eventually(() => call(base + "/submissions/" + submission.id), (result) => result.submission.status === "accepted", "Acceptance receipt was not reconciled");
  assert.equal((await call(base + "/messages?view=outbox")).messages.length, 0);
  assert.equal((await call(base + "/summary")).summary.outbox, 0);
  assert.equal((await call(base + "/messages?folder_id=sent")).messages[0].id, message.id);
  assert.equal((await bucket.list({ prefix: "test-sent/" })).objects.length, 1);
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

test("MBOX export and reimport preserve legacy text, binary attachments and quoted From lines", async (t) => {
  const { mf, tokens, call, admin, base, mailbox, draft } = await fixture(t, "6000000000", true);
  const harness = await mf.getWorker("mail-harness"), bucket = await mf.getR2Bucket("MAIL_BUCKET");
  const binary = Buffer.concat([
    Buffer.from(Array.from({ length: 256 }, (_, byte) => byte)),
    Buffer.from("\nFrom binary line\r\n>From quoted binary\n>>From twice quoted\n", "ascii"),
    Buffer.from([0, 0xff, 0x80]),
  ]);
  const originals = new Map([
    ["Legacy byte export", Buffer.concat([
      Buffer.from(["From: legacy@example.test", "To: owner@mail.test", "Subject: Legacy byte export", "Message-ID: <legacy-export@example.test>", "MIME-Version: 1.0", "Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: 8bit", "", "caf"].join("\r\n"), "ascii"),
      Buffer.from([0xe9, 0x20, 0xfc, 0x20, 0xdf]),
      Buffer.from("\r\nFrom plain line\n>From quoted line\r\n>>From twice quoted\nFromage is ordinary text\r\n", "ascii"),
    ])],
    ["Binary byte export", Buffer.concat([
      Buffer.from(["From: binary@example.test", "To: owner@mail.test", "Subject: Binary byte export", "Message-ID: <binary-export@example.test>", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="byte-export"', "", "--byte-export", "Content-Type: text/plain; charset=utf-8", "", "Binary attachment", "--byte-export", "Content-Type: application/octet-stream", "Content-Disposition: attachment; filename=bytes.bin", "Content-Transfer-Encoding: binary", "", ""].join("\r\n"), "ascii"),
      binary,
      Buffer.from("\r\n--byte-export--\r\n", "ascii"),
    ])],
  ]);
  for (const raw of originals.values()) {
    const received = await harness.fetch("https://test/email", { method: "POST", headers: { "x-recipient": "owner@mail.test" }, body: raw });
    assert.equal((await received.json()).rejected, null);
  }
  const ingested = await eventually(() => call(base + "/messages"), (page) => page.messages.length === 2, "Original messages were not ingested");
  const originalAttachment = (await call(base + "/messages/" + ingested.messages.find((entry) => entry.subject === "Binary byte export").id)).message;
  const originalBytes = await mf.dispatchFetch("https://office.test/api/mail" + base + "/messages/" + originalAttachment.id + "/attachments/" + originalAttachment.attachments[0].id, { headers: { Authorization: "Bearer " + tokens.owner } });
  const extractedBinary = Buffer.from(await originalBytes.arrayBuffer());
  assert.deepEqual(extractedBinary.subarray(0, 256), binary.subarray(0, 256));
  await draft({ subject: "Composed UTF8 export", text: "안녕하세요 — preserved UTF-8", html: "<p>안녕하세요 — preserved UTF-8</p>", include_signature: false });
  const exported = (await call(base + "/exports", { method: "POST", expected: 202 })).job;
  await eventually(() => call(base + "/jobs/" + exported.id), (result) => result.job.status === "completed", "Byte-preserving export failed");
  const download = await mf.dispatchFetch("https://office.test/api/mail" + base + "/jobs/" + exported.id + "/download", { headers: { Authorization: "Bearer " + tokens.owner } });
  assert.equal(download.status, 200);
  const archive = Buffer.from(await download.arrayBuffer());
  assert.ok(archive.includes(Buffer.from([0xe9, 0x20, 0xfc, 0x20, 0xdf])));
  assert.ok(archive.includes(Buffer.from([0, 0xff, 0x80])));
  assert.ok(archive.includes(Buffer.from(">>From quoted line\r\n>>>From twice quoted", "ascii")));
  const pieces = await bucket.list({ prefix: `data-jobs/${mailbox.id}/${exported.id}/` });
  assert.equal(pieces.objects.filter((object) => object.key.endsWith(".mbox")).length, 3);
  const target = (await admin("/mailboxes", { method: "POST", data: { name: "Byte import", owner_user_id: "owner" }, expected: 201 })).mailbox;
  const targetPath = "/mailboxes/" + target.id;
  const imported = await mf.dispatchFetch("https://office.test/api/mail" + targetPath + "/imports?format=mbox", {
    method: "POST", headers: { Authorization: "Bearer " + tokens.owner }, body: archive,
  });
  assert.equal(imported.status, 202);
  const importedJob = (await imported.json()).job;
  await eventually(() => call(targetPath + "/jobs/" + importedJob.id), (result) => result.job.status === "completed", "MBOX reimport failed");
  const restored = (await call(targetPath + "/messages")).messages;
  assert.equal(restored.length, 3);
  for (const [subject, raw] of originals) {
    const message = restored.find((entry) => entry.subject === subject);
    assert.ok(message, subject);
    const response = await mf.dispatchFetch("https://office.test/api/mail" + targetPath + "/messages/" + message.id + "/original", { headers: { Authorization: "Bearer " + tokens.owner } });
    assert.equal(response.status, 200);
    // The two final LF bytes frame the MBOX record; the original MIME is untouched.
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([raw, Buffer.from("\n\n")]));
  }
  const legacy = (await call(targetPath + "/messages/" + restored.find((entry) => entry.subject === "Legacy byte export").id)).message;
  assert.match(legacy.body.text, /café ü ß/);
  assert.match(legacy.body.text, /From plain line\n>From quoted line\n>>From twice quoted/);
  const attachment = (await call(targetPath + "/messages/" + restored.find((entry) => entry.subject === "Binary byte export").id)).message;
  assert.equal(attachment.attachments.length, 1);
  const bytes = await mf.dispatchFetch("https://office.test/api/mail" + targetPath + "/messages/" + attachment.id + "/attachments/" + attachment.attachments[0].id, { headers: { Authorization: "Bearer " + tokens.owner } });
  // Compare extracted attachments before and after export; the MIME parser has
  // its own newline normalization, independently of the preserved wire message.
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), extractedBinary);
  const composed = (await call(targetPath + "/messages/" + restored.find((entry) => entry.subject === "Composed UTF8 export").id)).message;
  assert.match(composed.body.text, /안녕하세요 — preserved UTF-8/);
  assert.match(composed.body.html, /안녕하세요 — preserved UTF-8/);
});

test("domain routing, signatures, audit and attachment-safe configuration restore", async (t) => {
  const { mf, db, tokens, call, admin, base, domain, mailbox, draft } =
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
  await call(base + "/audit-logs", { expected: 403 });
  await db.prepare("INSERT INTO roles(id,key,label) VALUES('mail-auditor','mail-auditor','Mail auditor')").run();
  await db.batch(permissionClosure(["admin.mail.audit.read"]).map(permission => db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('mail-auditor',?)").bind(permission)));
  await db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('owner','mail-auditor')").run();
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
  assert.equal(reader.can_read, 1); assert.equal(reader.can_send, 0); assert.equal(manager.can_manage, 1);
  assert.equal((await call("/mailboxes", { token: tokens.reader })).mailboxes.find((entry) => entry.id === id).access.write, false);
  await call(path, { token: tokens.reader, expected: 403 });
  await call(`/mailboxes/${id}/messages`, { token: tokens.reader });
  await call(`/mailboxes/${id}/messages`, { token: tokens.owner, expected: 403 });
  const directory = await admin("/mailbox-users");
  assert.deepEqual(Object.keys(directory.users[0]).sort(), ["display_name", "email_address", "id"]);
  assert.deepEqual(Object.keys(config.owner).sort(), ["display_name", "email_address", "id"]);
  const all = (await admin("/mailboxes?all=true")).mailboxes.find((entry) => entry.id === id);
  assert.equal(all.email_address, "support@mail.test"); assert.equal(all.member_count, 2);

  const custom = { can_read: true, can_write: false, can_send: true, can_manage: false };
  await admin(path, { method: "PATCH", data: { name: "Support team", address: { domain_id: domain.id, local_part: "help" }, members: [{ user_id: "reader", role: "custom", permissions: custom }] } });
  const changed = await admin(path);
  assert.equal(changed.addresses.find((entry) => entry.is_primary).email_address, "help@mail.test");
  assert.equal(changed.addresses.find((entry) => !entry.is_primary).email_address, "support@mail.test");
  assert.equal(changed.members.length, 1); assert.equal(changed.members[0].can_send, 1);
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

test("reply-all preserves To and Cc roles while excluding mailbox addresses, duplicates and Bcc", async (t) => {
  const { call, admin, base, mailbox, domain, draft, mf, tokens } = await fixture(t, "6000000000", true);
  const alias = (await admin("/addresses", { method: "POST", data: { domain_id: domain.id, mailbox_id: mailbox.id, local_part: "alias" }, expected: 201 })).address;
  const harness = await mf.getWorker("mail-harness"), bucket = await mf.getR2Bucket("MAIL_BUCKET");
  const recipientsOf = (message, kind) => message.recipients.filter((entry) => entry.kind === kind).map((entry) => entry.email_address);
  const received = async (name, headers) => {
    const result = await harness.fetch("https://test/email", { method: "POST", body: [...headers, "Subject: " + name, `Message-ID: <${name}@example.test>`, "Content-Type: text/plain; charset=utf-8", "", "Quoted reply-all body"].join("\r\n") });
    assert.equal((await result.json()).rejected, null);
    const page = await eventually(() => call(base + "/messages?q=subject:" + name), (page) => page.messages.length === 1, "The source mail did not arrive");
    return page.messages[0];
  };
  const replyAll = async (message, options = {}) => (await call(base + "/messages/" + message.id + "/reply-all", { method: "POST", data: {}, expected: 201, ...options })).message;
  let incoming, reply;
  await t.test("Reply-To stays in To, original Cc stays in Cc, and case-insensitive duplicates are removed", async () => {
    incoming = await received("RecipientRoles", [
      "From: original@example.test",
      "Reply-To: Replies@Example.test",
      "To: OWNER@mail.test, ALIAS@mail.test, Main@Example.test, MAIN@example.test, Both@example.test",
      "Cc: OWNER@mail.test, alias@mail.test, Observer@example.test, OBSERVER@example.test, both@EXAMPLE.test, replies@example.test",
    ]);
    const options = { headers: { "Idempotency-Key": "reply-all-roles" } };
    reply = await replyAll(incoming, options);
    const replay = await replyAll(incoming, options);
    assert.equal(replay.id, reply.id);
    assert.deepEqual(recipientsOf(reply, "to"), ["replies@example.test", "main@example.test", "both@example.test"]);
    assert.deepEqual(recipientsOf(reply, "cc"), ["observer@example.test"]);
    assert.deepEqual(recipientsOf(reply, "bcc"), []);
    assert.equal(reply.thread_id, incoming.thread_id);
    assert.match(reply.body.text, /Quoted reply-all body/);
    const reopened = (await call(base + "/drafts/" + reply.id)).message;
    assert.deepEqual(reopened.recipients, reply.recipients);
  });
  await t.test("sending the reply retains separate To and Cc provider fields", async () => {
    const job = (await call(base + "/drafts/" + reply.id + "/submissions", { method: "POST", data: { version: reply.draft.version, address_id: alias.id }, expected: 202 })).submission;
    const accepted = await eventually(() => call(base + "/submissions/" + job.id), (result) => result.submission.status === "accepted", "Reply-all send did not complete");
    const sent = await (await bucket.get("test-sent/" + accepted.submission.provider_message_id + ".json")).json();
    assert.equal(sent.from, "alias@mail.test");
    assert.deepEqual(sent.to, ["replies@example.test", "main@example.test", "both@example.test"]);
    assert.deepEqual(sent.cc, ["observer@example.test"]);
    assert.deepEqual(sent.bcc, []);
  });
  await t.test("a reply to our own sent alias preserves visible recipient roles and never reveals Bcc", async () => {
    const sentDraft = await draft({ subject: "Own alias recipients", reply_to: "our-support@example.test", to: ["main@example.test", "owner@mail.test"], cc: ["observer@example.test", "MAIN@example.test", "alias@mail.test"], bcc: ["hidden@example.test"] });
    const job = (await call(base + "/drafts/" + sentDraft.id + "/submissions", { method: "POST", data: { version: sentDraft.draft.version, address_id: alias.id }, expected: 202 })).submission;
    await eventually(() => call(base + "/submissions/" + job.id), (result) => result.submission.status === "accepted", "Own sent mail did not complete");
    const response = await replyAll(sentDraft);
    assert.deepEqual(recipientsOf(response, "to"), ["main@example.test"]);
    assert.deepEqual(recipientsOf(response, "cc"), ["observer@example.test"]);
    assert.deepEqual(recipientsOf(response, "bcc"), []);
    assert.ok(response.recipients.every((entry) => !["hidden@example.test", "our-support@example.test"].includes(entry.email_address)));
  });
  await t.test("the original sender appears in To once even when also listed in Cc", async () => {
    const message = await received("SenderInCc", ["From: Sender@Example.test", "To: owner@mail.test", "Cc: sender@example.test, other@example.test"]);
    const response = await replyAll(message);
    assert.deepEqual(recipientsOf(response, "to"), ["sender@example.test"]);
    assert.deepEqual(recipientsOf(response, "cc"), ["other@example.test"]);
  });
  await t.test("a Cc-only continuation keeps Cc and self-only messages produce no recipients", async () => {
    const ccOnly = await received("CcOnlyContinuation", ["From: ALIAS@mail.test", "To: owner@mail.test", "Cc: observer@example.test, alias@mail.test"]);
    const continuation = await replyAll(ccOnly);
    assert.deepEqual(recipientsOf(continuation, "to"), []);
    assert.deepEqual(recipientsOf(continuation, "cc"), ["observer@example.test"]);
    const selfOnly = await received("SelfOnlyRecipients", ["From: alias@mail.test", "To: owner@mail.test", "Cc: ALIAS@mail.test"]);
    assert.deepEqual((await replyAll(selfOnly)).recipients, []);
  });
  await t.test("ordinary replies and forwards keep their recipient behavior and write access is required", async () => {
    const ordinary = (await call(base + "/messages/" + incoming.id + "/reply", { method: "POST", data: {}, expected: 201 })).message;
    assert.deepEqual(recipientsOf(ordinary, "to"), ["replies@example.test"]);
    assert.deepEqual(recipientsOf(ordinary, "cc"), []);
    const forward = (await call(base + "/messages/" + incoming.id + "/forward", { method: "POST", data: { to: ["forward@example.test"] }, expected: 201 })).message;
    assert.deepEqual(recipientsOf(forward, "to"), ["forward@example.test"]);
    assert.deepEqual(recipientsOf(forward, "cc"), []);
    await call(base + "/members/reader", { method: "PUT", data: { read: true } });
    await call(base + "/messages/" + incoming.id + "/reply-all", { method: "POST", token: tokens.reader, data: {}, expected: 403 });
    await call(base + "/members/reader", { method: "PUT", data: { read: true, write: true } });
    const sharedReply = await replyAll(incoming, { token: tokens.reader });
    assert.deepEqual(recipientsOf(sharedReply, "to"), ["replies@example.test", "main@example.test", "both@example.test"]);
    assert.deepEqual(recipientsOf(sharedReply, "cc"), ["observer@example.test"]);
  });
});
test("draft Reply-To addresses survive editing and reach outgoing mail", async (t) => {
  const { call, base, draft, mf, address, tokens } = await fixture(t, "6000000000", true);
  const bucket = await mf.getR2Bucket("MAIL_BUCKET");
  const state = { to: "recipient@example.test", cc: "", bcc: "", reply_to: "Support@Example.test", address_id: address.id, schedule: "" };
  const message = await draft({ subject: "Custom Reply-To", reply_to: " Support@Example.test ", compose_state: state });
  assert.equal(message.reply_to_address, "support@example.test");
  assert.deepEqual(message.body.compose_state, state);
  const preserved = (await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: 1, text: "Updated body" } })).message;
  assert.equal(preserved.reply_to_address, "support@example.test");
  assert.deepEqual(preserved.body.compose_state, state);
  const updated = (await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: preserved.draft.version, reply_to: "replies@example.test", compose_state: { ...state, reply_to: "replies@example.test" } } })).message;
  assert.equal(updated.reply_to_address, "replies@example.test");
  const reopened = (await call(base + "/drafts/" + message.id)).message;
  assert.equal(reopened.reply_to_address, "replies@example.test");
  const send = async (value, token = tokens.owner) => {
    const submission = (await call(base + "/drafts/" + value.id + "/submissions", { method: "POST", token, data: { version: value.draft.version, address_id: address.id }, expected: 202 })).submission;
    await eventually(() => call(base + "/submissions/" + submission.id, { token }), (result) => result.submission.status === "accepted", "Reply-To mail was not accepted");
    const deliveries = await Promise.all((await bucket.list({ prefix: "test-sent/" })).objects.map(async (object) => (await bucket.get(object.key)).json()));
    return deliveries.find((delivery) => delivery.subject === value.subject);
  };
  const sent = await send(reopened);
  assert.equal(sent.replyTo, "replies@example.test");
  assert.equal(sent.from, "owner@mail.test");
  const reply = (await call(base + "/messages/" + message.id + "/reply", { method: "POST", data: {}, expected: 201 })).message;
  assert.equal(reply.recipients.find((entry) => entry.kind === "to").email_address, "recipient@example.test");
  const harness = await mf.getWorker("mail-harness");
  const incoming = await harness.fetch("https://test/email", { method: "POST", body: ["From: Sender <sender@example.test>", "To: owner@mail.test", "Reply-To: replies@example.test", "Subject: Incoming custom Reply-To", "Content-Type: text/plain; charset=utf-8", "", "Reply here"].join("\r\n") });
  assert.equal((await incoming.json()).rejected, null);
  const inbox = await eventually(() => call(base + "/messages?folder_id=inbox"), (page) => page.messages.length === 1, "Reply-To inbound mail missing");
  const receivedReply = (await call(base + "/messages/" + inbox.messages[0].id + "/reply", { method: "POST", data: {}, expected: 201 })).message;
  assert.equal(receivedReply.recipients.find((entry) => entry.kind === "to").email_address, "replies@example.test");

  const cleared = await draft({ subject: "Cleared Reply-To", reply_to: "old@example.test" });
  const empty = (await call(base + "/drafts/" + cleared.id, { method: "PATCH", data: { version: 1, reply_to: null } })).message;
  assert.equal(empty.reply_to_address, null);
  assert.equal((await send(empty)).replyTo, undefined);
  const whitespace = await draft({ reply_to: " " });
  assert.equal(whitespace.reply_to_address, null);
  const incomplete = await draft({ compose_state: { ...state, reply_to: "unfinished@" } });
  assert.equal(incomplete.body.compose_state.reply_to, "unfinished@");
  assert.equal(incomplete.reply_to_address, null);
  for (const reply_to of ["unfinished@", "one@example.test,two@example.test", "safe@example.test\r\nBcc: attacker@example.test", "x".repeat(255), false]) {
    await call(base + "/drafts", { method: "POST", data: { reply_to }, expected: 400 });
    await call(base + "/drafts/" + whitespace.id, { method: "PATCH", data: { version: whitespace.draft.version, reply_to }, expected: 400 });
  }
  const headers = { "Idempotency-Key": "draft-reply-to" };
  await draft({ reply_to: "first@example.test" }, headers);
  await call(base + "/drafts", { method: "POST", headers, data: { subject: "A mail test", text: "Hello searchable mail", to: ["recipient@example.test"], reply_to: "second@example.test" }, expected: 409 });

  await call(base + "/members/reader", { method: "PUT", data: { read: true, write: true } });
  const sharedDraft = (await call(base + "/drafts", { method: "POST", token: tokens.reader, data: { subject: "Default reply address", to: ["recipient@example.test"] }, expected: 201 })).message;
  await call(base + "/drafts/" + sharedDraft.id + "/submissions", { method: "POST", token: tokens.reader, data: { version: 1, address_id: address.id }, expected: 403 });
  await call(base + "/members/reader", { method: "PUT", data: { read: true, write: true, send: true } });
  const sharedSent = await send(sharedDraft, tokens.reader);
  assert.equal(sharedSent.replyTo, undefined);
  assert.equal(sharedSent.from, "owner@mail.test");
  assert.equal(sharedSent.headers["X-Officeflare-Sent-On-Behalf-Of"], undefined);

  const exported = (await call(base + "/exports", { method: "POST", expected: 202 })).job;
  await eventually(() => call(base + "/jobs/" + exported.id), (result) => result.job.status === "completed", "Reply-To export did not finish");
  const exportObjects = await bucket.list({ prefix: `data-jobs/${base.split("/").at(-1)}/${exported.id}/` });
  const exportedText = (await Promise.all(exportObjects.objects.filter((file) => file.key.endsWith(".mbox")).map(async (file) => (await bucket.get(file.key)).text()))).join("");
  assert.match(exportedText, /Reply-To: replies@example\.test/);
});

test("mail experience preferences, draft recovery and conversation paging", async (t) => {
  const { call, base, draft, mf, tokens, address } = await fixture(t, "250000", true);
  await t.test("personal preferences merge fields and remain scoped to the signed-in user", async () => {
    const defaults = (await call("/preferences")).preferences;
    assert.equal(defaults.conversation_view, true);
    await call("/preferences", { method: "PATCH", data: { density: "compact", undo_seconds: 30 } });
    const updated = await call("/preferences", { method: "PATCH", data: { reading_pane: "right" } });
    assert.equal(updated.preferences.density, "compact");
    assert.equal(updated.preferences.undo_seconds, 30);
    assert.equal(updated.preferences.reading_pane, "right");
    assert.deepEqual((await call("/preferences", { token: tokens.reader })).preferences, defaults);
    await call("/preferences", { method: "PATCH", data: { undo_seconds: 31 }, expected: 400 });
    await call("/preferences", { method: "PATCH", data: { density: "invalid" }, expected: 400 });
    await call("/preferences", { method: "PATCH", data: { shortcuts: "true" }, expected: 400 });
  });
  await t.test("unfinished recipient input survives draft saves without relaxing send validation", async () => {
    const state = { to: "unfinished@", cc: "", bcc: "", address_id: address.id, schedule: "" };
    const message = await draft({ to: [], compose_state: state });
    assert.deepEqual(message.body.compose_state, state);
    const updated = (await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: 1, text: "Updated body" } })).message;
    assert.deepEqual(updated.body.compose_state, state);
    await call(base + "/drafts/" + message.id + "/submissions", { method: "POST", data: { version: updated.draft.version, address_id: address.id, undo_window: 30 }, expected: 400 });
    const next = (await call(base + "/drafts/" + message.id, { method: "PATCH", data: { version: updated.draft.version, to: ["recipient@example.test"], compose_state: { ...state, to: "recipient@example.test, " } } })).message;
    const before = Math.floor(Date.now() / 1000), data = { version: next.draft.version, address_id: address.id, undo_window: 30 }, headers = { "Idempotency-Key": "undo-delay-test" };
    const send = (await call(base + "/drafts/" + next.id + "/submissions", { method: "POST", data, headers, expected: 202 })).submission;
    assert.equal(send.status, "scheduled");
    assert.ok(send.scheduled_at >= before + 30);
    assert.equal((await call(base + "/drafts/" + next.id + "/submissions", { method: "POST", data, headers, expected: 202 })).submission.id, send.id);
    const scheduled = await call(base + "/messages?view=scheduled");
    assert.equal(scheduled.messages.find((entry) => entry.id === next.id).scheduled_at, send.scheduled_at);
    assert.equal(scheduled.messages.find((entry) => entry.id === next.id).draft_state, "submitted");
    assert.equal((await call(base + "/messages?folder_id=drafts")).messages.some((entry) => entry.id === next.id), false);
    assert.equal((await call(base + "/summary")).summary.scheduled, 1);
    await call(base + "/submissions/" + send.id + "/cancel", { method: "POST" });
    assert.equal((await call(base + "/drafts/" + next.id)).message.draft.state, "editable");
    assert.equal((await call(base + "/summary")).summary.scheduled, 0);
  });
  await t.test("conversations merge across partitions with complete counts and stable cursor pages", async () => {
    const harness = await mf.getWorker("mail-harness");
    for (let n = 0; n < 5; n++) {
      const mime = ["From: Sender <sender@example.test>", "To: owner@mail.test", "Subject: " + (n < 3 ? "Conversation" : "Other " + n), `Message-ID: <experience-${n}@example.test>`, ...(n > 0 && n < 3 ? ["In-Reply-To: <experience-0@example.test>", "References: <experience-0@example.test>"] : []), "Content-Type: text/plain; charset=utf-8", "", "Message " + n].join("\r\n");
      const result = await harness.fetch("https://test/email", { method: "POST", body: mime });
      assert.equal((await result.json()).rejected, null);
      await eventually(() => call(base + "/messages?folder_id=inbox"), (page) => page.messages.length === n + 1, "Inbound mail missing");
    }
    assert.ok((await call(base + "/storage")).partitions.length > 1);
    const threads = (await call(base + "/threads?folder_id=inbox")).messages;
    assert.equal(threads.length, 3);
    const conversation = threads.find((entry) => entry.message_count === 3);
    assert.ok(conversation);
    assert.equal(conversation.unread_count, 3);
    const visited = [], ids = [];
    let cursor = null;
    do {
      const page = await call(base + "/threads?folder_id=inbox&limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      visited.push(...page.messages.map((entry) => entry.thread_id));
      ids.push(...page.messages.map((entry) => entry.id));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(ids, threads.map((entry) => entry.id));
    assert.equal(new Set(visited).size, 3);
    const reply = (await call(base + "/messages/" + conversation.id + "/reply", { method: "POST", data: {}, expected: 201 })).message;
    assert.equal((await call(base + "/threads?folder_id=inbox")).messages.find((entry) => entry.thread_id === conversation.thread_id).message_count, 3);
    assert.equal((await call(base + "/threads/" + conversation.thread_id)).messages.some((entry) => entry.id === reply.id), true);
    const summary = (await call(base + "/summary")).summary;
    assert.deepEqual(summary.folders.inbox, { total: 5, unread: 5 });
    assert.ok(summary.folders.drafts.total > 0);
    await call(base + "/messages/" + conversation.id, { method: "PATCH", data: { version: conversation.version, snoozed_until: Math.floor(Date.now() / 1000) + 3600 } });
    assert.equal((await call(base + "/threads/" + conversation.thread_id)).messages.length, 4);
    const snoozed = (await call(base + "/summary")).summary;
    assert.equal(snoozed.snoozed, 1);
    assert.deepEqual(snoozed.folders.inbox, {total:4,unread:4});
  });
});

test("backup restore preserves future snoozes and resumes reminders safely across retries", async (t) => {
  const { mf, call, admin, base, mailbox } = await fixture(t, "250000", true);
  const harness = await mf.getWorker("mail-harness"), bucket = await mf.getR2Bucket("MAIL_BUCKET");
  for (const subject of ["FutureSnooze", "ExpiredSnooze", "LegacySnooze", "NoSnooze"]) {
    const response = await harness.fetch("https://test/email", { method: "POST", body: ["From: sender@example.test", "To: owner@mail.test", "Subject: " + subject, `Message-ID: <${subject}@example.test>`, "", "A backed-up reminder"].join("\r\n") });
    assert.equal((await response.json()).rejected, null);
  }
  const originals = (await eventually(() => call(base + "/messages"), (page) => page.messages.length === 4, "Source mail was not received")).messages;
  const future = Math.floor(Date.now() / 1000) + 3600;
  for (const subject of ["FutureSnooze", "ExpiredSnooze"]) {
    const message = originals.find((entry) => entry.subject === subject);
    await call(base + "/messages/" + message.id, { method: "PATCH", data: { version: message.version, snoozed_until: future, ...(subject === "FutureSnooze" ? { is_read: true, is_starred: true } : {}) } });
  }
  const backup = (await call(base + "/backups", { method: "POST", expected: 202 })).job;
  await eventually(() => call(base + "/jobs/" + backup.id), (result) => result.job.status === "completed", "The snooze backup did not finish");
  const pieces = [];
  for (const entry of (await bucket.list({ prefix: `data-jobs/${mailbox.id}/${backup.id}/` })).objects.filter((entry) => entry.key.endsWith(".message.json")))
    pieces.push({ key: entry.key, message: await (await bucket.get(entry.key)).json() });
  assert.equal(pieces.length, 4);
  const futurePiece = pieces.find((piece) => piece.message.subject === "FutureSnooze"), expiredPiece = pieces.find((piece) => piece.message.subject === "ExpiredSnooze"), legacyPiece = pieces.find((piece) => piece.message.subject === "LegacySnooze");
  assert.equal(futurePiece.message.snoozed_until, future);
  assert.equal(expiredPiece.message.snoozed_until, future);
  expiredPiece.message.snoozed_until = Math.floor(Date.now() / 1000) - 60;
  await bucket.put(expiredPiece.key, JSON.stringify(expiredPiece.message));
  delete legacyPiece.message.snoozed_until;
  await bucket.put(legacyPiece.key, JSON.stringify(legacyPiece.message));
  const target = async (name) => {
    const box = (await admin("/mailboxes", { method: "POST", data: { name, owner_user_id: "owner" }, expected: 201 })).mailbox;
    return { id: box.id, path: "/mailboxes/" + box.id };
  };
  const start = async (destination) => (await call(base + "/backups/" + backup.id + "/restore", { method: "POST", data: { target_mailbox_id: destination.id }, expected: 202 })).job;
  const finish = async (destination, job) => eventually(() => call(destination.path + "/jobs/" + job.id), (result) => result.job.status === "completed", "The snooze restore did not finish");
  const all = async (destination) => (await call(destination.path + "/messages?include_snoozed=true")).messages;
  await t.test("future times and flags survive while expired, absent and null snoozes remain visible", async () => {
    const destination = await target("Restored snoozes"), job = await start(destination);
    await finish(destination, job);
    const restored = await all(destination), snoozed = restored.find((entry) => entry.subject === "FutureSnooze");
    assert.equal(restored.length, 4);
    assert.equal(snoozed.snoozed_until, future); assert.equal(snoozed.is_read, 1); assert.equal(snoozed.is_starred, 1);
    assert.equal(snoozed.folder_id, "inbox");
    for (const subject of ["ExpiredSnooze", "LegacySnooze", "NoSnooze"]) assert.equal(restored.find((entry) => entry.subject === subject).snoozed_until, null);
    assert.deepEqual((await call(destination.path + "/messages?snoozed_only=true")).messages.map((entry) => entry.id), [snoozed.id]);
    assert.equal((await call(destination.path + "/messages")).messages.length, 3);
    assert.equal((await call(destination.path + "/summary")).summary.snoozed, 1);
    assert.equal((await call(base + "/messages/" + originals.find((entry) => entry.subject === "FutureSnooze").id)).message.snoozed_until, future);
  });
  await t.test("a restored reminder clears its stored timestamp automatically when due", async () => {
    const destination = await target("Wake restored reminder"), deadline = Math.floor(Date.now() / 1000) + 6;
    await bucket.put(futurePiece.key, JSON.stringify({ ...futurePiece.message, snoozed_until: deadline }));
    const job = await start(destination); await finish(destination, job);
    const snoozed = (await all(destination)).find((entry) => entry.subject === "FutureSnooze");
    assert.equal(snoozed.snoozed_until, deadline);
    const awake = await eventually(() => call(destination.path + "/messages/" + snoozed.id), (result) => result.message.snoozed_until === null, "The restored reminder did not run");
    assert.ok(awake.message.version > snoozed.version);
    assert.equal((await call(destination.path + "/messages?snoozed_only=true")).messages.length, 0);
    assert.equal((await call(destination.path + "/messages")).messages.length, 4);
    await bucket.put(futurePiece.key, JSON.stringify(futurePiece.message));
  });
  await t.test("partial restore retries preserve a changed snooze and rearm its current time", async () => {
    const firstPiece = pieces[0], missingPiece = pieces[1];
    await bucket.put(firstPiece.key, JSON.stringify({ ...firstPiece.message, snoozed_until: future }));
    const missingBody = await (await bucket.get(missingPiece.message.body_r2_key)).arrayBuffer();
    await bucket.delete(missingPiece.message.body_r2_key);
    const destination = await target("Retried snooze"), job = await start(destination);
    await eventually(() => call(destination.path + "/jobs/" + job.id), (result) => result.job.status === "failed", "The incomplete backup did not pause restoration");
    const partial = (await all(destination)).find((entry) => entry.subject === firstPiece.message.subject);
    assert.ok(partial); assert.equal(partial.snoozed_until, future);
    const deadline = Math.floor(Date.now() / 1000) + 6;
    const changed = (await call(destination.path + "/messages/" + partial.id, { method: "PATCH", data: { version: partial.version, snoozed_until: deadline } })).message;
    await bucket.put(missingPiece.message.body_r2_key, missingBody);
    await call(destination.path + "/jobs/" + job.id + "/retry", { method: "POST", expected: 202 });
    await finish(destination, job);
    const recovered = (await call(destination.path + "/messages/" + partial.id)).message;
    assert.equal(recovered.snoozed_until, deadline); assert.equal(recovered.version, changed.version);
    assert.equal((await all(destination)).length, 4);
    await eventually(() => call(destination.path + "/messages/" + partial.id), (result) => result.message.snoozed_until === null, "The retried restore overwrote the current reminder schedule");
  });
});
test("rich mail preserves signatures, inline images and quoted HTML through editing and restore", async (t) => {
  const { mf, call, admin, base, tokens, mailbox, draft, address } = await fixture(t, "6000000000", true);
  const bucket = await mf.getR2Bucket("MAIL_BUCKET");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvR0AAAAASUVORK5CYII=", "base64");
  async function image(token = tokens.owner, bytes = png, contentType = "image/png", expected = 201) {
    const response = await mf.dispatchFetch("https://office.test/api/mail" + base + "/images", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": contentType, "Content-Length": String(bytes.length), "X-Filename-Encoded": encodeURIComponent("서명 로고.png") }, body: bytes,
    });
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  }
  await image(tokens.outsider, png, "image/png", 403);
  await image(tokens.owner, Buffer.from("not an image"), "image/png", 415);
  await image(tokens.owner, png, "image/svg+xml", 415);
  const logo = (await image()).image;
  assert.equal(logo.filename, "서명 로고.png");
  const htmlSignature = `<p><strong>Alex Morgan</strong><br><span style="color:#2563eb;font-family:Georgia,serif;font-size:16px">Officeflare team</span></p><p><img src="cid:${logo.content_id}" width="120" alt="Logo"></p>`;
  await call(base + "/settings", { method: "PATCH", data: { signature_html: htmlSignature } });
  const settings = (await call(base + "/settings")).settings;
  assert.match(settings.signature, /Alex Morgan\nOfficeflare team/);
  assert.match(settings.signature_html, /font-size:16px/);
  const otherBox = (await admin("/mailboxes", { method: "POST", data: { name: "Rich restore", owner_user_id: "owner" }, expected: 201 })).mailbox;
  await call(`/mailboxes/${otherBox.id}/settings`, { method: "PATCH", data: { signature_html: htmlSignature }, expected: 400 });
  await call(base + "/images/" + logo.id, { token: tokens.outsider, expected: 403 });
  const bodyHtml = '<p style="text-align:center"><span style="color:#dc2626;font-size:24px">안녕하세요 &amp; welcome</span></p><table style="border-collapse:collapse;width:100%"><tbody><tr><td style="border:1px solid rgb(221, 221, 221);padding:8px">First</td><td>Second</td></tr></tbody></table><script>alert(1)</script><p onclick="alert(1)" style="background-image:url(https://tracker.test/pixel);position:fixed">Safe</p><img src="https://tracker.test/pixel">';
  const original = await draft({ subject: "Rich message", text: undefined, editor_body: { html: bodyHtml } });
  assert.match(original.body.html, /text-align:center/);
  assert.match(original.body.html, /border-collapse:collapse/);
  assert.match(original.body.html, /border:1px solid rgb\(221, 221, 221\)/);
  assert.match(original.body.text, /안녕하세요 & welcome/);
  assert.doesNotMatch(original.body.html, /<script|onclick|position:|background-image|tracker\.test/);
  assert.equal(original.attachments.length, 1);
  assert.equal(original.attachments[0].content_id, logo.content_id);
  assert.equal(original.attachments[0].disposition, "inline");
  assert.match(original.body.html, new RegExp(`/messages/${original.id}/attachments/${original.attachments[0].id}`));
  const imagePreview = await mf.dispatchFetch("https://office.test/api/mail" + base + "/images/" + logo.id, { headers: { Authorization: "Bearer " + tokens.owner } });
  assert.equal(imagePreview.status, 200);
  assert.deepEqual(Buffer.from(await imagePreview.arrayBuffer()), png);
  const htmlOnly = await draft({ text: "", html: "<p>HTML fallback</p>", include_signature: false });
  assert.equal(htmlOnly.body.text, "HTML fallback");
  const unsigned = await draft({ text: "No signature", include_signature: false });
  assert.equal(unsigned.attachments.length, 0);
  assert.equal(unsigned.body.text, "No signature");
  const submission = (await call(base + "/drafts/" + original.id + "/submissions", { method: "POST", data: { version: original.draft.version, address_id: address.id, undo_window: 0 }, expected: 202 })).submission;
  await eventually(() => call(base + "/submissions/" + submission.id), (r) => r.submission.status === "accepted", "Rich mail was not accepted");
  const sent = await (await bucket.get((await bucket.list({ prefix: "test-sent/" })).objects[0].key)).json();
  assert.match(sent.html, /cid:/);
  assert.match(sent.html, /font-size:24px/);
  assert.equal(sent.attachments[0].contentId, logo.content_id);
  assert.equal(sent.attachments[0].disposition, "inline");
  const reply = (await call(base + "/messages/" + original.id + "/reply", { method: "POST", data: {}, expected: 201 })).message;
  assert.match(reply.body.quoted_body.html, /text-align:center/);
  assert.equal((reply.body.editor_body.text.match(/Alex Morgan/g) ?? []).length, 1);
  assert.doesNotMatch(reply.body.editor_body.html, /안녕하세요/);
  const edited = (await call(base + "/drafts/" + reply.id, { method: "PATCH", data: { version: reply.draft.version, editor_body: { html: "<p><em>Formatted reply</em></p>" }, include_quoted_body: false } })).message;
  assert.equal(edited.body.text, "Formatted reply");
  assert.doesNotMatch(edited.body.html, /안녕하세요/);
  assert.match(edited.body.quoted_body.html, /안녕하세요/);
  const included = (await call(base + "/drafts/" + reply.id, { method: "PATCH", data: { version: edited.draft.version, include_quoted_body: true } })).message;
  assert.match(included.body.html, /<em>Formatted reply<\/em>/);
  assert.match(included.body.html, /안녕하세요/);
  const excluded = (await call(base + "/drafts/" + reply.id, { method: "PATCH", data: { version: included.draft.version, include_quoted_body: false } })).message;
  const replySubmission = (await call(base + "/drafts/" + reply.id + "/submissions", { method: "POST", data: { version: excluded.draft.version, address_id: address.id, undo_window: 0 }, expected: 202 })).submission;
  await eventually(() => call(base + "/submissions/" + replySubmission.id), (r) => r.submission.status === "accepted", "Reply was not accepted");
  const deliveries = await Promise.all((await bucket.list({ prefix: "test-sent/" })).objects.map(async (object) => (await bucket.get(object.key)).json()));
  const sentReply = deliveries.find((delivery) => delivery.subject === "Re: Rich message");
  assert.equal(sentReply.attachments.length, 0);
  assert.doesNotMatch(sentReply.html, /안녕하세요/);
  const exported = (await call(base + "/exports", { method: "POST", expected: 202 })).job;
  await eventually(() => call(base + "/jobs/" + exported.id), (r) => r.job.status === "completed", "Rich export did not finish");
  const exportObjects = await bucket.list({ prefix: `data-jobs/${mailbox.id}/${exported.id}/` });
  const exportText = (await Promise.all(exportObjects.objects.filter((file) => file.key.endsWith(".mbox")).map(async (file) => (await bucket.get(file.key)).text()))).join("");
  assert.match(exportText, new RegExp(`Content-ID: <${logo.content_id}>`));
  assert.match(exportText, /Content-Disposition: inline/);
  const backup = (await call(base + "/backups", { method: "POST", expected: 202 })).job;
  await eventually(() => call(base + "/jobs/" + backup.id), (r) => r.job.status === "completed", "Rich backup did not finish");
  await bucket.delete(`images/${mailbox.id}/${logo.id}`);
  const restore = (await call(base + "/backups/" + backup.id + "/restore", { method: "POST", data: { target_mailbox_id: otherBox.id, restore_settings: true }, expected: 202 })).job;
  await eventually(() => call(`/mailboxes/${otherBox.id}/jobs/${restore.id}`), (r) => r.job.status === "completed", "Rich restore did not finish");
  const restoredSettings = (await call(`/mailboxes/${otherBox.id}/settings`)).settings;
  assert.equal(restoredSettings.signature_html, settings.signature_html);
  assert.ok(await bucket.head(`images/${otherBox.id}/${logo.id}`));
  const restoredDraft = (await call(`/mailboxes/${otherBox.id}/drafts`, { method: "POST", data: { text: "After restore" }, expected: 201 })).message;
  assert.equal(restoredDraft.attachments[0].content_id, logo.content_id);
  await call(`/mailboxes/${otherBox.id}/settings`, { method: "PATCH", data: { signature: "Legacy text" } });
  assert.equal((await call(`/mailboxes/${otherBox.id}/settings`)).settings.signature_html, "");
});

test("formatted mail and cached images remain authorized, private, and tied to exact message resources", async (t) => {
  const { remoteAssetCacheRequest, png } = await import('./mail-render-helpers.mjs');
  const { mf, tokens, raw, call, admin, base, mailbox, draft } = await fixture(t);
  const message = await draft({ subject: 'Newsletter rendering' });
  const bucket = await mf.getR2Bucket('MAIL_BUCKET');
  const object = (await bucket.list({ prefix: `bodies/${mailbox.id}/${message.id}/` })).objects[0];
  const body = await (await bucket.get(object.key)).json();
  // Received messages retain raw HTML in storage; legacy sanitized reads still stay strict.
  body.html = '<style>.newsletter{color:purple}</style><div class="newsletter" onclick="alert(1)"><img src="https://cdn.example.com/news.png" width="32" height="32"><script>alert(1)</script>Hello</div>';
  await bucket.put(object.key, JSON.stringify(body));
  const cache = (await mf.getCaches()).default;
  await cache.put(await remoteAssetCacheRequest('https://cdn.example.com/news.png', 'image'), new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } }));
  const renderPath = base + '/messages/' + message.id + '/render';
  const response = await raw('/api/mail' + renderPath, { token: tokens.owner });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const rendering = await response.json();
  assert.match(rendering.html, /\.newsletter\{color:purple\}/);
  assert.match(rendering.html, /class="newsletter"/);
  assert.doesNotMatch(rendering.html, /onclick|script|cdn\.example/);
  assert.deepEqual(rendering.assets, [{ source: '/api/mail' + renderPath + '/assets/0' }]);
  const image = await raw(rendering.assets[0].source, { token: tokens.owner });
  assert.equal(image.status, 200, await image.clone().text());
  assert.equal(image.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  for (const endpoint of [renderPath, renderPath + '/assets/0']) {
    await call(endpoint, { token: tokens.outsider, expected: 403 });
    await call(endpoint, { token: '', expected: 401 });
  }
  await call(base + '/members/reader', { method: 'PUT', data: { read: true } });
  for (const endpoint of [renderPath, renderPath + '/assets/0']) await call(endpoint, { token: tokens.reader, expected: 404 });
  for (const asset of ['99', '00', 'https%3A%2F%2Fevil.example.com']) await call(renderPath + '/assets/' + asset, { expected: 404 });
  const other = (await admin('/mailboxes', { method: 'POST', data: { name: 'Other mailbox', kind: 'shared', owner_user_id: 'owner' }, expected: 201 })).mailbox;
  await call('/mailboxes/' + other.id + '/messages/' + message.id + '/render', { expected: 404 });
  const legacy = (await call(base + '/messages/' + message.id)).message;
  assert.doesNotMatch(legacy.body.html, /<style|class="newsletter"|https:\/\/cdn\.example/);
  await call(base + '/drafts/' + message.id, { method: 'PATCH', data: { version: 1, text: 'Updated content', html: '<p>Changed</p>' } });
  assert.doesNotMatch((await call(renderPath)).html, /newsletter/);
  await call(renderPath + '/assets/0', { expected: 404 });
});

test("mail audit history requires a dedicated permission and mailbox management, with immediate revocation", async (t) => {
  const { db, tokens, raw, call, base, mailbox } = await fixture(t);
  const auditPath = base + "/audit-logs";
  assert.ok((await (await raw('/api/me/permissions', { token: tokens.administrator })).json()).permissions.includes('admin.mail.audit.read'));
  assert.ok(!(await (await raw('/api/me/permissions', { token: tokens.owner })).json()).permissions.includes('admin.mail.audit.read'));
  await call(auditPath, { expected: 403 }); // Personal ownership and Mail access are insufficient.
  await call(auditPath, { token: tokens.administrator, expected: 403 }); // Global permission never supplies mailbox access.
  await call(base + '/members/reader', { method: 'PUT', data: { read: true, manage: true } });
  await call(auditPath, { token: tokens.reader, expected: 403 });
  await db.prepare("INSERT INTO roles(id,key,label) VALUES('delegated-auditor','delegated-auditor','Delegated auditor')").run();
  await db.batch(permissionClosure(['admin.mail.audit.read']).map(permission => db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('delegated-auditor',?)").bind(permission)));
  await db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('reader','delegated-auditor')").run();
  const response = await raw('/api/mail' + auditPath, { token: tokens.reader });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.ok((await response.json()).events.some(event => event.actor_id === 'owner'));
  const { key } = await call('/api-keys', { method: 'POST', token: tokens.reader, data: { name: 'Auditor read key', expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: [{ mailbox_id: mailbox.id, action: 'read' }] }, expected: 201 });
  await call(auditPath, { token: key.token, expected: 403 });
  await call(base + '/members/reader', { method: 'PUT', data: { read: true, manage: false } });
  await call(auditPath, { token: tokens.reader, expected: 403 });
  await call(base + '/members/reader', { method: 'PUT', data: { read: true, manage: true } });
  await call(auditPath, { token: tokens.reader });
  await db.prepare("DELETE FROM role_permissions WHERE role_id='delegated-auditor' AND permission_key='console.access'").run();
  await call(auditPath, { token: tokens.reader, expected: 403 });
  await db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('delegated-auditor','console.access')").run();
  await call(auditPath, { token: tokens.reader });
  await db.prepare("DELETE FROM user_roles WHERE user_id='reader' AND role_id='delegated-auditor'").run();
  await call(auditPath, { token: tokens.reader, expected: 403 });
});

test("mail UI aggregates initial reads, applies bounded replay-safe commands and catches up private changes", async t => {
  const { call, base, draft, mf, tokens } = await fixture(t, "250000", true);
  const harness = await mf.getWorker("mail-harness");
  for (let index = 0; index < 3; index++) {
    const mime = ["From: sender@example.test", "To: owner@mail.test", "Subject: UI performance", `Message-ID: <ui-${index}@example.test>`, ...(index ? ["In-Reply-To: <ui-0@example.test>", "References: <ui-0@example.test>"] : []), "Content-Type: text/plain", "", "Mail " + index].join("\r\n");
    assert.equal((await (await harness.fetch("https://test/email", { method: "POST", body: mime })).json()).rejected, null);
    await eventually(() => call(base + "/messages?folder_id=inbox"), page => page.messages.length === index + 1, "Inbound UI message missing");
  }
  const bootstrap = await call("/ui/bootstrap?section=inbox");
  assert.equal(bootstrap.mailbox_id, base.split("/").at(-1));
  assert.equal(bootstrap.page.messages.length, 1);
  assert.equal(bootstrap.page.messages[0].message_count, 3);
  assert.equal(bootstrap.summary.folders.inbox.unread, 3);
  const row = bootstrap.page.messages[0];
  assert.equal(row.raw_r2_key, undefined); assert.equal(row.body_r2_key, undefined);
  assert.equal(row.search_text, undefined); assert.equal(row.provider_message_id, undefined);
  const view = await call(bootstrap.view_path.replace("/api/mail", ""));
  assert.deepEqual(view.messages, bootstrap.page.messages);
  const conversation = await call(base + "/ui/conversation/" + row.id);
  assert.equal(conversation.messages.length, 3); assert.ok(conversation.message.body.text);
  assert.equal((await call(base + "/summary")).summary.folders.inbox.unread, 3); // GET never marks read.
  await t.test("commands expand a conversation server-side with per-item versions and safe retry", async () => {
    const body = { targets: [{ id: row.id, version: row.version, thread: true }], changes: { is_read: true }, scope: "folder_id=inbox" }, headers = { "Idempotency-Key": "ui-command" };
    const result = await call(base + "/ui/commands", { method: "POST", data: body, headers });
    assert.equal(result.results.length, 3); assert.ok(result.results.every(item => item.success && item.message.version === item.before.version + 1));
    assert.equal(result.summary.folders.inbox.unread, 0);
    const replay = await call(base + "/ui/commands", { method: "POST", data: body, headers });
    assert.deepEqual(replay.results, result.results);
    await call(base + "/ui/commands", { method: "POST", data: { ...body, changes: { is_read: false } }, headers, expected: 409 });
    const delta = await call(base + "/ui/changes?since=" + bootstrap.cursor + "&scope=" + encodeURIComponent("folder_id=inbox&grouped=true"));
    assert.equal(delta.reset, false); assert.equal(delta.messages.length, 3); assert.equal(delta.view.length, 1);
    assert.equal(delta.view[0].unread_count, 0);
    const empty = await call(base + "/ui/changes?since=" + delta.cursor);
    assert.deepEqual(empty.messages, []); assert.equal(empty.summary, null);
    await call(base + "/ui/changes?since=-1", { expected: 400 });
  });
  await t.test("partial conflicts leave independent targets successful and report their conversation", async () => {
    const rows = (await call(base + "/messages?folder_id=inbox")).messages;
    const result = await call(base + "/ui/commands", { method: "POST", data: { targets: [{ id: rows[0].id, version: rows[0].version - 1 }, { id: rows[1].id, version: rows[1].version }], changes: { is_starred: true } } });
    assert.equal(result.results[0].success, false); assert.equal(result.results[0].thread_id, rows[0].thread_id);
    assert.equal(result.results[1].success, true);
    await call(base + "/ui/commands", { method: "POST", data: { targets: [{ id: rows[0].id, version: rows[0].version }], changes: { arbitrary: true } }, expected: 400 });
  });
  await t.test("private drafts, member revocation and user-only UI retain existing authorization", async () => {
    await call(base + "/members/reader", { method: "PUT", data: { read: true } });
    const watermark = (await call(base + "/ui/changes", { token: tokens.reader })).cursor;
    const message = await draft({ subject: "Private UI draft" });
    const delta = await call(base + "/ui/changes?since=" + watermark, { token: tokens.reader });
    assert.deepEqual(delta.messages, []); assert.equal(delta.summary, null);
    await call(base + "/ui/conversation/" + message.id, { token: tokens.reader, expected: 404 });
    await call(base + "/ui/compose-context?draft=" + message.id, { token: tokens.reader, expected: 404 });
    const context = await call(base + "/ui/compose-context?draft=" + message.id);
    assert.equal(context.message.id, message.id); assert.ok(context.settings); assert.ok(context.addresses);
    await call(base + "/ui/commands", { token: tokens.reader, method: "POST", data: { targets: [{ id: row.id, version: 1 }], changes: { is_read: true } }, expected: 403 });
    await call(base + "/members/reader", { method: "DELETE", expected: 204 });
    await call(base + "/ui/changes?since=" + watermark, { token: tokens.reader, expected: 403 });
    await call(base + "/ui/view?folder_id=inbox", { token: tokens.reader, expected: 403 });
    await call(base + "/ui/conversation/" + row.id, { token: tokens.outsider, expected: 403 });
  });
});
