import { test } from "node:test";
import { build } from "esbuild";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { fixture as baseFixture } from "./calendar-fixture.mjs";
import { encodeBytes, decodeBytes, COLLABORATION_PROTOCOL } from "../shared/collaboration.ts";
import {
  wikiUserPermissions,
  permissionClosure,
  defaultEligible,
} from "../src/authorization/permissions.ts";

const harness = await build({
  entryPoints: ["tests/collaboration-harness.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers", "cloudflare:sockets", "node:*"],
  loader: { ".sql": "text" },
  logLevel: "error",
});
const workerEntry = {
  type: "ESModule",
  path: "tests/collaboration-harness.mjs",
  contents: harness.outputFiles[0].text,
};

async function fixture(t, { probe = false, assets = false } = {}) {
  const f = await baseFixture(t, {
    collaboration: true,
    assets,
    ...(probe ? { workerEntry } : {}),
  });
  for (const user of ["alice", "bob", "read-only"])
    await f.db
      .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
      .bind(user, user === "read-only" ? "system-wiki-reader" : "system-wiki-user")
      .run();
  const raw = (path, { actor = "alice", method = "GET", data, headers = {} } = {}) =>
    f.mf.dispatchFetch(`https://office.test/api${path}`, {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${f.tokens[actor]}` } : {}),
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const call = async (path, options = {}) => {
    const response = await raw(path, options);
    assert.equal(
      response.status,
      options.expected ?? 200,
      `${options.method ?? "GET"} ${path}: ${await response.clone().text()}`,
    );
    return response.status === 204 ? null : response.json();
  };
  const space = async (name = "Knowledge", actor = "alice") =>
    (await call("/wiki/spaces", { method: "POST", data: { name }, actor, expected: 201 })).space;
  const page = async (space, parent_id = null, actor = "alice") =>
    (
      await call(`/wiki/spaces/${space}/pages`, {
        method: "POST",
        data: { parent_id },
        actor,
        expected: 201,
      })
    ).page;
  const member = async (space, user, role) => {
    const current = await call(`/wiki/spaces/${space}/members`);
    return call(`/wiki/spaces/${space}/members`, {
      method: "PUT",
      data: { email: `${user}@office.test`, role, version: current.version },
    });
  };
  const connect = async (resource, actor = "alice", providedTicket) => {
    const { ticket } = providedTicket
      ? { ticket: providedTicket }
      : await call(`/collaboration/resources/${resource}/sessions`, { method: "POST", actor });
    const response = await f.mf.dispatchFetch(
      `https://office.test/api/collaboration/resources/${resource}/sync`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: "https://office.test",
          "Sec-WebSocket-Protocol": COLLABORATION_PROTOCOL,
        },
      },
    );
    assert.equal(response.status, 101, response.status === 101 ? undefined : await response.text());
    const ws = response.webSocket;
    assert.ok(ws);
    ws.accept();
    const messages = [],
      waiters = [];
    const closed = new Promise((resolve) => ws.addEventListener("close", resolve));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      messages.push(message);
      for (const wake of [...waiters]) wake();
    });
    const next = (type, predicate = () => true) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          remove();
          reject(new Error(`Missing ${type}: ${JSON.stringify(messages)}`));
        }, 8000);
        const remove = () => {
          const i = waiters.indexOf(wake);
          if (i !== -1) waiters.splice(i, 1);
        };
        const wake = () => {
          const index = messages.findIndex((m) => m.type === type && predicate(m));
          if (index !== -1) {
            clearTimeout(timer);
            remove();
            resolve(messages.splice(index, 1)[0]);
          }
        };
        waiters.push(wake);
        wake();
      });
    ws.send(JSON.stringify({ type: "auth", ticket }));
    t.after(() => {
      try {
        ws.close();
      } catch {}
    });
    return { ws, next, closed, ticket, send: (message) => ws.send(JSON.stringify(message)) };
  };
  return { ...f, raw, call, space, page, member, connect };
}

