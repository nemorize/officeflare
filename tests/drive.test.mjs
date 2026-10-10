import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/auth/password.ts";
import { workerModules } from "./worker-modules.mjs";

const PASSWORD = "a long password for drive integration tests";
const timestamp = () => Math.floor(Date.now() / 1000), partBytes = 8 * 1024 * 1024;
const harness = await build({ entryPoints: ["tests/drive-harness.ts"], bundle: true, write: false, format: "esm", platform: "browser",
  external: ["cloudflare:workers", "../dist/index.js"], target: "es2022" });

async function fixture(t) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const bindings = { AUTH_SIGNING_KEYS: JSON.stringify({ active_kid: "test", keys: [{ ...await exportJWK(privateKey), kid: "test" }] }),
    MFA_ENCRYPTION_KEYS: JSON.stringify({ active_version: 1, keys: { 1: randomBytes(32).toString("base64url") } }),
    AUTH_ISSUER: "officeflare", AUTH_AUDIENCE: "officeflare-api", DRIVE_QUOTA_BYTES: "10737418240" };
  const common = { compatibilityDate: "2026-09-29", d1Databases: { DB: "drive-tests" }, r2Buckets: { DRIVE_BUCKET: "drive-tests" }, bindings };
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "officeflare", modules: workerModules },
    { ...common, name: "drive-harness", modules: [{ type: "ESModule", path: "tests/drive-harness.mjs", contents: harness.outputFiles[0].text }, ...workerModules] },
  ] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB"), bucket = await mf.getR2Bucket("DRIVE_BUCKET"), faults = await mf.getWorker("drive-harness");
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
  const hash = await hashPassword(PASSWORD);
  await db.prepare("INSERT INTO roles(id,key,label) VALUES('drive-test','drive-test','Drive test')").run();
  await db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('drive-test','drive.access')").run();
  for (const id of ["owner", "editor", "viewer", "commenter", "outsider", "no-drive", "admin"]) {
    await db.prepare("INSERT INTO users(id,email_address,password_hash) VALUES(?,?,?)").bind(id, `${id}@office.test`, hash).run();
    if (id !== "no-drive") await db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)").bind(id, id === "admin" ? "system-administrator" : "drive-test").run();
  }
  let ip = 0;
  const raw = (path, { method = "GET", actor = "owner", data, bytes, headers = {}, fault = false } = {}) => {
    const options = { method, headers: { "cf-connecting-ip": `192.0.2.${++ip % 250}`,
      ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: bytes ?? (data === undefined ? undefined : JSON.stringify(data)) };
    const url = `https://office.test${path.startsWith("/api/") ? path : `/api/drive${path}`}`;
    return fault ? faults.fetch(url, options) : mf.dispatchFetch(url, options);
  };
  const call = async (path, options = {}) => {
    const response = await raw(path, options);
    assert.equal(response.status, options.expected ?? 200, `${options.method ?? "GET"} ${path}: ${await response.clone().text()}`);
    return response.status === 204 ? null : response.json();
  };
  const tokens = {};
  for (const id of ["owner", "editor", "viewer", "commenter", "outsider", "no-drive", "admin"]) {
    const response = await mf.dispatchFetch("https://office.test/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": `192.0.2.${++ip}` },
      body: JSON.stringify({ email_address: `${id}@office.test`, password: PASSWORD }) });
    assert.equal(response.status, 200, await response.clone().text()); tokens[id] = (await response.json()).access_token;
  }
  const item = async (id, actor = "owner", query = "") => (await call(`/items/${id}${query}`, { actor })).item;
  const folder = async (name, parent_id = null, actor = "owner") => (await call("/folders", { actor, method: "POST", data: { name, parent_id }, expected: 201 })).item;
  const start = async (data, actor = "owner") => (await call("/uploads", { actor, method: "POST", data, expected: 201 })).upload;
  const complete = async (upload, actor = "owner", options = {}) => call(`/uploads/${upload.id}/complete`, { actor, method: "POST", data: {}, ...options });
  const upload = async (name, content = "hello drive", parent_id = null, actor = "owner", extra = {}) => {
    const bytes = Buffer.from(content), session = await start({ name, parent_id, size: bytes.length, content_type: "text/plain", ...extra }, actor);
    await call(`/uploads/${session.id}/content`, { actor, method: "PUT", bytes });
    return (await complete(session, actor)).item;
  };
  const share = async (id, user, role, extra = {}) => call(`/items/${id}/permissions/${user}`, { method: "PUT", data: { version: (await item(id)).version, role, ...extra } });
  const edit = async (id, changes, actor = "owner") => (await call(`/items/${id}`, { actor, method: "PATCH", data: { version: (await item(id, actor, changes.trashed === false ? "?include_trashed=true" : "")).version, ...changes } })).item;
  const link = async (id, extra = {}) => (await call(`/items/${id}/links`, { method: "POST", data: { version: (await item(id)).version, ...extra }, expected: 201 })).link;
  const recover = async () => { const response = await faults.fetch("https://internal/recover"); assert.equal(response.status, 200, await response.clone().text()); };
  const changes = async actor => { const result = []; let cursor; do { const page = await call(`/changes?limit=100${cursor ? `&cursor=${cursor}` : ""}`, { actor }); result.push(...page.changes); cursor = page.has_more ? page.cursor : null; } while (cursor); return result; };
  return { mf, db, bucket, raw, call, item, folder, start, complete, upload, share, edit, link, recover, changes, tokens };
}

