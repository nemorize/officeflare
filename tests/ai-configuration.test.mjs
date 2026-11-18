import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./ai-fixture.mjs";

const capabilities = {
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
};
const pricing = {
  schema_version: 1,
  source: "catalog",
  currency: "USD",
  unit: "micro_usd_per_million_tokens",
  input: 1000000,
  output: 1000000,
};
function providerBody(key, apiKey = "fixture-provider-key") {
  return {
    key,
    name: key,
    adapter_key: "openai",
    base_url: "https://provider.example/v1",
    enabled: true,
    oauth: null,
    gateway: null,
    accounts: [
      {
        name: key + " account",
        auth_kind: "api_key",
        share_scope: "workspace",
        status: "active",
        concurrency_limit: 10,
        credentials: { api_key: apiKey },
      },
    ],
  };
}
const source = (provider, modelId = "fixture") => ({
  provider_id: provider.id,
  provider_model_id: modelId,
  protocol: "openai_responses",
  auth_mode: "api",
  capabilities,
  pricing,
  enabled: true,
});
async function createProvider(f, key, apiKey) {
  return (
    await f.admin("/provider-configs", {
      method: "POST",
      data: providerBody(key, apiKey),
      expected: 201,
    })
  ).item;
}
async function createModel(f, key, providers) {
  return (
    await f.admin("/model-configs", {
      method: "POST",
      data: { key, name: key, vendor: "Fixture", enabled: true, providers },
      expected: 201,
    })
  ).item;
}
function writeProvider(value) {
  const { id, ...data } = value;
  return {
    ...data,
    accounts: data.accounts.map(({ has_secret, cooldown_until, ...account }) => account),
    gateway: data.gateway
      ? Object.fromEntries(Object.entries(data.gateway).filter(([key]) => key !== "has_secret"))
      : null,
  };
}
function writeModel(value) {
  const { id, ...data } = value;
  return { ...data, providers: data.providers.map(({ cooldown_until, ...source }) => source) };
}
async function enable(f) {
  await f.admin("/settings", { method: "PATCH", data: { version: 1, enabled: true } });
}
async function infer(f, modelName, options = {}) {
  const profile = (await f.call("/api/ai/models")).profiles.find(
    (profile) => profile.name === modelName,
  );
  assert.ok(
    profile,
    "Model is immediately available in chat without configuring routes or consumers",
  );
  return f.testCall("infer", f.request({ profileKey: profile.key, ...options }));
}

