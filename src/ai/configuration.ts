import type { Hono } from "hono";
import type { AppEnv, AuthContext } from "../auth/types";
import { uuid } from "../auth/types";
import { aiAdapters, aiProtocols } from "../../shared/ai-configuration.ts";
import { fail } from "./errors";
import { seal, unseal } from "./secrets";
import {
  canonical,
  fields,
  first,
  flag,
  integer,
  object,
  parse,
  rows,
  statement,
  text,
} from "./store";
import type { AIEnv, Bind, Guard } from "./types";
import { providerModelCatalog } from "./model-catalog.ts";

type Row = Record<string, any>;
type Dependencies = {
  permission: (c: AuthContext, group: string, manage?: boolean) => Promise<string>;
  mutation: typeof import("./admin").adminMutation;
  validate: (resource: string, data: Record<string, unknown>) => void;
};

/** Routes are materialized for historical attempt FKs; model mappings own selection order. */
export function modelRouteWrites(env: AIEnv, modelId: string, won: Guard, profileId?: string) {
  const filter = profileId ? " AND p.id=?" : "";
  const args: Bind[] = [modelId, ...(profileId ? [profileId] : [])];
  return [
    statement(
      env,
      `UPDATE ai_profile_routes SET enabled=0,version=version+1 WHERE profile_id IN(SELECT p.id FROM ai_profiles p WHERE p.model_id=?${filter}) AND ${won.sql}`,
      ...args,
      ...won.args,
    ),
    statement(
      env,
      `INSERT INTO ai_profile_routes(id,profile_id,provider_id,deployment_id,pool_id,gateway_id,priority,enabled)
      SELECT COALESCE(r.id,'model:'||p.id||':'||mp.deployment_id),p.id,mp.provider_id,mp.deployment_id,mp.pool_id,mp.gateway_id,
        COALESCE(r.priority,(SELECT COALESCE(max(x.priority),-1) FROM ai_profile_routes x WHERE x.profile_id=p.id)+mp.priority+1),mp.enabled
      FROM ai_profiles p JOIN ai_model_providers mp ON mp.model_id=p.model_id
      LEFT JOIN ai_profile_routes r ON r.id=(SELECT x.id FROM ai_profile_routes x WHERE x.profile_id=p.id AND x.deployment_id=mp.deployment_id ORDER BY x.id LIMIT 1)
      WHERE p.model_id=?${filter} AND ${won.sql}
      ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,deployment_id=excluded.deployment_id,pool_id=excluded.pool_id,gateway_id=excluded.gateway_id,enabled=excluded.enabled,version=ai_profile_routes.version+1`,
      ...args,
      ...won.args,
    ),
    statement(
      env,
      `UPDATE ai_profiles SET version=version+1,updated_at=unixepoch() WHERE id IN(SELECT p.id FROM ai_profiles p WHERE p.model_id=?${filter}) AND ${won.sql}`,
      ...args,
      ...won.args,
    ),
  ];
}