test("Drive backend: file lifecycle, inherited sharing, public links and recovery", async t => {
  const f = await fixture(t), { db, bucket, raw, call, item, folder, start, complete, upload, share, edit, link, recover } = f;
  let root, file;
  await t.test("Drive permission and ownership protect every private endpoint", async () => {
    await call("/quota", { actor: null, expected: 401 });
    await call("/quota", { actor: "no-drive", expected: 403 });
    assert.equal((await call("/capabilities")).part_bytes, partBytes);
    root = await folder("Shared folder"); file = await upload("hello.txt", "hello drive", root.id);
    await call(`/items/${file.id}`, { actor: "outsider", expected: 404 });
    await call(`/items/${file.id}`, { actor: "admin", expected: 404 });
    assert.equal((await item(file.id)).current_version.size, 11);
    assert.equal((await call("/quota")).reserved_bytes, 0);
    assert.equal((await call("/quota")).used_bytes, 11);
    assert.equal((await call(`/items?parent_id=${root.id}`)).items.length, 1);
  });
  await t.test("folder permissions inherit, editors write and viewers only read", async () => {
    await share(root.id, "viewer", "viewer"); await share(root.id, "editor", "editor"); await share(root.id, "commenter", "commenter");
    assert.equal((await item(file.id, "viewer")).effective_role, "viewer");
    assert.equal((await item(file.id, "editor")).effective_role, "editor");
    await call(`/items/${file.id}`, { actor: "viewer", method: "PATCH", data: { version: 1, name: "bad" }, expected: 404 });
    await call(`/items/${file.id}/permissions/outsider`, { actor: "editor", method: "PUT", data: { version: 1, role: "viewer" }, expected: 404 });
    await edit(file.id, { name: "renamed.txt" }, "editor");
    const created = await upload("by-editor.txt", "editor", root.id, "editor"); assert.equal(created.owner_user_id, "owner");
    await call(`/items/${created.id}`, { actor: "editor", method: "PATCH", data: { version: created.version, trashed: true }, expected: 404 });
    assert.equal((await call("/items?view=shared", { actor: "viewer" })).items.length, 3);
    const notifications = await call("/api/notifications?service=drive", { actor: "viewer" });
    assert.ok(notifications.notifications.some(entry => entry.type === "drive.shared"));
  });
  await t.test("downloads, HEAD, byte ranges, ETags and safe previews", async () => {
    const response = await raw(`/items/${file.id}/content`, { actor: "viewer" }); assert.equal(response.status, 200); assert.equal(await response.text(), "hello drive");
    assert.match(response.headers.get("content-disposition"), /^attachment/); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const partial = await raw(`/items/${file.id}/content`, { headers: { Range: "bytes=6-10" } }); assert.equal(partial.status, 206); assert.equal(await partial.text(), "drive");
    const suffix = await raw(`/items/${file.id}/content`, { headers: { Range: "bytes=-5" } }); assert.equal(await suffix.text(), "drive");
    const bad = await raw(`/items/${file.id}/content`, { headers: { Range: "bytes=999-" } }); assert.equal(bad.status, 416); assert.equal(bad.headers.get("content-range"), "bytes */11");
    const unchanged = await raw(`/items/${file.id}/content`, { headers: { "If-None-Match": response.headers.get("etag") } }); assert.equal(unchanged.status, 304);
    const head = await raw(`/items/${file.id}/content`, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
    const preview = await raw(`/items/${file.id}/preview`); assert.equal(preview.status, 200); assert.match(preview.headers.get("content-disposition"), /^inline/);
    const html = await upload("unsafe.html", "<script>alert(1)</script>", null, "owner", { content_type: "text/html" });
    await call(`/items/${html.id}/preview`, { expected: 400 });
  });
  await t.test("search, stars, recents and signed pagination", async () => {
    await call(`/items/${file.id}/star`, { method: "PUT", data: { starred: true } });
    assert.ok((await call("/items?view=starred")).items.some(entry => entry.id === file.id));
    assert.ok((await call("/items?view=recent")).items.some(entry => entry.id === file.id));
    assert.equal((await call("/items?q=renamed&kind=file&content_type=text/plain")).items[0].id, file.id);
    const first = await call("/items?view=all&limit=1"); assert.ok(first.next_cursor);
    const second = await call(`/items?view=all&limit=1&cursor=${first.next_cursor}`); assert.notEqual(second.items[0].id, first.items[0].id);
    await call(`/items?view=all&cursor=${first.next_cursor}x`, { expected: 400 });
    await call(`/items?view=all&cursor=${first.next_cursor}`, { actor: "viewer", expected: 400 });
    await call(`/items?view=shared&cursor=${first.next_cursor}`, { expected: 400 });
  });
  await t.test("versions retain bytes and stale updates leave no audit or quota change", async () => {
    const previous = await item(file.id), bytes = Buffer.from("new contents"), session = await start({ item_id: file.id, version: previous.version, size: bytes.length, content_type: "text/plain" });
    await call(`/uploads/${session.id}/content`, { method: "PUT", bytes }); await complete(session); await complete(session);
    assert.equal(await (await raw(`/items/${file.id}/content`)).text(), "new contents");
    const history = await call(`/items/${file.id}/versions`); assert.equal(history.versions.length, 2); assert.ok(history.versions.every(entry => !Object.hasOwn(entry, "blob_key")));
    assert.equal(await (await raw(`/items/${file.id}/content?version_id=${previous.current_version.id}`)).text(), "hello drive");
    const audit = await db.prepare("SELECT COUNT(*) count FROM drive_activity").first();
    await call(`/items/${file.id}`, { method: "PATCH", data: { version: previous.version, name: "stale.txt" }, expected: 412 });
    assert.deepEqual(await db.prepare("SELECT COUNT(*) count FROM drive_activity").first(), audit);
    await call(`/items/${file.id}/versions/${previous.current_version.id}/restore`, { method: "POST", data: { version: (await item(file.id)).version } });
    assert.equal(await (await raw(`/items/${file.id}/content`)).text(), "hello drive");
    await call(`/items/${file.id}/versions/${(await item(file.id)).current_version.id}?version=${(await item(file.id)).version}`, { method: "DELETE", expected: 409 });
    await call(`/items/${file.id}/versions/${previous.current_version.id}?version=${(await item(file.id)).version}`, { method: "DELETE", expected: 204 });
    await recover(); assert.equal(await (await raw(`/items/${file.id}/content`)).text(), "hello drive");
  });
  await t.test("upload reservations, exact sizes, checksums and cancellation", async () => {
    const before = await call("/quota"), hash = createHash("sha256").update("payload").digest("hex");
    const session = await start({ name: "verified.txt", size: 7, sha256: hash, content_type: "text/plain" });
    assert.equal((await call("/quota")).reserved_bytes, 7);
    await call(`/uploads/${session.id}`, { actor: "viewer", expected: 404 });
    await complete(session, "owner", { expected: 412 });
    await call(`/uploads/${session.id}/content`, { method: "PUT", bytes: Buffer.from("x"), expected: 400 });
    await call(`/uploads/${session.id}/content`, { method: "PUT", bytes: Buffer.from("invalid"), expected: 400 });
    await call(`/uploads/${session.id}/content`, { method: "PUT", bytes: Buffer.from("payload") });
    const info = await call(`/uploads/${session.id}`); assert.equal(info.upload.status, "ready");
    assert.equal(Object.hasOwn(info.upload, "blob_key"), false); assert.equal(Object.hasOwn(info.upload, "multipart_id"), false);
    await call(`/uploads/${session.id}`, { method: "DELETE", expected: 204 });
    await call(`/uploads/${session.id}`, { expected: 410 }); await recover();
    assert.equal((await call("/quota")).reserved_bytes, 0); assert.equal((await call("/quota")).used_bytes, before.used_bytes);
    assert.equal(await bucket.head((await db.prepare("SELECT blob_key FROM drive_uploads WHERE id=?").bind(session.id).first()).blob_key), null);
    await call("/uploads", { method: "POST", data: { name: "x", size: -1 }, expected: 400 });
    await call("/uploads", { method: "POST", data: { name: "x", size: 6 * 1024 ** 3 }, expected: 400 });
    await call("/folders", { method: "POST", data: { name: "../bad" }, expected: 400 });
    await call("/folders", { method: "POST", data: { name: "x", owner_user_id: "outsider" }, expected: 400 });
  });
  await t.test("multipart uploads resume, replace parts and complete once", async () => {
    const bytes = Buffer.alloc(partBytes, 65), tail = Buffer.from("last part"), size = bytes.length + tail.length;
    const session = await start({ name: "large.bin", size, mode: "multipart" });
    await call(`/uploads/${session.id}/parts/1`, { method: "PUT", bytes, headers: { "X-Content-SHA256": createHash("sha256").update(bytes).digest("hex") } });
    assert.equal((await call(`/uploads/${session.id}`)).parts.length, 1);
    await complete(session, "owner", { expected: 409 });
    await call(`/uploads/${session.id}/parts/2`, { method: "PUT", bytes: tail });
    await call(`/uploads/${session.id}/parts/2`, { method: "PUT", bytes: tail });
    const done = await complete(session); await complete(session);
    const response = await raw(`/items/${done.item.id}/content`, { headers: { Range: `bytes=${partBytes}-` } }); assert.equal(await response.text(), "last part");
    assert.equal((await item(done.item.id)).current_version.size, size);
    assert.equal((await call(`/items/${done.item.id}/versions`)).versions.length, 1);
    await call(`/uploads/${session.id}`, { method: "DELETE", expected: 409 });
    const cancelled = await start({ name: "aborted.bin", size, mode: "multipart" });
    await call(`/uploads/${cancelled.id}/parts/1`, { method: "PUT", bytes });
    await call(`/uploads/${cancelled.id}`, { method: "DELETE", expected: 204 }); await recover();
    assert.equal((await db.prepare("SELECT multipart_id FROM drive_uploads WHERE id=?").bind(cancelled.id).first()).multipart_id, null);
  });
  await t.test("two content uploads cannot overwrite the same item version", async () => {
    const target = await upload("concurrent.txt", "original"), version = (await item(target.id)).version;
    const first = await start({ item_id: target.id, version, size: 3 }), second = await start({ item_id: target.id, version, size: 3 });
    for (const entry of [first, second]) await call(`/uploads/${entry.id}/content`, { method: "PUT", bytes: Buffer.from("new") });
    await complete(first); await complete(second, "owner", { expected: 412 });
    assert.equal((await call(`/items/${target.id}/versions`)).versions.length, 2);
    await call(`/uploads/${second.id}`, { method: "DELETE", expected: 204 });
  });
  await t.test("read-only public links protect secrets, passwords and folder boundaries", async () => {
    const shared = await link(root.id, { password: "share-password" }), publicRoot = `/public/${shared.token}`, headers = { "X-Drive-Link-Password": "share-password" };
    await call(publicRoot, { actor: null, expected: 403 });
    await call(publicRoot, { actor: null, headers: { "X-Drive-Link-Password": "incorrect" }, expected: 403 });
    const metadata = await call(publicRoot, { actor: null, headers }); assert.equal(metadata.item.id, root.id); assert.equal(Object.hasOwn(metadata.item, "owner_user_id"), false);
    const children = await call(`${publicRoot}/items`, { actor: null, headers }); assert.ok(children.items.some(entry => entry.id === file.id));
    const response = await raw(`${publicRoot}/items/${file.id}/content`, { actor: null, headers }); assert.equal(response.status, 200); assert.equal(await response.text(), "hello drive");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    await call(`${publicRoot}/items/${file.id}/content?version_id=x`, { actor: null, headers, expected: 400 });
    const privateFile = await upload("private.txt"); await call(`${publicRoot}/items/${privateFile.id}/content`, { actor: null, headers, expected: 404 });
    await call(`${publicRoot}/items?parent_id=${privateFile.id}`, { actor: null, headers, expected: 404 });
    const inventory = await call(`/items/${root.id}/links`); assert.equal(Object.hasOwn(inventory.links[0], "token_hash"), false); assert.equal(Object.hasOwn(inventory.links[0], "password_hash"), false);
    const auditText = JSON.stringify((await call(`/items/${root.id}/activity`)).activity); assert.equal(auditText.includes(shared.token), false); assert.equal(auditText.includes("share-password"), false);
    await call(`/items/${root.id}/links/${shared.id}`, { method: "PATCH", data: { version: (await item(root.id)).version, allow_download: false } });
    await call(`${publicRoot}/items/${file.id}/content`, { actor: null, headers, expected: 403 });
    await call(`/items/${root.id}/links/${shared.id}`, { method: "PATCH", data: { version: (await item(root.id)).version, revoked: true } });
    await call(publicRoot, { actor: null, headers, expected: 404 });
    const expiring = await link(file.id, { expires_at: timestamp() + 100 });
    await db.prepare("UPDATE drive_links SET expires_at=unixepoch()-1 WHERE id=?").bind(expiring.id).run();
    await call(`/public/${expiring.token}`, { actor: null, expected: 404 });
  });
  await t.test("public file links stop working when the file moves outside a shared folder", async () => {
    const subfolder = await folder("movable", root.id), movable = await upload("movable.txt", "move me", subfolder.id), shared = await link(root.id);
    await edit(subfolder.id, { parent_id: null });
    await call(`/public/${shared.token}/items/${movable.id}/content`, { actor: null, expected: 404 });
    await call(`/items/${movable.id}`, { actor: "viewer", expected: 404 });
    assert.ok((await f.changes("viewer")).some(change => change.item_id === movable.id && !change.available));
  });
  await t.test("commenters create threads, authors edit and editors resolve", async () => {
    await call(`/items/${file.id}/comments`, { actor: "viewer", method: "POST", data: { body: "forbidden" }, expected: 404 });
    const comment = (await call(`/items/${file.id}/comments`, { actor: "commenter", method: "POST", data: { body: "Please review" }, expected: 201 })).comment;
    await call(`/items/${file.id}/comments/${comment.id}`, { actor: "editor", method: "PATCH", data: { version: comment.version, body: "altered" }, expected: 403 });
    await call(`/items/${file.id}/comments/${comment.id}`, { actor: "commenter", method: "PATCH", data: { version: comment.version, body: "Updated review" } });
    const reply = (await call(`/items/${file.id}/comments`, { actor: "editor", method: "POST", data: { body: "Done", parent_id: comment.id }, expected: 201 })).comment;
    await call(`/items/${file.id}/comments`, { actor: "commenter", method: "POST", data: { body: "Nested", parent_id: reply.id }, expected: 400 });
    await call(`/items/${file.id}/comments/${comment.id}`, { actor: "commenter", method: "PATCH", data: { version: 2, resolved: true }, expected: 404 });
    await call(`/items/${file.id}/comments/${comment.id}`, { actor: "editor", method: "PATCH", data: { version: 2, resolved: true } });
    assert.equal((await call(`/items/${file.id}/comments`, { actor: "viewer" })).comments.length, 2);
    await call(`/items/${file.id}/comments/${comment.id}`, { actor: "commenter", method: "PATCH", data: { version: 3, deleted: true } });
    assert.equal((await call(`/items/${file.id}/comments`)).comments.length, 0);
    await call(`/items/${file.id}/comments/${comment.id}`, { actor: "commenter", method: "PATCH", data: { version: 3, deleted: true }, expected: 404 });
  });
  await t.test("access requests hide guessed resources, deduplicate and grant inherited access", async () => {
    const target = await folder("Access requests"), child = await upload("request.txt", "request", target.id);
    await call("/items/unknown/access-requests", { actor: "outsider", method: "POST", data: {}, expected: 202 });
    for (let i = 0; i < 2; i++) await call(`/items/${target.id}/access-requests`, { actor: "outsider", method: "POST", data: { role: "commenter", message: "Let me in" }, expected: 202 });
    const requests = (await call(`/items/${target.id}/access-requests`)).requests; assert.equal(requests.length, 1);
    assert.equal((await call(`/items/${target.id}/activity`)).activity.filter(entry => entry.action === "access_requested").length, 1);
    await call(`/items/${target.id}/access-requests/${requests[0].id}`, { method: "PATCH", data: { version: (await item(target.id)).version, approved: true } });
    assert.equal((await item(child.id, "outsider")).effective_role, "commenter");
    await call(`/items/${target.id}/access-requests/${requests[0].id}`, { method: "PATCH", data: { version: (await item(target.id)).version, approved: true }, expected: 404 });
  });
  await t.test("copy preserves content while shares stay with the source and trashed subtrees are excluded", async () => {
    const source = await folder("Copy tree"), alive = await upload("alive.txt", "copied bytes", source.id), hidden = await folder("hidden", source.id);
    await upload("hidden.txt", "hidden", hidden.id); await edit(hidden.id, { trashed: true }); await share(source.id, "viewer", "viewer");
    for (let index = 0; index < 25; index++) await folder(`child-${index}`, source.id);
    const result = await call(`/items/${source.id}/copy`, { method: "POST", data: { name: "Copied tree" }, expected: 201 }), copied = result.item;
    const contents = (await call(`/items?parent_id=${copied.id}`)).items; assert.equal(contents.length, 26); assert.ok(contents.every(entry => entry.name !== "hidden"));
    await call(`/items/${copied.id}`, { actor: "viewer", expected: 404 });
    const copiedFile = contents.find(entry => entry.name === "alive.txt");
    await edit(alive.id, { trashed: true }); await call(`/items/${alive.id}?version=${(await item(alive.id, "owner", "?include_trashed=true")).version}`, { method: "DELETE", expected: 204 });
    await recover(); assert.equal(await (await raw(`/items/${copiedFile.id}/content`)).text(), "copied bytes");
    await call(`/items/${source.id}`, { method: "PATCH", data: { version: (await item(source.id)).version, parent_id: contents[0].id } });
    await call(`/items/${copied.id}`, { method: "PATCH", data: { version: (await item(copied.id)).version, parent_id: copiedFile.id }, expected: 400 });
    await call(`/items/${copied.id}`, { method: "PATCH", data: { version: (await item(copied.id)).version, parent_id: contents.find(entry => entry.kind === "folder").id }, expected: 400 });
  });
  await t.test("trash masks descendant grants and links; restoring retains sharing", async () => {
    const target = await folder("Trash tree"), child = await upload("trash.txt", "trash", target.id), shared = await link(child.id);
    await share(child.id, "viewer", "viewer"); await edit(target.id, { trashed: true });
    await call(`/items/${child.id}`, { actor: "viewer", expected: 404 }); await call(`/public/${shared.token}`, { actor: null, expected: 404 });
    assert.ok((await f.changes("viewer")).some(change => change.item_id === child.id && !change.available));
    assert.ok((await call("/items?view=trash")).items.some(entry => entry.id === target.id));
    await edit(target.id, { trashed: false }); assert.equal((await item(child.id, "viewer")).id, child.id);
    assert.equal((await call(`/public/${shared.token}`, { actor: null })).item.id, child.id);
    const pending = await start({ name: "pending.txt", parent_id: target.id, size: 6 });
    await call(`/uploads/${pending.id}/content`, { method: "PUT", bytes: Buffer.from("unused") });
    await edit(target.id, { trashed: true });
    await call(`/items/${target.id}?version=${(await item(target.id, "owner", "?include_trashed=true")).version}`, { method: "DELETE", expected: 204 });
    await recover(); assert.equal((await db.prepare("SELECT status FROM drive_uploads WHERE id=?").bind(pending.id).first()).status, "cancelled");
    await call(`/items/${child.id}?include_trashed=true`, { expected: 404 });
    assert.ok((await call(`/items/${target.id}/activity`)).activity.some(entry => entry.action === "purged"));
  });
  await t.test("ownership transfer detaches the tree, moves quota and revokes public links", async () => {
    const target = await folder("Transfer tree", root.id), child = await upload("transfer.txt", "transfer bytes", target.id), hidden = await folder("transfer trash", target.id);
    await upload("trashed-child.txt", "trashed bytes", hidden.id); await edit(hidden.id, { trashed: true });
    for (let index = 0; index < 20; index++) await folder(`transfer-child-${index}`, target.id);
    const shared = await link(target.id), before = await call("/quota"), total = 27;
    await call(`/items/${target.id}/transfer`, { method: "POST", data: { version: (await item(target.id)).version, user_id: "outsider" } });
    const transferred = await item(target.id, "outsider"); assert.equal(transferred.owner_user_id, "outsider"); assert.equal(transferred.parent_id, null);
    assert.equal((await item(child.id, "owner")).effective_role, "editor");
    assert.equal((await item(hidden.id, "outsider", "?include_trashed=true")).owner_user_id, "outsider");
    assert.equal((await call("/quota")).used_bytes, before.used_bytes - total); assert.equal((await call("/quota", { actor: "outsider" })).used_bytes, total);
    await call(`/public/${shared.token}`, { actor: null, expected: 404 });
    await call(`/items/${child.id}`, { actor: "viewer", expected: 404 });
  });
  await t.test("recovery expires uploads, retains active leases and purges old trash", async () => {
    const before = await call("/quota"), session = await start({ name: "expires.txt", size: 5 });
    await call(`/uploads/${session.id}/content`, { method: "PUT", bytes: Buffer.from("stale") });
    await db.prepare("UPDATE drive_uploads SET expires_at=unixepoch()-1,lease_until=unixepoch()+100 WHERE id=?").bind(session.id).run();
    await recover(); assert.equal((await call("/quota")).reserved_bytes, 5);
    await db.prepare("UPDATE drive_uploads SET lease_until=0 WHERE id=?").bind(session.id).run(); await recover();
    assert.equal((await call("/quota")).reserved_bytes, 0);
    const old = await upload("old-trash.txt", "old trash"); await edit(old.id, { trashed: true });
    await db.prepare("UPDATE drive_items SET trashed_at=unixepoch()-31*86400 WHERE id=?").bind(old.id).run(); await recover();
    await call(`/items/${old.id}?include_trashed=true`, { expected: 404 });
    assert.equal((await call("/quota")).used_bytes, before.used_bytes);
    await recover(); assert.equal((await call("/quota")).used_bytes, before.used_bytes);
  });
  await t.test("expired grants and disabled owners revoke access and activity stays immutable", async () => {
    const target = await upload("expires-grant.txt"), shared = await link(target.id);
    await share(target.id, "viewer", "viewer", { expires_at: timestamp() + 100 });
    await db.prepare("UPDATE drive_permissions SET expires_at=unixepoch()-1 WHERE item_id=? AND user_id='viewer'").bind(target.id).run();
    await call(`/items/${target.id}`, { actor: "viewer", expected: 404 }); await recover();
    assert.ok((await call(`/items/${target.id}/activity`)).activity.some(entry => entry.action === "permission_expired"));
    await db.prepare("UPDATE users SET disabled_at=unixepoch() WHERE id='owner'").run();
    await call(`/public/${shared.token}`, { actor: null, expected: 404 });
    await call(`/items/${file.id}`, { actor: "viewer", expected: 404 });
    await db.prepare("UPDATE users SET disabled_at=NULL WHERE id='owner'").run();
    await assert.rejects(db.prepare("UPDATE drive_activity SET action='forged'").run(), /immutable/);
    await assert.rejects(db.prepare("DELETE FROM drive_activity").run(), /immutable/);
    await assert.rejects(db.prepare("UPDATE drive_versions SET size=size+1").run(), /immutable/);
    const actions = (await call(`/items/${file.id}/activity`)).activity.map(entry => entry.action);
    assert.ok(actions.includes("file_created")); assert.ok(actions.includes("content_updated"));
    assert.equal((await call(`/items/${file.id}/activity`, { actor: "viewer" })).activity.every(entry => Object.keys(entry.details).length === 0), true);
  });
  await t.test("permission revocation during R2 writes prevents finalization and releases expired reservations", async () => {
    const target = await folder("Revocation race"); await share(target.id, "editor", "editor");
    const session = await start({ name: "denied.txt", parent_id: target.id, size: 6 }, "editor");
    await call(`/uploads/${session.id}/content`, { actor: "editor", method: "PUT", bytes: Buffer.from("secret"), fault: true,
      headers: { "X-Test-After-Storage": `DELETE FROM drive_permissions WHERE item_id='${target.id}' AND user_id='editor'` }, expected: 412 });
    await complete(session, "editor", { expected: 404 });
    assert.equal(await db.prepare("SELECT id FROM drive_items WHERE id=?").bind(session.item_id).first(), null);
    await db.prepare("UPDATE drive_uploads SET expires_at=unixepoch()-1,lease_until=0 WHERE id=?").bind(session.id).run(); await recover();
    assert.equal((await call("/quota")).reserved_bytes, 0);
    const key = (await db.prepare("SELECT blob_key FROM drive_uploads WHERE id=?").bind(session.id).first()).blob_key; assert.equal(await bucket.head(key), null);
  });
  await t.test("public link revocation during R2 reads prevents returning bytes", async () => {
    const target = await upload("public-race.txt", "secret"), shared = await link(target.id);
    await call(`/public/${shared.token}/items/${target.id}/content`, { actor: null, fault: true,
      headers: { "X-Test-After-Storage": `UPDATE drive_links SET revoked_at=unixepoch() WHERE id='${shared.id}'` }, expected: 404 });
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM drive_activity WHERE item_id=? AND action='public_download'").bind(target.id).first()).count, 0);
  });
  await t.test("D1 failure rolls back metadata, quota, audit and notification delivery together", async () => {
    const target = await folder("Rollback"); await share(target.id, "viewer", "viewer");
    const session = await start({ name: "rollback.txt", parent_id: target.id, size: 8 });
    await call(`/uploads/${session.id}/content`, { method: "PUT", bytes: Buffer.from("rollback") });
    const before = await call("/quota"), notifications = (await db.prepare("SELECT COUNT(*) count FROM notification_events").first()).count;
    await complete(session, "owner", { fault: true, headers: { "X-Test-Fail-Batch": "INSERT INTO drive_versions" }, expected: 500 });
    assert.equal(await db.prepare("SELECT id FROM drive_items WHERE id=?").bind(session.item_id).first(), null);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM drive_activity WHERE item_id=?").bind(session.item_id).first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM notification_events").first()).count, notifications);
    assert.equal((await call("/quota")).used_bytes, before.used_bytes); assert.equal((await call("/quota")).reserved_bytes, 8);
    const done = await complete(session); assert.equal(done.item.id, session.item_id); assert.equal((await call("/quota")).reserved_bytes, 0);
  });
  await t.test("folder snapshots reject concurrent child creation for copies and transfers", async () => {
    const target = await folder("Snapshot");
    const insert = child => `INSERT INTO drive_items(id,owner_user_id,parent_id,kind,name,created_by) VALUES('${child}','owner','${target.id}','folder','raced','owner')`;
    await call(`/items/${target.id}/copy`, { method: "POST", data: { name: "Should not exist" }, fault: true,
      headers: { "X-Test-Before-Batch": insert("copy-raced-child") }, expected: 412 });
    assert.equal((await call("/items?q=Should%20not%20exist")).items.length, 0);
    await call(`/items/${target.id}/transfer`, { method: "POST", data: { version: (await item(target.id)).version, user_id: "outsider" }, fault: true,
      headers: { "X-Test-Before-Batch": insert("transfer-raced-child") }, expected: 412 });
    assert.equal((await item(target.id)).owner_user_id, "owner");
  });
  await t.test("change feeds never reveal denied resources' descendants or a newly shared folder's trash", async () => {
    const denied = await folder("Denied"), privateChild = await upload("private-child.txt", "private", denied.id);
    await call(`/items/${denied.id}/access-requests`, { actor: "outsider", method: "POST", data: {}, expected: 202 });
    const request = (await call(`/items/${denied.id}/access-requests`)).requests[0];
    await call(`/items/${denied.id}/access-requests/${request.id}`, { method: "PATCH", data: { version: (await item(denied.id)).version, approved: false } });
    assert.equal((await f.changes("outsider")).some(change => change.item_id === privateChild.id), false);
    const shared = await folder("Shared with private trash"), hidden = await upload("private-trash.txt", "private", shared.id);
    await edit(hidden.id, { trashed: true }); await share(shared.id, "viewer", "viewer");
    assert.equal((await f.changes("viewer")).some(change => change.item_id === hidden.id), false);
    await edit(hidden.id, { trashed: false });
    assert.equal((await f.changes("viewer")).some(change => change.item_id === hidden.id && change.available), true);
  });
  await t.test("large folder operations reject the limit before changing any ownership or quota", async () => {
    const target = await folder("Too large"), before = await call("/quota");
    await db.batch(Array.from({ length: 200 }, (_, index) => db.prepare("INSERT INTO drive_items(id,owner_user_id,parent_id,kind,name,created_by) VALUES(?,'owner',?,'folder',?,'owner')").bind(`limit-child-${index}`, target.id, `Child ${index}`)));
    await call(`/items/${target.id}/copy`, { method: "POST", data: {}, expected: 413 });
    await call(`/items/${target.id}/transfer`, { method: "POST", data: { version: (await item(target.id)).version, user_id: "outsider" }, expected: 413 });
    assert.equal((await item(target.id)).owner_user_id, "owner"); assert.deepEqual(await call("/quota"), before);
  });
  await t.test("quota includes retained versions and reservations and rejected uploads cannot reserve bytes", async () => {
    const before = await call("/quota");
    await db.prepare("UPDATE drive_accounts SET quota_bytes=used_bytes+reserved_bytes+4 WHERE user_id='owner'").run();
    const session = await start({ name: "quota.txt", size: 4 });
    await call("/uploads", { method: "POST", data: { name: "over.txt", size: 1 }, expected: 413 });
    assert.equal((await call("/quota")).reserved_bytes, 4);
    await call(`/uploads/${session.id}`, { method: "DELETE", expected: 204 });
    await db.prepare("UPDATE drive_accounts SET quota_bytes=? WHERE user_id='owner'").bind(before.quota_bytes).run();
  });
  await t.test("a revoked session cannot finish an upload even if its access token has not expired", async () => {
    const session = await start({ name: "revoked-session.txt", size: 0 }, "commenter");
    await call(`/uploads/${session.id}/content`, { actor: "commenter", method: "PUT", bytes: Buffer.alloc(0) });
    await db.prepare("UPDATE user_sessions SET revoked_at=unixepoch() WHERE user_id='commenter'").run();
    await complete(session, "commenter", { expected: 401 });
    assert.equal(await db.prepare("SELECT id FROM drive_items WHERE id=?").bind(session.item_id).first(), null);
    await db.prepare("UPDATE drive_uploads SET expires_at=unixepoch()-1,lease_until=0 WHERE id=?").bind(session.id).run(); await recover();
  });
});