test("Wiki spaces, nested restrictions, role ceilings and guarded tree mutations", async (t) => {
  const f = await fixture(t),
    space = await f.space(),
    other = await f.space("Other", "bob"),
    root = await f.page(space.id),
    child = await f.page(space.id, root.id);
  assert.equal(defaultEligible(wikiUserPermissions), true);
  assert.deepEqual(permissionClosure(wikiUserPermissions).sort(), [...wikiUserPermissions].sort());
  await f.call("/wiki/spaces", { actor: null, expected: 401 });
  await f.call("/wiki/spaces", { actor: "no-calendar", expected: 403 });
  await f.call(`/wiki/pages/${root.id}`, { actor: "bob", expected: 404 });
  await f.call(`/wiki/spaces/${other.id}`, { expected: 404 });
  await f.member(space.id, "bob", "editor");
  await f.member(space.id, "read-only", "manager");
  await f.call(`/wiki/pages/${child.id}`, { actor: "bob" });
  await f.call(`/wiki/spaces/${space.id}/pages`, {
    actor: "read-only",
    method: "POST",
    data: {},
    expected: 403,
  });
  const acl = await f.call(`/wiki/pages/${child.id}/grants`);
  await f.call(`/wiki/pages/${child.id}/grants`, {
    method: "PUT",
    data: {
      permission_mode: "restricted",
      grants: [],
      version: acl.version,
      acl_version: acl.acl_version,
    },
  });
  await f.call(`/wiki/pages/${child.id}`, { actor: "bob", expected: 404 });
  assert.deepEqual(
    (await f.call(`/wiki/spaces/${space.id}/pages`, { actor: "bob" })).pages.map((p) => p.id),
    [root.id],
  );
  await f.call(`/wiki/pages/${root.id}/trash`, {
    actor: "bob",
    method: "POST",
    data: { version: root.version },
    expected: 412,
  });
  await f.call(`/wiki/pages/${root.id}/moves`, {
    method: "POST",
    data: { parent_id: child.id, version: root.version },
    expected: 412,
  });
  assert.equal((await f.call(`/wiki/pages/${root.id}`)).page.parent_id, null);
  await f.call(`/wiki/pages/${root.id}/trash`, { method: "POST", data: { version: root.version } });
  await f.call(`/wiki/pages/${child.id}`, { expected: 404 });
  const trashed = (await f.call(`/wiki/spaces/${space.id}/pages?trash=true`)).pages.find(
    (p) => p.id === root.id,
  );
  await f.call(`/wiki/pages/${root.id}/restore`, {
    method: "POST",
    data: { version: trashed.version },
  });
  await f.call(`/wiki/pages/${child.id}`, { actor: "bob", expected: 404 });
  await f.call(`/wiki/pages/${child.id}`);
  const current = await f.call(`/wiki/pages/${child.id}/grants`);
  await f.call(`/wiki/pages/${child.id}/grants`, {
    method: "PUT",
    data: {
      permission_mode: "restricted",
      grants: [{ user_id: "bob", role: "editor" }],
      version: current.version,
      acl_version: current.acl_version,
    },
  });
  await f.call(`/wiki/pages/${child.id}`, { actor: "bob" });
  const members = await f.call(`/wiki/spaces/${space.id}/members`);
  await f.call(`/wiki/spaces/${space.id}/members/bob?version=${members.version}`, {
    method: "DELETE",
    expected: 204,
  });
  await f.member(space.id, "bob", "viewer");
  await f.call(`/wiki/pages/${child.id}`, { actor: "bob", expected: 404 });
  assert.equal((await f.call(`/wiki/pages/${root.id}`, { actor: "bob" })).page.role, 1);
});