test("existing providers, credentials, models and profile route IDs migrate without losing relationships", async (t) => {
  const f = await fixture(t, {
    configure: false,
    beforeAIConfigurationMigration: async (db) => {
      await db.batch([
        db.prepare(
          "INSERT INTO ai_providers(id,key,name,adapter_key,base_url,enabled) VALUES('legacy-p','legacy-p','Legacy','openai','https://provider.example/v1',1)",
        ),
        db.prepare(
          "INSERT INTO ai_provider_accounts(id,provider_id,name,auth_kind,share_scope,sharing_authorization,authorization_ref,status,secret_envelope_json) VALUES('legacy-a','legacy-p','Legacy credential','api_key','workspace','provider_permitted','legacy','active','{}')",
        ),
        db.prepare(
          "INSERT INTO ai_account_pools(id,provider_id,name,strategy,enabled) VALUES('legacy-pool','legacy-p','Legacy pool','priority',1)",
        ),
        db.prepare(
          "INSERT INTO ai_pool_members(pool_id,account_id,provider_id) VALUES('legacy-pool','legacy-a','legacy-p')",
        ),
        db.prepare(
          "INSERT INTO ai_models(id,key,name,vendor,enabled) VALUES('legacy-m','legacy-m','Legacy model','Fixture',1)",
        ),
        db
          .prepare(
            "INSERT INTO ai_model_deployments(id,model_id,provider_id,provider_model_id,protocol,auth_mode,capabilities_json,pricing_json,enabled) VALUES('legacy-d','legacy-m','legacy-p','fixture','openai_responses','api',?,?,1)",
          )
          .bind(JSON.stringify(capabilities), JSON.stringify(pricing)),
        db.prepare(
          "INSERT INTO ai_profiles(id,key,name,enabled) VALUES('legacy-profile','legacy-profile','Legacy model',1)",
        ),
        db.prepare(
          "INSERT INTO ai_consumer_profiles(consumer_key,profile_id,enabled,is_default) VALUES('hub.chat','legacy-profile',1,1)",
        ),
        db.prepare(
          "INSERT INTO ai_profile_routes(id,profile_id,provider_id,deployment_id,pool_id,priority,enabled) VALUES('legacy-route','legacy-profile','legacy-p','legacy-d','legacy-pool',0,1)",
        ),
      ]);
    },
  });
  const provider = (await f.admin("/provider-configs")).items[0];
  assert.equal(provider.id, "legacy-p");
  assert.equal(provider.accounts[0].id, "legacy-a");
  const model = (await f.admin("/model-configs")).items[0];
  assert.equal(model.providers[0].provider_id, provider.id);
  assert.equal(
    (await f.db.prepare("SELECT model_id FROM ai_profiles WHERE id='legacy-profile'").first())
      .model_id,
    "legacy-m",
  );
  assert.equal(
    (await f.db.prepare("SELECT profile_id FROM ai_models WHERE id='legacy-m'").first()).profile_id,
    "legacy-profile",
  );
  assert.equal((await f.db.prepare("SELECT id FROM ai_profile_routes").first()).id, "legacy-route");
  assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("changing a model's provider preserves prior attempt history and rejects stale edits", async (t) => {
  const f = await fixture(t, { configure: false });
  const first = await createProvider(f, "old-provider"),
    second = await createProvider(f, "new-provider");
  const model = await createModel(f, "edited-model", [source(first)]);
  await enable(f);
  const prior = await infer(f, model.name);
  const changed = writeModel(model);
  changed.providers[0] = {
    ...changed.providers[0],
    provider_id: second.id,
    provider_model_id: "replacement",
  };
  const updated = (await f.admin(`/model-configs/${model.id}`, { method: "PATCH", data: changed }))
    .item;
  const next = await infer(f, model.name);
  assert.equal(
    (
      await f.db
        .prepare("SELECT provider_id FROM ai_inference_attempts WHERE invocation_id=?")
        .bind(prior.invocation_id)
        .first()
    ).provider_id,
    first.id,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT provider_id FROM ai_inference_attempts WHERE invocation_id=?")
        .bind(next.invocation_id)
        .first()
    ).provider_id,
    second.id,
  );
  await f.admin(`/model-configs/${model.id}`, { method: "PATCH", data: changed, expected: 409 });
  assert.equal((await f.admin("/model-configs")).items[0].version, updated.version);
  assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("model limits and reasoning constrain provider selection and the outgoing request", async (t) => {
  const f = await fixture(t, { configure: false });
  const first = await createProvider(f, "low-reasoning"),
    second = await createProvider(f, "high-reasoning");
  const model = await createModel(f, "reasoning-model", [
    {
      ...source(first, "low"),
      reasoning_levels: ["low"],
    },
    {
      ...source(second, "high"),
      reasoning_levels: ["high"],
    },
  ]);
  const path = `/model-configs/${model.id}`;
  const settings = {
    context_tokens: 3000,
    max_output_tokens: 512,
    default_reasoning_effort: "high",
  };
  await f.admin(path, {
    method: "PATCH",
    data: { ...writeModel(model), capabilities: { ...settings, context_tokens: 512 } },
    expected: 400,
  });
  await f.admin(path, {
    method: "PATCH",
    data: {
      ...writeModel(model),
      capabilities: { ...settings, default_reasoning_effort: "medium" },
    },
    expected: 400,
  });
  const { item: saved } = await f.admin(path, {
    method: "PATCH",
    data: { ...writeModel(model), capabilities: settings },
  });
  const { capabilities: omitted, ...legacy } = writeModel(saved);
  for (const provider of legacy.providers) delete provider.reasoning_levels;
  await f.admin(path, { method: "PATCH", data: legacy });
  assert.deepEqual((await f.admin(path)).item.capabilities, settings);
  await createModel(f, "same-upstream-model", [
    { ...source(second, "high"), reasoning_levels: [] },
  ]);

  await enable(f);
  assert.equal((await infer(f, model.name)).text, "Hello");
  const profile = (await f.call("/api/ai/models")).profiles.find(
    (profile) => profile.name === model.name,
  );
  const rejected = await f.testCall(
    "infer",
    f.request({
      profileKey: profile.key,
      messages: [{ role: "user", content: "a".repeat(1600) }],
    }),
    422,
  );
  assert.equal(rejected.code, "AI_LIMIT_REACHED");
  const requests = (await f.bucket.list({ prefix: "ai-requests/" })).objects;
  assert.equal(requests.length, 1);
  const { body } = await (await f.bucket.get(requests[0].key)).json();
  assert.equal(body.model, "high");
  assert.equal(body.max_output_tokens, 512);
  assert.deepEqual(body.reasoning, { effort: "high" });
});

test("profile model changes rebuild routes and clearing the model disables the old routes", async (t) => {
  const f = await fixture(t, { configure: false });
  const provider = await createProvider(f, "profile-provider");
  const first = await createModel(f, "profile-first", [source(provider, "first")]);
  const second = await createModel(f, "profile-second", [source(provider, "second")]);
  const profile = await f.create("profiles", {
    key: "feature-profile",
    name: "Feature profile",
    model_id: first.id,
    enabled: true,
  });
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM ai_profile_routes WHERE profile_id=? AND enabled=1")
        .bind(profile.id)
        .first()
    ).n,
    1,
  );
  const updated = (
    await f.admin(`/profiles/${profile.id}`, {
      method: "PATCH",
      data: { version: profile.version, model_id: second.id },
    })
  ).item;
  const selected = await f.db
    .prepare(
      "SELECT d.provider_model_id FROM ai_profile_routes r JOIN ai_model_deployments d ON d.id=r.deployment_id WHERE r.profile_id=? AND r.enabled=1",
    )
    .bind(profile.id)
    .first();
  assert.equal(selected.provider_model_id, "second");
  await f.admin(`/profiles/${profile.id}`, {
    method: "PATCH",
    data: { version: updated.version, model_id: null },
  });
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM ai_profile_routes WHERE profile_id=? AND enabled=1")
        .bind(profile.id)
        .first()
    ).n,
    0,
  );
});

