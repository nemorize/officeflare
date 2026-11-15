import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { fixture } from "./ai-fixture.mjs";
import { COLLABORATION_PROTOCOL, decodeBytes, encodeBytes } from "../shared/collaboration.ts";

const rpc = (f, name, args = {}, { token, actor = "alice", key } = {}) =>
  f.call("/api/mcp", {
    actor: token ? null : actor,
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: name === "tools/list" ? name : "tools/call",
      params: name === "tools/list" ? {} : { name, arguments: args },
    },
  });
function result(response) {
  assert.equal(response.result.isError, false, JSON.stringify(response));
  return response.result.structuredContent;
}
const read = async (f, page, options) =>
  result(await rpc(f, "wiki.get_page", { page_id: page }, options)).page;
const spaces = async (f, actor = "alice") => (await f.call("/api/wiki/spaces", { actor })).spaces;
const direct = (f, name, args, operation = crypto.randomUUID(), actor = "alice", expected = 200) =>
  f.testCall("tool", { name, args, operation, principal: f.principals[actor] }, expected);
const create = async (
  f,
  space_id,
  title = "Notes",
  text = "Initial body",
  actor = "alice",
  operation,
) => (await direct(f, "wiki.create_page", { space_id, title, text }, operation, actor)).page;
const updateArgs = (page, changes) => ({
  page_id: page.id,
  version: page.version,
  epoch: page.epoch,
  seq: page.seq,
  ...changes,
});
async function key(f, scopes, constraints = {}, actor = "alice") {
  return (
    await f.call("/api/mcp/api-keys", {
      actor,
      method: "POST",
      data: {
        name: "Wiki client",
        scopes,
        constraints,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      expected: 201,
    })
  ).key.token;
}
async function approve(f, operation, actor = "alice", expected = 200) {
  const review = await f.call(`/api/mcp/operations/${operation.operation_id}`, { actor });
  return f.call(`/api/mcp/operations/${operation.operation_id}/decision`, {
    actor,
    method: "POST",
    data: { decision: "allow", intent_hash: review.operation.intent_hash },
    expected,
  });
}
async function completed(f, operation) {
  await f.testCall("operation", { id: operation.operation_id });
  return (await f.call(`/api/mcp/operations/${operation.operation_id}`)).operation;
}
async function connect(t, f, resource) {
  const { ticket } = await f.call(`/api/collaboration/resources/${resource}/sessions`, {
    method: "POST",
  });
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
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  ws.accept();
  t.after(() => {
    try {
      ws.close();
    } catch {}
  });
  const queue = [],
    waiters = [];
  ws.addEventListener("message", (event) => {
    queue.push(JSON.parse(event.data));
    for (const wake of [...waiters]) wake();
  });
  const next = (type) =>
    new Promise((resolve, reject) => {
      const remove = () => {
        const index = waiters.indexOf(wake);
        if (index >= 0) waiters.splice(index, 1);
      };
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`Missing ${type}: ${JSON.stringify(queue)}`));
      }, 8000);
      const wake = () => {
        const index = queue.findIndex((item) => item.type === type);
        if (index >= 0) {
          clearTimeout(timer);
          remove();
          resolve(queue.splice(index, 1)[0]);
        }
      };
      waiters.push(wake);
      wake();
    });
  const send = (data) => ws.send(JSON.stringify(data));
  send({ type: "auth", ticket });
  return { next, send };
}

test("wiki tools are registered, scoped by space and respect personal page access", async (t) => {
  const f = await fixture(t, { configure: false, wiki: true });
  const alice = (await spaces(f))[0],
    bob = (await spaces(f, "bob"))[0];
  const page = await create(f, alice.id, "Release notes", "Searchable release body");
  const privatePage = await create(f, bob.id, "Bob private", "Private body", "bob");
  const connection = (
    await f.call("/api/ai/mcp/connections", {
      method: "POST",
      data: { server_id: "system-mcp-wiki", name: "Wiki" },
      expected: 201,
    })
  ).connection;
  const tools = (await f.call(`/api/ai/mcp/connections/${connection.id}/tools`)).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["wiki.list_spaces", "wiki.search", "wiki.get_page", "wiki.create_page", "wiki.update_page"],
  );
  const token = await key(f, ["wiki.read"], { wiki_space_ids: [alice.id] });
  const listed = await rpc(f, "tools/list", {}, { token });
  assert.deepEqual(
    listed.result.tools.filter((tool) => tool.name.startsWith("wiki.")).map((tool) => tool.name),
    ["wiki.list_spaces", "wiki.search", "wiki.get_page"],
  );
  assert.deepEqual(
    result(await rpc(f, "wiki.list_spaces", {}, { token })).spaces.map((space) => space.id),
    [alice.id],
  );
  assert.equal(
    result(await rpc(f, "wiki.search", { space_id: alice.id, query: "release body" }, { token }))
      .pages[0].id,
    page.id,
  );
  assert.equal((await read(f, page.id, { token })).text, "Searchable release body");
  const denied = await rpc(f, "wiki.get_page", { page_id: privatePage.id }, { token });
  assert.equal(denied.result.isError, true);
  assert.ok(!JSON.stringify(denied).includes("Private body"));
  const privateDenied = await rpc(f, "wiki.get_page", { page_id: privatePage.id });
  assert.equal(privateDenied.result.isError, true);
  assert.ok(!JSON.stringify(privateDenied).includes("Private body"));
  assert.equal(
    (
      await rpc(
        f,
        "wiki.create_page",
        { space_id: alice.id, title: "Denied", text: "Denied" },
        { token },
      )
    ).result.isError,
    true,
  );
  const other = (
    await f.call("/api/wiki/spaces", { method: "POST", data: { name: "Other" }, expected: 201 })
  ).space;
  assert.equal(
    (await rpc(f, "wiki.search", { space_id: other.id }, { token })).result.isError,
    true,
  );
});

