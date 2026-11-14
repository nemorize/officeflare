import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireAccess } from "../auth/store";
import { requirePermission } from "../authorization/access";
import { now, uuid, type AppEnv } from "../auth/types";
import { aiAdmin } from "../ai/admin";
import { aiConnections, roomTools } from "../ai/connections";
import { aiAccounts, aiOAuthCallback } from "../ai/oauth";
import { createRun, finishRun, ownedRoom, ownedRun, resumeRun } from "../ai/hub";
import { AIService } from "../ai/service";
import { getPayload, putPayload } from "../ai/payloads";
import { fail } from "../ai/errors";
import { safeAPIError } from "../ai/http";
import { rulesFor, settings } from "../ai/quota";
import {
  canonical,
  ensureUserSubject,
  fields,
  first,
  hash,
  identity,
  identityGuard,
  integer,
  object,
  parse,
  rows,
  session,
  statement,
  text,
} from "../ai/store";
import { userPrincipal, type AIMessage, type ObjectValue } from "../ai/types";

const ai = new Hono<AppEnv>();
ai.onError(safeAPIError);
ai.route("/admin", aiAdmin);
ai.route("/oauth", aiOAuthCallback);
ai.use("*", requireAccess, requirePermission("ai.access"));
ai.route("/", aiAccounts);
ai.route("/mcp", aiConnections);
ai.get("/capabilities", async (c) =>
  c.json({
    enabled: (await settings(c.env)).enabled === 1,
    personal_rooms: true,
    agents: true,
    external_mcp: true,
    usage_limits: true,
    providers: ["openai", "openrouter", "anthropic", "google", "cloudflare", "openai_compatible"],
  }),
);
ai.get("/models", async (c) =>
  c.json({
    profiles: await rows(
      c.env,
      `SELECT DISTINCT p.id,p.key,p.name,p.required_capabilities_json FROM ai_profiles p JOIN ai_consumer_profiles cp ON cp.profile_id=p.id AND cp.consumer_key='hub.chat' AND cp.enabled=1 JOIN ai_profile_routes r ON r.profile_id=p.id AND r.enabled=1 JOIN ai_account_pools pool ON pool.id=r.pool_id AND pool.enabled=1 AND pool.archived_at IS NULL JOIN ai_providers provider ON provider.id=r.provider_id AND provider.enabled=1 AND provider.archived_at IS NULL JOIN ai_model_deployments deployment ON deployment.id=r.deployment_id AND deployment.enabled=1 AND deployment.archived_at IS NULL JOIN ai_models model ON model.id=deployment.model_id AND model.enabled=1 AND model.archived_at IS NULL LEFT JOIN ai_gateways gateway ON gateway.id=r.gateway_id JOIN ai_pool_members pm ON pm.pool_id=r.pool_id AND pm.enabled=1 JOIN ai_provider_accounts a ON a.id=pm.account_id WHERE p.enabled=1 AND p.archived_at IS NULL AND (r.gateway_id IS NULL OR (gateway.enabled=1 AND gateway.archived_at IS NULL)) AND a.status='active' AND ((a.share_scope='workspace' AND a.sharing_authorization='provider_permitted') OR (a.share_scope='owner' AND a.owner_user_id=?)) ORDER BY p.name`,
      c.get("identity").user.id,
    ),
  }),
);
ai.get("/quota", async (c) => {
  const subject = await ensureUserSubject(c.env, c.get("identity").user.id),
    config = await settings(c.env);
  return c.json({
    time_zone: config.quota_time_zone,
    rules: await rulesFor(c.env, [subject, config.workspace_subject_id, "system-ai-chat"]),
    buckets: await rows(
      c.env,
      "SELECT metric,window_kind,scope_key,window_start,window_end,used_amount,reserved_amount FROM ai_quota_buckets WHERE subject_id=? AND window_end>unixepoch()",
      subject,
    ),
  });
});
ai.get("/usage", async (c) => {
  const subject = await ensureUserSubject(c.env, c.get("identity").user.id),
    after = integer(Number(c.req.query("after") ?? now() - 30 * 86400)),
    before = integer(Number(c.req.query("before") ?? now() + 1), after + 1);
  if (before - after > 366 * 86400) fail(400, "AI_INVALID_INPUT");
  return c.json({
    usage: await first(
      c.env,
      `SELECT count(DISTINCT i.id) invocations,COALESCE(sum(u.input_tokens_delta),0) input_tokens,COALESCE(sum(u.output_tokens_delta),0) output_tokens,sum(u.cost_micro_usd_delta) cost_micro_usd,sum(CASE WHEN u.cost_source='unknown' THEN 1 ELSE 0 END) unknown_cost_events FROM ai_invocations i LEFT JOIN ai_inference_attempts a ON a.invocation_id=i.id LEFT JOIN ai_usage_events u ON u.attempt_id=a.id WHERE i.billing_subject_id=? AND i.created_at>=? AND i.created_at<?`,
      subject,
      after,
      before,
    ),
  });
});
ai.get("/rooms", async (c) =>
  c.json({
    rooms: await rows(
      c.env,
      "SELECT id,title,profile_id,version,created_at,updated_at FROM ai_rooms WHERE owner_user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 100",
      c.get("identity").user.id,
    ),
  }),
);
ai.post("/rooms", async (c) => {
  const data = fields(object(await c.req.json()), ["title", "profile_key", "instructions"]),
    principal = userPrincipal(c.get("identity"));
  const profile = data.profile_key
    ? await first<{ id: string }>(
        c.env,
        "SELECT p.id FROM ai_profiles p JOIN ai_consumer_profiles cp ON cp.profile_id=p.id WHERE p.key=? AND cp.consumer_key='hub.chat' AND cp.enabled=1 AND p.enabled=1",
        text(data.profile_key, 100),
      )
    : await first<{ id: string }>(
        c.env,
        "SELECT p.id FROM ai_profiles p JOIN ai_consumer_profiles cp ON cp.profile_id=p.id WHERE cp.consumer_key='hub.chat' AND cp.enabled=1 AND cp.is_default=1 AND p.enabled=1",
      );
  if (!profile) fail(422, "AI_NO_AVAILABLE_ACCOUNT");
  const id = uuid(),
    subject = await ensureUserSubject(c.env, c.get("identity").user.id),
    instructions = data.instructions
      ? await putPayload(
          c.env,
          subject,
          c.get("identity").user.id,
          "chat.instructions",
          text(data.instructions, 16000),
        )
      : null,
    auth = identityGuard(principal);
  await statement(
    c.env,
    `INSERT INTO ai_rooms(id,owner_user_id,title,profile_id,instructions_payload_id) SELECT ?,?,?,?,? WHERE ${auth.sql}`,
    id,
    c.get("identity").user.id,
    text(data.title ?? t("ai.newConversation"), 200),
    profile.id,
    instructions,
    ...auth.args,
  ).run();
  return c.json({ room: await ownedRoom(c.env, principal, id) }, 201);
});
ai.get("/rooms/:room", async (c) =>
  c.json({ room: await ownedRoom(c.env, userPrincipal(c.get("identity")), c.req.param("room")) }),
);
ai.patch("/rooms/:room", async (c) => {
  const principal = userPrincipal(c.get("identity")),
    room = await ownedRoom(c.env, principal, c.req.param("room")),
    data = fields(object(await c.req.json()), ["version", "title", "profile_key", "instructions"]),
    version = integer(data.version, 1);
  if (data.profile_key !== undefined || data.instructions !== undefined)
    if (
      await first(
        c.env,
        "SELECT id FROM ai_runs WHERE room_id=? AND status IN('queued','running','waiting_approval','reconciling','cancel_requested')",
        room.id,
      )
    )
      fail(409, "AI_BUSY");
  const profile = data.profile_key
    ? await first<{ id: string }>(
        c.env,
        "SELECT p.id FROM ai_profiles p JOIN ai_consumer_profiles cp ON cp.profile_id=p.id WHERE p.key=? AND cp.consumer_key='hub.chat' AND cp.enabled=1 AND p.enabled=1",
        text(data.profile_key, 100),
      )
    : { id: room.profile_id };
  if (!profile) fail(403, "AI_FORBIDDEN");
  const instructions =
    data.instructions === undefined
      ? room.instructions_payload_id
      : data.instructions === null || data.instructions === ""
        ? null
        : await putPayload(
            c.env,
            await ensureUserSubject(c.env, room.owner_user_id),
            room.owner_user_id,
            "chat.instructions",
            text(data.instructions, 16000),
          );
  const result = await statement(
    c.env,
    "UPDATE ai_rooms SET title=?,profile_id=?,instructions_payload_id=?,version=version+1,updated_at=unixepoch() WHERE id=? AND owner_user_id=? AND version=? RETURNING id",
    data.title === undefined ? room.title : text(data.title, 200),
    profile.id,
    instructions,
    room.id,
    room.owner_user_id,
    version,
  ).first();
  if (!result) fail(409, "AI_CONFLICT");
  return c.json({ room: await ownedRoom(c.env, principal, room.id) });
});
ai.delete("/rooms/:room", async (c) => {
  const principal = userPrincipal(c.get("identity")),
    room = await ownedRoom(c.env, principal, c.req.param("room"));
  const active = await rows<{ id: string }>(
    c.env,
    "SELECT id FROM ai_runs WHERE room_id=? AND status IN('queued','running','waiting_approval')",
    room.id,
  );
  for (const run of active) await cancelRun(c.env, principal, run.id);
  await statement(
    c.env,
    "UPDATE ai_rooms SET deleted_at=unixepoch(),version=version+1 WHERE id=? AND owner_user_id=?",
    room.id,
    room.owner_user_id,
  ).run();
  return c.body(null, 204);
});
ai.get("/rooms/:room/messages", async (c) => {
  const room = await ownedRoom(c.env, userPrincipal(c.get("identity")), c.req.param("room")),
    after = integer(Number(c.req.query("after") ?? 0));
  const messages = await rows<{
    id: string;
    seq: number;
    role: string;
    status: string;
    payload_id: string | null;
    version: number;
  }>(
    c.env,
    "SELECT id,seq,role,status,payload_id,version FROM ai_room_messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT 100",
    room.id,
    after,
  );
  return c.json({
    messages: await Promise.all(
      messages.map(async ({ payload_id, ...message }) => {
        let body: AIMessage | null = null;
        try {
          body = payload_id ? await getPayload<AIMessage>(c.env, payload_id) : null;
        } catch {
          /* Retained metadata can outlive message content. */
        }
        return {
          ...message,
          content: body?.content ?? null,
          tool_calls: body?.tool_calls,
          tool_call_id: body?.tool_call_id,
        };
      }),
    ),
    next_seq: messages.at(-1)?.seq ?? after,
  });
});
ai.post("/rooms/:room/runs", requirePermission("ai.runs.create"), async (c) => {
  const data = fields(object(await c.req.json()), ["message"]),
    key = text(c.req.header("idempotency-key"), 128),
    content = text(data.message, 64000);
  const run = await createRun(
    c.env,
    userPrincipal(c.get("identity")),
    c.req.param("room"),
    content,
    key,
  );
  return c.json({ run: publicRun(run) }, 202);
});
const publicRun = (run: Awaited<ReturnType<typeof ownedRun>>) => ({
  id: run.id,
  room_id: run.room_id,
  status: run.status,
  error_code: run.error_code,
  created_at: run.created_at,
  deadline_at: run.deadline_at,
});
ai.get("/runs/:run", async (c) =>
  c.json({
    run: publicRun(await ownedRun(c.env, userPrincipal(c.get("identity")), c.req.param("run"))),
  }),
);
ai.get("/runs/:run/events", async (c) => {
  const principal = userPrincipal(c.get("identity")),
    run = await ownedRun(c.env, principal, c.req.param("run"));
  let after = integer(Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0));
  if (!c.req.header("accept")?.includes("text/event-stream"))
    return c.json({
      events: await rows(
        c.env,
        "SELECT seq,kind,payload_json,created_at FROM ai_run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 100",
        run.id,
        after,
      ),
    });
  return streamSSE(c, async (stream) => {
    const deadline = Date.now() + 25000;
    while (!stream.aborted && Date.now() < deadline) {
      const current = await ownedRun(c.env, principal, run.id);
      const events = await rows<{ seq: number; kind: string; payload_json: string }>(
        c.env,
        "SELECT seq,kind,payload_json FROM ai_run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 100",
        run.id,
        after,
      );
      for (const event of events) {
        after = event.seq;
        await stream.writeSSE({
          id: String(event.seq),
          event: event.kind,
          data: event.payload_json,
        });
      }
      const partial = await first<{ id: string; payload_id: string | null; version: number }>(
        c.env,
        "SELECT id,payload_id,version FROM ai_room_messages WHERE run_id=? AND status='streaming' ORDER BY seq DESC LIMIT 1",
        run.id,
      );
      if (partial?.payload_id) {
        const message = await getPayload<AIMessage>(c.env, partial.payload_id);
        await stream.writeSSE({
          event: "message.snapshot",
          data: canonical({ id: partial.id, version: partial.version, content: message.content }),
        });
      }
      if (
        ["succeeded", "failed", "cancelled", "waiting_approval", "reconciling"].includes(
          current.status,
        )
      )
        break;
      await stream.sleep(1000);
    }
  });
});
async function cancelRun(
  env: AppEnv["Bindings"],
  principal: ReturnType<typeof userPrincipal>,
  id: string,
) {
  const run = await ownedRun(env, principal, id);
  const invocations = await rows<{ id: string }>(
    env,
    "SELECT id FROM ai_invocations WHERE json_extract(source_ref_json,'$.type')='run' AND json_extract(source_ref_json,'$.id')=? AND status IN('queued','running')",
    id,
  );
  for (const invocation of invocations) await new AIService(env).cancel(invocation.id, principal);
  if (["queued", "waiting_approval"].includes(run.status)) {
    await finishRun(env, run, "cancelled", "AI_CANCELLED");
  }
  await statement(
    env,
    "UPDATE ai_runs SET status='cancel_requested' WHERE id=? AND status='running'",
    id,
  ).run();
}
ai.post("/runs/:run/cancel", async (c) => {
  await cancelRun(c.env, userPrincipal(c.get("identity")), c.req.param("run"));
  return c.json({
    run: publicRun(await ownedRun(c.env, userPrincipal(c.get("identity")), c.req.param("run"))),
  });
});
ai.post("/runs/:run/resume", async (c) => {
  await resumeRun(c.env, userPrincipal(c.get("identity")), c.req.param("run"));
  return c.json(
    { run: publicRun(await ownedRun(c.env, userPrincipal(c.get("identity")), c.req.param("run"))) },
    202,
  );
});
ai.get("/runs/:run/approvals", async (c) => {
  const run = await ownedRun(c.env, userPrincipal(c.get("identity")), c.req.param("run"));
  const approvals = await rows<{
    id: string;
    tool_name: string;
    status: string;
    intent_hash: string;
    expires_at: number;
    args_payload_id: string;
  }>(
    c.env,
    "SELECT a.id,t.name tool_name,a.status,a.intent_hash,a.expires_at,tc.args_payload_id FROM ai_tool_approvals a JOIN ai_tool_calls tc ON tc.id=a.tool_call_id JOIN ai_mcp_tools t ON t.id=tc.tool_id WHERE tc.run_id=? AND a.required_user_id=? ORDER BY a.created_at",
    run.id,
    run.actor_user_id,
  );
  return c.json({
    approvals: await Promise.all(
      approvals.map(async ({ args_payload_id, ...approval }) => ({
        ...approval,
        arguments: await getPayload(c.env, args_payload_id),
      })),
    ),
  });
});
ai.post("/approvals/:approval/decision", async (c) => {
  const data = fields(object(await c.req.json()), ["decision", "intent_hash"]),
    principal = userPrincipal(c.get("identity"));
  if (!["allow", "deny"].includes(String(data.decision))) fail(400, "AI_INVALID_INPUT");
  const approval = await first<{
    id: string;
    tool_call_id: string;
    run_id: string;
    room_id: string;
    connection_id: string;
    tool_id: string;
    args_payload_id: string;
    intent_hash: string;
    expires_at: number;
  }>(
    c.env,
    "SELECT a.*,tc.run_id,tc.room_id,tc.connection_id,tc.tool_id,tc.args_payload_id FROM ai_tool_approvals a JOIN ai_tool_calls tc ON tc.id=a.tool_call_id WHERE a.id=? AND a.required_user_id=? AND a.status='pending' AND a.expires_at>unixepoch()",
    c.req.param("approval"),
    c.get("identity").user.id,
  );
  if (!approval || data.intent_hash !== approval.intent_hash) fail(409, "AI_APPROVAL_STALE");
  await ownedRun(c.env, principal, approval.run_id);
  const tool = (await roomTools(c.env, principal, approval.room_id)).find(
    (entry) => entry.id === approval.tool_id && entry.connectionId === approval.connection_id,
  );
  if (
    !tool ||
    (await tool.intent(await getPayload<ObjectValue>(c.env, approval.args_payload_id))) !==
      approval.intent_hash
  )
    fail(409, "AI_APPROVAL_STALE");
  const decision = data.decision === "allow" ? "approved" : "denied",
    marker = uuid(),
    guard = identityGuard(principal);
  await session(c.env).batch([
    statement(
      c.env,
      `UPDATE ai_tool_approvals SET status=?,decision_user_id=?,decision_session_id=?,decided_at=unixepoch() WHERE id=? AND status='pending' AND expires_at>unixepoch() AND ${guard.sql}`,
      decision,
      c.get("identity").user.id,
      c.get("identity").session.id,
      approval.id,
      ...guard.args,
    ),
    statement(
      c.env,
      "UPDATE ai_tool_calls SET status=? WHERE id=? AND status='waiting_approval' AND EXISTS(SELECT 1 FROM ai_tool_approvals WHERE id=? AND status=? AND decision_session_id=?)",
      decision,
      approval.tool_call_id,
      approval.id,
      decision,
      c.get("identity").session.id,
    ),
  ]);
  const run = await ownedRun(c.env, principal, approval.run_id);
  if (
    run.status === "waiting_approval" &&
    !(await first(
      c.env,
      "SELECT tc.id FROM ai_tool_calls tc JOIN ai_tool_approvals a ON a.tool_call_id=tc.id WHERE tc.run_id=? AND a.status='pending' AND a.expires_at>unixepoch()",
      run.id,
    ))
  )
    await resumeRun(c.env, principal, run.id);
  return c.json({ status: decision });
});
ai.put("/rooms/:room/mcp-bindings", requirePermission("ai.connections.manage"), async (c) => {
  const principal = userPrincipal(c.get("identity")),
    room = await ownedRoom(c.env, principal, c.req.param("room")),
    data = fields(object(await c.req.json()), ["version", "bindings"]),
    expected = integer(data.version, 1);
  if (!Array.isArray(data.bindings) || data.bindings.length > 16) fail(400, "AI_INVALID_INPUT");
  const bindings: { connection_id: string; allowed_tools: string[] }[] = [];
  for (const input of data.bindings) {
    const value = fields(object(input), ["connection_id", "allowed_tools"]);
    if (
      !Array.isArray(value.allowed_tools) ||
      value.allowed_tools.length > 64 ||
      value.allowed_tools.some((name) => typeof name !== "string")
    )
      fail(400, "AI_INVALID_INPUT");
    const connection = await first(
      c.env,
      "SELECT id FROM ai_mcp_connections WHERE id=? AND owner_user_id=? AND status='connected'",
      text(value.connection_id, 100),
      room.owner_user_id,
    );
    if (!connection) fail(403, "AI_FORBIDDEN");
    bindings.push({
      connection_id: String(value.connection_id),
      allowed_tools: value.allowed_tools as string[],
    });
  }
  const marker = uuid(),
    auth = identityGuard(principal),
    won = "EXISTS(SELECT 1 FROM ai_audit_events WHERE event_key=?)";
  await session(c.env).batch([
    statement(
      c.env,
      `INSERT INTO ai_audit_events(event_key,actor_key,action,target_type,target_id) SELECT ?,?,'room.tools.update','room',? WHERE EXISTS(SELECT 1 FROM ai_rooms WHERE id=? AND owner_user_id=? AND version=?) AND ${auth.sql}`,
      marker,
      "user:" + room.owner_user_id,
      room.id,
      room.id,
      room.owner_user_id,
      expected,
      ...auth.args,
    ),
    statement(
      c.env,
      `UPDATE ai_room_mcp_bindings SET enabled=0,version=version+1 WHERE room_id=? AND ${won}`,
      room.id,
      marker,
    ),
    ...bindings.map((binding) =>
      statement(
        c.env,
        `INSERT INTO ai_room_mcp_bindings(room_id,connection_id,owner_user_id,allowed_tools_json,enabled) SELECT ?,?,?,?,1 WHERE ${won} ON CONFLICT(room_id,connection_id) DO UPDATE SET allowed_tools_json=excluded.allowed_tools_json,enabled=1,version=ai_room_mcp_bindings.version+1`,
        room.id,
        binding.connection_id,
        room.owner_user_id,
        canonical(binding.allowed_tools),
        marker,
      ),
    ),
    statement(
      c.env,
      `UPDATE ai_rooms SET version=version+1,updated_at=unixepoch() WHERE id=? AND ${won}`,
      room.id,
      marker,
    ),
  ]);
  if (!(await first(c.env, "SELECT seq FROM ai_audit_events WHERE event_key=?", marker)))
    fail(409, "AI_CONFLICT");
  return c.json({ room: await ownedRoom(c.env, principal, room.id), bindings });
});
export default ai;
