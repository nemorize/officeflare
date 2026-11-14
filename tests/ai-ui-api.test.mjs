import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./ai-fixture.mjs";

test("AI screen reads recover room state and keep other users' histories private", async (t) => {
  const f = await fixture(t);
  const room = (
    await f.call("/api/ai/rooms", {
      method: "POST",
      data: { title: "Private", profile_key: f.profile.key, instructions: "Use concise answers" },
      expected: 201,
    })
  ).room;
  const connection = (
    await f.call("/api/ai/mcp/connections", {
      method: "POST",
      data: { server_id: "system-mcp-contacts", name: "Contacts" },
      expected: 201,
    })
  ).connection;
  await f.call(`/api/ai/rooms/${room.id}/mcp-bindings`, {
    method: "PUT",
    data: {
      version: room.version,
      bindings: [{ connection_id: connection.id, allowed_tools: ["contacts.search"] }],
    },
  });
  const run = (
    await f.call(`/api/ai/rooms/${room.id}/runs`, {
      method: "POST",
      data: { message: "Hello" },
      headers: { "Idempotency-Key": "ui-read" },
      expected: 202,
    })
  ).run;
  assert.equal((await f.call(`/api/ai/rooms/${room.id}`)).room.instructions, "Use concise answers");
  assert.equal((await f.call(`/api/ai/rooms/${room.id}/runs`)).runs[0].id, run.id);
  assert.equal(
    (await f.call(`/api/ai/rooms/${room.id}/mcp-bindings`)).bindings[0].connection_id,
    connection.id,
  );
  for (const suffix of ["", "/runs", "/mcp-bindings"])
    await f.call(`/api/ai/rooms/${room.id}${suffix}`, { actor: "bob", expected: 404 });
  assert.equal(typeof (await f.call("/api/ai/quota")).user_subject_id, "string");
});

test("AI console relationship and user directory reads require their scoped administrator permissions", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.admin(`/pools/${f.pool.id}/members`)).members[0].account_id, f.account.id);
  assert.equal(
    (await f.admin("/consumers/hub.chat/profiles")).profiles[0].profile_id,
    f.profile.id,
  );
  assert.ok((await f.admin("/quota-plans/system-ai-user/rules")).rules.length > 0);
  const directory = await f.admin("/users?q=alice");
  assert.deepEqual(
    directory.users.map((user) => user.id),
    ["alice"],
  );
  assert.ok(!JSON.stringify(directory).includes("password_hash"));
  assert.equal((await f.admin("/settings")).encryption_ready, true);
  for (const path of [
    `/pools/${f.pool.id}/members`,
    "/consumers/hub.chat/profiles",
    "/quota-plans/system-ai-user/rules",
    "/users?q=alice",
  ])
    await f.call("/api/ai/admin" + path, { expected: 403 });
});