test("approved wiki creation and repeated delivery create one page and preserve its body", async (t) => {
  const f = await fixture(t, { configure: false, wiki: true });
  const space = (await spaces(f))[0],
    token = await key(f, ["wiki.read", "wiki.write"]);
  const args = {
    space_id: space.id,
    title: "Approved title",
    text: "First paragraph\n\nSecond paragraph",
  };
  const proposed = result(await rpc(f, "wiki.create_page", args, { token, key: "create-wiki" }));
  assert.equal(proposed.requires_human_approval, true);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM wiki_pages").first()).n, 0);
  await approve(f, proposed);
  await Promise.all([
    f.testCall("operation", { id: proposed.operation_id }),
    f.testCall("operation", { id: proposed.operation_id }),
  ]);
  const operation = (await f.call(`/api/mcp/operations/${proposed.operation_id}`)).operation;
  assert.equal(operation.status, "succeeded", JSON.stringify(operation));
  const page = operation.result.page;
  assert.equal(page.title, args.title);
  assert.equal(page.text, args.text);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM wiki_pages").first()).n, 1);
  const stored = await f.db
    .prepare("SELECT operation_key FROM mcp_tool_operations WHERE id=?")
    .bind(proposed.operation_id)
    .first();
  const replay = await create(f, space.id, args.title, args.text, "alice", stored.operation_key);
  assert.equal(replay.id, page.id);
  assert.equal(replay.seq, page.seq);
  await direct(
    f,
    "wiki.create_page",
    { ...args, text: "Changed input" },
    stored.operation_key,
    "alice",
    409,
  );
  assert.equal((await read(f, page.id)).text, args.text);
  const indexed = result(
    await rpc(f, "wiki.search", { space_id: space.id, query: "Second paragraph" }, { token }),
  );
  assert.equal(indexed.pages[0].id, page.id);
  const [one, two] = await Promise.all(
    [1, 2].map(() =>
      f.call(`/api/wiki/spaces/${space.id}/pages`, {
        method: "POST",
        data: {},
        headers: { "Idempotency-Key": "parallel-wiki-create" },
        expected: 201,
      }),
    ),
  );
  assert.equal(one.page.id, two.page.id);
});

test("wiki approvals track live CRDT edits and approved changes reach connected editors", async (t) => {
  const f = await fixture(t, { configure: false, wiki: true });
  const space = (await spaces(f))[0],
    token = await key(f, ["wiki.read", "wiki.write"]);
  const page = await create(f, space.id);
  const socket = await connect(t, f, page.resource_id),
    ready = await socket.next("ready");
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  Y.applyUpdate(doc, decodeBytes(ready.state));
  const stale = result(
    await rpc(f, "wiki.update_page", updateArgs(page, { text: "Stale replacement" }), { token }),
  );
  const before = Y.encodeStateVector(doc);
  doc.getText("title").insert(0, "Human ");
  socket.send({
    type: "update",
    epoch: ready.epoch,
    id: "human-edit",
    update: encodeBytes(Y.encodeStateAsUpdate(doc, before)),
  });
  await socket.next("ack");
  await approve(f, stale, "alice", 409);
  const fresh = await read(f, page.id);
  assert.equal(fresh.title, "Human Notes");
  assert.ok(fresh.seq > page.seq);
  const proposed = result(
    await rpc(f, "wiki.update_page", updateArgs(fresh, { text: "Approved body" }), { token }),
  );
  await approve(f, proposed);
  const done = await completed(f, proposed);
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const update = await socket.next("update");
  Y.applyUpdate(doc, decodeBytes(update.update));
  assert.equal(doc.getText("title").toString(), "Human Notes");
  assert.equal(doc.getXmlFragment("content").toString(), "<paragraph>Approved body</paragraph>");
  const latest = await read(f, page.id);
  const metadataStale = result(
    await rpc(f, "wiki.update_page", updateArgs(latest, { title: "Stale title" }), { token }),
  );
  await f.call(`/api/wiki/pages/${page.id}`, {
    method: "PATCH",
    data: { icon: "book", version: latest.version },
  });
  await approve(f, metadataStale, "alice", 409);
  assert.equal((await read(f, page.id)).title, "Human Notes");
});

