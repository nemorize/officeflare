import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { exportJWK, generateKeyPair } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/auth/password.ts";
import { workerModules } from "./worker-modules.mjs";
import { notificationTarget } from "../web/lib/notification-center.ts";
import { returnToWorkspace } from "../web/lib/profile.ts";

const password = "a long password for notification center tests";
const timestamp = () => Math.floor(Date.now() / 1000);
const harness = await build({ entryPoints: ["tests/notifications-harness.ts"], bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022" });

async function fixture(t) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [
    { name: "officeflare", modules: workerModules, compatibilityDate: "2026-09-29", d1Databases: { DB: "notifications-test" },
      durableObjects: { NOTIFICATION_HUB: { className: "NotificationHubDO", useSQLite: true } },
      queueProducers: { NOTIFICATION_QUEUE: "notifications-test-queue" },
      queueConsumers: { "notifications-test-queue": { maxBatchSize: 100, maxBatchTimeout: 0, maxRetries: 0 } },
      bindings: { AUTH_SIGNING_KEYS: JSON.stringify({ active_kid: "test", keys: [{ ...await exportJWK(privateKey), kid: "test" }] }),
        MFA_ENCRYPTION_KEYS: JSON.stringify({ active_version: 1, keys: { 1: randomBytes(32).toString("base64url") } }),
        AUTH_ISSUER: "officeflare", AUTH_AUDIENCE: "officeflare-api", NOTIFICATION_QUEUE_NAME: "notifications-test-queue" } },
    { name: "notifications-harness", modules: [{ type: "ESModule", path: "notifications-harness.mjs", contents: harness.outputFiles[0].text }],
      compatibilityDate: "2026-09-29", d1Databases: { DB: "notifications-test" },
      queueProducers: { NOTIFICATION_QUEUE: "notifications-test-queue" },
      durableObjects: { NOTIFICATION_HUB: { className: "NotificationHubDO", scriptName: "officeflare", useSQLite: true } } },
  ] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    let statement = "", trigger = false;
    for (const line of (await readFile(`migrations/${file}`, "utf8")).split("\n")) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      statement += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) { await db.prepare(statement).run(); statement = ""; trigger = false; }
    }
    assert.equal(statement.trim(), "");
  }
  const hash = await hashPassword(password);
  for (const id of ["alice", "bob", "disabled"]) await db.prepare("INSERT INTO users (id, email_address, password_hash, disabled_at) VALUES (?, ?, ?, ?)").bind(id, `${id}@office.test`, hash, id === "disabled" ? timestamp() : null).run();
  let ip = 0;
  const raw = (path, { method = "GET", token, data, headers = {} } = {}) => mf.dispatchFetch(`https://office.test/api/notifications${path}`, {
    method, headers: { "cf-connecting-ip": `192.0.2.${++ip % 250}`, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const call = async (path, options = {}) => {
    const response = await raw(path, options); assert.equal(response.status, options.expected ?? 200, `${path}: ${await response.clone().text()}`);
    assert.equal(response.headers.get("cache-control"), "no-store"); return response.json();
  };
  const login = async (id) => {
    const response = await mf.dispatchFetch("https://office.test/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": `192.0.2.${++ip % 250}` }, body: JSON.stringify({ email_address: `${id}@office.test`, password }) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const publisher = await mf.getWorker("notifications-harness");
  const publish = async (key, recipients = ["alice"], extra = {}) => {
    const response = await publisher.fetch("https://internal/publish", { method: "POST", body: JSON.stringify({ source_key: key, recipient_ids: recipients, type: "system.announcement", title: key, body: "Workspace update", target_path: "/notifications", ...extra }) });
    assert.equal(response.status, extra.rollback ? 409 : 200, await response.clone().text());
  };
  const deliver = async (seq) => (await publisher.fetch("https://internal/deliver", { method: "POST", body: JSON.stringify({ seq }) })).json();
  const recover = async () => { const response = await publisher.fetch("https://internal/recover", { method: "POST", body: "{}" }); assert.equal(response.status, 200); };
  const tokens = { alice: await login("alice"), bob: await login("bob") };
  const connect = async (token, supplied) => {
    const ticket = supplied ?? (await call("/events/tickets", { token, method: "POST", data: {}, expected: 201 })).ticket;
    const response = await raw("/events/ws", { headers: { Upgrade: "websocket", Origin: "https://office.test", "Sec-WebSocket-Protocol": `officeflare.notifications, ticket.${ticket}` } });
    assert.equal(response.status, 101, response.status === 101 ? "" : await response.text());
    response.webSocket.accept(); t.after(() => response.webSocket.close()); return { socket: response.webSocket, ticket };
  };
  return { mf, db, raw, call, publish, deliver, recover, tokens, connect, login };
}
async function eventually(read, predicate) {
  for (let attempt = 0; attempt < 80; attempt++) { const value = await read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  assert.fail("Notification condition was not satisfied");
}

test("Notification center: ownership, atomic delivery, preferences and synchronization", async (t) => {
  const { db, raw, call, publish, recover, deliver, tokens, connect, login } = await fixture(t), token = tokens.alice.access_token;
  const list = (owner = token, query = "") => call(query, { token: owner });
  await t.test("sign-ins create private notifications without service or Console grants", async () => {
    await call("", { expected: 401 });
    const alice = await list(), bob = await list(tokens.bob.access_token);
    assert.equal(alice.notifications.length, 1); assert.equal(alice.notifications[0].type, "security.sign_in");
    assert.equal(alice.notifications[0].target_path, "/profile/sessions"); assert.notEqual(alice.notifications[0].id, bob.notifications[0].id);
    await call(`/${bob.notifications[0].id}`, { token, method: "PATCH", data: { version: 1, read: true }, expected: 404 });
    await call("", { token, method: "POST", data: {}, expected: 404 });
    await call("?state=invalid", { token, expected: 400 }); await call("?limit=101", { token, expected: 400 }); await call("?type=mail.new", { token, expected: 400 });
  });
  await t.test("transaction conditions and rollbacks include events, recipients, changes and outbox", async () => {
    await publish("lost-operation", ["alice"], { condition: false }); await publish("rolled-back", ["alice"], { rollback: true });
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM notification_events WHERE source_key IN ('lost-operation', 'rolled-back')").first()).count, 0);
    await Promise.all([publish("deduplicated", ["alice", "bob", "alice", "disabled"]), publish("deduplicated", ["alice", "bob", "disabled"])]);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM notification_events WHERE source_key = 'deduplicated'").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM notification_inbox i JOIN notification_events e ON e.id = i.event_id WHERE e.source_key = 'deduplicated'").first()).count, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM notification_changes c WHERE c.kind = 'created' AND c.notification_id IN (SELECT i.id FROM notification_inbox i JOIN notification_events e ON e.id = i.event_id WHERE e.source_key = 'deduplicated')").first()).count, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM notification_outbox o JOIN notification_changes c ON c.seq = o.seq WHERE c.kind = 'created'").first()).count, 4);
  });
  await t.test("read-all cutoff preserves concurrent arrivals; cursors cannot cross owners or filters", async () => {
    const summary = await call("/summary", { token }); await publish("arrived-later");
    const readAll = await call("/read-all", { token, method: "POST", data: { cursor: summary.read_all_cursor } }); assert.equal(readAll.updated, 2);
    const unread = await list(token, "?state=unread"); assert.deepEqual(unread.notifications.map((item) => item.title), ["arrived-later"]);
    await call("/read-all", { token: tokens.bob.access_token, method: "POST", data: { cursor: summary.read_all_cursor }, expected: 400 });
    await call("/read-all", { token, method: "POST", data: { cursor: summary.read_all_cursor + "tampered" }, expected: 400 });
    const first = await list(token, "?limit=1"); assert.ok(first.next_cursor);
    const next = await list(token, `?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`); assert.notEqual(next.notifications[0].id, first.notifications[0].id);
    await call(`?limit=1&state=unread&cursor=${encodeURIComponent(first.next_cursor)}`, { token, expected: 400 });
    await call(`?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`, { token: tokens.bob.access_token, expected: 400 });
  });
  await t.test("versioned mutations, archive, snooze expiry and deletion tombstones", async () => {
    const item = (await list(token, "?state=unread")).notifications[0];
    const changed = await call(`/${item.id}`, { token, method: "PATCH", data: { version: item.version, archived: true } });
    await call(`/${item.id}`, { token, method: "PATCH", data: { version: item.version, read: true }, expected: 412 });
    assert.ok(!(await list()).notifications.some((row) => row.id === item.id)); assert.equal((await list(token, "?state=archived")).notifications[0].id, item.id);
    await call(`/${item.id}`, { token, method: "PATCH", data: { version: changed.version, snoozed_until: timestamp() + 3600, archived: false } });
    assert.equal((await list(token, "?state=snoozed")).notifications[0].id, item.id);
    assert.ok((await call("/summary", { token })).next_snoozed_until > timestamp());
    await db.prepare("UPDATE notification_inbox SET snoozed_until = ? WHERE id = ?").bind(timestamp() - 1, item.id).run(); await recover();
    const restored = (await list(token, "?state=unread")).notifications[0]; assert.equal(restored.id, item.id); assert.equal(restored.snoozed_until, null);
    assert.equal((await call("/summary", { token })).next_snoozed_until, null);
    const before = await call("/summary", { token });
    await call(`/${item.id}`, { token, method: "PATCH", data: { version: restored.version, deleted: true } });
    await call(`/${item.id}`, { token, method: "PATCH", data: { version: restored.version + 1, read: true }, expected: 404 });
    const changes = await call(`/changes?cursor=${encodeURIComponent(before.change_cursor)}`, { token });
    assert.ok(changes.changes.some((change) => change.notification_id === item.id && change.kind === "deleted"));
  });
  await t.test("preference precedence, mandatory security and immutable suppression on retry", async () => {
    let settings = await call("/preferences", { token }); assert.equal(settings.version, 0);
    settings = await call("/preferences", { token, method: "PUT", data: { enabled: false, rules: {}, version: settings.version } });
    await call("/preferences", { token, method: "PUT", data: { enabled: true, rules: {}, version: 0 }, expected: 412 });
    await call("/preferences", { token, method: "PUT", data: { ...settings, rules: { "type:security.sign_in": false } }, expected: 400 });
    await call("/preferences", { token, method: "PUT", data: { ...settings, rules: { "type:mail.new": true } }, expected: 400 });
    await publish("muted"); assert.ok(!(await list(token, "?state=all")).notifications.some((item) => item.title === "muted"));
    settings = await call("/preferences", { token, method: "PUT", data: { ...settings, rules: { "service:system": false, "category:system:updates": false, "type:system.announcement": true } } });
    await publish("muted"); await publish("explicitly-enabled");
    const items = (await list(token, "?service=system&state=all")).notifications; assert.ok(items.some((item) => item.title === "explicitly-enabled")); assert.ok(!items.some((item) => item.title === "muted"));
    await login("alice"); assert.ok((await list(token, "?state=unread&type=security.sign_in")).notifications.length > 0);
  });
  await t.test("WebSocket ticket replay, origin checks, multiple devices and session revocation", async () => {
    await recover();
    await eventually(async () => db.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE delivered_at IS NULL").first(), (row) => row.count === 0);
    const a = await connect(token), second = await connect(token), bob = await connect(tokens.bob.access_token);
    const events = [], secondEvents = [], bobEvents = [];
    a.socket.addEventListener("message", (event) => events.push(event.data)); second.socket.addEventListener("message", (event) => secondEvents.push(event.data)); bob.socket.addEventListener("message", (event) => bobEvents.push(event.data));
    const replay = await raw("/events/ws", { headers: { Upgrade: "websocket", Origin: "https://office.test", "Sec-WebSocket-Protocol": `officeflare.notifications, ticket.${a.ticket}` } }); assert.equal(replay.status, 401);
    const ticket = (await call("/events/tickets", { token, method: "POST", data: {}, expected: 201 })).ticket;
    const foreign = await raw("/events/ws", { headers: { Upgrade: "websocket", Origin: "https://attacker.test", "Sec-WebSocket-Protocol": `officeflare.notifications, ticket.${ticket}` } }); assert.equal(foreign.status, 403);
    await db.prepare("UPDATE notification_ws_tickets SET expires_at = ? WHERE session_id = ?").bind(timestamp() - 1, tokens.alice.session_id).run();
    const expired = await raw("/events/ws", { headers: { Upgrade: "websocket", Origin: "https://office.test", "Sec-WebSocket-Protocol": `officeflare.notifications, ticket.${ticket}` } }); assert.equal(expired.status, 401);
    await publish("realtime-update"); await recover();
    await eventually(async () => events, (items) => items.length > 0); await eventually(async () => secondEvents, (items) => items.length > 0);
    assert.ok(events.every((item) => item === '{"kind":"notifications.changed"}')); assert.equal(bobEvents.length, 0);
    const pending = await db.prepare("SELECT o.seq FROM notification_outbox o JOIN notification_changes c ON c.seq = o.seq WHERE c.user_id = 'alice' ORDER BY o.seq DESC LIMIT 1").first();
    await eventually(async () => db.prepare("SELECT delivered_at FROM notification_outbox WHERE seq = ?").bind(pending.seq).first(), (row) => row.delivered_at !== null);
    const count = events.length; assert.equal((await deliver(pending.seq)).action, "ack"); assert.equal(events.length, count);
    let closed; a.socket.addEventListener("close", (event) => { closed = event.code; });
    await db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ?").bind(timestamp(), tokens.alice.session_id).run(); a.socket.send("ping");
    await eventually(async () => closed, (code) => code === 4001); await call("/summary", { token, expected: 401 });
  });
});

test("Notification navigation stays on registered workspace routes", () => {
  for (const path of ["/notifications", "/profile/notifications"]) assert.equal(returnToWorkspace(path), path);
  assert.equal(notificationTarget("/profile/sessions"), "/profile/sessions");
  for (const path of ["https://attacker.test", "//attacker.test", "/profile/sessions?redirect=//attacker.test", null]) assert.equal(notificationTarget(path), null);
});
