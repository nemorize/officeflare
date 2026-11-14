import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "../src/db/ai-schema.ts";
import { fixture } from "./ai-fixture.mjs";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

test("AI migrations match query models and secrets are write-only and bound to their rows", async (t) => {
  const f = await fixture(t);
  for (const model of Object.values(schema)) {
    const columns = (await f.db.prepare(`PRAGMA table_info(${getTableName(model)})`).all()).results
      .map((column) => column.name)
      .sort();
    assert.deepEqual(columns, Object.keys(getTableColumns(model)).sort(), getTableName(model));
  }
  const response = await f.admin("/accounts");
  assert.equal(response.items[0].has_secret, true);
  assert.ok(!JSON.stringify(response).includes("fixture-provider-key"));
  assert.equal(response.items[0].secret_envelope_json, undefined);
  await f.call("/api/ai/admin/accounts", { expected: 403 });
  const encrypted = await f.db
    .prepare("SELECT secret_envelope_json FROM ai_provider_accounts WHERE id=?")
    .bind(f.account.id)
    .first();
  assert.ok(!encrypted.secret_envelope_json.includes("fixture-provider-key"));
  const decrypted = await f.testCall("unseal", {
    purpose: "account:" + f.account.id,
    envelope: encrypted.secret_envelope_json,
  });
  assert.equal(decrypted.value.api_key, "fixture-provider-key");
  await f.testCall(
    "unseal",
    { purpose: "account:another", envelope: encrypted.secret_envelope_json },
    503,
  );
  assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("AI common execution meters once, preserves idempotency and reports no provider secrets", async (t) => {
  const f = await fixture(t),
    request = f.request();
  const first = await f.testCall("infer", request);
  assert.equal(first.text, "Hello");
  assert.equal(first.usage.input_tokens, 7);
  assert.equal(first.usage.output_tokens, 3);
  const repeated = await f.testCall("infer", request);
  assert.equal(repeated.invocation_id, first.invocation_id);
  assert.equal((await f.bucket.list({ prefix: "ai-requests/" })).objects.length, 1);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM ai_usage_events").first()).n, 1);
  assert.equal((await f.call("/api/ai/usage")).usage.cost_micro_usd, 10);
  assert.equal(
    (await f.db.prepare("SELECT sum(reserved_amount) n FROM ai_quota_buckets").first()).n,
    0,
  );
  await f.testCall(
    "infer",
    { ...request, messages: [{ role: "user", content: "Different" }] },
    409,
  );
  assert.equal((await f.bucket.list({ prefix: "ai-requests/" })).objects.length, 1);
});

test("a non-chat service uses the same AI execution and accounting without creating a room", async (t) => {
  const f = await fixture(t);
  await f.db
    .prepare(
      "INSERT INTO ai_subjects(id,key,kind,service_key,plan_id) VALUES('fixture-service','service:fixture.classify','service','fixture.classify','system-ai-service')",
    )
    .run();
  await f.db
    .prepare(
      "INSERT INTO ai_consumers(key,name,principal_kind,billing_policy,budget_subject_id,enabled) VALUES('fixture.classify','Fixture classifier','service','service','fixture-service',1)",
    )
    .run();
  await f.db
    .prepare(
      "INSERT INTO ai_consumer_profiles(consumer_key,profile_id,enabled,is_default) VALUES('fixture.classify',?,1,1)",
    )
    .bind(f.profile.id)
    .run();
  const result = await f.testCall(
    "infer",
    f.request({
      consumer: "fixture.classify",
      principal: { kind: "service", serviceKey: "fixture.classify" },
      sourceRef: { type: "message", id: "source-message" },
    }),
  );
  assert.equal(result.text, "Hello");
  const row = await f.db
    .prepare("SELECT * FROM ai_invocations WHERE id=?")
    .bind(result.invocation_id)
    .first();
  assert.equal(row.billing_subject_id, "fixture-service");
  assert.equal(row.actor_user_id, null);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM ai_rooms").first()).n, 0);
  await f.testCall(
    "infer",
    f.request({
      consumer: "fixture.classify",
      principal: { kind: "service", serviceKey: "another" },
    }),
    403,
  );
});

test("concurrent admission cannot overspend the last user request and lowering a limit keeps usage", async (t) => {
  const f = await fixture(t);
  const quota = await f.admin("/users/alice/quota");
  await f.admin("/users/alice/quota", {
    method: "PUT",
    data: {
      version: quota.subject.version,
      overrides: [{ metric: "invocations", window_kind: "day", scope_key: "*", limit_value: 1 }],
    },
  });
  await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "delay" }));
  const responses = await Promise.all(
    [f.request(), f.request()].map((request) =>
      f.mf.dispatchFetch("https://office.test/test-ai/infer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
  assert.equal((await f.bucket.list({ prefix: "ai-requests/" })).objects.length, 1);
  const bucket = await f.db
    .prepare("SELECT * FROM ai_quota_buckets WHERE subject_id=? AND metric='invocations'")
    .bind(quota.subject.id)
    .first();
  assert.equal(bucket.used_amount, 1);
  assert.equal(bucket.reserved_amount, 0);
  const updated = await f.admin("/users/alice/quota");
  await f.admin("/users/alice/quota", {
    method: "PUT",
    data: {
      version: updated.subject.version,
      overrides: [{ metric: "invocations", window_kind: "day", scope_key: "*", limit_value: 0 }],
    },
  });
  await f.testCall("infer", f.request(), 429);
  assert.equal(
    (
      await f.db
        .prepare("SELECT used_amount FROM ai_quota_buckets WHERE id=?")
        .bind(bucket.id)
        .first()
    ).used_amount,
    1,
  );
});

test("account rolling retries a known rejection and preserves all accepted attempt usage", async (t) => {
  const f = await fixture(t);
  const rejected = await f.create("accounts", {
    provider_id: f.provider.id,
    name: "Rejected",
    auth_kind: "api_key",
    owner_user_id: "admin",
    share_scope: "workspace",
    sharing_authorization: "provider_permitted",
    authorization_ref: "fixture",
    status: "active",
    secret: { api_key: "fixture-rejected-key" },
  });
  await f.admin(`/pools/${f.pool.id}/members`, {
    method: "PUT",
    data: {
      version: f.pool.version,
      members: [
        { account_id: rejected.id, priority: 0 },
        { account_id: f.account.id, priority: 1 },
      ],
    },
  });
  const result = await f.testCall("infer", f.request());
  assert.equal(result.text, "Hello");
  const attempts = (
    await f.db
      .prepare("SELECT status FROM ai_inference_attempts WHERE invocation_id=? ORDER BY ordinal")
      .bind(result.invocation_id)
      .all()
  ).results;
  assert.deepEqual(
    attempts.map((row) => row.status),
    ["failed", "succeeded"],
  );
  assert.equal((await f.db.prepare("SELECT count(*) n FROM ai_usage_events").first()).n, 1);
  assert.ok(
    (
      await f.db
        .prepare("SELECT cooldown_until FROM ai_provider_accounts WHERE id=?")
        .bind(rejected.id)
        .first()
    ).cooldown_until >
      Date.now() / 1000,
  );
});

test("unknown provider acceptance retains reservations and never rolls or resends automatically", async (t) => {
  const f = await fixture(t),
    request = f.request();
  await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "unknown" }));
  await f.testCall("infer", request, 503);
  const invocation = await f.db.prepare("SELECT * FROM ai_invocations").first();
  assert.equal(invocation.status, "unknown");
  assert.equal(
    (await f.db.prepare("SELECT status FROM ai_inference_attempts").first()).status,
    "unknown",
  );
  assert.ok(
    (await f.db.prepare("SELECT sum(reserved_amount) n FROM ai_quota_buckets").first()).n > 0,
  );
  await f.testCall("infer", request, 503);
  await f.testCall("recover", {});
  assert.equal((await f.bucket.list({ prefix: "ai-requests/" })).objects.length, 1);
});