test("Collaboration merges concurrent edits, acknowledges durability and survives reconnect", async (t) => {
  const f = await fixture(t),
    space = await f.space(),
    page = await f.page(space.id);
  await f.member(space.id, "bob", "editor");
  const alice = await f.connect(page.resource_id),
    bob = await f.connect(page.resource_id, "bob"),
    a = await alice.next("ready"),
    b = await bob.next("ready");
  const docA = new Y.Doc(),
    docB = new Y.Doc();
  Y.applyUpdate(docA, decodeBytes(a.state));
  Y.applyUpdate(docB, decodeBytes(b.state));
  let updateA, updateB;
  docA.on("update", (u, origin) => {
    if (origin !== "remote") updateA = u;
  });
  docB.on("update", (u, origin) => {
    if (origin !== "remote") updateB = u;
  });
  docA.getText("title").insert(0, "Alpha");
  docB.getText("title").insert(0, "Beta");
  alice.send({ type: "update", epoch: a.epoch, id: "alice-1", update: encodeBytes(updateA) });
  bob.send({ type: "update", epoch: b.epoch, id: "bob-1", update: encodeBytes(updateB) });
  const ackA = await alice.next("ack"),
    ackB = await bob.next("ack");
  Y.applyUpdate(docA, decodeBytes((await alice.next("update")).update), "remote");
  Y.applyUpdate(docB, decodeBytes((await bob.next("update")).update), "remote");
  assert.equal(docA.getText("title").toString(), docB.getText("title").toString());
  assert.match(docA.getText("title").toString(), /Alpha/);
  assert.match(docA.getText("title").toString(), /Beta/);
  const persisted = await f.call(`/collaboration/resources/${page.resource_id}/content`),
    server = new Y.Doc();
  Y.applyUpdate(server, decodeBytes(persisted.state));
  assert.equal(server.getText("title").toString(), docA.getText("title").toString());
  const exported = await f.raw(`/wiki/pages/${page.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /Alpha|Beta/);
  // Retrying the exact packet returns its original durable receipt.
  bob.send({ type: "update", epoch: b.epoch, id: "bob-1", update: encodeBytes(updateB) });
  assert.equal((await bob.next("ack")).seq, ackB.seq);
  bob.send({ type: "update", epoch: b.epoch, id: "bob-1", update: encodeBytes(updateA) });
  const rejected = await bob.next("error");
  assert.equal(rejected.code, "mutation_conflict");
  const again = await f.connect(page.resource_id),
    ready = await again.next("ready"),
    reconnected = new Y.Doc();
  Y.applyUpdate(reconnected, decodeBytes(ready.state));
  assert.equal(reconnected.getText("title").toString(), server.getText("title").toString());
  assert.equal(ready.seq, Math.max(ackA.seq, ackB.seq));
  const foreign = await f.space("Foreign", "bob"),
    foreignPage = await f.page(foreign.id, null, "bob");
  await f.call(`/collaboration/resources/${foreignPage.resource_id}/sessions`, {
    method: "POST",
    expected: 404,
  });
  const wrongOrigin = await f.mf.dispatchFetch(
    `https://office.test/api/collaboration/resources/${page.resource_id}/sync`,
    {
      headers: {
        Upgrade: "websocket",
        Origin: "https://attacker.test",
        "Sec-WebSocket-Protocol": COLLABORATION_PROTOCOL,
      },
    },
  );
  assert.equal(wrongOrigin.status, 403);
});

