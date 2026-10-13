import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/auth/password.ts";
import { workerModules } from "./worker-modules.mjs";
import { driveUserPermissions } from "../src/authorization/permissions.ts";
import { permissionCatalog, permissionClosure } from "../src/authorization/permissions.ts";

const PASSWORD = "a long password for drive integration tests";
const timestamp = () => Math.floor(Date.now() / 1000), partBytes = 8 * 1024 * 1024;
const harness = await build({ entryPoints: ["tests/drive-harness.ts"], bundle: true, write: false, format: "esm", platform: "browser",
  external: ["cloudflare:workers", "../dist/index.js"], target: "es2022" });

async function fixture(t, options = {}) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const bindings = { AUTH_SIGNING_KEYS: JSON.stringify({ active_kid: "test", keys: [{ ...await exportJWK(privateKey), kid: "test" }] }),
    MFA_ENCRYPTION_KEYS: JSON.stringify({ active_version: 1, keys: { 1: randomBytes(32).toString("base64url") } }),
    AUTH_ISSUER: "officeflare", AUTH_AUDIENCE: "officeflare-api" };
  const common = { compatibilityDate: "2026-09-29", d1Databases: { DB: "drive-tests" }, r2Buckets: { DRIVE_BUCKET: "drive-tests", PROFILE_BUCKET: "drive-profile-tests" }, bindings };
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "officeflare", modules: workerModules },
    { ...common, name: "drive-harness", modules: [{ type: "ESModule", path: "tests/drive-harness.mjs", contents: harness.outputFiles[0].text }, ...workerModules] },
  ] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB"), bucket = await mf.getR2Bucket("DRIVE_BUCKET"), faults = await mf.getWorker("drive-harness");
  for (const file of (await readdir("migrations")).sort()) {
    if (file === "0017_drive_administration.sql" && options.beforeAdminMigration) await options.beforeAdminMigration(db);
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
  await db.batch(driveUserPermissions.map(key => db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('drive-test',?)").bind(key)));
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

test('Drive UI API supports safe account search, roles and complete ordered pagination', async t => {
  const f = await fixture(t);
  await f.db.prepare("UPDATE users SET display_name=CASE id WHEN 'owner' THEN 'Owner' WHEN 'editor' THEN 'Team Editor' WHEN 'viewer' THEN 'Team Viewer' ELSE id END").run();
  const found = (await f.call('/people?q=Team', {actor:'viewer'})).people;
  assert.deepEqual(found.map(person=>person.id), ['editor']);
  assert.deepEqual(Object.keys(found[0]).sort(), ['display_name','email_address','id']);
  assert.deepEqual((await f.call('/people?q=no-drive')).people, []);
  assert.deepEqual((await f.call('/people?q=%')).people, []);
  await f.call('/people?q=owner',{actor:'no-drive',expected:403});
  const root = await f.folder('Shared documents'); await f.share(root.id,'viewer','viewer');
  const a = await f.upload('zeta.txt','12345',root.id), b = await f.upload('alpha.txt','1',root.id), c = await f.upload('ALPHA.txt','12',root.id);
  await f.folder('가'.repeat(255),root.id); await f.folder('Beta folder',root.id);
  const described = await f.item(a.id,'viewer'); assert.equal(described.owner.display_name,'Owner'); assert.equal(described.effective_role,'viewer');
  for (const sort of ['name','updated_at','size']) for (const order of ['asc','desc']) {
    const collected = []; let cursor = null, firstCursor;
    do {
      const page = await f.call(`/items?view=all&parent_id=${root.id}&sort=${sort}&order=${order}&limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`, {actor:'viewer'});
      assert.ok(page.items.length, `${sort} ${order}: empty page after ${collected.length} items`);
      assert.equal(page.items[0].effective_role,'viewer'); assert.equal(page.items[0].owner.email_address,'owner@office.test');
      collected.push(page.items[0]); cursor=page.next_cursor; firstCursor ??= cursor;
    } while (cursor);
    assert.equal(collected.length,5); assert.equal(new Set(collected.map(item=>item.id)).size,5);
    assert.deepEqual(collected.slice(0,2).map(item=>item.kind), ['folder','folder']);
    if (sort === 'size') assert.deepEqual(collected.slice(2).map(item=>item.size),order === 'asc'?[1,2,5]:[5,2,1]);
    await f.call(`/items?view=all&parent_id=${root.id}&sort=${sort}&order=${order==='asc'?'desc':'asc'}&cursor=${encodeURIComponent(firstCursor)}`,{actor:'viewer',expected:400});
  }
  await f.call('/items?sort=DROP_TABLE', {expected:400});
  const permissions = (await f.call(`/items/${b.id}/permissions`)).permissions;
  assert.equal(permissions[0].display_name,'Team Viewer'); assert.equal(permissions[0].source_name,'Shared documents'); assert.equal(permissions[0].inherited,1);
  await f.call(`/items/${c.id}/comments`,{actor:'viewer',method:'POST',data:{body:'No'},expected:404});
});

test("Drive owner photos require readable files and refresh when the image changes", async t => {
  const f = await fixture(t), root = await f.folder("Owner photo access"), photoPath = "/people/owner/profile-image";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ9kAAAAASUVORK5CYII=", "base64");
  const bucket = await f.mf.getR2Bucket("PROFILE_BUCKET"), key = "profiles/owner/photo.png";
  await bucket.put(key, png, { httpMetadata: { contentType: "image/png" } });
  await f.db.prepare("UPDATE users SET display_name='Drive owner',profile_image_key=? WHERE id='owner'").bind(key).run();
  await f.call(photoPath, { actor: null, expected: 401 });
  await f.call(photoPath, { actor: "no-drive", expected: 403 });
  for (const actor of ["viewer", "outsider", "admin"]) await f.call(photoPath, { actor, expected: 404 });
  await f.share(root.id, "viewer", "viewer");
  const child = await f.folder("Inherited access", root.id), described = await f.item(child.id, "viewer");
  await bucket.put("profiles/viewer/recipient.png", png, { httpMetadata: { contentType: "image/png" } });
  await f.db.prepare("UPDATE users SET profile_image_key='profiles/viewer/recipient.png' WHERE id='viewer'").run();
  const grant = (await f.call(`/items/${child.id}/permissions`)).permissions[0];
  assert.equal(grant.inherited, 1);
  assert.equal(grant.has_profile_image, true);
  assert.equal(grant.profile_image_version, "recipient.png");
  assert.equal(Object.hasOwn(grant, "profile_image_key"), false);
  const recipientPhoto = await f.raw("/people/viewer/profile-image");
  assert.equal(recipientPhoto.status, 200);
  assert.deepEqual(Buffer.from(await recipientPhoto.arrayBuffer()), png);
  await f.call("/people/viewer/profile-image", { actor: "outsider", expected: 404 });
  assert.equal(described.owner.display_name, "Drive owner");
  assert.equal(described.owner.has_profile_image, true);
  assert.equal(described.owner.profile_image_version, "photo.png");
  assert.equal(Object.hasOwn(described.owner, "profile_image_key"), false);
  const listed = (await f.call("/items?view=shared", { actor: "viewer" })).items;
  assert.ok(listed.every(entry => entry.owner.has_profile_image && entry.owner.profile_image_version === "photo.png"));
  assert.equal(JSON.stringify(listed).includes("profiles/owner/"), false);
  const response = await f.raw(photoPath, { actor: "viewer" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  await f.call("/api/users/owner/profile-image", { actor: "viewer", expected: 403 });
  await f.db.prepare("UPDATE drive_settings SET internal_sharing_enabled=0 WHERE id=1").run();
  await f.call(photoPath, { actor: "viewer", expected: 404 });
  await f.db.prepare("UPDATE drive_settings SET internal_sharing_enabled=1 WHERE id=1").run();
  await bucket.put("profiles/owner/replaced.png", png, { httpMetadata: { contentType: "image/png" } });
  await f.db.prepare("UPDATE users SET profile_image_key='profiles/owner/replaced.png' WHERE id='owner'").run();
  assert.equal((await f.item(child.id, "viewer")).owner.profile_image_version, "replaced.png");
  await f.db.prepare("UPDATE users SET profile_image_key=NULL WHERE id='owner'").run();
  assert.equal((await f.item(child.id, "viewer")).owner.has_profile_image, false);
  await f.call(photoPath, { actor: "viewer", expected: 404 });
  await f.db.prepare("UPDATE users SET profile_image_key=? WHERE id='owner'").bind(key).run();
  await f.call(`/items/${root.id}/permissions/viewer?version=${(await f.item(root.id)).version}`, { method: "DELETE" });
  await f.call(photoPath, { actor: "viewer", expected: 404 });
  await f.call("/people/viewer/profile-image", { expected: 404 });
});

const adminCall = (f, path, options = {}) => f.call(`/admin${path}`, { actor: "admin", ...options });
const patchSettings = async (f, changes, options = {}) => adminCall(f, "/settings", { method: "PATCH", data: { version: (await adminCall(f, "/settings")).settings.version, reason: "Administrative integration test", ...changes }, ...options });
const patchAccount = async (f, user, changes, options = {}) => adminCall(f, `/accounts/${user}`, { method: "PATCH", data: { version: (await adminCall(f, `/accounts/${user}`)).account.version, reason: "Storage and availability test", ...changes }, ...options });
const testRole = async (f, user, keys) => {
  const id = `role-${user}`;
  await f.db.prepare("INSERT OR IGNORE INTO roles(id,key,label) VALUES(?,?,?)").bind(id, id, id).run();
  await f.db.prepare("DELETE FROM user_roles WHERE user_id=?").bind(user).run();
  await f.db.batch(permissionClosure(keys).map(key => f.db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES(?,?)").bind(id, key)));
  await f.db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)").bind(user, id).run();
};

test("Drive administration migration preserves old quotas and usage grants", async t => {
  const f = await fixture(t, { beforeAdminMigration: async db => {
    await db.prepare("INSERT INTO users(id,email_address,password_hash) VALUES('legacy','legacy@office.test','migration-fixture')").run();
    await db.prepare("INSERT INTO roles(id,key,label) VALUES('legacy-drive','legacy-drive','Existing Drive role')").run();
    await db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('legacy-drive','drive.access')").run();
    await db.prepare("INSERT INTO drive_accounts(user_id,quota_bytes) VALUES('legacy',12345)").run();
  } });
  const legacy = await f.db.prepare("SELECT * FROM drive_accounts WHERE user_id='legacy'").first();
  assert.equal(legacy.quota_bytes, 12345); assert.equal(legacy.quota_override_bytes, 12345);
  const grants = (await f.db.prepare("SELECT permission_key FROM role_permissions WHERE role_id='legacy-drive' ORDER BY permission_key").all()).results;
  assert.deepEqual(grants.map(row => row.permission_key), [...driveUserPermissions].sort());
  const system = (await f.db.prepare("SELECT permission_key FROM role_permissions WHERE role_id='system-administrator' ORDER BY permission_key").all()).results;
  assert.deepEqual(system.map(row => row.permission_key), Object.keys(permissionCatalog).sort());
  assert.equal((await adminCall(f, "/settings")).settings.default_quota_bytes, 10 * 1024 ** 3);
});

test("Drive console permissions work independently of personal Drive access", async t => {
  const f = await fixture(t);
  const file = await f.upload("Private administrator audit.txt");
  await adminCall(f, "/overview", { actor: "owner", expected: 403 });
  await f.call(`/items/${file.id}`, { actor: "admin", expected: 404 });
  await testRole(f, "no-drive", ["admin.drive.accounts.read", "admin.drive.items.read", "admin.drive.sharing.read", "admin.drive.audit.read"]);
  assert.equal((await adminCall(f, "/accounts", { actor: "no-drive" })).items.length, 7);
  assert.equal((await adminCall(f, "/items", { actor: "no-drive" })).items[0].name, file.name);
  await adminCall(f, "/sharing", { actor: "no-drive" }); await adminCall(f, "/activity", { actor: "no-drive" });
  await adminCall(f, "/settings", { actor: "no-drive", expected: 403 });
  await adminCall(f, "/accounts/owner", { actor: "no-drive", method: "PATCH", data: { version: 1, quota_override_bytes: 1000, reason: "Not permitted" }, expected: 403 });
  await f.call("/quota", { actor: "no-drive", expected: 403 });
  await f.call(`/items/${file.id}/content`, { actor: "no-drive", expected: 403 });
});

test("Drive database defaults, overrides, concurrency and suspension are enforced", async t => {
  const f = await fixture(t), file = await f.upload("Storage.txt", "stored bytes"), shared = await f.link(file.id);
  const initial = (await adminCall(f, "/settings")).settings;
  await patchSettings(f, { default_quota_bytes: 1024 * 1024 });
  assert.equal((await f.call("/quota")).quota_bytes, 1024 * 1024);
  assert.equal((await f.call("/quota", { actor: "viewer" })).quota_bytes, 1024 * 1024);
  await patchAccount(f, "owner", { quota_override_bytes: 1234 });
  await patchSettings(f, { default_quota_bytes: 2048 });
  assert.equal((await f.call("/quota")).quota_bytes, 1234);
  assert.equal((await f.call("/quota", { actor: "viewer" })).quota_bytes, 2048);
  await adminCall(f, "/settings", { method: "PATCH", data: { version: initial.version, public_sharing_enabled: false, reason: "Stale snapshot" }, expected: 412 });
  await patchAccount(f, "owner", { quota_override_bytes: null, status: "read_only" });
  const dto = await f.item(file.id); assert.equal(dto.actions.update, false); assert.equal(dto.actions.download, true);
  await f.call("/folders", { method: "POST", data: { name: "Forbidden" }, expected: 403 });
  assert.equal((await f.raw(`/items/${file.id}/content`)).status, 200);
  await patchAccount(f, "owner", { status: "suspended" });
  await f.call("/quota", { expected: 403 }); await f.call(`/public/${shared.token}`, { actor: null, expected: 404 });
  await patchAccount(f, "owner", { status: "active", quota_override_bytes: 1 });
  await f.call("/uploads", { method: "POST", data: { name: "too much", size: 1 }, expected: 413 });
  assert.equal((await f.item(file.id)).current_version.size, Buffer.byteLength("stored bytes"));
  await assert.rejects(f.db.prepare("UPDATE drive_admin_activity SET action='forged'").run(), /immutable/);
  await assert.rejects(f.db.prepare("DELETE FROM drive_admin_activity").run(), /immutable/);
  const logs = await adminCall(f, "/activity?kind=admin&action=account_updated&owner=owner");
  assert.equal(logs.items.length, 4); assert.ok(logs.items.every(entry => entry.details.reason));
});

test("Drive read-only roles, shared ACLs and policy changes guard actual bytes", async t => {
  const f = await fixture(t), root = await f.folder("Access checks"), file = await f.upload("Readable.txt", "read-only bytes", root.id);
  await f.share(root.id, "viewer", "viewer");
  await testRole(f, "owner", ["drive.access", "drive.files.download"]);
  assert.equal((await f.item(file.id)).actions.create, false);
  assert.equal((await f.raw(`/items/${file.id}/preview`)).status, 200); assert.equal((await f.raw(`/items/${file.id}/content`)).status, 200);
  await f.call(`/items/${file.id}`, { method: "PATCH", data: { version: file.version, name: "Changed" }, expected: 403 });
  await f.call(`/items/${file.id}/copy`, { method: "POST", data: { version: file.version }, expected: 403 });
  await f.call(`/items/${file.id}/comments`, { method: "POST", data: { body: "Not allowed" }, expected: 403 });
  await patchSettings(f, { internal_sharing_enabled: false });
  await f.call(`/items/${file.id}`, { actor: "viewer", expected: 404 }); await f.item(file.id);
  await patchSettings(f, { internal_sharing_enabled: true });
  const bytes = await f.raw(`/items/${file.id}/content`, { actor: "viewer", fault: true, headers: { "X-Test-After-Storage": "UPDATE drive_settings SET internal_sharing_enabled=0 WHERE id=1" } });
  assert.equal(bytes.status, 404);
  await testRole(f, "owner", [...driveUserPermissions]);
  await patchSettings(f, { internal_sharing_enabled: true });
  const upload = await f.start({ name: "Policy race.txt", size: 3, content_type: "text/plain" });
  await f.call(`/uploads/${upload.id}/content`, { method: "PUT", bytes: Buffer.from("abc"), fault: true, headers: { "X-Test-After-Storage": "UPDATE drive_settings SET max_file_bytes=1 WHERE id=1" }, expected: 412 });
  await f.call("/uploads", { method: "POST", data: { name: "Too big", size: 2 }, expected: 413 });
});

test("Drive public policies apply to existing links and admin revocation is immediate", async t => {
  const f = await fixture(t), file = await f.upload("Link policy.txt"), old = await f.link(file.id);
  await patchSettings(f, { public_link_password_required: true, public_link_max_days: 7 });
  await f.call(`/public/${old.token}`, { actor: null, expected: 404 });
  await f.call(`/items/${file.id}/links`, { method: "POST", data: { version: (await f.item(file.id)).version }, expected: 403 });
  const link = await f.link(file.id, { password: "workspace-password", expires_at: timestamp() + 6 * 86400 });
  await f.call(`/public/${link.token}`, { actor: null, headers: { "X-Drive-Link-Password": "workspace-password" } });
  const all = await adminCall(f, "/sharing?kind=links&state=all");
  assert.equal(all.items.length, 2); assert.ok(!JSON.stringify(all).includes("password_hash")); assert.ok(!JSON.stringify(all).includes(link.token));
  const expired = await f.link(file.id, { password: "workspace-password", expires_at: timestamp() + 6 * 86400 });
  await f.db.prepare("UPDATE drive_links SET expires_at=unixepoch()-1 WHERE id=?").bind(expired.id).run();
  assert.equal((await adminCall(f, "/sharing?kind=links&state=all")).items.find(entry => entry.id === expired.id).policy_allowed, 0);
  await adminCall(f, `/items/${file.id}/links/${link.id}/revoke`, { method: "POST", data: { version: (await f.item(file.id)).version, reason: "External link revoked" } });
  await f.call(`/public/${link.token}`, { actor: null, headers: { "X-Drive-Link-Password": "workspace-password" }, expected: 404 });
  const race = await f.link(file.id, { password: "workspace-password", expires_at: timestamp() + 6 * 86400 });
  await f.call(`/public/${race.token}/items/${file.id}/content`, { actor: null, fault: true, headers: { "X-Drive-Link-Password": "workspace-password", "X-Test-After-Storage": "UPDATE drive_settings SET public_sharing_enabled=0 WHERE id=1" }, expected: 404 });
  await f.call(`/items/${file.id}/links/${race.id}`, { method: "PATCH", data: { version: (await f.item(file.id)).version, revoked: true } });
  assert.equal((await adminCall(f, "/activity?kind=admin&action=link_revoked")).items.length, 1);
});

test("Drive administrative grants, trash, audit filters and revoked admin rights stay atomic", async t => {
  const f = await fixture(t), root = await f.folder("Admin grant source"), file = await f.upload("Audit searchable.txt", "contents", root.id);
  await adminCall(f, `/items/${root.id}/permissions`, { method: "POST", data: { version: root.version, user_id: "viewer", role: "commenter", reason: "Grant inherited access" } });
  assert.equal((await f.item(file.id, "viewer")).effective_role, "commenter");
  await adminCall(f, `/items/${root.id}/permissions/viewer`, { method: "DELETE", data: { version: (await f.item(root.id)).version, reason: "Remove inherited access" } });
  await f.call(`/items/${file.id}`, { actor: "viewer", expected: 404 });
  await f.edit(root.id, { trashed: true });
  await adminCall(f, `/items/${root.id}/restore`, { method: "POST", data: { version: (await f.item(root.id, "owner", "?include_trashed=true")).version, reason: "Recover folder" } });
  await f.item(file.id);
  await f.edit(root.id, { trashed: true });
  await adminCall(f, `/items/${root.id}/purge`, { method: "POST", data: { version: (await f.item(root.id, "owner", "?include_trashed=true")).version, reason: "Remove old folder" } });
  await f.call(`/items/${file.id}`, { expected: 404 });
  assert.equal((await f.call("/quota")).used_bytes, 0);
  const first = await adminCall(f, "/activity?limit=1&kind=all"); assert.ok(first.next_cursor);
  const next = await adminCall(f, `/activity?limit=1&kind=all&cursor=${encodeURIComponent(first.next_cursor)}`); assert.notEqual(first.items[0].page_id, next.items[0].page_id);
  await adminCall(f, `/activity?kind=admin&cursor=${encodeURIComponent(first.next_cursor)}`, { expected: 400 });
  assert.ok((await adminCall(f, "/activity?q=admin@office.test&kind=admin")).items.length >= 4);
  const before = await f.db.prepare("SELECT COUNT(*) count FROM drive_admin_activity").first();
  await patchSettings(f, { default_quota_bytes: 54321 }, { fault: true, headers: { "X-Test-Before-Batch": "DELETE FROM role_permissions WHERE role_id='system-administrator' AND permission_key='admin.drive.settings.manage'" }, expected: 403 });
  assert.deepEqual(await f.db.prepare("SELECT COUNT(*) count FROM drive_admin_activity").first(), before);
  assert.equal((await adminCall(f, "/settings")).settings.default_quota_bytes, 10 * 1024 ** 3);
});

test("Drive handover moves large trees from disabled owners without copying R2 objects", async t => {
  const f = await fixture(t), root = await f.folder("Former owner files"), file = await f.upload("Retained.txt", "retained", root.id), link = await f.link(root.id);
  await f.share(root.id, "viewer", "viewer");
  await f.db.batch(Array.from({ length: 250 }, (_, index) => f.db.prepare("INSERT INTO drive_items(id,owner_user_id,parent_id,kind,name,created_by) VALUES(?,'owner',?,'folder',?,'owner')").bind(`handover-child-${index}`, root.id, `Folder ${index}`)));
  const original = await f.db.prepare("SELECT blob_key FROM drive_versions WHERE item_id=?").bind(file.id).first();
  await f.db.prepare("UPDATE users SET disabled_at=unixepoch() WHERE id='owner'").run();
  const account = (await adminCall(f, "/accounts/owner")).account;
  const created = await adminCall(f, "/transfers", { method: "POST", data: { source_user_id: "owner", target_user_id: "editor", version: account.version, reason: "Former owner handover" }, expected: 202 });
  for (let pass = 0; pass < 4; pass++) { await f.recover(); if ((await f.db.prepare("SELECT status FROM drive_admin_jobs WHERE id=?").bind(created.job.id).first()).status === "completed") break; }
  const job = await f.db.prepare("SELECT * FROM drive_admin_jobs WHERE id=?").bind(created.job.id).first();
  assert.equal(job.status, "completed"); assert.equal(job.total_items, 252); assert.equal(job.processed_items, 252); assert.equal(job.reserved_bytes, 0);
  assert.equal((await f.item(file.id, "editor")).effective_role, "owner"); assert.equal((await f.item(file.id, "viewer")).effective_role, "viewer");
  assert.equal(await (await f.raw(`/items/${file.id}/content`, { actor: "editor" })).text(), "retained");
  assert.equal((await f.call("/quota", { actor: "editor" })).used_bytes, Buffer.byteLength("retained"));
  assert.equal((await f.db.prepare("SELECT used_bytes FROM drive_accounts WHERE user_id='owner'").first()).used_bytes, 0);
  assert.equal((await f.bucket.list()).objects.length, 1); assert.ok(await f.bucket.head(original.blob_key));
  await f.call(`/public/${link.token}`, { actor: null, expected: 404 });
  assert.equal((await adminCall(f, "/activity?kind=admin&action=transfer_completed")).items.length, 1);
  assert.ok((await f.call("/api/notifications?service=drive", { actor: "editor" })).notifications.some(entry => entry.type === "drive.shared"));
});

test("Drive transfer failures retain reservations, freeze partial trees and resume after reauthorization", async t => {
  const f = await fixture(t), root = await f.folder("Resumable handover"), file = await f.upload("Recover.txt", "recover", root.id);
  await f.db.batch(Array.from({ length: 40 }, (_, index) => f.db.prepare("INSERT INTO drive_items(id,owner_user_id,parent_id,kind,name,created_by) VALUES(?,'owner',?,'folder',?,'owner')").bind(`resume-child-${index}`, root.id, `Folder ${index}`)));
  const started = await adminCall(f, "/transfers", { method: "POST", fault: true, headers: { "X-Test-Before-Transfer": "DELETE FROM role_permissions WHERE role_id='system-administrator' AND permission_key='admin.drive.ownership.transfer'", "X-Test-Transfer-Chunk": "2" }, data: { item_id: root.id, target_user_id: "editor", version: (await f.item(root.id)).version, reason: "Test permission removal during handover" }, expected: 202 });
  await f.recover();
  let job = await f.db.prepare("SELECT * FROM drive_admin_jobs WHERE id=?").bind(started.job.id).first();
  assert.equal(job.status, "failed"); assert.ok(job.processed_items > 0 && job.processed_items < job.total_items);
  await f.call(`/items/${root.id}`, { actor: "editor", expected: 404 });
  await f.call("/folders", { actor: "owner", method: "POST", data: { name: "Locked source" }, expected: 403 });
  await f.call("/folders", { actor: "editor", method: "POST", data: { name: "Locked destination" }, expected: 403 });
  await adminCall(f, `/transfers/${job.id}/retry`, { method: "POST", data: { version: job.version, reason: "Unauthorized retry" }, expected: 403 });
  await f.db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('system-administrator','admin.drive.ownership.transfer')").run();
  await adminCall(f, `/transfers/${job.id}/cancel`, { method: "POST", data: { version: job.version, reason: "Unsafe cancellation" }, expected: 409 });
  await adminCall(f, `/transfers/${job.id}/retry`, { method: "POST", data: { version: job.version, reason: "Resume with valid authorization" } });
  await f.recover();
  job = await f.db.prepare("SELECT * FROM drive_admin_jobs WHERE id=?").bind(job.id).first();
  assert.equal(job.status, "completed"); assert.equal(job.reserved_bytes, 0);
  assert.equal((await f.item(file.id, "editor")).owner_user_id, "editor");
  assert.equal((await f.call("/quota", { actor: "editor" })).reserved_bytes, 0);
  await f.folder("Unlocked destination", null, "editor");
});

test("Drive handover keeps inherited trash and avoids unaudited account initialization", async t => {
  const f = await fixture(t), parent = await f.folder("Trashed source"), child = await f.folder("Keep in trash", parent.id);
  await f.share(parent.id, "viewer", "viewer");
  await f.edit(parent.id, { trashed: true });
  const trash = await adminCall(f, "/items?state=trash");
  assert.equal(trash.items.find(entry => entry.id === child.id).in_trash, 1);
  // A legacy folder-only account can have inventory without a quota row.
  await f.db.prepare("DELETE FROM drive_accounts WHERE user_id='owner'").run();
  assert.equal((await adminCall(f, "/accounts/owner")).account.version, 0);
  await adminCall(f, "/transfers", { method: "POST", data: { source_user_id: "owner", target_user_id: "editor", version: 0, reason: "Claim must be authorized" }, fault: true, headers: { "X-Test-Before-Batch": "DELETE FROM role_permissions WHERE role_id='system-administrator' AND permission_key='admin.drive.ownership.transfer'" }, expected: 403 });
  assert.equal((await f.db.prepare("SELECT COUNT(*) count FROM drive_accounts").first()).count, 0);
  await f.db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('system-administrator','admin.drive.ownership.transfer')").run();
  const created = await adminCall(f, "/transfers", { method: "POST", data: { item_id: child.id, target_user_id: "editor", version: child.version, reason: "Preserve trash during ownership change" }, expected: 202 });
  await f.recover();
  assert.equal((await f.db.prepare("SELECT status FROM drive_admin_jobs WHERE id=?").bind(created.job.id).first()).status, "completed");
  const moved = await f.item(child.id, "editor", "?include_trashed=true");
  assert.ok(moved.trashed_at); assert.equal(moved.parent_id, null); assert.equal(moved.owner_user_id, "editor");
  await f.call(`/items/${child.id}`, { actor: "editor", expected: 404 });
  await f.call(`/items/${child.id}`, { actor: "viewer", expected: 404 });
});

test("Drive administrators can safely release former owners' unfinished uploads before handover", async t => {
  const f = await fixture(t), folder = await f.folder("Handover after cancellation"), upload = await f.start({ name: "Unfinished.txt", size: 3, content_type: "text/plain" });
  await f.call(`/uploads/${upload.id}/content`, { method: "PUT", bytes: Buffer.from("abc") });
  await f.db.prepare("UPDATE users SET disabled_at=unixepoch() WHERE id='owner'").run();
  const account = (await adminCall(f, "/accounts/owner")).account;
  assert.equal(account.active_uploads, 1); assert.equal(account.reserved_bytes, 3);
  await adminCall(f, "/transfers", { method: "POST", data: { source_user_id: "owner", target_user_id: "editor", version: account.version, reason: "Wait for pending upload cleanup" }, expected: 409 });
  await adminCall(f, "/accounts/owner/cancel-uploads", { method: "POST", data: { version: account.version, reason: "Former owner's incomplete upload" }, actor: "viewer", expected: 403 });
  await adminCall(f, "/accounts/owner/cancel-uploads", { method: "POST", data: { version: account.version, reason: "Former owner's incomplete upload" } });
  assert.equal((await adminCall(f, "/accounts/owner")).account.reserved_bytes, 0);
  await adminCall(f, "/transfers", { method: "POST", data: { source_user_id: "owner", target_user_id: "editor", version: account.version, reason: "Handover after safe cancellation" }, expected: 202 });
  await f.recover();
  assert.equal((await f.item(folder.id, "editor")).effective_role, "owner");
  assert.equal((await f.bucket.list()).objects.length, 0);
  assert.equal((await adminCall(f, "/activity?kind=admin&action=uploads_cancelled")).items.length, 1);
});
