import { now, uuid } from "../auth/types";
import { permissionClosure } from "../authorization/permissions";
import { consumerDefinition } from "./consumers";
import { accountCredentials } from "./credentials";
import { errorCode, fail, type AICode } from "./errors";
import { assertSchema, validateSchema } from "./json-schema";
import { enqueue } from "./jobs";
import { getPayload, putPayload } from "./payloads";
import { callProvider, price, ProviderFailure, usageBound } from "./providers";
import { reserve, reservationGuard, rulesFor, settings, settle, uncertain } from "./quota";
import { unseal } from "./secrets";
import {
  audit,
  canonical,
  ensureUserSubject,
  first,
  hash,
  identity,
  identityGuard,
  integer,
  object,
  parse,
  requireUserPermission,
  rows,
  session,
  statement,
  text,
} from "./store";
import type {
  Account,
  AIEnv,
  AIEvent,
  AILimits,
  AIPrincipal,
  AIRequest,
  AIResult,
  AIRuntime,
  Deployment,
  Guard,
  Invocation,
  Profile,
  Provider,
  QuotaContext,
  Route,
} from "./types";

const defaults: AILimits = {
  max_input_tokens: 16384,
  max_output_tokens: 2048,
  max_attempts: 3,
  timeout_seconds: 120,
  max_cost_micro_usd: null,
};
export async function resolveRequest(env: AIEnv, request: AIRequest) {
  const definition = consumerDefinition(request.consumer);
  if (!definition || !definition.principals.includes(request.principal.kind))
    fail(403, "AI_FORBIDDEN");
  if (request.principal.kind === "user") {
    await identity(env, request.principal);
    if (definition.permission)
      await requireUserPermission(env, request.principal, definition.permission);
  } else if (request.principal.serviceKey !== request.consumer) fail(403, "AI_FORBIDDEN");
  const consumer = await first<{
    enabled: number;
    billing_policy: string;
    budget_subject_id: string;
    tools_allowed: number;
    limits_json: string;
    version: number;
  }>(env, "SELECT * FROM ai_consumers WHERE key=?", request.consumer);
  if (!consumer?.enabled || consumer.billing_policy !== definition.billing)
    fail(403, "AI_FORBIDDEN");
  const profile = await first<Profile>(
    env,
    "SELECT p.* FROM ai_profiles p JOIN ai_consumer_profiles cp ON cp.profile_id=p.id WHERE p.key=? AND cp.consumer_key=? AND cp.enabled=1 AND p.enabled=1 AND p.archived_at IS NULL",
    request.profileKey,
    request.consumer,
  );
  if (!profile) fail(403, "AI_FORBIDDEN");
  const owner =
    definition.billing === "actor" && request.principal.kind === "user"
      ? request.principal.userId
      : definition.billing === "resource_owner"
        ? await definition.resolveOwner?.(env, request)
        : null;
  if (definition.billing === "resource_owner" && !owner) fail(403, "AI_FORBIDDEN");
  const billing = owner ? await ensureUserSubject(env, owner) : consumer.budget_subject_id;
  const config = await settings(env);
  if (!config.enabled) fail(503, "AI_DISABLED");
  if (request.tools?.length && !consumer.tools_allowed) fail(403, "AI_FORBIDDEN");
  const limits = { ...defaults };
  for (const field of Object.keys(defaults) as (keyof AILimits)[]) {
    const candidates = [
      parse(consumer.limits_json)[field],
      parse(profile.limits_json)[field],
      request.limits?.[field],
    ].filter((value) => value !== undefined && value !== null);
    if (candidates.length)
      limits[field] = Math.min(
        ...candidates.map((value) =>
          integer(
            value,
            1,
            field === "timeout_seconds"
              ? 300
              : field === "max_attempts"
                ? 5
                : Number.MAX_SAFE_INTEGER,
          ),
        ),
      );
  }
  const auth = identityGuard(request.principal),
    required = definition.permission ? permissionClosure([definition.permission]) : [];
  const guard: Guard = {
    sql:
      `${auth.sql} AND EXISTS(SELECT 1 FROM ai_consumers c JOIN ai_consumer_profiles cp ON cp.consumer_key=c.key JOIN ai_profiles p ON p.id=cp.profile_id WHERE c.key=? AND c.version=? AND c.enabled=1 AND cp.enabled=1 AND p.id=? AND p.version=? AND p.enabled=1) AND (SELECT enabled FROM ai_settings WHERE id=1)=1` +
      (request.principal.kind === "user"
        ? ` AND NOT EXISTS(SELECT 1 FROM json_each(?) needed WHERE NOT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=? AND rp.permission_key=needed.value))`
        : ""),
    args: [
      ...auth.args,
      request.consumer,
      consumer.version,
      profile.id,
      profile.version,
      ...(request.principal.kind === "user" ? [canonical(required), request.principal.userId] : []),
    ],
  };
  const context: QuotaContext = {
    subjectIds: [...new Set([config.workspace_subject_id, consumer.budget_subject_id, billing])],
    consumer: request.consumer,
    profileId: profile.id,
    epoch: config.policy_epoch,
  };
  return { profile, consumer, billing, context, guard, limits };
}
function validateRequest(request: AIRequest) {
  text(request.consumer, 80);
  text(request.profileKey, 100);
  text(request.idempotencyKey, 128);
  text(request.sourceRef?.type, 80);
  text(request.sourceRef?.id, 200);
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > 200)
    fail(400, "AI_INVALID_INPUT");
  for (const message of request.messages) {
    if (!["system", "user", "assistant", "tool"].includes(message.role))
      fail(400, "AI_INVALID_INPUT");
    text(message.content, 256 * 1024, true);
    if (message.tool_calls)
      for (const call of message.tool_calls) {
        text(call.id, 200);
        text(call.name, 128);
        object(call.arguments);
      }
  }
  if (
    (request.tools?.length ?? 0) > 64 ||
    new TextEncoder().encode(canonical(request)).length > 512 * 1024
  )
    fail(413, "AI_INVALID_INPUT");
  if (new Set(request.tools?.map((tool) => tool.name)).size !== (request.tools?.length ?? 0))
    fail(400, "AI_INVALID_INPUT");
  for (const tool of request.tools ?? []) {
    text(tool.name, 128);
    text(tool.description, 4000);
    assertSchema(tool.inputSchema);
  }
  if (request.outputSchema) assertSchema(request.outputSchema);
}
export async function prepareInvocation(env: AIEnv, request: AIRequest) {
  validateRequest(request);
  const resolved = await resolveRequest(env, request),
    requestHash = await hash(request);
  const initiator =
    request.principal.kind === "user"
      ? "user:" + request.principal.userId
      : "service:" + request.principal.serviceKey;
  let invocation = await first<Invocation>(
    env,
    "SELECT * FROM ai_invocations WHERE consumer_key=? AND initiator_key=? AND idempotency_key=?",
    request.consumer,
    initiator,
    request.idempotencyKey,
  );
  if (invocation && invocation.request_hash !== requestHash) fail(409, "AI_CONFLICT");
  if (!invocation) {
    const id = uuid(),
      payload = await putPayload(
        env,
        resolved.billing,
        request.principal.kind === "user" ? request.principal.userId : null,
        "inference.input",
        request,
      );
    await statement(
      env,
      `INSERT INTO ai_invocations(id,consumer_key,initiator_key,actor_user_id,session_id,actor_auth_version,billing_subject_id,profile_id,source_ref_json,trace_id,idempotency_key,request_hash,input_payload_id,policy_snapshot_json,deadline_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${resolved.guard.sql} ON CONFLICT(consumer_key,initiator_key,idempotency_key) DO NOTHING`,
      id,
      request.consumer,
      initiator,
      request.principal.kind === "user" ? request.principal.userId : null,
      request.principal.kind === "user" ? request.principal.sessionId : null,
      request.principal.kind === "user" ? request.principal.authVersion : null,
      resolved.billing,
      resolved.profile.id,
      canonical(request.sourceRef),
      uuid(),
      request.idempotencyKey,
      requestHash,
      payload,
      canonical({
        limits: resolved.limits,
        profile_version: resolved.profile.version,
        consumer_version: resolved.consumer.version,
      }),
      now() + resolved.limits.timeout_seconds * resolved.limits.max_attempts + 120,
      ...resolved.guard.args,
    ).run();
    invocation = await first<Invocation>(
      env,
      "SELECT * FROM ai_invocations WHERE consumer_key=? AND initiator_key=? AND idempotency_key=?",
      request.consumer,
      initiator,
      request.idempotencyKey,
    );
    if (!invocation) fail(403, "AI_FORBIDDEN");
    if (invocation.request_hash !== requestHash) fail(409, "AI_CONFLICT");
  }
  if (!invocation.admission_reservation_id && invocation.status === "queued") {
    try {
      const invocationId = invocation.id;
      const reservation = await reserve(env, {
        operationKey: "invocation:" + invocationId,
        operationId: invocationId,
        kind: "invocation",
        invocationId,
        context: resolved.context,
        amounts: { invocations: 1, concurrent_invocations: 1 },
        expiresAt: invocation.deadline_at,
        guard: resolved.guard,
        tail: (reservationId, token) => {
          const won = reservationGuard(reservationId, token);
          return [
            statement(
              env,
              `UPDATE ai_invocations SET admission_reservation_id=? WHERE id=? AND admission_reservation_id IS NULL AND ${won.sql}`,
              reservationId,
              invocationId,
              ...won.args,
            ),
            statement(
              env,
              `INSERT INTO ai_jobs(id,kind,entity_id,generation,dedupe_key,available_at,publish_after) SELECT ?,'invocation',?,1,?,unixepoch(),unixepoch() WHERE ${won.sql} ON CONFLICT(dedupe_key) DO NOTHING`,
              uuid(),
              invocationId,
              "invocation:" + invocationId + ":1",
              ...won.args,
            ),
          ];
        },
      });
      invocation.admission_reservation_id = reservation.id;
    } catch (error) {
      await statement(
        env,
        "UPDATE ai_invocations SET status='failed',error_code=?,finished_at=unixepoch() WHERE id=? AND admission_reservation_id IS NULL",
        errorCode(error),
        invocation.id,
      ).run();
      throw error;
    }
  }
  return invocation;
}
async function finishInvocation(
  env: AIEnv,
  invocation: Invocation,
  status: "succeeded" | "failed" | "cancelled",
  code: AICode | null = null,
) {
  const effects = (guard: Guard) => [
    statement(
      env,
      `UPDATE ai_invocations SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE ? END,error_code=?,finished_at=unixepoch(),lease_expires_at=NULL WHERE id=? AND status IN('queued','running','cancel_requested','unknown') AND ${guard.sql}`,
      status,
      code,
      invocation.id,
      ...guard.args,
    ),
  ];
  if (invocation.admission_reservation_id)
    await settle(env, invocation.admission_reservation_id, { invocations: 1 }, false, effects);
  else await session(env).batch(effects({ sql: "1", args: [] }));
}
function orderedAccounts(accounts: Account[], strategy: string) {
  if (strategy === "weighted")
    return accounts
      .map((account) => ({
        account,
        score:
          -Math.log((crypto.getRandomValues(new Uint32Array(1))[0]! + 1) / 4294967297) /
          Number((account as Account & { weight: number }).weight),
      }))
      .sort((a, b) => a.score - b.score)
      .map((entry) => entry.account);
  return accounts;
}
export async function executeInvocation(
  env: AIEnv,
  id: string,
  runtime: AIRuntime = {},
): Promise<AIResult> {
  let invocation = await first<Invocation>(env, "SELECT * FROM ai_invocations WHERE id=?", id);
  if (!invocation) fail(404, "AI_NOT_FOUND");
  if (invocation.status === "succeeded") return getPayload(env, invocation.output_payload_id);
  if (invocation.status === "unknown") fail(503, "AI_RESULT_UNKNOWN");
  if (invocation.status === "cancel_requested" || invocation.status === "cancelled") {
    await finishInvocation(env, invocation, "cancelled", "AI_CANCELLED");
    fail(409, "AI_CANCELLED");
  }
  if (invocation.status === "failed")
    fail(422, (invocation.error_code ?? "AI_PROVIDER_ERROR") as AICode);
  const executionToken = uuid();
  const claimed = await statement(
    env,
    "UPDATE ai_invocations SET status='running',execution_token=?,lease_expires_at=?,started_at=COALESCE(started_at,unixepoch()) WHERE id=? AND status='queued' AND admission_reservation_id IS NOT NULL RETURNING *",
    executionToken,
    now() + 600,
    id,
  ).first<Invocation>();
  if (!claimed) fail(409, "AI_BUSY");
  invocation = claimed;
  const request = await getPayload<AIRequest>(env, invocation.input_payload_id);
  let lastCode: AICode = "AI_NO_AVAILABLE_ACCOUNT",
    lastError: unknown;
  try {
    const resolved = await resolveRequest(env, request),
      pinned = parse<{ limits: AILimits; profile_version: number; consumer_version: number }>(
        invocation.policy_snapshot_json,
      );
    if (
      resolved.profile.version !== pinned.profile_version ||
      resolved.consumer.version !== pinned.consumer_version
    )
      fail(409, "AI_CONFLICT");
    const routes = await rows<Route>(
      env,
      "SELECT r.* FROM ai_profile_routes r JOIN ai_account_pools p ON p.id=r.pool_id LEFT JOIN ai_gateways g ON g.id=r.gateway_id WHERE r.profile_id=? AND r.enabled=1 AND p.enabled=1 AND p.archived_at IS NULL AND (r.gateway_id IS NULL OR (g.enabled=1 AND g.archived_at IS NULL)) ORDER BY r.priority",
      resolved.profile.id,
    );
    let ordinal = 0;
    for (const route of routes) {
      const deployment = await first<Deployment>(
        env,
        "SELECT d.* FROM ai_model_deployments d JOIN ai_models m ON m.id=d.model_id WHERE d.id=? AND d.enabled=1 AND d.archived_at IS NULL AND m.enabled=1 AND m.archived_at IS NULL",
        route.deployment_id,
      );
      const provider = await first<Provider>(
        env,
        "SELECT * FROM ai_providers WHERE id=? AND enabled=1 AND archived_at IS NULL",
        route.provider_id,
      );
      if (!deployment || !provider) continue;
      const required = parse(resolved.profile.required_capabilities_json),
        capabilities = parse(deployment.capabilities_json),
        policy = parse(resolved.profile.data_policy_json);
      if (
        Object.entries(required).some(
          ([key, value]) =>
            key !== "schema_version" && canonical(capabilities[key]) !== canonical(value),
        )
      ) {
        lastCode = "AI_CAPABILITY_UNSUPPORTED";
        continue;
      }
      if (
        Array.isArray(policy.allowed_provider_ids) &&
        !policy.allowed_provider_ids.includes(provider.id)
      )
        continue;
      if (policy.region && object(capabilities.data_policy ?? {}).region !== policy.region)
        continue;
      if (
        policy.require_no_logging === true &&
        object(capabilities.data_policy ?? {}).no_logging !== true
      )
        continue;
      if (route.gateway_id && (policy.require_no_logging === true || policy.region)) {
        lastCode = "AI_CAPABILITY_UNSUPPORTED";
        continue;
      }
      let bound: ReturnType<typeof usageBound>;
      try {
        bound = usageBound(request, deployment, pinned.limits);
      } catch (error) {
        lastError = error;
        lastCode = errorCode(error);
        continue;
      }
      const monetary = (await rulesFor(env, resolved.context.subjectIds)).some(
        (rule) =>
          rule.metric === "cost_micro_usd" &&
          rule.limit_value !== null &&
          ["*", "consumer:" + request.consumer, "profile:" + resolved.profile.id].includes(
            rule.scope_key,
          ),
      );
      if (monetary && bound.cost === null) {
        lastCode = "AI_USAGE_BOUND_UNAVAILABLE";
        continue;
      }
      const strategy = (await first<{ strategy: string }>(
        env,
        "SELECT strategy FROM ai_account_pools WHERE id=?",
        route.pool_id,
      ))!.strategy;
      const accounts = orderedAccounts(
        await rows<Account>(
          env,
          `SELECT a.*,m.weight FROM ai_provider_accounts a JOIN ai_pool_members m ON m.account_id=a.id WHERE m.pool_id=? AND m.enabled=1 AND a.status='active' AND (a.cooldown_until IS NULL OR a.cooldown_until<=unixepoch()) AND ((a.share_scope='workspace' AND a.sharing_authorization='provider_permitted') OR (a.share_scope='owner' AND a.owner_user_id=?)) ORDER BY ${strategy === "least_recently_used" ? "COALESCE(a.last_selected_at,0)," : ""} m.priority,a.id`,
          route.pool_id,
          request.principal.kind === "user" ? request.principal.userId : "",
        ),
        strategy,
      );
      for (const account of accounts) {
        if (++ordinal > pinned.limits.max_attempts) break;
        if (now() >= invocation.deadline_at) fail(422, "AI_LIMIT_REACHED");
        const current = await first<{ status: string }>(
          env,
          "SELECT status FROM ai_invocations WHERE id=? AND execution_token=?",
          id,
          executionToken,
        );
        if (!current || current.status !== "running") fail(409, "AI_CANCELLED");
        let credentials: Awaited<ReturnType<typeof accountCredentials>>;
        try {
          credentials = await accountCredentials(env, account, provider, runtime.fetcher);
        } catch (error) {
          lastError = error;
          lastCode = errorCode(error);
          continue;
        }
        const attemptId = uuid(),
          config = await settings(env),
          attemptContext = { ...resolved.context, epoch: config.policy_epoch };
        const auth = resolved.guard;
        const candidateGuard: Guard = {
          sql: `${auth.sql} AND EXISTS(SELECT 1 FROM ai_invocations WHERE id=? AND execution_token=? AND status='running') AND EXISTS(SELECT 1 FROM ai_provider_accounts a JOIN ai_pool_members m ON m.account_id=a.id JOIN ai_profile_routes r ON r.pool_id=m.pool_id JOIN ai_providers p ON p.id=a.provider_id JOIN ai_model_deployments d ON d.id=r.deployment_id WHERE a.id=? AND a.status='active' AND a.credential_version=? AND (a.cooldown_until IS NULL OR a.cooldown_until<=unixepoch()) AND m.enabled=1 AND r.id=? AND r.version=? AND r.enabled=1 AND p.enabled=1 AND d.enabled=1 AND d.version=? AND (SELECT count(*) FROM ai_inference_attempts x WHERE x.account_id=a.id AND x.status IN('prepared','in_flight','unknown'))<a.concurrency_limit AND (a.quota_group_key IS NULL OR (SELECT count(*) FROM ai_inference_attempts x JOIN ai_provider_accounts grouped ON grouped.id=x.account_id WHERE grouped.provider_id=a.provider_id AND grouped.quota_group_key=a.quota_group_key AND x.status IN('prepared','in_flight','unknown'))<(SELECT min(concurrency_limit) FROM ai_provider_accounts grouped WHERE grouped.provider_id=a.provider_id AND grouped.quota_group_key=a.quota_group_key AND grouped.status='active')))`,
          args: [
            ...auth.args,
            id,
            executionToken,
            account.id,
            credentials.version,
            route.id,
            route.version,
            deployment.version,
          ],
        };
        let reservation: { id: string; inserted: boolean };
        try {
          reservation = await reserve(env, {
            operationKey: "attempt:" + attemptId,
            operationId: attemptId,
            kind: "attempt",
            invocationId: id,
            context: attemptContext,
            guard: candidateGuard,
            amounts: {
              input_tokens: bound.usage.input_tokens,
              output_tokens: bound.usage.output_tokens,
              total_tokens: bound.usage.input_tokens + bound.usage.output_tokens,
              ...(bound.cost === null ? {} : { cost_micro_usd: bound.cost }),
            },
            expiresAt: now() + pinned.limits.timeout_seconds + 60,
            tail: (reservationId, token) => {
              const won = reservationGuard(reservationId, token);
              return [
                statement(
                  env,
                  `INSERT INTO ai_inference_attempts(id,invocation_id,ordinal,route_id,provider_id,deployment_id,pool_id,account_id,gateway_id,credential_version,route_snapshot_json,pricing_snapshot_json,status,execution_token,lease_expires_at,reservation_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,? WHERE ${won.sql}`,
                  attemptId,
                  id,
                  ordinal,
                  route.id,
                  provider.id,
                  deployment.id,
                  route.pool_id,
                  account.id,
                  route.gateway_id,
                  credentials.version,
                  canonical({
                    route,
                    deployment,
                    provider: { id: provider.id, adapter_key: provider.adapter_key },
                    bound,
                  }),
                  deployment.pricing_json,
                  executionToken,
                  now() + pinned.limits.timeout_seconds + 60,
                  reservationId,
                  ...won.args,
                ),
                statement(
                  env,
                  `UPDATE ai_provider_accounts SET last_selected_at=unixepoch() WHERE id=? AND ${won.sql}`,
                  account.id,
                  ...won.args,
                ),
              ];
            },
          });
        } catch (error) {
          lastError = error;
          lastCode = errorCode(error);
          continue;
        }
        let gateway: { baseUrl: string; token: string } | null = null;
        try {
          if (route.gateway_id) {
            const value = await first<{ config_json: string; secret_envelope_json: string | null }>(
              env,
              "SELECT config_json,secret_envelope_json FROM ai_gateways WHERE id=? AND enabled=1 AND archived_at IS NULL",
              route.gateway_id,
            );
            if (!value?.secret_envelope_json) fail(503, "AI_NO_AVAILABLE_ACCOUNT");
            const config = parse(value.config_json),
              secret = await unseal<Record<string, unknown>>(
                env,
                "gateway:" + route.gateway_id,
                value.secret_envelope_json,
              );
            gateway = {
              baseUrl:
                "https://gateway.ai.cloudflare.com/v1/" +
                encodeURIComponent(String(config.account_id)) +
                "/" +
                encodeURIComponent(String(config.gateway_id)) +
                "/" +
                encodeURIComponent(String(config.provider_slug)),
              token: String(secret.api_key),
            };
          }
          await resolveRequest(env, request);
          const sent = await statement(
            env,
            `UPDATE ai_inference_attempts SET status='in_flight',sent_at=unixepoch() WHERE id=? AND execution_token=? AND status='prepared' AND ${resolved.guard.sql} AND EXISTS(SELECT 1 FROM ai_invocations WHERE id=? AND status='running' AND execution_token=?) RETURNING id`,
            attemptId,
            executionToken,
            ...resolved.guard.args,
            id,
            executionToken,
          ).first();
          if (!sent) fail(409, "AI_CANCELLED");
          const { schema_version: _schemaVersion, ...generation } = parse(
            resolved.profile.generation_json,
          );
          const result = await callProvider(
            request,
            provider,
            deployment,
            account,
            credentials.credentials,
            pinned.limits,
            generation,
            gateway,
            runtime,
          );
          if (request.outputSchema && !result.tool_calls.length)
            validateSchema(request.outputSchema, JSON.parse(result.text));
          if (result.usage.source === "unknown") result.usage = bound.usage;
          const cost = price(parse(deployment.pricing_json), result.usage);
          const output: AIResult = {
            invocation_id: id,
            text: result.text,
            tool_calls: result.tool_calls,
            finish_reason: result.finish_reason,
            usage: result.usage,
            provider_state: result.provider_state,
          };
          const payloadId = await putPayload(
            env,
            invocation.billing_subject_id,
            invocation.actor_user_id,
            "inference.output",
            output,
          );
          await settle(
            env,
            reservation.id,
            {
              input_tokens: result.usage.input_tokens,
              output_tokens: result.usage.output_tokens,
              total_tokens: result.usage.input_tokens + result.usage.output_tokens,
              ...(cost === null ? {} : { cost_micro_usd: cost }),
            },
            false,
            (won) => [
              statement(
                env,
                `INSERT INTO ai_usage_events(attempt_id,event_key,event_kind,usage_source,cost_source,input_tokens_delta,output_tokens_delta,cached_input_tokens_delta,cache_write_tokens_delta,reasoning_tokens_delta,cost_micro_usd_delta,receipt_json) SELECT ?,?,'measurement',?,?,?,?,?,?,?,?,? WHERE ${won.sql}`,
                attemptId,
                "usage:" + attemptId,
                result.usage.source,
                cost === null
                  ? "unknown"
                  : parse(deployment.pricing_json).source === "internal_rate"
                    ? "internal_rate"
                    : "catalog",
                result.usage.input_tokens,
                result.usage.output_tokens,
                result.usage.cached_input_tokens,
                result.usage.cache_write_tokens,
                result.usage.reasoning_tokens,
                cost,
                canonical({ request_id: result.request_id }),
                ...won.args,
              ),
              statement(
                env,
                `UPDATE ai_inference_attempts SET status='succeeded',output_payload_id=?,provider_request_id=?,usage_state=?,finished_at=unixepoch() WHERE id=? AND execution_token=? AND ${won.sql}`,
                payloadId,
                result.request_id,
                result.usage.source,
                attemptId,
                executionToken,
                ...won.args,
              ),
              statement(
                env,
                `UPDATE ai_invocations SET output_payload_id=? WHERE id=? AND execution_token=? AND ${won.sql}`,
                payloadId,
                id,
                executionToken,
                ...won.args,
              ),
            ],
          );
          if (
            result.usage.input_tokens > bound.usage.input_tokens ||
            result.usage.output_tokens > bound.usage.output_tokens ||
            (cost !== null && bound.cost !== null && cost > bound.cost)
          )
            await statement(
              env,
              "UPDATE ai_model_deployments SET enabled=0,version=version+1 WHERE id=?",
              deployment.id,
            ).run();
          await finishInvocation(env, invocation, "succeeded");
          return output;
        } catch (error) {
          const attempt = await first<{ status: string }>(
            env,
            "SELECT status FROM ai_inference_attempts WHERE id=?",
            attemptId,
          );
          if (attempt?.status === "succeeded") {
            await finishInvocation(env, invocation, "succeeded");
            return getPayload(
              env,
              (await first<{ output_payload_id: string }>(
                env,
                "SELECT output_payload_id FROM ai_inference_attempts WHERE id=?",
                attemptId,
              ))!.output_payload_id,
            );
          }
          const accepted =
            error instanceof ProviderFailure ? error.accepted : attempt?.status === "in_flight";
          if (accepted) {
            await uncertain(env, reservation.id);
            if (invocation.admission_reservation_id)
              await uncertain(env, invocation.admission_reservation_id);
            await session(env).batch([
              statement(
                env,
                "UPDATE ai_inference_attempts SET status='unknown',error_code='AI_RESULT_UNKNOWN' WHERE id=? AND execution_token=?",
                attemptId,
                executionToken,
              ),
              statement(
                env,
                "UPDATE ai_invocations SET status='unknown',error_code='AI_RESULT_UNKNOWN',lease_expires_at=NULL WHERE id=? AND execution_token=?",
                id,
                executionToken,
              ),
            ]);
            fail(503, "AI_RESULT_UNKNOWN");
          }
          await settle(env, reservation.id, {}, true, (won) => [
            statement(
              env,
              `UPDATE ai_inference_attempts SET status='failed',error_code=?,finished_at=unixepoch() WHERE id=? AND ${won.sql}`,
              error instanceof ProviderFailure ? error.code : errorCode(error),
              attemptId,
              ...won.args,
            ),
          ]);
          if (error instanceof ProviderFailure && error.status === 401)
            await statement(
              env,
              "UPDATE ai_provider_accounts SET status='reauth_required',version=version+1 WHERE id=?",
              account.id,
            ).run();
          if (error instanceof ProviderFailure && error.status === 429)
            await statement(
              env,
              "UPDATE ai_provider_accounts SET cooldown_until=?,last_error_code='RATE_LIMIT' WHERE id=? OR (provider_id=? AND quota_group_key=? AND ? IS NOT NULL)",
              now() + (error.retryAfter || 60),
              account.id,
              account.provider_id,
              account.quota_group_key,
              account.quota_group_key,
            ).run();
          lastError = error;
          lastCode = error instanceof ProviderFailure ? "AI_PROVIDER_ERROR" : errorCode(error);
        }
      }
      if (ordinal >= pinned.limits.max_attempts) break;
    }
    await finishInvocation(env, invocation, "failed", lastCode);
    if (lastError && !(lastError instanceof ProviderFailure)) throw lastError;
    fail(503, lastCode);
  } catch (error) {
    const current = await first<{ status: string }>(
      env,
      "SELECT status FROM ai_invocations WHERE id=?",
      id,
    );
    if (current?.status !== "unknown" && current?.status !== "succeeded")
      await finishInvocation(env, invocation, "failed", errorCode(error));
    throw error;
  }
}
export class AIService {
  constructor(
    private env: AIEnv,
    private runtime: AIRuntime = {},
  ) {}
  async submit(request: AIRequest) {
    const invocation = await prepareInvocation(this.env, request);
    if (invocation.status === "queued") await enqueue(this.env, "invocation", invocation.id);
    return { invocationId: invocation.id };
  }
  async execute(request: AIRequest) {
    return executeInvocation(
      this.env,
      (await prepareInvocation(this.env, request)).id,
      this.runtime,
    );
  }
  stream(request: AIRequest): ReadableStream<AIEvent> {
    return new ReadableStream({
      start: async (controller) => {
        let id = "";
        try {
          id = (await prepareInvocation(this.env, request)).id;
          const result = await executeInvocation(this.env, id, {
            ...this.runtime,
            onDelta: async (delta) => {
              controller.enqueue({ type: "output.delta", invocation_id: id, data: delta });
              await this.runtime.onDelta?.(delta);
            },
          });
          controller.enqueue({ type: "completed", invocation_id: id, data: result });
        } catch (error) {
          controller.enqueue({
            type: "failed",
            invocation_id: id,
            data: { code: errorCode(error) },
          });
        } finally {
          controller.close();
        }
      },
    });
  }
  async cancel(id: string, principal: AIPrincipal) {
    await identity(this.env, principal);
    const owner = principal.kind === "user" ? principal.userId : "";
    const value = await first<Invocation>(
      this.env,
      "SELECT * FROM ai_invocations WHERE id=? AND actor_user_id=?",
      id,
      owner,
    );
    if (!value) fail(404, "AI_NOT_FOUND");
    await statement(
      this.env,
      "UPDATE ai_invocations SET status='cancel_requested' WHERE id=? AND status IN('queued','running')",
      id,
    ).run();
    if (value.status === "queued")
      await finishInvocation(this.env, value, "cancelled", "AI_CANCELLED");
  }
}
export async function recoverInvocations(env: AIEnv) {
  await statement(
    env,
    "UPDATE ai_oauth_flows SET status='unknown' WHERE status='exchanging' AND consumed_at<unixepoch()-60",
  ).run();
  const expired = await rows<Invocation>(
    env,
    "SELECT * FROM ai_invocations WHERE (status IN('running','cancel_requested') AND lease_expires_at<=unixepoch()) OR (status='queued' AND deadline_at<=unixepoch()) ORDER BY created_at LIMIT 25",
  );
  for (const invocation of expired) {
    const attempt = await first<{ id: string; status: string; reservation_id: string | null }>(
      env,
      "SELECT id,status,reservation_id FROM ai_inference_attempts WHERE invocation_id=? ORDER BY ordinal DESC LIMIT 1",
      invocation.id,
    );
    if (attempt?.status === "succeeded" && invocation.output_payload_id) {
      await finishInvocation(env, invocation, "succeeded");
      continue;
    }
    if (attempt && ["in_flight", "unknown"].includes(attempt.status)) {
      await statement(
        env,
        "UPDATE ai_inference_attempts SET status='unknown',error_code='AI_RESULT_UNKNOWN' WHERE id=?",
        attempt.id,
      ).run();
      if (attempt.reservation_id) await uncertain(env, attempt.reservation_id);
      if (invocation.admission_reservation_id)
        await uncertain(env, invocation.admission_reservation_id);
      await statement(
        env,
        "UPDATE ai_invocations SET status='unknown',error_code='AI_RESULT_UNKNOWN',lease_expires_at=NULL WHERE id=?",
        invocation.id,
      ).run();
    } else {
      if (attempt?.reservation_id) await settle(env, attempt.reservation_id, {}, true);
      await finishInvocation(env, invocation, "failed", "AI_LIMIT_REACHED");
    }
  }
}
