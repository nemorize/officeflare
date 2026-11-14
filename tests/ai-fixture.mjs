import assert from "node:assert/strict";
import { build } from "esbuild";
import { fixture as calendarFixture } from "./calendar-fixture.mjs";

const harness = await build({
  entryPoints: ["tests/ai-harness.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers", "cloudflare:sockets", "../dist/index.js", "node:*"],
  loader: { ".sql": "text" },
  target: "es2022",
});
export async function fixture(t, { configure = true, assets = false } = {}) {
  const f = await calendarFixture(t, {
    ai: true,
    assets,
    workerEntry: {
      type: "ESModule",
      path: "tests/ai-harness.js",
      contents: harness.outputFiles[0].text,
    },
  });
  for (const user of ["alice", "bob"])
    for (const role of ["system-ai-user", "system-contacts-user"])
      await f.db
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
        .bind(user, role)
        .run();
  const call = async (
    path,
    { actor = "alice", method = "GET", data, headers = {}, expected = 200, form } = {},
  ) => {
    const response = await f.mf.dispatchFetch("https://office.test" + path, {
      method,
      headers: {
        ...(actor ? { Authorization: "Bearer " + f.tokens[actor] } : {}),
        ...(data === undefined && !form
          ? {}
          : { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" }),
        ...headers,
      },
      body: form
        ? new URLSearchParams(form).toString()
        : data === undefined
          ? undefined
          : JSON.stringify(data),
    });
    assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`);
    return response.status === 204 ? null : response.json();
  };
  const testCall = (kind, data, expected = 200) =>
    call("/test-ai/" + kind, { actor: null, method: "POST", data, expected });
  const admin = (path, options = {}) =>
    call("/api/ai/admin" + path, { actor: "admin", ...options });
  const create = async (resource, data) =>
    (await admin("/" + resource, { method: "POST", data, expected: 201 })).item;
  const bucket = await f.mf.getR2Bucket("MAIL_BUCKET");
  let provider, account, pool, model, deployment, profile;
  if (configure) {
    provider = await create("providers", {
      key: "fixture",
      name: "Fixture",
      adapter_key: "openai",
      base_url: "https://provider.example/v1",
      enabled: true,
    });
    account = await create("accounts", {
      provider_id: provider.id,
      name: "Shared fixture",
      auth_kind: "api_key",
      share_scope: "workspace",
      sharing_authorization: "provider_permitted",
      authorization_ref: "fixture-workspace-key",
      status: "active",
      concurrency_limit: 10,
      secret: { api_key: "fixture-provider-key" },
    });
    pool = await create("pools", {
      provider_id: provider.id,
      name: "Pool",
      strategy: "priority",
      enabled: true,
    });
    pool = (
      await admin(`/pools/${pool.id}/members`, {
        method: "PUT",
        data: { version: pool.version, members: [{ account_id: account.id }] },
      })
    ).pool;
    model = await create("models", {
      key: "fixture-model",
      name: "Fixture model",
      vendor: "Fixture",
      enabled: true,
    });
    deployment = await create("deployments", {
      provider_id: provider.id,
      model_id: model.id,
      provider_model_id: "fixture",
      protocol: "openai_responses",
      auth_mode: "api",
      capabilities_json: {
        schema_version: 1,
        streaming: true,
        tool_calls: true,
        json_schema: true,
        input_token_bound: "utf8_bytes",
        input_overhead_tokens: 1024,
        bounded_usage: true,
        enforces_output_limit: true,
        context_tokens: 131072,
        max_output_tokens: 8192,
      },
      pricing_json: {
        schema_version: 1,
        source: "catalog",
        currency: "USD",
        unit: "micro_usd_per_million_tokens",
        input: 1000000,
        output: 1000000,
      },
      enabled: true,
    });
    profile = await create("profiles", {
      key: "fixture-chat",
      name: "Fixture chat",
      enabled: true,
    });
    await create("routes", {
      profile_id: profile.id,
      provider_id: provider.id,
      deployment_id: deployment.id,
      pool_id: pool.id,
      priority: 0,
      enabled: true,
    });
    const consumer = (await admin("/consumers")).items.find((entry) => entry.key === "hub.chat");
    await admin("/consumers/hub.chat/profiles", {
      method: "PUT",
      data: { version: consumer.version, profiles: [{ profile_id: profile.id, is_default: true }] },
    });
    await admin("/settings", { method: "PATCH", data: { version: 1, enabled: true } });
  }
  const principals = {};
  for (const user of ["alice", "bob", "admin"]) {
    const row = await f.db
      .prepare(
        "SELECT s.id,u.auth_version FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE u.id=? ORDER BY s.created_at DESC LIMIT 1",
      )
      .bind(user)
      .first();
    principals[user] = {
      kind: "user",
      userId: user,
      sessionId: row.id,
      authVersion: row.auth_version,
    };
  }
  let invocation = 0;
  const request = (options = {}) => ({
    consumer: "hub.chat",
    principal: principals.alice,
    profileKey: "fixture-chat",
    idempotencyKey: "fixture-invocation-" + ++invocation,
    sourceRef: { type: "fixture", id: "fixture" },
    messages: [{ role: "user", content: "Hello" }],
    ...options,
  });
  return {
    ...f,
    bucket,
    call,
    admin,
    create,
    testCall,
    provider,
    account,
    pool,
    model,
    deployment,
    profile,
    principals,
    request,
  };
}
