import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fixture } from "./ai-fixture.mjs";

const accept = { Accept: "application/json, text/event-stream" };
async function grant(f, requested = "contacts.read", actor = "alice") {
  const client = await f.call("/api/mcp/oauth/register", {
    actor: null,
    method: "POST",
    data: {
      client_name: "External test client",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
    },
    expected: 201,
  });
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "https://office.test/api/mcp",
    scope: requested,
    state: "fixture-state",
  });
  const authorization = await f.mf.dispatchFetch(
    "https://office.test/api/mcp/oauth/authorize?" + query,
    { redirect: "manual" },
  );
  assert.equal(authorization.status, 302, await authorization.clone().text());
  const id = new URL(authorization.headers.get("location")).searchParams.get("request");
  const consent = await f.call(`/api/mcp/oauth/requests/${id}`, { actor });
  assert.equal(consent.request.client_name, "External test client");
  const decision = await f.call(`/api/mcp/oauth/requests/${id}/decision`, {
    actor,
    method: "POST",
    data: { decision: "allow" },
  });
  const callback = new URL(decision.redirect_uri);
  assert.equal(callback.searchParams.get("state"), "fixture-state");
  const form = {
    client_id: client.client_id,
    grant_type: "authorization_code",
    code: callback.searchParams.get("code"),
    redirect_uri: client.redirect_uris[0],
    code_verifier: verifier,
    resource: "https://office.test/api/mcp",
  };
  const tokens = await f.call("/api/mcp/oauth/token", { actor: null, method: "POST", form });
  return { client, verifier, form, tokens, id };
}
const rpc = (f, token, method, params, options = {}) =>
  f.call("/api/mcp", {
    actor: null,
    method: "POST",
    data: { jsonrpc: "2.0", id: options.id ?? 1, method, params },
    headers: { ...accept, Authorization: "Bearer " + token, ...options.headers },
    expected: options.expected ?? 200,
  });

