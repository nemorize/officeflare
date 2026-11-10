import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/auth/password.ts";
import { workerModules } from "./worker-modules.mjs";

const harness = await build({
  entryPoints: ["tests/notifications-harness.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  target: "es2022",
});
async function fixture(t, configured = true) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const rsa = await generateKeyPair("RS256", { extractable: true });
  const privatePem = await exportPKCS8(rsa.privateKey);
  const fcm = configured
    ? {
        FCM_SERVICE_ACCOUNT: JSON.stringify({
          project_id: "push-test",
          client_email: "push@push-test.iam.gserviceaccount.com",
          private_key: privatePem,
        }),
        FCM_WEB_CONFIG: JSON.stringify({
          projectId: "push-test",
          apiKey: "public-key",
          appId: "test-app",
          messagingSenderId: "123",
          private_key: "must-not-leak",
        }),
        FCM_VAPID_KEY: "B" + "A".repeat(86),
      }
    : {};
  const sent = [],
    oauth = [],
    failures = new Map();
  const outboundService = async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "oauth2.googleapis.com") {
      const form = new URLSearchParams(await request.text());
      const { payload } = await jwtVerify(form.get("assertion"), rsa.publicKey, {
        audience: "https://oauth2.googleapis.com/token",
        issuer: "push@push-test.iam.gserviceaccount.com",
      });
      assert.equal(payload.scope, "https://www.googleapis.com/auth/firebase.messaging");
      oauth.push(payload);
      return Response.json({ access_token: "test-access", expires_in: 3600 });
    }
    if (url.hostname === "fcm.googleapis.com") {
      assert.equal(request.headers.get("authorization"), "Bearer test-access");
      assert.equal(url.pathname, "/v1/projects/push-test/messages:send");
      const { message } = await request.json();
      sent.push(message);
      const code = failures.get(message.token);
      if (code)
        return Response.json(
          {
            error: {
              details: [
                { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code },
              ],
            },
          },
          { status: code === "UNREGISTERED" ? 404 : 503 },
        );
      return Response.json({ name: "projects/push-test/messages/test" });
    }
    throw new Error(`Unexpected external fetch: ${url.hostname}`);
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: "officeflare",
          modules: workerModules,
          compatibilityDate: "2026-09-29",
          d1Databases: { DB: "push-test" },
          durableObjects: { NOTIFICATION_HUB: { className: "NotificationHubDO", useSQLite: true } },
          outboundService,
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
            ...fcm,
          },
        },
        {
          name: "push-harness",
          modules: [
            { type: "ESModule", path: "push-harness.mjs", contents: harness.outputFiles[0].text },
          ],
          compatibilityDate: "2026-09-29",
          d1Databases: { DB: "push-test" },
          outboundService,
          bindings: fcm,
          durableObjects: {
            NOTIFICATION_HUB: {
              className: "NotificationHubDO",
              scriptName: "officeflare",
              useSQLite: true,
            },
          },
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    let statement = "",
      trigger = false;
    for (const line of (await readFile(`migrations/${file}`, "utf8")).split("\n")) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      statement += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
        await db.prepare(statement).run();
        statement = "";
        trigger = false;
      }
    }
    assert.equal(statement.trim(), "", file);
  }
  const password = "a long password for push notification tests";
  const hash = await hashPassword(password);
  for (const id of ["alice", "bob"])
    await db
      .prepare("INSERT INTO users (id, email_address, password_hash) VALUES (?, ?, ?)")
      .bind(id, `${id}@office.test`, hash)
      .run();
  await db
    .prepare("INSERT INTO user_roles (user_id, role_id) VALUES ('alice', 'system-administrator')")
    .run();
  let ip = 0;
  const call = async (path, { method = "GET", tokens, data, expected = 200 } = {}) => {
    const response = await mf.dispatchFetch(`https://office.test/api${path}`, {
      method,
      headers: {
        "cf-connecting-ip": `192.0.2.${++ip % 250}`,
        ...(tokens ? { Authorization: `Bearer ${tokens.access_token}` } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(response.status, expected, `${path}: ${await response.clone().text()}`);
    return response.status === 204 ? null : response.json();
  };
  const login = (id) =>
    call("/auth/login", { method: "POST", data: { email_address: `${id}@office.test`, password } });
  const alice = await login("alice"),
    bob = await login("bob");
  const publisher = await mf.getWorker("push-harness");
  const publish = async (key, extra = {}) => {
    const response = await publisher.fetch("https://internal/publish", {
      method: "POST",
      body: JSON.stringify({
        source_key: key,
        type: "system.announcement",
        title: "Push title",
        body: "Push body",
        target_path: "/notifications",
        recipient_ids: ["alice"],
        ...extra,
      }),
    });
    assert.equal(response.status, 200, await response.text());
    return (
      await db
        .prepare(
          "SELECT c.seq FROM notification_changes c JOIN notification_inbox i ON i.id = c.notification_id JOIN notification_events e ON e.id = i.event_id WHERE e.source_key = ? AND c.kind = 'created'",
        )
        .bind(key)
        .first()
    )?.seq;
  };
  const deliver = async (seq) =>
    (
      await publisher.fetch("https://internal/deliver", {
        method: "POST",
        body: JSON.stringify({ seq }),
      })
    ).json();
  const register = (
    token,
    device = "device_1234567890",
    tokens = alice,
    expected = 200,
    token_type = "fcm_web",
  ) =>
    call("/push/tokens", {
      method: "PUT",
      tokens,
      expected,
      data: { token, device_id: device, token_type, session_id: tokens.session_id },
    });
  const enable = async () => {
    const settings = await call("/push/settings", { tokens: alice });
    return call("/push/settings", {
      method: "PUT",
      tokens: alice,
      data: { web_push_enabled: true, version: settings.version },
    });
  };
  return {
    db,
    call,
    alice,
    bob,
    login,
    register,
    enable,
    publish,
    deliver,
    sent,
    oauth,
    failures,
    privatePem,
  };
}

test("web push remains optional and requires administrator permission and configuration", async (t) => {
  const f = await fixture(t, false);
  await f.call("/push/config", { expected: 401 });
  assert.deepEqual(await f.call("/push/config", { tokens: f.bob }), { available: false });
  const settings = await f.call("/push/settings", { tokens: f.alice });
  assert.equal(settings.configured, false);
  assert.equal(settings.web_push_enabled, false);
  await f.call("/push/settings", { tokens: f.bob, expected: 403 });
  await f.call("/push/settings", {
    method: "PUT",
    tokens: f.alice,
    data: { web_push_enabled: true, version: settings.version },
    expected: 409,
  });
  await f.register("a-token", undefined, f.alice, 409);
});

test("web push registration rotates tokens, enforces types and ownership, and removes logged-out devices", async (t) => {
  const f = await fixture(t);
  await f.register("a-token", undefined, f.alice, 409);
  const enabled = await f.enable();
  const config = await f.call("/push/config", { tokens: f.bob });
  assert.equal(config.available, true);
  assert.deepEqual(Object.keys(config.firebase).sort(), [
    "apiKey",
    "appId",
    "messagingSenderId",
    "projectId",
  ]);
  assert.ok(!JSON.stringify(config).includes(f.privatePem));
  await f.call("/push/settings", {
    method: "PUT",
    tokens: f.bob,
    data: { web_push_enabled: false, version: enabled.version },
    expected: 403,
  });
  await f.call("/push/settings", {
    method: "PUT",
    tokens: f.alice,
    data: { web_push_enabled: true, version: 1 },
    expected: 412,
  });
  await f.register("a-token");
  await f.register("a-token");
  await f.register("native-token", "another_device_123", f.alice, 400, "fcm_ios");
  await f.call("/push/tokens", {
    method: "PUT",
    tokens: f.alice,
    data: {
      token: "bad-session",
      token_type: "fcm_web",
      device_id: "device_1234567890",
      session_id: f.bob.session_id,
    },
    expected: 401,
  });
  await f.register("rotated-token");
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM push_tokens").first()).n, 1);
  assert.equal(
    (await f.db.prepare("SELECT token_type FROM push_tokens").first()).token_type,
    "fcm_web",
  );
  await f.call("/push/tokens", {
    method: "DELETE",
    tokens: f.bob,
    data: { device_id: "device_1234567890" },
    expected: 204,
  });
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM push_tokens").first()).n, 1);
  await f.register("rotated-token", "device_bob_1234567", f.bob);
  assert.equal((await f.db.prepare("SELECT user_id FROM push_tokens").first()).user_id, "bob");
  await f.call("/auth/logout", { method: "POST", tokens: f.bob, expected: 204 });
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM push_tokens").first()).n, 0);
});

test("FCM delivery retries only failed devices, drops unregistered tokens, and ignores updates and opt-outs", async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.register("good-token");
  await f.register("retry-token", "retry_device_12345");
  await f.register("gone-token", "gone_device_123456");
  f.failures.set("retry-token", "UNAVAILABLE");
  f.failures.set("gone-token", "UNREGISTERED");
  const seq = await f.publish("delivery");
  assert.equal((await f.deliver(seq)).action, "retry");
  assert.equal(f.sent.length, 3);
  assert.equal(f.oauth.length, 1);
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM push_tokens WHERE token='gone-token'").first()).n,
    0,
  );
  f.failures.delete("retry-token");
  assert.equal((await f.deliver(seq)).action, "ack");
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent[3].token, "retry-token");
  assert.equal((await f.deliver(seq)).action, "ack");
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent[0].data.title, "Push title");
  assert.equal(f.sent[0].data.session_id, f.alice.session_id);
  assert.equal(f.sent[0].notification, undefined);
  await f.db
    .prepare(
      "UPDATE notification_inbox SET read_at = unixepoch() WHERE id = (SELECT notification_id FROM notification_changes WHERE seq = ?)",
    )
    .bind(seq)
    .run();
  const update = await f.db.prepare("SELECT MAX(seq) seq FROM notification_changes").first();
  await f.deliver(update.seq);
  assert.equal(f.sent.length, 4);
  const ignored = await f.publish("admin-disabled");
  const settings = await f.call("/push/settings", { tokens: f.alice });
  await f.call("/push/settings", {
    method: "PUT",
    tokens: f.alice,
    data: { web_push_enabled: false, version: settings.version },
  });
  await f.deliver(ignored);
  assert.equal(f.sent.length, 4);
  await f.enable();
  await f.call("/push/tokens", {
    method: "DELETE",
    tokens: f.alice,
    data: { device_id: "device_1234567890" },
    expected: 204,
  });
  await f.db
    .prepare(
      "UPDATE user_sessions SET created_at=unixepoch()-120, expires_at=unixepoch()-1 WHERE id=?",
    )
    .bind(f.alice.session_id)
    .run();
  const expired = await f.publish("expired-session");
  await f.deliver(expired);
  assert.equal(f.sent.length, 4);
});