test("wiki writes require current permissions and reject invalid bodies before creating a page", async (t) => {
  const f = await fixture(t, { configure: false, wiki: true });
  const space = (await spaces(f))[0],
    token = await key(f, ["wiki.write"]);
  const invalid = await rpc(
    f,
    "wiki.create_page",
    { space_id: space.id, title: "Oversized document", text: "\n".repeat(16000) },
    { token },
  );
  assert.equal(invalid.result.isError, true);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM wiki_pages").first()).n, 0);
  const page = await create(f, space.id);
  const proposed = result(
    await rpc(f, "wiki.update_page", updateArgs(page, { text: "Must not write" }), { token }),
  );
  await approve(f, proposed);
  await f.db
    .prepare("DELETE FROM user_roles WHERE user_id='alice' AND role_id='system-wiki-user'")
    .run();
  await f.db
    .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('alice','system-wiki-reader')")
    .run();
  await f.testCall("operation", { id: proposed.operation_id });
  assert.equal(
    (await f.call(`/api/mcp/operations/${proposed.operation_id}`)).operation.status,
    "failed",
  );
  assert.equal((await read(f, page.id)).text, "Initial body");
  await f.call("/api/mcp/api-keys", {
    method: "POST",
    data: {
      name: "Denied",
      scopes: ["wiki.write"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
    expected: 403,
  });
  const tools = await rpc(f, "tools/list");
  assert.equal(tools.result.tools.filter((tool) => tool.name.startsWith("wiki.")).length, 3);
  await f.db
    .prepare(
      "INSERT INTO role_permissions(role_id,permission_key) VALUES('system-wiki-reader','wiki.pages.create')",
    )
    .run();
  const createOnly = await rpc(f, "tools/list");
  assert.ok(!createOnly.result.tools.some((tool) => tool.name === "wiki.create_page"));
  await direct(
    f,
    "wiki.create_page",
    { space_id: space.id, title: "No editor permission", text: "Denied" },
    crypto.randomUUID(),
    "alice",
    403,
  );
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM wiki_pages").first()).n, 1);
});

test("shared wiki restrictions and workspace creation policy still apply through MCP", async (t) => {
  const f = await fixture(t, { configure: false, wiki: true });
  const space = (
    await f.call("/api/wiki/spaces", { method: "POST", data: { name: "Shared" }, expected: 201 })
  ).space;
  const page = await create(f, space.id, "Restricted notes", "Restricted body");
  const members = await f.call(`/api/wiki/spaces/${space.id}/members`);
  await f.call(`/api/wiki/spaces/${space.id}/members`, {
    method: "PUT",
    data: { email: "bob@office.test", role: "editor", version: members.version },
  });
  assert.equal((await read(f, page.id, { actor: "bob" })).text, "Restricted body");
  const current = (await f.call(`/api/wiki/spaces/${space.id}`)).space;
  await f.call(`/api/wiki/pages/${page.id}/grants`, {
    method: "PUT",
    data: {
      permission_mode: "restricted",
      grants: [],
      version: page.version,
      acl_version: current.acl_version,
    },
  });
  const denied = await rpc(f, "wiki.get_page", { page_id: page.id }, { actor: "bob" });
  assert.equal(denied.result.isError, true);
  assert.ok(!JSON.stringify(denied).includes("Restricted body"));
  assert.deepEqual(
    result(await rpc(f, "wiki.search", { space_id: space.id }, { actor: "bob" })).pages,
    [],
  );
  assert.equal(
    (await rpc(f, "wiki.update_page", updateArgs(page, { text: "Forbidden" }), { actor: "bob" }))
      .result.isError,
    true,
  );
  const token = await key(f, ["wiki.write"]);
  const proposed = result(
    await rpc(
      f,
      "wiki.create_page",
      { space_id: space.id, title: "Policy denied", text: "Must not exist" },
      { token },
    ),
  );
  await approve(f, proposed);
  await f.db
    .prepare(
      "UPDATE console_settings SET values_json=json_set(values_json,'$.pages_enabled',0) WHERE service='wiki'",
    )
    .run();
  assert.notEqual((await completed(f, proposed)).status, "succeeded");
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM wiki_pages").first()).n, 1);
});