test("one provider mutation saves credentials, gateway, and managed account membership without returning secrets", async (t) => {
  const f = await fixture(t, { configure: false });
  const data = providerBody("configured");
  data.gateway = {
    account_id: "cf-account",
    gateway_id: "gateway",
    provider_slug: "openai",
    api_key: "fixture-gateway-key",
  };
  const provider = (await f.admin("/provider-configs", { method: "POST", data, expected: 201 }))
    .item;
  assert.equal(provider.accounts[0].has_secret, true);
  assert.equal(provider.gateway.has_secret, true);
  assert.ok(!JSON.stringify(provider).includes("fixture-provider-key"));
  assert.ok(!JSON.stringify(provider).includes("fixture-gateway-key"));
  const stored = await f.db
    .prepare("SELECT pool_id,gateway_id FROM ai_providers WHERE id=?")
    .bind(provider.id)
    .first();
  assert.ok(stored.pool_id && stored.gateway_id);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM ai_pool_members WHERE pool_id=?")
        .bind(stored.pool_id)
        .first()
    ).n,
    1,
  );
  const account = await f.db
    .prepare("SELECT * FROM ai_provider_accounts WHERE provider_id=?")
    .bind(provider.id)
    .first();
  const saved = (
    await f.admin(`/provider-configs/${provider.id}`, {
      method: "PATCH",
      data: { ...writeProvider(provider), name: "Renamed" },
    })
  ).item;
  const updated = await f.db
    .prepare("SELECT * FROM ai_provider_accounts WHERE provider_id=?")
    .bind(provider.id)
    .first();
  assert.equal(updated.secret_envelope_json, account.secret_envelope_json);
  assert.equal(updated.credential_version, account.credential_version);
  assert.equal(saved.name, "Renamed");
  await f.admin(`/provider-configs/${provider.id}`, {
    method: "PATCH",
    data: writeProvider(provider),
    expected: 409,
  });
  const bad = writeProvider(saved);
  bad.accounts[0].credentials = { api_key: "" };
  await f.admin(`/provider-configs/${provider.id}`, { method: "PATCH", data: bad, expected: 400 });
  assert.equal((await f.admin("/provider-configs")).items[0].version, saved.version);
  await f.call("/api/ai/admin/provider-configs", { expected: 403 });
});

