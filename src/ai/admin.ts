import { Hono } from "hono";
import { requireAccess } from "../auth/store";
import { can } from "../authorization/access";
import { permissionClosure } from "../authorization/permissions";
import type { AppEnv, AuthContext } from "../auth/types";
import { now, uuid as newId } from "../auth/types";
import { consumerCatalog, consumerDefinition } from "./consumers";
import { fail } from "./errors";
import { assertSchema } from "./json-schema";
import { safeUrl } from "./providers";
import { seal } from "./secrets";
import {
  canonical,
  ensureUserSubject,
  fields,
  first,
  flag,
  identityGuard,
  integer,
  object,
  parse,
  rows,
  session,
  statement,
  text,
} from "./store";
import { rulesFor, settings } from "./quota";
import { closeReconciledRun, reconcileInvocation, usageAdjustment } from "./reconciliation";
import { userPrincipal } from "./types";

type Resource = {
  table: string;
  permission: "settings" | "providers" | "quotas";
  key?: string;
  fields: string[];
  json?: string[];
  defaults?: Record<string, unknown>;
};
const resources: Record<string, Resource> = {
  providers: {
    table: "ai_providers",
    permission: "providers",
    fields: ["key", "name", "adapter_key", "base_url", "config_json", "enabled"],
    json: ["config_json"],
  },
  gateways: {
    table: "ai_gateways",
    permission: "providers",
    fields: ["key", "name", "adapter_key", "config_json", "enabled"],
    json: ["config_json"],
  },
  accounts: {
    table: "ai_provider_accounts",
    permission: "providers",
    fields: [
      "provider_id",
      "name",
      "auth_kind",
      "owner_user_id",
      "share_scope",
      "sharing_authorization",
      "authorization_ref",
      "status",
      "metadata_json",
      "quota_group_key",
      "concurrency_limit",
    ],
    json: ["metadata_json"],
  },
  pools: {
    table: "ai_account_pools",
    permission: "providers",
    fields: ["provider_id", "name", "strategy", "enabled"],
  },
  models: {
    table: "ai_models",
    permission: "providers",
    fields: ["key", "name", "vendor", "capabilities_json", "enabled"],
    json: ["capabilities_json"],
  },
  deployments: {
    table: "ai_model_deployments",
    permission: "providers",
    fields: [
      "model_id",
      "provider_id",
      "provider_model_id",
      "protocol",
      "auth_mode",
      "capabilities_json",
      "pricing_json",
      "config_json",
      "enabled",
    ],
    json: ["capabilities_json", "pricing_json", "config_json"],
  },
  profiles: {
    table: "ai_profiles",
    permission: "settings",
    fields: [
      "key",
      "name",
      "required_capabilities_json",
      "generation_json",
      "data_policy_json",
      "limits_json",
      "enabled",
    ],
    json: ["required_capabilities_json", "generation_json", "data_policy_json", "limits_json"],
  },
  routes: {
    table: "ai_profile_routes",
    permission: "settings",
    fields: [
      "profile_id",
      "provider_id",
      "deployment_id",
      "pool_id",
      "gateway_id",
      "priority",
      "config_json",
      "enabled",
    ],
    json: ["config_json"],
  },
  consumers: {
    table: "ai_consumers",
    key: "key",
    permission: "settings",
    fields: [
      "key",
      "name",
      "principal_kind",
      "billing_policy",
      "budget_subject_id",
      "tools_allowed",
      "limits_json",
      "enabled",
    ],
    json: ["limits_json"],
  },
  "quota-plans": {
    table: "ai_quota_plans",
    permission: "quotas",
    fields: ["key", "name", "enabled"],
  },
  "mcp-servers": {
    table: "ai_mcp_servers",
    permission: "settings",
    fields: ["key", "name", "transport", "builtin_key", "endpoint_url", "config_json", "enabled"],
    json: ["config_json"],
  },
};
export function adminPrincipal(c: AuthContext) {
  return userPrincipal(c.get("identity"));
}
async function permission(c: AuthContext, group: string, manage = false) {
  const key = `admin.ai.${group}.${manage ? "manage" : "read"}`;
  if (!(await can(c, key as never))) fail(403, "AI_FORBIDDEN");
  return key;
}
export async function adminMutation(
  c: AuthContext,
  permissionKey: string,
  action: string,
  target: string,
  targetId: string,
  guard: { sql: string; args: (string | number | null)[] },
  writes: (won: { sql: string; args: string[] }) => D1PreparedStatement[],
) {
  const token = newId(),
    identity = identityGuard(adminPrincipal(c)),
    user = c.get("identity").user.id;
  const required = canonical(permissionClosure([permissionKey]));
  const won = { sql: "EXISTS(SELECT 1 FROM ai_audit_events WHERE event_key=?)", args: [token] };
  await session(c.env).batch([
    statement(
      c.env,
      `INSERT INTO ai_audit_events(event_key,actor_key,actor_user_id,action,target_type,target_id) SELECT ?,?,?,?,?,? WHERE ${guard.sql} AND ${identity.sql} AND NOT EXISTS(SELECT 1 FROM json_each(?) needed WHERE NOT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=? AND rp.permission_key=needed.value))`,
      token,
      "user:" + user,
      user,
      action,
      target,
      targetId,
      ...guard.args,
      ...identity.args,
      required,
      user,
    ),
    ...writes(won),
  ]);
  if (!(await first(c.env, "SELECT seq FROM ai_audit_events WHERE event_key=?", token)))
    fail(409, "AI_CONFLICT");
}
function publicRow(row: Record<string, unknown>) {
  const {
    secret_envelope_json,
    metadata_json,
    oauth_subject,
    oauth_client_id,
    oauth_host_id,
    ...safe
  } = row;
  if (Object.hasOwn(row, "secret_envelope_json")) safe.has_secret = !!secret_envelope_json;
  if (metadata_json) {
    const metadata = parse(String(metadata_json));
    delete metadata._refresh;
    safe.metadata_json = metadata;
  }
  return safe;
}
function validateConfig(resource: string, data: Record<string, unknown>) {
  if (data.base_url !== undefined)
    data.base_url = safeUrl(text(data.base_url, 2000)).href.replace(/\/$/, "");
  if (data.endpoint_url !== undefined && data.endpoint_url !== null)
    data.endpoint_url = safeUrl(text(data.endpoint_url, 2000)).href;
  if (
    resource === "providers" &&
    data.adapter_key !== undefined &&
    !["openai", "openrouter", "anthropic", "google", "cloudflare", "openai_compatible"].includes(
      String(data.adapter_key),
    )
  )
    fail(400, "AI_INVALID_INPUT");
  if (
    resource === "gateways" &&
    data.adapter_key !== undefined &&
    data.adapter_key !== "cloudflare"
  )
    fail(400, "AI_INVALID_INPUT");
  if (
    resource === "accounts" &&
    data.auth_kind !== undefined &&
    !["api_key", "oauth"].includes(String(data.auth_kind))
  )
    fail(400, "AI_INVALID_INPUT");
  if (data.concurrency_limit !== undefined) integer(data.concurrency_limit, 1, 10000);
  for (const field of ["enabled", "tools_allowed"])
    if (data[field] !== undefined) data[field] = flag(data[field]);
  for (const [field, value] of Object.entries(data))
    if (field.endsWith("_json")) {
      const parsed = typeof value === "string" ? object(JSON.parse(value)) : object(value);
      if (
        Object.keys(parsed).some(
          (key) =>
            key.startsWith("_") ||
            /secret|authorization|api_key|access_token|refresh_token/i.test(key),
        )
      )
        fail(400, "AI_INVALID_INPUT");
      if (field === "limits_json")
        for (const [key, amount] of Object.entries(parsed))
          if (key !== "schema_version" && amount !== null) integer(amount, 1);
      if (field === "generation_json")
        fields(parsed, ["schema_version", "temperature", "top_p", "reasoning_effort"]);
      if (field === "pricing_json") {
        fields(parsed, [
          "schema_version",
          "source",
          "currency",
          "unit",
          "input",
          "output",
          "cache_read",
          "cache_write",
          "effective_at",
        ]);
        if (parsed.currency !== "USD" || parsed.unit !== "micro_usd_per_million_tokens")
          fail(400, "AI_INVALID_INPUT");
        for (const key of ["input", "output", "cache_read", "cache_write"])
          if (parsed[key] !== undefined && parsed[key] !== null) integer(parsed[key]);
      }
      if (parsed.oauth !== undefined) {
        const oauth = object(parsed.oauth);
        fields(oauth, [
          "issuer",
          "authorization_endpoint",
          "token_endpoint",
          "jwks_uri",
          "revocation_endpoint",
          "client_id",
          "scope",
          "resource",
          "hosted_authorization_ref",
        ]);
        for (const key of [
          "issuer",
          "authorization_endpoint",
          "token_endpoint",
          "jwks_uri",
          "revocation_endpoint",
          "resource",
        ])
          if (oauth[key]) safeUrl(text(oauth[key], 2000));
        if (
          resource === "providers" &&
          oauth.issuer === "https://auth.openai.com" &&
          !oauth.hosted_authorization_ref
        )
          fail(400, "AI_INVALID_INPUT");
      }
      data[field] = canonical(parsed);
    }
}
export const aiAdmin = new Hono<AppEnv>();
aiAdmin.use("*", requireAccess);
aiAdmin.get("/settings", async (c) => {
  await permission(c, "settings");
  return c.json({ settings: await settings(c.env), consumers: consumerCatalog() });
});
aiAdmin.patch("/settings", async (c) => {
  const key = await permission(c, "settings", true),
    data = fields(object(await c.req.json()), [
      "version",
      "enabled",
      "default_user_plan_id",
      "quota_time_zone",
      "payload_retention_days",
    ]),
    expected = integer(data.version, 1);
  if (data.enabled !== undefined) {
    data.enabled = flag(data.enabled);
    if (data.enabled) await seal(c.env, "configuration-check", {});
  }
  if (data.payload_retention_days !== undefined) integer(data.payload_retention_days, 1, 3650);
  if (data.quota_time_zone !== undefined) {
    const zone = text(data.quota_time_zone, 100);
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    } catch {
      fail(400, "AI_INVALID_INPUT");
    }
    if (
      zone !== (await settings(c.env)).quota_time_zone &&
      (await first(c.env, "SELECT id FROM ai_quota_buckets LIMIT 1"))
    )
      fail(409, "AI_CONFLICT");
  }
  delete data.version;
  const entries = Object.entries(data);
  if (!entries.length) fail(400, "AI_INVALID_INPUT");
  await adminMutation(
    c,
    key,
    "settings.update",
    "settings",
    "1",
    { sql: "EXISTS(SELECT 1 FROM ai_settings WHERE id=1 AND version=?)", args: [expected] },
    (won) => [
      statement(
        c.env,
        `UPDATE ai_settings SET ${entries.map(([field]) => field + "=?").join(",")},version=version+1,policy_epoch=policy_epoch+1,updated_at=unixepoch(),updated_by=? WHERE id=1 AND ${won.sql}`,
        ...entries.map(([, value]) => value as string | number | null),
        c.get("identity").user.id,
        ...won.args,
      ),
    ],
  );
  return c.json({ settings: await settings(c.env) });
});
aiAdmin.get("/usage", async (c) => {
  await permission(c, "usage");
  const after = Number(c.req.query("after") ?? now() - 30 * 86400),
    before = Number(c.req.query("before") ?? now() + 1);
  integer(after);
  integer(before, after + 1);
  if (before - after > 366 * 86400) fail(400, "AI_INVALID_INPUT");
  return c.json({
    usage: await rows(
      c.env,
      `SELECT i.billing_subject_id,i.consumer_key,count(DISTINCT i.id) invocations,COALESCE(sum(u.input_tokens_delta),0) input_tokens,COALESCE(sum(u.output_tokens_delta),0) output_tokens,sum(u.cost_micro_usd_delta) cost_micro_usd,sum(CASE WHEN u.cost_source='unknown' THEN 1 ELSE 0 END) unknown_cost_events FROM ai_invocations i LEFT JOIN ai_inference_attempts a ON a.invocation_id=i.id LEFT JOIN ai_usage_events u ON u.attempt_id=a.id WHERE i.created_at>=? AND i.created_at<? GROUP BY i.billing_subject_id,i.consumer_key ORDER BY i.billing_subject_id LIMIT 500`,
      after,
      before,
    ),
  });
});
aiAdmin.get("/audit", async (c) => {
  await permission(c, "audit");
  return c.json({
    events: await rows(
      c.env,
      "SELECT * FROM ai_audit_events WHERE seq<? ORDER BY seq DESC LIMIT 100",
      integer(Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER), 1),
    ),
  });
});
aiAdmin.get("/reconciliation", async (c) => {
  await permission(c, "usage");
  return c.json({
    invocations: await rows(
      c.env,
      "SELECT id,consumer_key,billing_subject_id,status,created_at FROM ai_invocations WHERE status='unknown' ORDER BY created_at LIMIT 100",
    ),
    tool_calls: await rows(
      c.env,
      "SELECT id,run_id,status,created_at FROM ai_tool_calls WHERE status='unknown' ORDER BY created_at LIMIT 100",
    ),
    external_operations: await rows(
      c.env,
      "SELECT id,owner_user_id,tool_name,status,created_at FROM mcp_tool_operations WHERE status='unknown' ORDER BY created_at LIMIT 100",
    ),
  });
});
aiAdmin.post("/invocations/:id/reconcile", async (c) => {
  await permission(c, "quotas", true);
  const data = fields(object(await c.req.json()), ["reason"]),
    reason = text(data.reason, 1000);
  await statement(
    c.env,
    "INSERT INTO ai_audit_events(event_key,actor_key,action,target_type,target_id,details_json) VALUES(?,?,'invocation.reconcile.request','invocation',?,?)",
    newId(),
    "user:" + c.get("identity").user.id,
    c.req.param("id"),
    canonical({ reason }),
  ).run();
  await reconcileInvocation(c.env, c.req.param("id"));
  await statement(
    c.env,
    "INSERT INTO ai_audit_events(event_key,actor_key,action,target_type,target_id,details_json) VALUES(?,?,'invocation.reconcile','invocation',?,?)",
    newId(),
    "user:" + c.get("identity").user.id,
    c.req.param("id"),
    canonical({ reason, accounting: "conservative_estimate" }),
  ).run();
  return c.json({ status: "reconciled", accounting: "estimated" });
});
aiAdmin.post("/tool-calls/:id/reconcile", async (c) => {
  await permission(c, "quotas", true);
  const reason = text(fields(object(await c.req.json()), ["reason"]).reason, 1000),
    id = c.req.param("id");
  const call = await first<{ run_id: string; reservation_id: string | null; created_at: number }>(
    c.env,
    "SELECT run_id,reservation_id,created_at FROM ai_tool_calls WHERE id=? AND status='unknown'",
    id,
  );
  if (!call) fail(409, "AI_CONFLICT");
  if (call.created_at + 600 > now()) fail(409, "AI_BUSY");
  await statement(
    c.env,
    "INSERT INTO ai_audit_events(event_key,actor_key,action,target_type,target_id,details_json) VALUES(?,?,'tool.reconcile','tool_call',?,?)",
    newId(),
    "user:" + c.get("identity").user.id,
    id,
    canonical({ reason, resolution: "failed_without_retry" }),
  ).run();
  if (call.reservation_id)
    await (await import("./quota")).settle(c.env, call.reservation_id, { tool_calls: 1 });
  await statement(
    c.env,
    "UPDATE ai_tool_calls SET status='failed',error_code='AI_RESULT_UNKNOWN',finished_at=unixepoch() WHERE id=? AND status='unknown'",
    id,
  ).run();
  await closeReconciledRun(c.env, call.run_id);
  return c.json({ status: "failed", retried: false });
});
aiAdmin.post("/attempts/:id/usage", async (c) => {
  await permission(c, "quotas", true);
  const data = fields(object(await c.req.json()), ["reason", "input_tokens", "output_tokens"]),
    reason = text(data.reason, 1000),
    input = integer(data.input_tokens),
    output = integer(data.output_tokens);
  const key = "usage-correction:" + text(c.req.header("idempotency-key"), 128);
  await usageAdjustment(
    c.env,
    c.req.param("id"),
    key,
    {
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      source: "provider",
    },
    reason,
  );
  await statement(
    c.env,
    "INSERT INTO ai_audit_events(event_key,actor_key,action,target_type,target_id,details_json) VALUES(?,?,'usage.adjust','attempt',?,?) ON CONFLICT(event_key) DO NOTHING",
    key,
    "user:" + c.get("identity").user.id,
    c.req.param("id"),
    canonical({ reason, input_tokens: input, output_tokens: output }),
  ).run();
  return c.json({ adjusted: true });
});
aiAdmin.get("/users/:user/quota", async (c) => {
  await permission(c, "quotas");
  const subject = await ensureUserSubject(c.env, c.req.param("user"));
  return c.json({
    subject: await first(c.env, "SELECT * FROM ai_subjects WHERE id=?", subject),
    rules: await rulesFor(c.env, [subject]),
    overrides: await rows(c.env, "SELECT * FROM ai_quota_overrides WHERE subject_id=?", subject),
    buckets: await rows(
      c.env,
      "SELECT * FROM ai_quota_buckets WHERE subject_id=? AND window_end>unixepoch()",
      subject,
    ),
  });
});
aiAdmin.put("/users/:user/quota", async (c) => {
  const key = await permission(c, "quotas", true),
    subject = await ensureUserSubject(c.env, c.req.param("user")),
    data = fields(object(await c.req.json()), ["version", "plan_id", "status", "overrides"]),
    expected = integer(data.version, 1);
  if (!Array.isArray(data.overrides) || data.overrides.length > 64) fail(400, "AI_INVALID_INPUT");
  if (data.status !== undefined && !["active", "suspended"].includes(String(data.status)))
    fail(400, "AI_INVALID_INPUT");
  const overrides = data.overrides.map((value) => {
    const rule = fields(object(value), ["metric", "window_kind", "scope_key", "limit_value"]);
    if (rule.limit_value !== null) integer(rule.limit_value);
    return rule;
  });
  await adminMutation(
    c,
    key,
    "quota.update",
    "subject",
    subject,
    {
      sql: "EXISTS(SELECT 1 FROM ai_subjects WHERE id=? AND version=?)",
      args: [subject, expected],
    },
    (won) => [
      statement(
        c.env,
        `DELETE FROM ai_quota_overrides WHERE subject_id=? AND ${won.sql}`,
        subject,
        ...won.args,
      ),
      ...overrides.map((rule) =>
        statement(
          c.env,
          `INSERT INTO ai_quota_overrides(id,subject_id,metric,window_kind,scope_key,limit_value,updated_by) SELECT ?,?,?,?,?,?,? WHERE ${won.sql}`,
          newId(),
          subject,
          text(rule.metric),
          text(rule.window_kind),
          text(rule.scope_key ?? "*"),
          rule.limit_value as number | null,
          c.get("identity").user.id,
          ...won.args,
        ),
      ),
      statement(
        c.env,
        `UPDATE ai_subjects SET plan_id=?,status=?,version=version+1,updated_at=unixepoch() WHERE id=? AND ${won.sql}`,
        data.plan_id === null || data.plan_id === undefined ? null : text(data.plan_id),
        String(data.status ?? "active"),
        subject,
        ...won.args,
      ),
    ],
  );
  return c.json({
    subject: await first(c.env, "SELECT * FROM ai_subjects WHERE id=?", subject),
    rules: await rulesFor(c.env, [subject]),
  });
});
aiAdmin.put("/quota-plans/:plan/rules", async (c) => {
  const key = await permission(c, "quotas", true),
    plan = c.req.param("plan"),
    data = fields(object(await c.req.json()), ["version", "rules"]),
    expected = integer(data.version, 1);
  if (!Array.isArray(data.rules) || data.rules.length > 64) fail(400, "AI_INVALID_INPUT");
  const rules = data.rules.map((value) => {
    const rule = fields(object(value), ["metric", "window_kind", "scope_key", "limit_value"]);
    if (rule.limit_value !== null) integer(rule.limit_value);
    return rule;
  });
  await adminMutation(
    c,
    key,
    "plan.rules",
    "plan",
    plan,
    {
      sql: "EXISTS(SELECT 1 FROM ai_quota_plans WHERE id=? AND version=?)",
      args: [plan, expected],
    },
    (won) => [
      statement(
        c.env,
        `DELETE FROM ai_quota_rules WHERE plan_id=? AND ${won.sql}`,
        plan,
        ...won.args,
      ),
      ...rules.map((rule) =>
        statement(
          c.env,
          `INSERT INTO ai_quota_rules(id,plan_id,metric,window_kind,scope_key,limit_value) SELECT ?,?,?,?,?,? WHERE ${won.sql}`,
          newId(),
          plan,
          text(rule.metric),
          text(rule.window_kind),
          text(rule.scope_key ?? "*"),
          rule.limit_value as number | null,
          ...won.args,
        ),
      ),
      statement(
        c.env,
        `UPDATE ai_quota_plans SET version=version+1,updated_at=unixepoch() WHERE id=? AND ${won.sql}`,
        plan,
        ...won.args,
      ),
    ],
  );
  return c.json({
    rules: await rows(c.env, "SELECT * FROM ai_quota_rules WHERE plan_id=?", plan),
    plan: await first(c.env, "SELECT * FROM ai_quota_plans WHERE id=?", plan),
  });
});
aiAdmin.put("/pools/:id/members", async (c) => {
  const permissionKey = await permission(c, "providers", true),
    id = c.req.param("id"),
    data = fields(object(await c.req.json()), ["version", "members"]),
    version = integer(data.version, 1);
  if (!Array.isArray(data.members) || data.members.length > 64) fail(400, "AI_INVALID_INPUT");
  const members = data.members.map((entry) => {
    const member = fields(object(entry), ["account_id", "priority", "weight", "enabled"]);
    return {
      id: text(member.account_id, 100),
      priority: integer(member.priority ?? 0),
      weight: integer(member.weight ?? 1, 1, 10000),
      enabled: flag(member.enabled ?? true),
    };
  });
  if (new Set(members.map((member) => member.id)).size !== members.length)
    fail(400, "AI_INVALID_INPUT");
  await adminMutation(
    c,
    permissionKey,
    "pool.members",
    "pool",
    id,
    { sql: "EXISTS(SELECT 1 FROM ai_account_pools WHERE id=? AND version=?)", args: [id, version] },
    (won) => [
      statement(
        c.env,
        `DELETE FROM ai_pool_members WHERE pool_id=? AND ${won.sql}`,
        id,
        ...won.args,
      ),
      ...members.map((member) =>
        statement(
          c.env,
          `INSERT INTO ai_pool_members(pool_id,account_id,provider_id,priority,weight,enabled) SELECT id,?,provider_id,?,?,? FROM ai_account_pools WHERE id=? AND ${won.sql}`,
          member.id,
          member.priority,
          member.weight,
          member.enabled,
          id,
          ...won.args,
        ),
      ),
      statement(
        c.env,
        `UPDATE ai_account_pools SET version=version+1,updated_at=unixepoch() WHERE id=? AND ${won.sql}`,
        id,
        ...won.args,
      ),
    ],
  );
  return c.json({
    pool: await first(c.env, "SELECT * FROM ai_account_pools WHERE id=?", id),
    members: await rows(
      c.env,
      "SELECT account_id,priority,weight,enabled FROM ai_pool_members WHERE pool_id=? ORDER BY priority",
      id,
    ),
  });
});
aiAdmin.put("/consumers/:id/profiles", async (c) => {
  const permissionKey = await permission(c, "settings", true),
    id = c.req.param("id"),
    data = fields(object(await c.req.json()), ["version", "profiles"]),
    version = integer(data.version, 1);
  if (!Array.isArray(data.profiles) || data.profiles.length > 64) fail(400, "AI_INVALID_INPUT");
  const profiles = data.profiles.map((entry) => {
    const value = fields(object(entry), ["profile_id", "is_default"]);
    return { id: text(value.profile_id, 100), isDefault: flag(value.is_default ?? false) };
  });
  if (
    profiles.filter((entry) => entry.isDefault).length > 1 ||
    new Set(profiles.map((entry) => entry.id)).size !== profiles.length
  )
    fail(400, "AI_INVALID_INPUT");
  await adminMutation(
    c,
    permissionKey,
    "consumer.profiles",
    "consumer",
    id,
    { sql: "EXISTS(SELECT 1 FROM ai_consumers WHERE key=? AND version=?)", args: [id, version] },
    (won) => [
      statement(
        c.env,
        `UPDATE ai_consumer_profiles SET enabled=0,is_default=0 WHERE consumer_key=? AND ${won.sql}`,
        id,
        ...won.args,
      ),
      ...profiles.map((profile) =>
        statement(
          c.env,
          `INSERT INTO ai_consumer_profiles(consumer_key,profile_id,is_default,enabled) SELECT ?,?,?,1 WHERE ${won.sql} ON CONFLICT(consumer_key,profile_id) DO UPDATE SET is_default=excluded.is_default,enabled=1`,
          id,
          profile.id,
          profile.isDefault,
          ...won.args,
        ),
      ),
      statement(
        c.env,
        `UPDATE ai_consumers SET version=version+1,updated_at=unixepoch() WHERE key=? AND ${won.sql}`,
        id,
        ...won.args,
      ),
    ],
  );
  return c.json({
    consumer: await first(c.env, "SELECT * FROM ai_consumers WHERE key=?", id),
    profiles,
  });
});
aiAdmin.get("/:resource", async (c) => {
  const spec = resources[c.req.param("resource")];
  if (!spec) fail(404, "AI_NOT_FOUND");
  await permission(c, spec.permission);
  return c.json({
    items: (
      await rows<Record<string, unknown>>(
        c.env,
        `SELECT * FROM ${spec.table} ORDER BY ${spec.key ?? "id"} LIMIT 200`,
      )
    ).map(publicRow),
  });
});
aiAdmin.post("/:resource", async (c) => {
  const resource = c.req.param("resource"),
    spec = resources[resource];
  if (!spec) fail(404, "AI_NOT_FOUND");
  const key = await permission(c, spec.permission, true),
    data = fields(object(await c.req.json()), [...spec.fields, "secret"]),
    secret = data.secret;
  delete data.secret;
  validateConfig(resource, data);
  const id = spec.key ? text(data[spec.key], 100) : newId();
  if (resource === "consumers") {
    const definition = consumerDefinition(id);
    if (!definition || data.billing_policy !== definition.billing) fail(400, "AI_INVALID_INPUT");
  }
  if (resource === "accounts") {
    data.owner_user_id ??= c.get("identity").user.id;
    if (data.auth_kind === "api_key" && !secret) fail(400, "AI_INVALID_INPUT");
  }
  if (secret !== undefined) {
    if (!["accounts", "gateways"].includes(resource)) fail(400, "AI_INVALID_INPUT");
    const credentials = fields(object(secret), ["api_key", "client_secret"]);
    for (const value of Object.values(credentials)) text(value, 16384);
    data.secret_envelope_json = await seal(
      c.env,
      (resource === "accounts" ? "account:" : "gateway:") + id,
      credentials,
    );
  }
  const entries = [
    [spec.key ?? "id", id],
    ...Object.entries(data).filter(([field]) => field !== (spec.key ?? "id")),
  ];
  await adminMutation(c, key, resource + ".create", resource, id, { sql: "1", args: [] }, (won) => [
    statement(
      c.env,
      `INSERT INTO ${spec.table}(${entries.map(([field]) => field).join(",")}) SELECT ${entries.map(() => "?").join(",")} WHERE ${won.sql}`,
      ...entries.map(([, value]) => value as string | number | null),
      ...won.args,
    ),
  ]);
  return c.json(
    {
      item: publicRow(
        (await first<Record<string, unknown>>(
          c.env,
          `SELECT * FROM ${spec.table} WHERE ${spec.key ?? "id"}=?`,
          id,
        ))!,
      ),
    },
    201,
  );
});
aiAdmin.patch("/:resource/:id", async (c) => {
  const resource = c.req.param("resource"),
    spec = resources[resource];
  if (!spec) fail(404, "AI_NOT_FOUND");
  const key = await permission(c, spec.permission, true),
    id = c.req.param("id"),
    data = fields(object(await c.req.json()), [
      ...spec.fields.filter((field) => field !== "key"),
      "secret",
      "version",
    ]),
    expected = integer(data.version, 1),
    secret = data.secret;
  delete data.version;
  delete data.secret;
  validateConfig(resource, data);
  if (secret !== undefined) {
    if (!["accounts", "gateways"].includes(resource)) fail(400, "AI_INVALID_INPUT");
    const credentials = fields(object(secret), ["api_key", "client_secret"]);
    for (const value of Object.values(credentials)) text(value, 16384);
    data.secret_envelope_json = await seal(
      c.env,
      (resource === "accounts" ? "account:" : "gateway:") + id,
      credentials,
    );
  }
  const entries = Object.entries(data);
  if (!entries.length) fail(400, "AI_INVALID_INPUT");
  await adminMutation(
    c,
    key,
    resource + ".update",
    resource,
    id,
    {
      sql: `EXISTS(SELECT 1 FROM ${spec.table} WHERE ${spec.key ?? "id"}=? AND version=?)`,
      args: [id, expected],
    },
    (won) => [
      statement(
        c.env,
        `UPDATE ${spec.table} SET ${entries.map(([field]) => field + "=?").join(",")},version=version+1${secret !== undefined ? ",credential_version=credential_version+1" : ""} WHERE ${spec.key ?? "id"}=? AND ${won.sql}`,
        ...entries.map(([, value]) => value as string | number | null),
        id,
        ...won.args,
      ),
    ],
  );
  return c.json({
    item: publicRow(
      (await first<Record<string, unknown>>(
        c.env,
        `SELECT * FROM ${spec.table} WHERE ${spec.key ?? "id"}=?`,
        id,
      ))!,
    ),
  });
});