test("Readers cannot write; membership revocation closes live access; restore fences old epochs", async (t) => {
  const f = await fixture(t),
    space = await f.space(),
    page = await f.page(space.id);
  await f.member(space.id, "bob", "viewer");
  const reader = await f.connect(page.resource_id, "bob"),
    ready = await reader.next("ready");
  assert.equal(ready.capabilities.write, false);
  const rogue = new Y.Doc();
  Y.applyUpdate(rogue, decodeBytes(ready.state));
  let update;
  rogue.on("update", (u) => (update = u));
  rogue.getText("title").insert(0, "Forbidden");
  reader.send({ type: "update", epoch: ready.epoch, id: "forbidden", update: encodeBytes(update) });
  assert.equal((await reader.next("error")).code, "read_only");
  await f.member(space.id, "bob", "editor");
  const writer = await f.connect(page.resource_id, "bob"),
    writerReady = await writer.next("ready");
  assert.equal(writerReady.capabilities.write, true);
  const replay = await f.connect(page.resource_id, "bob", writer.ticket);
  await replay.next("error");
  const members = await f.call(`/wiki/spaces/${space.id}/members`);
  await f.call(`/wiki/spaces/${space.id}/members/bob?version=${members.version}`, {
    method: "DELETE",
    expected: 204,
  });
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Revocation was not enforced")), 7000);
    t.after(() => clearTimeout(timer));
  });
  const close = await Promise.race([writer.closed, timeout]);
  assert.equal(close.code, 4003);
  await f.call(`/collaboration/resources/${page.resource_id}/content`, {
    actor: "bob",
    expected: 404,
  });
  const owner = await f.connect(page.resource_id),
    ownerReady = await owner.next("ready"),
    document = new Y.Doc();
  Y.applyUpdate(document, decodeBytes(ownerReady.state));
  const snapshot = await f.call(`/collaboration/resources/${page.resource_id}/snapshots`, {
    method: "POST",
  });
  document.on("update", (u) => (update = u));
  document.getText("title").insert(0, "Changed");
  owner.send({
    type: "update",
    epoch: ownerReady.epoch,
    id: "change",
    update: encodeBytes(update),
  });
  await owner.next("ack");
  const restored = await f.call(`/collaboration/resources/${page.resource_id}/restores`, {
    method: "POST",
    data: { snapshot_id: snapshot.id, epoch: ownerReady.epoch },
    headers: { "Idempotency-Key": "restore-test" },
  });
  assert.equal(restored.epoch, ownerReady.epoch + 1);
  await owner.next("reset");
  const fresh = await f.connect(page.resource_id),
    next = await fresh.next("ready"),
    restoredDoc = new Y.Doc();
  Y.applyUpdate(restoredDoc, decodeBytes(next.state));
  assert.equal(restoredDoc.getText("title").toString(), "");
  fresh.send({ type: "update", epoch: ownerReady.epoch, id: "stale", update: encodeBytes(update) });
  await fresh.next("reset");
});