test("logical models roll in configured order, retain exhausted provider cooldowns, and resume the first provider after reset", async (t) => {
  const f = await fixture(t, { configure: false });
  const exhausted = await createProvider(f, "first", "fixture-rejected-key");
  const available = await createProvider(f, "second");
  const model = await createModel(f, "rolling", [source(exhausted), source(available)]);
  await enable(f);
  const result = await infer(f, model.name);
  assert.equal(result.text, "Hello");
  const attempts = (
    await f.db
      .prepare(
        "SELECT provider_id,status FROM ai_inference_attempts WHERE invocation_id=? ORDER BY ordinal",
      )
      .bind(result.invocation_id)
      .all()
  ).results;
  assert.deepEqual(attempts, [
    { provider_id: exhausted.id, status: "failed" },
    { provider_id: available.id, status: "succeeded" },
  ]);
  const next = await infer(f, model.name);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM ai_inference_attempts WHERE invocation_id=?")
        .bind(next.invocation_id)
        .first()
    ).n,
    1,
  );
  const before = (await f.admin("/model-configs")).items[0];
  const reversed = writeModel(before);
  reversed.providers.reverse();
  await f.admin(`/model-configs/${model.id}`, { method: "PATCH", data: reversed });
  const again = await infer(f, model.name);
  assert.equal(
    (
      await f.db
        .prepare("SELECT provider_id FROM ai_inference_attempts WHERE invocation_id=?")
        .bind(again.invocation_id)
        .first()
    ).provider_id,
    available.id,
  );
  // Reordering back and resetting the account restores the configured first choice.
  const current = (await f.admin("/model-configs")).items[0];
  const original = writeModel(current);
  original.providers.reverse();
  await f.admin(`/model-configs/${model.id}`, { method: "PATCH", data: original });
  await f.db
    .prepare("UPDATE ai_provider_accounts SET cooldown_until=unixepoch()-1 WHERE provider_id=?")
    .bind(exhausted.id)
    .run();
  await f.db
    .prepare("UPDATE ai_model_deployments SET cooldown_until=unixepoch()-1 WHERE provider_id=?")
    .bind(exhausted.id)
    .run();
  const resumed = await infer(f, model.name);
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT provider_id FROM ai_inference_attempts WHERE invocation_id=? ORDER BY ordinal LIMIT 1",
        )
        .bind(resumed.invocation_id)
        .first()
    ).provider_id,
    exhausted.id,
  );
  assert.equal(
    (await f.db.prepare("SELECT sum(reserved_amount) n FROM ai_quota_buckets").first()).n,
    0,
  );
});

test("quota rejections can exhaust more providers than the normal retry limit", async (t) => {
  const f = await fixture(t, { configure: false });
  const providers = [];
  for (let index = 0; index < 4; index++)
    providers.push(await createProvider(f, "limited-" + index, "fixture-rejected-key"));
  providers.push(await createProvider(f, "available"));
  const model = await createModel(
    f,
    "many-providers",
    providers.map((provider) => source(provider)),
  );
  await enable(f);
  const result = await infer(f, model.name);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM ai_inference_attempts WHERE invocation_id=?")
        .bind(result.invocation_id)
        .first()
    ).n,
    5,
  );
});

test("models can share a provider model and removing or disabling one model does not disable another", async (t) => {
  const f = await fixture(t, { configure: false });
  const provider = await createProvider(f, "shared");
  const first = await createModel(f, "first-model", [source(provider)]);
  const second = await createModel(f, "second-model", [source(provider)]);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM ai_model_deployments").first()).n, 1);
  await enable(f);
  await f.admin(`/model-configs/${first.id}`, {
    method: "PATCH",
    data: { ...writeModel(first), enabled: false },
  });
  assert.equal((await infer(f, second.name)).text, "Hello");
  const duplicate = { ...writeModel(second), providers: [source(provider), source(provider)] };
  await f.admin(`/model-configs/${second.id}`, { method: "PATCH", data: duplicate, expected: 400 });
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM ai_model_providers WHERE model_id=?")
        .bind(second.id)
        .first()
    ).n,
    1,
  );
});