test("suppressed notifications and revoked mailbox access never produce a push", async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.register("mail-token");
  await f.call("/notifications/preferences", {
    method: "PUT",
    tokens: f.alice,
    data: { enabled: false, rules: {}, version: 0 },
  });
  assert.equal(await f.publish("suppressed"), undefined);
  const seq = await f.publish("mail:missing-mailbox:ingest", {
    type: "mail.received",
    target_path: "/mail",
  });
  assert.equal(seq, undefined);
  await f.call("/notifications/preferences", {
    method: "PUT",
    tokens: f.alice,
    data: { enabled: true, rules: {}, version: 1 },
  });
  const inaccessible = await f.publish("mail:missing-mailbox:ingest2", {
    type: "mail.received",
    target_path: "/mail",
  });
  await f.deliver(inaccessible);
  assert.equal(f.sent.length, 0);
});

test("queued pushes respect current preferences and concurrent delivery keeps Unicode payloads bounded", async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.register("unicode-token");
  const pending = await f.publish("before-opt-out");
  await f.call("/notifications/preferences", {
    method: "PUT",
    tokens: f.alice,
    data: { enabled: false, rules: {}, version: 0 },
  });
  await f.deliver(pending);
  assert.equal(f.sent.length, 0);
  await f.call("/notifications/preferences", {
    method: "PUT",
    tokens: f.alice,
    data: { enabled: true, rules: {}, version: 1 },
  });
  const large = await f.publish("unicode", { body: "한".repeat(1000) });
  await Promise.all([f.deliver(large), f.deliver(large)]);
  await f.deliver(large);
  assert.equal(f.sent.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(f.sent[0])) < 4096);
  assert.match(f.sent[0].data.body, /^한+$/);
  assert.ok(f.sent[0].data.body.length < 1000);
});