test("Chat, Anthropic and Gemini adapters normalize their streaming and usage responses", async (t) => {
  const f = await fixture(t);
  for (const protocol of [
    "openai_chat",
    "anthropic_messages",
    "google_generate_content",
    "cloudflare_run",
  ]) {
    await f.db
      .prepare("UPDATE ai_model_deployments SET protocol=?,version=version+1 WHERE id=?")
      .bind(protocol, f.deployment.id)
      .run();
    const result = await f.testCall("infer", f.request());
    assert.equal(result.text, "Hello", protocol);
    assert.equal(result.usage.input_tokens, 7);
    assert.equal(result.usage.output_tokens, 3);
  }
});

test("provider tool continuations preserve opaque signatures and native parameter names", async (t) => {
  const f = await fixture(t);
  await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "signed-tools" }));
  await f.db
    .prepare("UPDATE ai_profiles SET generation_json=?,version=version+1 WHERE id=?")
    .bind(JSON.stringify({ top_p: 0.8 }), f.profile.id)
    .run();
  for (const protocol of ["anthropic_messages", "google_generate_content"]) {
    await f.db
      .prepare("UPDATE ai_model_deployments SET protocol=?,version=version+1 WHERE id=?")
      .bind(protocol, f.deployment.id)
      .run();
    const initial = f.request({
      tools: [
        {
          name: "fixture.lookup",
          description: "Lookup",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    const first = await f.testCall("infer", initial);
    assert.equal(first.tool_calls.length, 1);
    const result = await f.testCall(
      "infer",
      f.request({
        tools: initial.tools,
        messages: [
          ...initial.messages,
          {
            role: "assistant",
            content: first.text,
            tool_calls: first.tool_calls,
            provider_state: first.provider_state,
          },
          {
            role: "tool",
            tool_call_id: first.tool_calls[0].id,
            tool_name: first.tool_calls[0].name,
            content: "Result",
          },
        ],
      }),
    );
    assert.equal(result.text, "Hello");
  }
  const objects = await f.bucket.list({ prefix: "ai-requests/" });
  const requests = await Promise.all(
    objects.objects.map(async (item) => JSON.parse(await (await f.bucket.get(item.key)).text())),
  );
  const google = requests.find((request) =>
    request.body.contents?.some((message) => message.parts?.some((part) => part.functionResponse)),
  );
  assert.equal(google.body.contents[1].parts[0].thoughtSignature, "fixture-encrypted-signature");
  assert.equal(google.body.generationConfig.topP, 0.8);
  assert.equal(google.body.generationConfig.top_p, undefined);
  const anthropic = requests.find((request) =>
    request.body.messages?.some((message) =>
      message.content?.some((part) => part.type === "tool_result"),
    ),
  );
  assert.equal(anthropic.body.messages[1].content[0].signature, "fixture-encrypted-signature");
});

test("Cloudflare gateway credentials are separate from provider credentials", async (t) => {
  const f = await fixture(t);
  const gateway = await f.create("gateways", {
    key: "fixture",
    name: "Cloudflare",
    adapter_key: "cloudflare",
    config_json: {
      account_id: "fixture-account",
      gateway_id: "fixture-gateway",
      provider_slug: "openai",
    },
    enabled: true,
    secret: { api_key: "fixture-gateway-key" },
  });
  await f.db
    .prepare("UPDATE ai_profile_routes SET gateway_id=?,version=version+1")
    .bind(gateway.id)
    .run();
  assert.equal((await f.testCall("infer", f.request())).text, "Hello");
  const request = JSON.parse(
    await (
      await f.bucket.get((await f.bucket.list({ prefix: "ai-requests/" })).objects[0].key)
    ).text(),
  );
  assert.equal(request.fixture_authorized, true);
  assert.equal(request.gateway_authorized, true);
  assert.match(request.url, /^https:\/\/gateway\.ai\.cloudflare\.com\//);
});

test("agent steps wait for approval, isolate rooms, resume once and preserve the tool result", async (t) => {
  const f = await fixture(t);
  await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "tools" }));
  const room = (
    await f.call("/api/ai/rooms", {
      method: "POST",
      data: { title: "Agent", profile_key: f.profile.key },
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
      bindings: [{ connection_id: connection.id, allowed_tools: ["contacts.create"] }],
    },
  });
  const run = (
    await f.call(`/api/ai/rooms/${room.id}/runs`, {
      method: "POST",
      data: { message: "Create a contact" },
      headers: { "Idempotency-Key": "agent-test" },
      expected: 202,
    })
  ).run;
  const repeated = await f.call(`/api/ai/rooms/${room.id}/runs`, {
    method: "POST",
    data: { message: "Create a contact" },
    headers: { "Idempotency-Key": "agent-test" },
    expected: 202,
  });
  assert.equal(repeated.run.id, run.id);
  await f.call(`/api/ai/runs/${run.id}`, { actor: "bob", expected: 404 });
  await f.testCall("advance", { id: run.id });
  await f.testCall("advance", { id: run.id });
  assert.equal((await f.call(`/api/ai/runs/${run.id}`)).run.status, "waiting_approval");
  assert.equal((await f.db.prepare("SELECT count(*) n FROM contacts").first()).n, 0);
  const approvals = await f.call(`/api/ai/runs/${run.id}/approvals`);
  assert.equal(approvals.approvals.length, 1);
  const approval = approvals.approvals[0];
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT sum(reserved_amount) n FROM ai_quota_buckets WHERE metric='concurrent_runs'",
        )
        .first()
    ).n,
    0,
  );
  await f.call(`/api/ai/approvals/${approval.id}/decision`, {
    method: "POST",
    data: { decision: "allow", intent_hash: approval.intent_hash },
  });
  await f.testCall("advance", { id: run.id });
  await f.testCall("advance", { id: run.id });
  const finished = await f.call(`/api/ai/runs/${run.id}`);
  assert.equal(finished.run.status, "succeeded");
  const contacts = await f.call("/api/contacts");
  assert.equal(contacts.contacts.length, 1);
  assert.equal(contacts.contacts[0].display_name, "Agent contact");
  await f.testCall("advance", { id: run.id });
  assert.equal((await f.call("/api/contacts")).contacts.length, 1);
  const messages = (await f.call(`/api/ai/rooms/${room.id}/messages`)).messages;
  assert.equal(messages.at(-1).content, "Hello");
  assert.ok(!JSON.stringify(messages).includes("provider_state"));
});