test("Wiki comments, attachments and stale mutations remain scoped to the page", async (t) => {
  const f = await fixture(t),
    space = await f.space(),
    page = await f.page(space.id),
    other = await f.space("Bob", "bob"),
    foreign = await f.page(other.id, null, "bob");
  await f.member(space.id, "bob", "commenter");
  const comment = await f.call(`/wiki/pages/${page.id}/comments`, {
    method: "POST",
    actor: "bob",
    data: { body: "Review this" },
    expected: 201,
  });
  await f.call(`/wiki/pages/${foreign.id}/comments/${comment.id}`, {
    method: "PATCH",
    actor: "bob",
    data: { version: 1, body: "Wrong page" },
    expected: 404,
  });
  await f.call(`/wiki/pages/${page.id}`, {
    method: "PATCH",
    actor: "bob",
    data: { icon: "X", version: 1 },
    expected: 403,
  });
  await f.call(`/wiki/pages/${page.id}`, { method: "PATCH", data: { icon: "📚", version: 1 } });
  await f.call(`/wiki/pages/${page.id}`, {
    method: "PATCH",
    data: { icon: "X", version: 1 },
    expected: 412,
  });
  const upload = await f.mf.dispatchFetch(
    `https://office.test/api/wiki/pages/${page.id}/assets?filename=notes.txt`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${f.tokens.alice}`, "Content-Type": "text/plain" },
      body: "Private notes",
    },
  );
  assert.equal(upload.status, 201, await upload.clone().text());
  const { asset } = await upload.json();
  const content = await f.raw(`/wiki/pages/${page.id}/assets/${asset.id}`, { actor: "bob" });
  assert.equal(content.status, 200);
  assert.equal(await content.text(), "Private notes");
  await f.call(`/wiki/pages/${foreign.id}/assets/${asset.id}`, { actor: "bob", expected: 404 });
});

test("The same collaboration engine supports a non-wiki adapter and restart recovery", async (t) => {
  const f = await fixture(t, { probe: true }),
    resource = crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO collaboration_resources(id,service,resource_id,schema_key) VALUES(?,'probe','alice','counter.v1')",
    )
    .bind(resource)
    .run();
  await f.call(`/collaboration/resources/${resource}/sessions`, {
    method: "POST",
    actor: "bob",
    expected: 404,
  });
  const connection = await f.connect(resource),
    ready = await connection.next("ready"),
    doc = new Y.Doc();
  Y.applyUpdate(doc, decodeBytes(ready.state));
  assert.equal(ready.schema_key, "counter.v1");
  let update;
  doc.on("update", (u) => (update = u));
  for (let count = 1; count <= 55; count++) {
    doc.getMap("properties").set("count", count);
    connection.send({
      type: "update",
      epoch: ready.epoch,
      id: `counter-${count}`,
      update: encodeBytes(update),
    });
    assert.equal((await connection.next("ack")).seq, count);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await f.mf.dispatchFetch("https://office.test/test-collaboration/restart", {
    method: "POST",
    body: JSON.stringify({ id: resource }),
  });
  const again = await f.connect(resource),
    recovered = await again.next("ready"),
    state = new Y.Doc();
  Y.applyUpdate(state, decodeBytes(recovered.state));
  assert.equal(state.getMap("properties").get("count"), 55);
  assert.equal(recovered.seq, 55);
  const bucket = await f.mf.getR2Bucket("WIKI_BUCKET");
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await bucket.get(`probe/${resource}`);
    if (value && JSON.parse(await value.text()).count === 55) break;
    if (attempt === 29) assert.fail("Projection was not recovered");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test("Permanent deletion retires collaboration and recovers object cleanup", async (t) => {
  const f = await fixture(t, { probe: true }),
    space = await f.space(),
    page = await f.page(space.id),
    child = await f.page(space.id, page.id);
  const connection = await f.connect(child.resource_id);
  await connection.next("ready");
  const response = await f.mf.dispatchFetch(
    `https://office.test/api/wiki/pages/${child.id}/assets?filename=test.txt`,
    { method: "POST", headers: { Authorization: `Bearer ${f.tokens.alice}` }, body: "purge me" },
  );
  assert.equal(response.status, 201);
  const asset = (await response.json()).asset,
    record = await f.db
      .prepare("SELECT object_key FROM wiki_assets WHERE id=?")
      .bind(asset.id)
      .first();
  await f.call(`/wiki/pages/${child.id}/comments`, {
    method: "POST",
    data: { body: "private" },
    expected: 201,
  });
  await f.call(`/wiki/pages/${page.id}/trash`, { method: "POST", data: { version: page.version } });
  await f.call(`/wiki/pages/${page.id}?version=${page.version + 1}`, {
    method: "DELETE",
    expected: 204,
  });
  await f.call(`/collaboration/resources/${child.resource_id}/content`, { expected: 404 });
  const recovery = await f.mf.dispatchFetch("https://office.test/test-collaboration/recover");
  assert.equal(recovery.status, 200);
  assert.equal((await connection.closed).code, 4003);
  const bucket = await f.mf.getR2Bucket("WIKI_BUCKET");
  assert.equal(await bucket.get(record.object_key), null);
  assert.equal(
    (
      await f.db
        .prepare("SELECT COUNT(*) n FROM wiki_comments WHERE page_id=?")
        .bind(child.id)
        .first()
    ).n,
    0,
  );
  assert.ok(
    (
      await f.db
        .prepare("SELECT purged_at FROM collaboration_resources WHERE id=?")
        .bind(child.resource_id)
        .first()
    ).purged_at,
  );
  await f.call(`/wiki/pages/${page.id}/restore`, {
    method: "POST",
    data: { version: page.version + 2 },
    expected: 404,
  });
});