test("account credentials roll inside a provider without cooling a working sibling account", async (t) => {
  const f = await fixture(t, { configure: false });
  const data = providerBody("accounts", "fixture-rejected-key");
  data.accounts.push({
    ...data.accounts[0],
    name: "Working",
    credentials: { api_key: "fixture-provider-key" },
  });
  const provider = (await f.admin("/provider-configs", { method: "POST", data, expected: 201 }))
    .item;
  const model = await createModel(f, "account-rolling", [source(provider)]);
  await enable(f);
  assert.equal((await infer(f, model.name)).text, "Hello");
  assert.equal((await infer(f, model.name)).text, "Hello");
  const attempts = (
    await f.db
      .prepare("SELECT account_id,status FROM ai_inference_attempts ORDER BY created_at,ordinal")
      .all()
  ).results;
  assert.equal(attempts.filter((attempt) => attempt.status === "succeeded").length, 2);
  assert.equal(attempts.filter((attempt) => attempt.status === "failed").length, 1);
});

test("insufficient credit rolls safely, while uncertain acceptance never repeats the request", async (t) => {
  const f = await fixture(t, { configure: false });
  const first = await createProvider(f, "credits", "fixture-credit-exhausted-key");
  const second = await createProvider(f, "fallback");
  const model = await createModel(f, "credit-rolling", [source(first), source(second)]);
  await enable(f);
  assert.equal((await infer(f, model.name)).text, "Hello");
  const account = await f.db
    .prepare("SELECT cooldown_until FROM ai_provider_accounts WHERE provider_id=?")
    .bind(first.id)
    .first();
  assert.ok(account.cooldown_until > Date.now() / 1000 + 3500);
  await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "unknown" }));
  const profile = (await f.call("/api/ai/models")).profiles[0];
  await f.testCall("infer", f.request({ profileKey: profile.key }), 503);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM ai_inference_attempts WHERE status='unknown'")
        .first()
    ).n,
    1,
  );
});

test("provider reset times support seconds, HTTP dates, durations, and explicit credit exhaustion", async (t) => {
  const f = await fixture(t, { configure: false });
  for (const [data, minimum] of [
    [{ status: 429, headers: { "retry-after": "90" } }, 90],
    [{ status: 429, headers: { "retry-after": new Date(Date.now() + 90000).toUTCString() } }, 88],
    [{ status: 429, headers: { "x-ratelimit-reset-tokens": "1h30m" } }, 5400],
    [{ status: 402, body: { error: { code: "insufficient_credits" } } }, 0],
    [
      {
        status: 429,
        body: { error: { status: "RESOURCE_EXHAUSTED", details: [{ retryDelay: "45s" }] } },
      },
      45,
    ],
  ]) {
    const error = await f.testCall("rejection", data);
    assert.equal(error.exhausted, true);
    assert.equal(error.accepted, false);
    assert.ok(error.retryAfter >= minimum);
    if (data.status === 402) assert.equal(error.blocked, true);
  }
  assert.equal((await f.testCall("rejection", { status: 503 })).accepted, true);
});

test("model catalogs normalize provider IDs and metadata and keep credentials server-side", async (t) => {
  const f = await fixture(t, { configure: false });
  const provider = await createProvider(f, "catalog");
  await f.bucket.put(
    "ai-fixture-catalog",
    JSON.stringify({
      data: [
        {
          id: "vendor/model",
          name: "Model",
          context_length: 65536,
          top_provider: { max_completion_tokens: 8192 },
        },
      ],
    }),
  );
  const catalog = await f.testCall("catalog", { id: provider.id });
  assert.deepEqual(catalog.models, [
    { id: "vendor/model", name: "Model", context_tokens: 65536, max_output_tokens: 8192 },
  ]);
  assert.ok(!JSON.stringify(catalog).includes("fixture-provider-key"));
});