test("room MCP bindings cannot borrow another user's connection", async (t) => {
  const f = await fixture(t),
    room = (
      await f.call("/api/ai/rooms", {
        method: "POST",
        data: { title: "Alice", profile_key: f.profile.key },
        expected: 201,
      })
    ).room;
  const connection = (
    await f.call("/api/ai/mcp/connections", {
      actor: "bob",
      method: "POST",
      data: { server_id: "system-mcp-contacts", name: "Bob" },
      expected: 201,
    })
  ).connection;
  await f.call(`/api/ai/rooms/${room.id}/mcp-bindings`, {
    method: "PUT",
    data: {
      version: room.version,
      bindings: [{ connection_id: connection.id, allowed_tools: ["contacts.get"] }],
    },
    expected: 403,
  });
  assert.equal((await f.db.prepare("SELECT count(*) n FROM ai_room_mcp_bindings").first()).n, 0);
});

test("remote MCP uses a distinct connection token, protocol negotiation and strict schemas", async (t) => {
  const f = await fixture(t);
  const server = await f.create("mcp-servers", {
    key: "remote",
    name: "Remote",
    transport: "streamable_http",
    endpoint_url: "https://remote-mcp.example/mcp",
    enabled: true,
  });
  const connection = (
    await f.call("/api/ai/mcp/connections", {
      method: "POST",
      data: { server_id: server.id, name: "Remote", secret: { api_key: "fixture-remote-key" } },
      expected: 201,
    })
  ).connection;
  const tools = await f.testCall("remote", { id: connection.id });
  assert.equal(tools.tools[0].name, "lookup");
  assert.equal((await f.bucket.list({ prefix: "ai-requests/" })).objects.length, 3);
});