test("MCP exposes resource and OAuth discovery and rejects anonymous protocol access", async (t) => {
  const f = await fixture(t, { configure: false });
  const metadata = await f.call("/.well-known/oauth-protected-resource/api/mcp", { actor: null });
  assert.equal(metadata.resource, "https://office.test/api/mcp");
  assert.deepEqual(metadata.authorization_servers, ["https://office.test"]);
  const oauth = await f.call("/.well-known/oauth-authorization-server", { actor: null });
  assert.deepEqual(oauth.code_challenge_methods_supported, ["S256"]);
  const missing = await f.mf.dispatchFetch("https://office.test/api/mcp", {
    method: "POST",
    headers: { ...accept, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate"), /oauth-protected-resource/);
  const invalid = await f.mf.dispatchFetch("https://office.test/api/mcp", {
    method: "POST",
    headers: { ...accept, Authorization: "Bearer invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get("www-authenticate"), /invalid_token/);
});

test("external OAuth authorizes only scoped tools and tokens cannot access Officeflare account APIs", async (t) => {
  const f = await fixture(t, { configure: false }),
    connection = await grant(f);
  const initialized = await rpc(f, connection.tokens.access_token, "initialize", {
    protocolVersion: "2025-11-25",
  });
  assert.equal(initialized.result.serverInfo.name, "officeflare");
  const listed = await rpc(f, connection.tokens.access_token, "tools/list", {});
  assert.ok(listed.result.tools.some((tool) => tool.name === "contacts.search"));
  assert.ok(!listed.result.tools.some((tool) => tool.name === "contacts.create"));
  assert.ok(!listed.result.tools.some((tool) => tool.name.startsWith("mail.")));
  const result = await rpc(f, connection.tokens.access_token, "tools/call", {
    name: "contacts.search",
    arguments: {},
  });
  assert.equal(result.result.isError, false, JSON.stringify(result));
  const denied = await rpc(f, connection.tokens.access_token, "tools/call", {
    name: "contacts.create",
    arguments: { data: { display_name: "Denied" } },
  });
  assert.equal(denied.result.isError, true);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM contacts").first()).n, 0);
  await f.call("/api/me", {
    actor: null,
    headers: { Authorization: "Bearer " + connection.tokens.access_token },
    expected: 401,
  });
});

test("OAuth PKCE, redirect matching, token replay and scope expansion are rejected", async (t) => {
  const f = await fixture(t, { configure: false }),
    connection = await grant(f);
  await f.call("/api/mcp/oauth/token", {
    actor: null,
    method: "POST",
    form: connection.form,
    expected: 400,
  });
  await f.call("/api/mcp/oauth/token", {
    actor: null,
    method: "POST",
    form: {
      client_id: connection.client.client_id,
      grant_type: "refresh_token",
      refresh_token: connection.tokens.refresh_token,
      scope: "contacts.read contacts.write",
    },
    expected: 400,
  });
  const params = new URLSearchParams({
    client_id: connection.client.client_id,
    redirect_uri: "https://evil.example/callback",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(connection.verifier).digest("base64url"),
    scope: "contacts.read",
  });
  const mismatch = await f.mf.dispatchFetch(
    "https://office.test/api/mcp/oauth/authorize?" + params,
    { redirect: "manual" },
  );
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.headers.get("location"), null);
});

test("refresh rotation detects reuse and revokes all tokens of that external grant", async (t) => {
  const f = await fixture(t, { configure: false }),
    connection = await grant(f);
  const form = {
    client_id: connection.client.client_id,
    grant_type: "refresh_token",
    refresh_token: connection.tokens.refresh_token,
    resource: "https://office.test/api/mcp",
  };
  const next = await f.call("/api/mcp/oauth/token", { actor: null, method: "POST", form });
  assert.notEqual(next.access_token, connection.tokens.access_token);
  assert.notEqual(next.refresh_token, connection.tokens.refresh_token);
  await rpc(f, next.access_token, "tools/list", {});
  await f.call("/api/mcp/oauth/token", { actor: null, method: "POST", form, expected: 400 });
  await rpc(f, next.access_token, "tools/list", {}, { expected: 401 });
  await rpc(f, connection.tokens.access_token, "tools/list", {}, { expected: 401 });
  assert.equal((await f.call("/api/me")).user.id, "alice");
});

test("external writes are explicit approval operations and execute exactly once", async (t) => {
  const f = await fixture(t, { configure: false }),
    connection = await grant(f, "contacts.read contacts.write");
  const args = { data: { display_name: "External approved contact" } };
  const proposed = await rpc(
    f,
    connection.tokens.access_token,
    "tools/call",
    { name: "contacts.create", arguments: args },
    { headers: { "Idempotency-Key": "external-create" } },
  );
  assert.equal(proposed.result.isError, false);
  const operation = JSON.parse(proposed.result.content[0].text);
  assert.equal(operation.requires_human_approval, true);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM contacts").first()).n, 0);
  const repeated = await rpc(
    f,
    connection.tokens.access_token,
    "tools/call",
    { name: "contacts.create", arguments: args },
    { headers: { "Idempotency-Key": "external-create" } },
  );
  assert.equal(JSON.parse(repeated.result.content[0].text).operation_id, operation.operation_id);
  await f.call(`/api/mcp/operations/${operation.operation_id}`, { actor: "bob", expected: 404 });
  const review = await f.call(`/api/mcp/operations/${operation.operation_id}`);
  await f.call(`/api/mcp/operations/${operation.operation_id}/decision`, {
    method: "POST",
    data: { decision: "allow", intent_hash: review.operation.intent_hash },
  });
  await Promise.all([
    f.testCall("operation", { id: operation.operation_id }),
    f.testCall("operation", { id: operation.operation_id }),
  ]);
  const completed = await rpc(f, connection.tokens.access_token, "tools/call", {
    name: "officeflare.get_operation",
    arguments: { operation_id: operation.operation_id },
  });
  assert.equal(JSON.parse(completed.result.content[0].text).status, "succeeded");
  assert.equal((await f.db.prepare("SELECT count(*) n FROM contacts").first()).n, 1);
});

test("revoking a grant before an approved write prevents the domain mutation", async (t) => {
  const f = await fixture(t, { configure: false }),
    connection = await grant(f, "contacts.write");
  const proposed = await rpc(f, connection.tokens.access_token, "tools/call", {
    name: "contacts.create",
    arguments: { data: { display_name: "Must not exist" } },
  });
  const operation = JSON.parse(proposed.result.content[0].text),
    review = await f.call(`/api/mcp/operations/${operation.operation_id}`);
  await f.call(`/api/mcp/operations/${operation.operation_id}/decision`, {
    method: "POST",
    data: { decision: "allow", intent_hash: review.operation.intent_hash },
  });
  const connections = await f.call("/api/mcp/grants");
  await f.call(`/api/mcp/grants/${connections.grants[0].id}`, { method: "DELETE", expected: 204 });
  await f.testCall("operation", { id: operation.operation_id });
  assert.equal((await f.db.prepare("SELECT count(*) n FROM contacts").first()).n, 0);
  await rpc(f, connection.tokens.access_token, "tools/list", {}, { expected: 401 });
});

test("MCP API keys are scoped and revocable without widening legacy mail API keys", async (t) => {
  const f = await fixture(t, { configure: false });
  const key = await f.call("/api/mcp/api-keys", {
    method: "POST",
    data: {
      name: "External key",
      scopes: ["contacts.read"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
    expected: 201,
  });
  const listed = await rpc(f, key.key.token, "tools/list", {});
  assert.ok(listed.result.tools.some((tool) => tool.name === "contacts.get"));
  assert.ok(!listed.result.tools.some((tool) => tool.name === "contacts.create"));
  assert.ok(!JSON.stringify(await f.call("/api/mcp/api-keys")).includes(key.key.token));
  await f.call(`/api/mcp/api-keys/${key.key.id}`, { method: "DELETE", expected: 204 });
  await rpc(f, key.key.token, "tools/list", {}, { expected: 401 });
});

test("MCP enforces private contact ownership and registered Origin boundaries", async (t) => {
  const f = await fixture(t, { configure: false });
  const privateContact = (
    await f.call("/api/contacts", {
      actor: "bob",
      method: "POST",
      data: { display_name: "Bob secret" },
      expected: 201,
    })
  ).contact;
  const connection = await grant(f);
  const denied = await rpc(f, connection.tokens.access_token, "tools/call", {
    name: "contacts.get",
    arguments: { contact_id: privateContact.id },
  });
  assert.equal(denied.result.isError, true);
  assert.ok(!JSON.stringify(denied).includes("Bob secret"));
  await rpc(
    f,
    connection.tokens.access_token,
    "tools/list",
    {},
    { headers: { Origin: "https://evil.example" }, expected: 403 },
  );
  await rpc(
    f,
    connection.tokens.access_token,
    "tools/list",
    {},
    { headers: { Origin: "https://client.example" } },
  );
});

test("external MCP obeys per-user tool quotas independently of chat enablement", async (t) => {
  const f = await fixture(t, { configure: false }),
    connection = await grant(f);
  const quota = await f.admin("/users/alice/quota");
  await f.admin("/users/alice/quota", {
    method: "PUT",
    data: {
      version: quota.subject.version,
      overrides: [
        {
          metric: "tool_calls",
          window_kind: "day",
          scope_key: "consumer:mcp.tools",
          limit_value: 1,
        },
      ],
    },
  });
  const first = await rpc(f, connection.tokens.access_token, "tools/call", {
    name: "contacts.search",
    arguments: {},
  });
  assert.equal(first.result.isError, false);
  const blocked = await rpc(f, connection.tokens.access_token, "tools/call", {
    name: "contacts.search",
    arguments: {},
  });
  assert.equal(blocked.result.isError, true);
  const bucket = await f.db
    .prepare("SELECT * FROM ai_quota_buckets WHERE metric='tool_calls' AND subject_id=?")
    .bind(quota.subject.id)
    .first();
  assert.equal(bucket.used_amount, 1);
  assert.equal(bucket.reserved_amount, 0);
  assert.equal((await f.db.prepare("SELECT enabled FROM ai_settings").first()).enabled, 0);
});