async function providerConfigurations(env: AIEnv, id?: string) {
  const providers = await rows<Row>(
    env,
    "SELECT * FROM ai_providers WHERE archived_at IS NULL AND (? IS NULL OR id=?) ORDER BY name,id LIMIT 200",
    id ?? null,
    id ?? null,
  );
  const ids = canonical(providers.map((provider) => provider.id));
  const accounts = await rows<Row>(
    env,
    `SELECT a.*,COALESCE(m.priority,1000000) priority FROM ai_provider_accounts a JOIN ai_providers p ON p.id=a.provider_id LEFT JOIN ai_pool_members m ON m.account_id=a.id AND m.pool_id=p.pool_id WHERE a.provider_id IN(SELECT value FROM json_each(?)) AND a.status<>'revoked' ORDER BY priority,a.created_at,a.id`,
    ids,
  );
  const gateways = await rows<Row>(
    env,
    "SELECT * FROM ai_gateways WHERE id IN(SELECT gateway_id FROM ai_providers WHERE id IN(SELECT value FROM json_each(?)))",
    ids,
  );
  return providers.map((provider) => {
    const gateway = gateways.find((item) => item.id === provider.gateway_id);
    return {
      id: provider.id,
      key: provider.key,
      name: provider.name,
      adapter_key: provider.adapter_key,
      base_url: provider.base_url,
      enabled: !!provider.enabled,
      version: provider.version,
      oauth: parse(provider.config_json).oauth ?? null,
      accounts: accounts
        .filter((account) => account.provider_id === provider.id)
        .map((account) => ({
          id: account.id,
          version: account.version,
          name: account.name,
          auth_kind: account.auth_kind,
          share_scope: account.share_scope,
          owner_user_id: account.owner_user_id,
          authorization_ref: account.authorization_ref,
          status: account.status,
          concurrency_limit: account.concurrency_limit,
          quota_group_key: account.quota_group_key,
          has_secret: !!account.secret_envelope_json,
          cooldown_until: account.cooldown_until,
        })),
      gateway: gateway
        ? { ...parse(gateway.config_json), has_secret: !!gateway.secret_envelope_json }
        : null,
    };
  });
}
async function providerConfiguration(env: AIEnv, id: string) {
  const item = (await providerConfigurations(env, id))[0];
  if (!item) fail(404, "AI_NOT_FOUND");
  return item;
}
async function modelConfigurations(env: AIEnv, id?: string) {
  const models = await rows<Row>(
    env,
    "SELECT * FROM ai_models WHERE archived_at IS NULL AND (? IS NULL OR id=?) ORDER BY name,id LIMIT 200",
    id ?? null,
    id ?? null,
  );
  const sources = await rows<Row>(
    env,
    `SELECT mp.model_id,mp.id,mp.provider_id,mp.enabled,d.provider_model_id,d.protocol,d.auth_mode,d.capabilities_json,d.pricing_json,d.config_json,d.cooldown_until FROM ai_model_providers mp JOIN ai_model_deployments d ON d.id=mp.deployment_id WHERE mp.model_id IN(SELECT value FROM json_each(?)) ORDER BY mp.priority`,
    canonical(models.map((model) => model.id)),
  );
  return models.map((model) => ({
    id: model.id,
    key: model.key,
    name: model.name,
    vendor: model.vendor,
    enabled: !!model.enabled,
    version: model.version,
    providers: sources
      .filter((source) => source.model_id === model.id)
      .map(({ model_id, capabilities_json, pricing_json, config_json, enabled, ...source }) => ({
        ...source,
        enabled: !!enabled,
        capabilities: parse(capabilities_json),
        pricing: parse(pricing_json),
        config: parse(config_json),
      })),
  }));
}
async function modelConfiguration(env: AIEnv, id: string) {
  const item = (await modelConfigurations(env, id))[0];
  if (!item) fail(404, "AI_NOT_FOUND");
  return item;
}