test("queued expiry and cancellation release run slots, including a crashed cancelling worker", async (t) => {
  const f = await fixture(t);
  const room = (
    await f.call("/api/ai/rooms", {
      method: "POST",
      data: { title: "Recovery", profile_key: f.profile.key },
      expected: 201,
    })
  ).room;
  const makeRun = async (key) =>
    (
      await f.call(`/api/ai/rooms/${room.id}/runs`, {
        method: "POST",
        data: { message: key },
        headers: { "Idempotency-Key": key },
        expected: 202,
      })
    ).run;
  const cancelled = await makeRun("cancel-queued");
  await f.call(`/api/ai/runs/${cancelled.id}/cancel`, { method: "POST", data: {} });
  assert.equal((await f.call(`/api/ai/runs/${cancelled.id}`)).run.status, "cancelled");
  const expired = await makeRun("expire-queued");
  await f.db
    .prepare("UPDATE ai_runs SET deadline_at=unixepoch()-1 WHERE id=?")
    .bind(expired.id)
    .run();
  await f.testCall("recover", {});
  assert.equal((await f.call(`/api/ai/runs/${expired.id}`)).run.status, "failed");
  const crashed = await makeRun("cancel-crashed");
  await f.db
    .prepare(
      "UPDATE ai_runs SET status='cancel_requested',execution_token='crashed',lease_expires_at=unixepoch()-1 WHERE id=?",
    )
    .bind(crashed.id)
    .run();
  await f.testCall("recover", {});
  assert.equal((await f.call(`/api/ai/runs/${crashed.id}`)).run.status, "cancelled");
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT sum(reserved_amount) n FROM ai_quota_buckets WHERE metric='concurrent_runs'",
        )
        .first()
    ).n,
    0,
  );
  assert.equal((await f.bucket.list({ prefix: "ai-requests/" })).objects.length, 0);
});