test("credit exhaustion without a reset does not probe again until an administrator retries the provider", async (t) => {
  const f = await fixture(t, { configure: false });
  const first = await createProvider(f, "blocked", "fixture-credit-blocked-key"),
    second = await createProvider(f, "working");
  const model = await createModel(f, "blocked-credit-model", [source(first), source(second)]);
  await enable(f);
  await infer(f, model.name);
  const blocked = (await f.admin("/provider-configs")).items.find((item) => item.id === first.id);
  assert.ok(blocked.accounts[0].cooldown_until > 1e11);
  await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "credit-restored" }));
  const skipped = await infer(f, model.name);
  assert.equal(
    (
      await f.db
        .prepare("SELECT provider_id FROM ai_inference_attempts WHERE invocation_id=?")
        .bind(skipped.invocation_id)
        .first()
    ).provider_id,
    second.id,
  );
  await f.call(`/api/ai/admin/provider-configs/${first.id}/reset`, {
    method: "POST",
    data: { version: blocked.version },
    expected: 403,
  });
  await f.admin(`/provider-configs/${first.id}/reset`, {
    method: "POST",
    data: { version: blocked.version },
  });
  const resumed = await infer(f, model.name);
  assert.equal(
    (
      await f.db
        .prepare("SELECT provider_id FROM ai_inference_attempts WHERE invocation_id=?")
        .bind(resumed.invocation_id)
        .first()
    ).provider_id,
    first.id,
  );
});

test("ChatGPT account catalogs use slugs and hide non-display models", async (t) => {
  const f = await fixture(t, { configure: false });
  const provider = await createProvider(f, "oauth-catalog"),
    account = provider.accounts[0];
  const { envelope } = await f.testCall("seal", {
    purpose: "account:" + account.id,
    value: { access_token: "fixture-provider-key" },
  });
  await f.db
    .prepare(
      "UPDATE ai_provider_accounts SET auth_kind='oauth',oauth_issuer='https://issuer.example',oauth_subject='fixture-user',oauth_client_id='fixture-client',secret_envelope_json=? WHERE id=?",
    )
    .bind(envelope, account.id)
    .run();
  await f.bucket.put(
    "ai-fixture-catalog",
    JSON.stringify({
      models: [
        { slug: "display-model", display_name: "Visible model", visibility: "list" },
        { slug: "hidden-model", display_name: "Hidden model", visibility: "hidden" },
      ],
    }),
  );
  assert.deepEqual((await f.testCall("catalog", { id: provider.id })).models, [
    { id: "display-model", name: "Visible model" },
  ]);
});

test("removing an account during OAuth refresh cannot restore the revoked account", async (t) => {
  const f = await fixture(t, { configure: false });
  const provider = await createProvider(f, "removed-account"),
    account = provider.accounts[0];
  const { envelope } = await f.testCall("seal", {
    purpose: "account:" + account.id,
    value: { access_token: "fixture-old", refresh_token: "fixture-refresh" },
  });
  await f.db
    .prepare("UPDATE ai_providers SET config_json=? WHERE id=?")
    .bind(
      JSON.stringify({ oauth: { token_endpoint: "https://issuer.example/token" } }),
      provider.id,
    )
    .run();
  await f.db
    .prepare(
      "UPDATE ai_provider_accounts SET auth_kind='oauth',oauth_issuer='https://issuer.example',oauth_subject='fixture-user',oauth_client_id='fixture-client',credential_expires_at=unixepoch()-1,secret_envelope_json=? WHERE id=?",
    )
    .bind(envelope, account.id)
    .run();
  await f.bucket.put("ai-fixture-oauth", JSON.stringify({ refresh_delay: 1000 }));
  const pending = f.testCall("credentials", { id: account.id }, 503);
  let started = false;
  for (let index = 0; index < 40; index++) {
    const row = await f.db
      .prepare(
        "SELECT json_extract(metadata_json,'$._refresh.token') token FROM ai_provider_accounts WHERE id=?",
      )
      .bind(account.id)
      .first();
    if (row.token) {
      started = true;
      break;
    }
  }
  assert.ok(started, "Refresh is in progress");
  const replacement = {
    ...writeProvider(provider),
    accounts: providerBody("replacement").accounts,
  };
  await f.admin(`/provider-configs/${provider.id}`, { method: "PATCH", data: replacement });
  await pending;
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM ai_provider_accounts WHERE id=?")
        .bind(account.id)
        .first()
    ).status,
    "revoked",
  );
  assert.equal((await f.admin("/provider-configs")).items[0].accounts.length, 1);
});