export function registerAIConfiguration(app: Hono<AppEnv>, deps: Dependencies) {
  const { permission, mutation, validate } = deps;
  app.get("/provider-configs", async (c) => {
    await permission(c, "providers");
    return c.json({ items: await providerConfigurations(c.env) });
  });
  app.get("/provider-configs/:id", async (c) => {
    await permission(c, "providers");
    return c.json({ item: await providerConfiguration(c.env, c.req.param("id")) });
  });
  const saveProvider = async (c: AuthContext, updating: boolean) => {
    const permissionKey = await permission(c, "providers", true);
    const input = fields(object(await c.req.json()), [
      "version",
      "key",
      "name",
      "adapter_key",
      "base_url",
      "enabled",
      "oauth",
      "accounts",
      "gateway",
    ]);
    const id = updating ? text(c.req.param("id"), 100) : uuid();
    const previous = updating
      ? await first<Row>(c.env, "SELECT * FROM ai_providers WHERE id=? AND archived_at IS NULL", id)
      : null;
    if (updating && !previous) fail(404, "AI_NOT_FOUND");
    const version = updating ? integer(input.version, 1) : 0;
    if (previous && input.key !== previous.key) fail(400, "AI_INVALID_INPUT");
    if (!aiAdapters.includes(input.adapter_key as never)) fail(400, "AI_INVALID_INPUT");
    const provider = {
      key: text(input.key, 100),
      name: text(input.name, 200),
      adapter_key: text(input.adapter_key),
      base_url: text(input.base_url, 2000),
      enabled: flag(input.enabled),
      config_json: {
        ...parse(previous?.config_json ?? "{}"),
        ...(input.oauth ? { oauth: object(input.oauth) } : {}),
      },
    };
    if (!input.oauth) delete provider.config_json.oauth;
    validate("providers", provider);
    if (!Array.isArray(input.accounts) || !input.accounts.length || input.accounts.length > 16)
      fail(400, "AI_INVALID_INPUT");
    const existing = previous
      ? await rows<Row>(c.env, "SELECT * FROM ai_provider_accounts WHERE provider_id=?", id)
      : [];
    const accounts: Row[] = [];
    const poolId = previous?.pool_id ?? uuid();
    let guard: Guard = previous
      ? { sql: "EXISTS(SELECT 1 FROM ai_providers WHERE id=? AND version=?)", args: [id, version] }
      : { sql: "1", args: [] };
    for (const value of input.accounts) {
      const account = fields(object(value), [
        "id",
        "version",
        "name",
        "auth_kind",
        "share_scope",
        "owner_user_id",
        "authorization_ref",
        "status",
        "concurrency_limit",
        "quota_group_key",
        "credentials",
      ]);
      const old = account.id ? existing.find((item) => item.id === account.id) : null;
      if (account.id && !old) fail(400, "AI_INVALID_INPUT");
      if (old) {
        guard = {
          sql: `${guard.sql} AND EXISTS(SELECT 1 FROM ai_provider_accounts WHERE id=? AND version=? AND credential_version=?)`,
          args: [...guard.args, old.id, integer(account.version, 1), old.credential_version],
        };
      }
      if (
        !["api_key", "oauth"].includes(String(account.auth_kind)) ||
        !["owner", "workspace"].includes(String(account.share_scope))
      )
        fail(400, "AI_INVALID_INPUT");
      if (account.auth_kind === "oauth" && !input.oauth) fail(400, "AI_INVALID_INPUT");
      let envelope: string | null =
        old && old.auth_kind === account.auth_kind ? old.secret_envelope_json : null;
      const secret =
        account.credentials === undefined
          ? null
          : fields(object(account.credentials), ["api_key", "client_secret"]);
      const changedSecret = !!secret && Object.keys(secret).length > 0;
      const accountId = old?.id ?? uuid();
      if (changedSecret) {
        for (const value of Object.values(secret!)) text(value, 16384);
        const retained = envelope ? await unseal<Row>(c.env, "account:" + accountId, envelope) : {};
        envelope = await seal(c.env, "account:" + accountId, { ...retained, ...secret });
      }
      if (account.auth_kind === "api_key" && !envelope) fail(400, "AI_INVALID_INPUT");
      if (!["active", "disabled", "reauth_required"].includes(String(account.status)))
        fail(400, "AI_INVALID_INPUT");
      let status = String(account.status);
      if (
        account.auth_kind === "oauth" &&
        (!old?.oauth_subject || old?.auth_kind !== account.auth_kind)
      )
        status = "disabled";
      accounts.push({
        id: accountId,
        name: text(account.name, 200),
        auth_kind: account.auth_kind,
        owner_user_id:
          account.share_scope === "owner"
            ? text(account.owner_user_id ?? c.get("identity").user.id, 100)
            : null,
        share_scope: account.share_scope,
        sharing_authorization:
          account.share_scope === "workspace" ? "provider_permitted" : "owner_only",
        authorization_ref:
          account.share_scope === "workspace"
            ? text(account.authorization_ref ?? `console:${c.get("identity").user.id}`, 500)
            : null,
        status,
        concurrency_limit: integer(account.concurrency_limit ?? 1, 1, 10000),
        quota_group_key: account.quota_group_key ? text(account.quota_group_key, 200) : null,
        envelope,
        credential_changed: changedSecret || (old && old.auth_kind !== account.auth_kind),
      });
    }
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length)
      fail(400, "AI_INVALID_INPUT");
    let gateway: Row | null = null;
    if (input.gateway !== null && input.gateway !== undefined) {
      const value = fields(object(input.gateway), [
        "account_id",
        "gateway_id",
        "provider_slug",
        "api_key",
      ]);
      const gatewayId = previous?.gateway_id ?? uuid();
      const old = previous?.gateway_id
        ? await first<Row>(c.env, "SELECT * FROM ai_gateways WHERE id=?", gatewayId)
        : null;
      const config = Object.fromEntries(
        ["account_id", "gateway_id", "provider_slug"].map((field) => [
          field,
          text(value[field], 200),
        ]),
      );
      const envelope = value.api_key
        ? await seal(c.env, "gateway:" + gatewayId, { api_key: text(value.api_key, 16384) })
        : old?.secret_envelope_json;
      if (!envelope) fail(400, "AI_INVALID_INPUT");
      gateway = { id: gatewayId, config, envelope, changed: !!value.api_key };
    }
    await mutation(c, permissionKey, "provider.configure", "provider", id, guard, (won) => {
      const writes = [
        statement(
          c.env,
          `INSERT INTO ai_providers(id,key,name,adapter_key,base_url,config_json,enabled) SELECT ?,?,?,?,?,?,? WHERE ${won.sql} ON CONFLICT(id) DO UPDATE SET name=excluded.name,adapter_key=excluded.adapter_key,base_url=excluded.base_url,config_json=excluded.config_json,enabled=excluded.enabled,version=ai_providers.version+1,updated_at=unixepoch()`,
          id,
          provider.key,
          provider.name,
          provider.adapter_key,
          provider.base_url,
          provider.config_json as unknown as string,
          provider.enabled,
          ...won.args,
        ),
        statement(
          c.env,
          `INSERT INTO ai_account_pools(id,provider_id,name,strategy,enabled) SELECT ?,?,?,'priority',1 WHERE ${won.sql} ON CONFLICT(id) DO UPDATE SET strategy='priority',enabled=1,version=ai_account_pools.version+1`,
          poolId,
          id,
          provider.name,
          ...won.args,
        ),
        statement(
          c.env,
          `DELETE FROM ai_pool_members WHERE pool_id=? AND ${won.sql}`,
          poolId,
          ...won.args,
        ),
        statement(
          c.env,
          `UPDATE ai_provider_accounts SET status='revoked',version=version+1 WHERE provider_id=? AND id NOT IN(SELECT value FROM json_each(?)) AND ${won.sql}`,
          id,
          canonical(accounts.map((account) => account.id)),
          ...won.args,
        ),
      ];
      accounts.forEach((account, priority) => {
        writes.push(
          statement(
            c.env,
            `INSERT INTO ai_provider_accounts(id,provider_id,name,auth_kind,owner_user_id,share_scope,sharing_authorization,authorization_ref,status,concurrency_limit,quota_group_key,secret_envelope_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${won.sql} ON CONFLICT(id) DO UPDATE SET name=excluded.name,auth_kind=excluded.auth_kind,owner_user_id=excluded.owner_user_id,share_scope=excluded.share_scope,sharing_authorization=excluded.sharing_authorization,authorization_ref=excluded.authorization_ref,status=excluded.status,concurrency_limit=excluded.concurrency_limit,quota_group_key=excluded.quota_group_key,secret_envelope_json=excluded.secret_envelope_json,cooldown_until=CASE WHEN ?=1 THEN NULL ELSE ai_provider_accounts.cooldown_until END,last_error_code=CASE WHEN ?=1 THEN NULL ELSE ai_provider_accounts.last_error_code END,oauth_issuer=CASE WHEN ai_provider_accounts.auth_kind=excluded.auth_kind THEN ai_provider_accounts.oauth_issuer END,oauth_subject=CASE WHEN ai_provider_accounts.auth_kind=excluded.auth_kind THEN ai_provider_accounts.oauth_subject END,oauth_client_id=CASE WHEN ai_provider_accounts.auth_kind=excluded.auth_kind THEN ai_provider_accounts.oauth_client_id END,oauth_workspace_id=CASE WHEN ai_provider_accounts.auth_kind=excluded.auth_kind THEN ai_provider_accounts.oauth_workspace_id END,oauth_host_id=CASE WHEN ai_provider_accounts.auth_kind=excluded.auth_kind THEN ai_provider_accounts.oauth_host_id END,credential_expires_at=CASE WHEN ai_provider_accounts.auth_kind=excluded.auth_kind THEN ai_provider_accounts.credential_expires_at END,credential_version=ai_provider_accounts.credential_version+?,version=ai_provider_accounts.version+1,updated_at=unixepoch()`,
            account.id,
            id,
            account.name,
            account.auth_kind,
            account.owner_user_id,
            account.share_scope,
            account.sharing_authorization,
            account.authorization_ref,
            account.status,
            account.concurrency_limit,
            account.quota_group_key,
            account.envelope,
            ...won.args,
            account.credential_changed ? 1 : 0,
            account.credential_changed ? 1 : 0,
            account.credential_changed ? 1 : 0,
          ),
          statement(
            c.env,
            `INSERT INTO ai_pool_members(pool_id,account_id,provider_id,priority) SELECT ?,?,?,? WHERE ${won.sql}`,
            poolId,
            account.id,
            id,
            priority,
            ...won.args,
          ),
        );
      });
      if (gateway)
        writes.push(
          statement(
            c.env,
            `INSERT INTO ai_gateways(id,key,name,adapter_key,config_json,secret_envelope_json,enabled) SELECT ?,?,?,'cloudflare',?,?,1 WHERE ${won.sql} ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,secret_envelope_json=excluded.secret_envelope_json,enabled=1,version=ai_gateways.version+1,credential_version=ai_gateways.credential_version+?`,
            gateway.id,
            "provider:" + id,
            provider.name,
            canonical(gateway.config),
            gateway.envelope,
            ...won.args,
            gateway.changed ? 1 : 0,
          ),
        );
      writes.push(
        statement(
          c.env,
          `UPDATE ai_model_deployments SET cooldown_until=NULL,last_error_code=NULL WHERE provider_id=? AND ${won.sql}`,
          id,
          ...won.args,
        ),
        statement(
          c.env,
          `UPDATE ai_providers SET pool_id=?,gateway_id=? WHERE id=? AND ${won.sql}`,
          poolId,
          gateway?.id ?? null,
          id,
          ...won.args,
        ),
        statement(
          c.env,
          `UPDATE ai_model_providers SET pool_id=?,gateway_id=? WHERE provider_id=? AND ${won.sql}`,
          poolId,
          gateway?.id ?? null,
          id,
          ...won.args,
        ),
        statement(
          c.env,
          `UPDATE ai_profile_routes SET pool_id=?,gateway_id=?,version=version+1 WHERE provider_id=? AND ${won.sql}`,
          poolId,
          gateway?.id ?? null,
          id,
          ...won.args,
        ),
      );
      return writes;
    });
    return c.json({ item: await providerConfiguration(c.env, id) }, updating ? 200 : 201);
  };
  app.post("/provider-configs", (c) => saveProvider(c, false));
  app.patch("/provider-configs/:id", (c) => saveProvider(c, true));
  app.post("/provider-configs/:id/reset", async (c) => {
    const key = await permission(c, "providers", true),
      id = text(c.req.param("id"), 100);
    const version = integer(fields(object(await c.req.json()), ["version"]).version, 1);
    await mutation(
      c,
      key,
      "provider.retry",
      "provider",
      id,
      {
        sql: "EXISTS(SELECT 1 FROM ai_providers WHERE id=? AND version=? AND archived_at IS NULL)",
        args: [id, version],
      },
      (won) => [
        statement(
          c.env,
          `UPDATE ai_provider_accounts SET cooldown_until=NULL,last_error_code=NULL WHERE provider_id=? AND ${won.sql}`,
          id,
          ...won.args,
        ),
        statement(
          c.env,
          `UPDATE ai_model_deployments SET cooldown_until=NULL,last_error_code=NULL WHERE provider_id=? AND ${won.sql}`,
          id,
          ...won.args,
        ),
        statement(
          c.env,
          `UPDATE ai_providers SET version=version+1 WHERE id=? AND ${won.sql}`,
          id,
          ...won.args,
        ),
      ],
    );
    return c.json({ item: await providerConfiguration(c.env, id) });
  });
  app.get("/provider-configs/:id/models", async (c) => {
    await permission(c, "providers", true);
    return c.json(
      await providerModelCatalog(
        c.env,
        c.req.param("id"),
        c.get("identity").user.id,
        c.req.query("cursor"),
      ),
    );
  });

  app.get("/model-configs", async (c) => {
    await permission(c, "providers");
    return c.json({ items: await modelConfigurations(c.env) });
  });
  app.get("/model-configs/:id", async (c) => {
    await permission(c, "providers");
    return c.json({ item: await modelConfiguration(c.env, c.req.param("id")) });
  });
  const saveModel = async (c: AuthContext, updating: boolean) => {
    const permissionKey = await permission(c, "providers", true);
    const input = fields(object(await c.req.json()), [
      "version",
      "key",
      "name",
      "vendor",
      "enabled",
      "providers",
    ]);
    const id = updating ? text(c.req.param("id"), 100) : uuid();
    const previous = updating
      ? await first<Row>(c.env, "SELECT * FROM ai_models WHERE id=? AND archived_at IS NULL", id)
      : null;
    if (updating && !previous) fail(404, "AI_NOT_FOUND");
    if (previous && input.key !== previous.key) fail(400, "AI_INVALID_INPUT");
    const key = text(input.key, 100),
      name = text(input.name, 200),
      vendor = text(input.vendor ?? "", 200, true),
      enabled = flag(input.enabled);
    if (!Array.isArray(input.providers) || !input.providers.length || input.providers.length > 64)
      fail(400, "AI_INVALID_INPUT");
    const existing = previous
      ? await rows<Row>(c.env, "SELECT * FROM ai_model_providers WHERE model_id=?", id)
      : [];
    let guard: Guard = previous
      ? {
          sql: "EXISTS(SELECT 1 FROM ai_models WHERE id=? AND version=?)",
          args: [id, integer(input.version, 1)],
        }
      : { sql: "1", args: [] };
    const requested = input.providers.map((value) =>
      fields(object(value), [
        "id",
        "provider_id",
        "provider_model_id",
        "protocol",
        "auth_mode",
        "enabled",
        "capabilities",
        "pricing",
        "config",
      ]),
    );
    const providerRows = await rows<Row>(
      c.env,
      "SELECT * FROM ai_providers WHERE archived_at IS NULL AND id IN(SELECT value FROM json_each(?))",
      canonical(requested.map((source) => text(source.provider_id, 100))),
    );
    const deploymentRows = await rows<Row>(
      c.env,
      `SELECT DISTINCT d.* FROM ai_model_deployments d JOIN json_each(?) source ON d.provider_id=json_extract(source.value,'$.provider_id') AND d.provider_model_id=json_extract(source.value,'$.provider_model_id') AND d.protocol=json_extract(source.value,'$.protocol') AND d.auth_mode=json_extract(source.value,'$.auth_mode')`,
      canonical(
        requested.map(({ provider_id, provider_model_id, protocol, auth_mode }) => ({
          provider_id,
          provider_model_id,
          protocol,
          auth_mode,
        })),
      ),
    );
    const sources: Row[] = [];
    for (const source of requested) {
      if (source.id && !existing.some((row) => row.id === source.id)) fail(400, "AI_INVALID_INPUT");
      const provider = providerRows.find((row) => row.id === source.provider_id);
      if (!provider?.pool_id) fail(400, "AI_INVALID_INPUT");
      if (
        !aiProtocols.includes(source.protocol as never) ||
        !["api", "chatgpt_plan", "platform"].includes(String(source.auth_mode))
      )
        fail(400, "AI_INVALID_INPUT");
      const data: Row = {
        provider_id: provider.id,
        provider_model_id: text(source.provider_model_id, 300),
        protocol: source.protocol,
        auth_mode: source.auth_mode,
        capabilities_json: object(source.capabilities),
        pricing_json: object(source.pricing),
        config_json: object(source.config ?? {}),
        enabled: flag(source.enabled),
      };
      validate("deployments", data);
      const caps = parse(String(data.capabilities_json));
      integer(caps.context_tokens, 1);
      integer(caps.max_output_tokens, 1);
      const pricing = parse(String(data.pricing_json));
      if (data.enabled && pricing.source !== "unknown") {
        integer(pricing.input);
        integer(pricing.output);
      }
      if (
        data.enabled &&
        (caps.bounded_usage !== true ||
          caps.input_token_bound !== "utf8_bytes" ||
          (data.auth_mode !== "chatgpt_plan" && caps.enforces_output_limit !== true))
      )
        fail(400, "AI_USAGE_BOUND_UNAVAILABLE");
      const deployment = deploymentRows.find(
        (row) =>
          row.provider_id === provider.id &&
          row.provider_model_id === data.provider_model_id &&
          row.protocol === data.protocol &&
          row.auth_mode === data.auth_mode,
      );
      sources.push({
        ...data,
        id: source.id ?? uuid(),
        deployment_id: deployment?.id ?? uuid(),
        pool_id: provider.pool_id,
        gateway_id: provider.gateway_id,
      });
    }
    if (
      new Set(
        sources.map((source) =>
          [source.provider_id, source.provider_model_id, source.protocol, source.auth_mode].join(
            "\0",
          ),
        ),
      ).size !== sources.length ||
      new Set(sources.map((source) => source.id)).size !== sources.length
    )
      fail(400, "AI_INVALID_INPUT");
    guard = {
      sql: `${guard.sql} AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM ai_providers p WHERE p.id=json_extract(expected.value,'$.id') AND p.version=json_extract(expected.value,'$.version'))) AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM ai_model_deployments d WHERE d.id=json_extract(expected.value,'$.id') AND d.version=json_extract(expected.value,'$.version')))`,
      args: [
        ...guard.args,
        canonical(providerRows.map(({ id, version }) => ({ id, version }))),
        canonical(deploymentRows.map(({ id, version }) => ({ id, version }))),
      ],
    };
    const profileId = previous?.profile_id ?? uuid();
    await mutation(c, permissionKey, "model.configure", "model", id, guard, (won) => {
      const writes = [
        statement(
          c.env,
          `INSERT INTO ai_models(id,key,name,vendor,enabled) SELECT ?,?,?,?,? WHERE ${won.sql} ON CONFLICT(id) DO UPDATE SET name=excluded.name,vendor=excluded.vendor,enabled=excluded.enabled,version=ai_models.version+1,updated_at=unixepoch()`,
          id,
          key,
          name,
          vendor,
          enabled,
          ...won.args,
        ),
        statement(
          c.env,
          `DELETE FROM ai_model_providers WHERE model_id=? AND ${won.sql}`,
          id,
          ...won.args,
        ),
      ];
      sources.forEach((source, priority) =>
        writes.push(
          statement(
            c.env,
            `INSERT INTO ai_model_deployments(id,model_id,provider_id,provider_model_id,protocol,auth_mode,capabilities_json,pricing_json,config_json,enabled,verified_at) SELECT ?,?,?,?,?,?,?,?,?,?,unixepoch() WHERE ${won.sql} ON CONFLICT(id) DO UPDATE SET capabilities_json=excluded.capabilities_json,pricing_json=excluded.pricing_json,config_json=excluded.config_json,enabled=CASE WHEN excluded.enabled=1 THEN 1 ELSE ai_model_deployments.enabled END,version=ai_model_deployments.version+1,updated_at=unixepoch()`,
            source.deployment_id,
            id,
            source.provider_id,
            source.provider_model_id,
            source.protocol,
            source.auth_mode,
            source.capabilities_json,
            source.pricing_json,
            source.config_json,
            source.enabled,
            ...won.args,
          ),
          statement(
            c.env,
            `INSERT INTO ai_model_providers(id,model_id,provider_id,deployment_id,pool_id,gateway_id,priority,enabled) SELECT ?,?,?,?,?,?,?,? WHERE ${won.sql}`,
            source.id,
            id,
            source.provider_id,
            source.deployment_id,
            source.pool_id,
            source.gateway_id,
            priority,
            source.enabled,
            ...won.args,
          ),
        ),
      );
      if (!previous?.profile_id) {
        writes.push(
          statement(
            c.env,
            `INSERT INTO ai_profiles(id,key,name,model_id,enabled) SELECT ?,?,?,?,? WHERE ${won.sql}`,
            profileId,
            "model-" + profileId,
            name,
            id,
            enabled,
            ...won.args,
          ),
          statement(
            c.env,
            `INSERT INTO ai_consumer_profiles(consumer_key,profile_id,enabled) SELECT 'hub.chat',?,1 WHERE ${won.sql}`,
            profileId,
            ...won.args,
          ),
          statement(
            c.env,
            `UPDATE ai_models SET profile_id=? WHERE id=? AND ${won.sql}`,
            profileId,
            id,
            ...won.args,
          ),
        );
      } else {
        writes.push(
          statement(
            c.env,
            `UPDATE ai_profiles SET name=?,enabled=? WHERE id=? AND ${won.sql}`,
            name,
            enabled,
            profileId,
            ...won.args,
          ),
        );
      }
      writes.push(
        statement(
          c.env,
          `UPDATE ai_consumer_profiles SET is_default=0 WHERE consumer_key='hub.chat' AND is_default=1 AND profile_id IN(SELECT id FROM ai_profiles WHERE enabled=0) AND ${won.sql}`,
          ...won.args,
        ),
        statement(
          c.env,
          `UPDATE ai_consumer_profiles SET is_default=1 WHERE consumer_key='hub.chat' AND profile_id=(SELECT cp.profile_id FROM ai_consumer_profiles cp JOIN ai_profiles p ON p.id=cp.profile_id WHERE cp.consumer_key='hub.chat' AND cp.enabled=1 AND p.enabled=1 ORDER BY p.created_at,p.id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM ai_consumer_profiles WHERE consumer_key='hub.chat' AND is_default=1) AND ${won.sql}`,
          ...won.args,
        ),
        ...modelRouteWrites(c.env, id, won),
      );
      return writes;
    });
    return c.json({ item: await modelConfiguration(c.env, id) }, updating ? 200 : 201);
  };
  app.post("/model-configs", (c) => saveModel(c, false));
  app.patch("/model-configs/:id", (c) => saveModel(c, true));
}