test("a new conversation run after cancelling approval excludes incomplete provider tool exchanges", async (t) => {
  const f = await fixture(t);
  await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "tools" }));
  const room = (
    await f.call("/api/ai/rooms", {
      method: "POST",
      data: { title: "Cancel approval", profile_key: f.profile.key },
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
      bindings: [{ connection_id: connection.id, allowed_tools: ["contacts.create"] }],
    },
  });
  const run = (
    await f.call(`/api/ai/rooms/${room.id}/runs`, {
      method: "POST",
      data: { message: "Create a contact" },
      headers: { "Idempotency-Key": "before-cancel" },
      expected: 202,
    })
  ).run;
  await f.testCall("advance", { id: run.id });
  await f.testCall("advance", { id: run.id });
  await f.call(`/api/ai/runs/${run.id}/cancel`, { method: "POST", data: {} });
  await f.bucket.put("ai-fixture-mode", "{}");
  const next = (
    await f.call(`/api/ai/rooms/${room.id}/runs`, {
      method: "POST",
      data: { message: "Continue without creating contacts" },
      headers: { "Idempotency-Key": "after-cancel" },
      expected: 202,
    })
  ).run;
  await f.testCall("advance", { id: next.id });
  assert.equal((await f.call(`/api/ai/runs/${next.id}`)).run.status, "succeeded");
  const requests = await Promise.all(
    (await f.bucket.list({ prefix: "ai-requests/" })).objects.map(async (item) =>
      JSON.parse(await (await f.bucket.get(item.key)).text()),
    ),
  );
  const continued = requests.find((request) =>
    request.body.input?.some((message) => message.content === "Continue without creating contacts"),
  );
  assert.ok(continued);
  assert.ok(
    !continued.body.input.some(
      (message) => message.type === "function_call" || message.type === "function_call_output",
    ),
  );
  assert.equal((await f.db.prepare("SELECT count(*) n FROM contacts").first()).n, 0);
});

test("unknown usage reconciles without resend and later receipts append an idempotent correction", async (t) => {
  const f = await fixture(t);
  await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "unknown" }));
  await f.testCall("infer", f.request(), 503);
  const invocation = await f.db.prepare("SELECT * FROM ai_invocations").first();
  const attempt = await f.db.prepare("SELECT * FROM ai_inference_attempts").first();
  await f.admin(`/invocations/${invocation.id}/reconcile`, {
    method: "POST",
    data: { reason: "Expired unresolved request" },
    expected: 409,
  });
  await f.db
    .prepare("UPDATE ai_inference_attempts SET lease_expires_at=unixepoch()-1 WHERE id=?")
    .bind(attempt.id)
    .run();
  await f.admin(`/invocations/${invocation.id}/reconcile`, {
    method: "POST",
    data: { reason: "Expired unresolved request" },
  });
  assert.equal((await f.db.prepare("SELECT status FROM ai_invocations").first()).status, "failed");
  assert.equal(
    (await f.db.prepare("SELECT usage_source FROM ai_usage_events").first()).usage_source,
    "estimated",
  );
  const correction = {
    method: "POST",
    data: { input_tokens: 7, output_tokens: 3, reason: "Provider receipt" },
    headers: { "Idempotency-Key": "receipt-1" },
  };
  await f.admin(`/attempts/${attempt.id}/usage`, correction);
  await f.admin(`/attempts/${attempt.id}/usage`, correction);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM ai_usage_events").first()).n, 2);
  assert.equal((await f.call("/api/ai/usage")).usage.cost_micro_usd, 10);
  assert.equal(
    (await f.db.prepare("SELECT sum(reserved_amount) n FROM ai_quota_buckets").first()).n,
    0,
  );
  assert.equal((await f.bucket.list({ prefix: "ai-requests/" })).objects.length, 1);
});

test("registered provider OAuth verifies signed identity and serializes rotating refresh tokens", async (t) => {
  const f = await fixture(t);
  const issuer = "https://issuer.example",
    clientId = "registered-officeflare";
  const provider = await f.create("providers", {
    key: "oauth",
    name: "OAuth",
    adapter_key: "openai",
    base_url: "https://provider.example/v1",
    enabled: true,
    config_json: {
      oauth: {
        issuer,
        client_id: clientId,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/jwks",
        scope: "openid offline_access",
        hosted_authorization_ref: "registered-fixture",
      },
    },
  });
  const account = (
    await f.call("/api/ai/accounts", {
      method: "POST",
      data: { provider_id: provider.id, name: "Personal OAuth" },
      expected: 201,
    })
  ).account;
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "fixture" }] };
  for (const valid of [false, true]) {
    const start = await f.call(`/api/ai/accounts/${account.id}/oauth/start`, {
      method: "POST",
      data: {},
    });
    const authorization = new URL(start.authorization_url);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const idToken = await new SignJWT({
      nonce: valid ? authorization.searchParams.get("nonce") : "wrong",
    })
      .setProtectedHeader({ alg: "ES256", kid: "fixture" })
      .setSubject("fixture-subject")
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    await f.bucket.put(
      "ai-fixture-oauth",
      JSON.stringify({
        jwks,
        tokens: {
          access_token: "fixture-oauth",
          refresh_token: "fixture-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: idToken,
        },
      }),
    );
    const callback = new URL("https://office.test/api/ai/oauth/callback");
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    callback.searchParams.set("code", "fixture-code");
    const response = await f.mf.dispatchFetch(callback, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"), valid ? /status=connected/ : /status=failed/);
    assert.equal(
      (
        await f.db
          .prepare("SELECT status FROM ai_provider_accounts WHERE id=?")
          .bind(account.id)
          .first()
      ).status,
      valid ? "active" : "disabled",
    );
  }
  await f.db
    .prepare("UPDATE ai_provider_accounts SET credential_expires_at=unixepoch()-1 WHERE id=?")
    .bind(account.id)
    .run();
  const replies = await Promise.all(
    [1, 2].map(() =>
      f.mf.dispatchFetch("https://office.test/test-ai/credentials", {
        method: "POST",
        body: JSON.stringify({ id: account.id }),
      }),
    ),
  );
  assert.ok(replies.some((response) => response.status === 200));
  assert.ok(replies.every((response) => [200, 409].includes(response.status)));
  const stored = await f.testCall("credentials", { id: account.id });
  assert.equal(stored.access_token, "fixture-refreshed");
  const records = await f.bucket.list({ prefix: "ai-oauth-requests/" });
  const grants = await Promise.all(
    records.objects.map(async (object) => (await f.bucket.get(object.key)).text()),
  );
  assert.equal(grants.filter((grant) => grant === "refresh_token").length, 1);
  assert.equal(
    (
      await f.db
        .prepare("SELECT credential_version FROM ai_provider_accounts WHERE id=?")
        .bind(account.id)
        .first()
    ).credential_version,
    3,
  );
});
