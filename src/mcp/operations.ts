import { Hono } from "hono";
import { requireAccess } from "../auth/store";
import { now, uuid, type AppEnv } from "../auth/types";
import { errorCode, fail } from "../ai/errors";
import { enqueue } from "../ai/jobs";
import { beginTool } from "../ai/tool-meter";
import { reservationGuard, settle } from "../ai/quota";
import {
  audit,
  canonical,
  first,
  hash,
  identityGuard,
  object,
  parse,
  rows,
  session,
  statement,
  text,
} from "../ai/store";
import { userPrincipal } from "../ai/types";
import type { AIEnv, ObjectValue } from "../ai/types";
import { authorizationLive, scopeTool, type MCPAuthorization } from "./authorization";
import { builtinTool, runBuiltinTool, toolIntent } from "./registry";

interface Operation {
  id: string;
  owner_user_id: string;
  session_id: string;
  credential_id: string;
  authorization_json: string;
  tool_name: string;
  args_json: string;
  intent_hash: string;
  operation_key: string;
  status: string;
  result_json: string | null;
  expires_at: number;
}
export async function proposeOperation(
  env: AIEnv,
  auth: MCPAuthorization,
  name: string,
  args: ObjectValue,
  key: string,
) {
  const definition = builtinTool(name);
  if (!definition || auth.principal.kind !== "user") fail(404, "AI_NOT_FOUND");
  await scopeTool(env, auth, definition, args);
  const intent = await toolIntent(env, auth.principal, definition, args),
    id = uuid(),
    requestKey = await hash(key);
  const existing = await first<Operation>(
    env,
    "SELECT * FROM mcp_tool_operations WHERE credential_id=? AND operation_key=?",
    auth.credentialId,
    requestKey,
  );
  if (existing) {
    if (existing.tool_name !== name || existing.args_json !== canonical(args))
      fail(409, "AI_CONFLICT");
    return operationResult(existing);
  }
  await statement(
    env,
    "INSERT INTO mcp_tool_operations(id,owner_user_id,session_id,credential_id,authorization_json,tool_name,args_json,intent_hash,operation_key,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(credential_id,operation_key) DO NOTHING",
    id,
    auth.principal.userId,
    auth.principal.sessionId,
    auth.credentialId,
    canonical(auth),
    name,
    canonical(args),
    intent.snapshot_hash,
    requestKey,
    now() + 900,
  ).run();
  const value = (await first<Operation>(
    env,
    "SELECT * FROM mcp_tool_operations WHERE credential_id=? AND operation_key=?",
    auth.credentialId,
    requestKey,
  ))!;
  await audit(
    env,
    "user:" + auth.principal.userId,
    "mcp.operation.request",
    "mcp_operation",
    value.id,
    { tool: name },
    "mcp-operation:" + value.id,
  );
  return operationResult(value);
}
export function operationResult(operation: Operation) {
  return {
    operation_id: operation.id,
    status: operation.status,
    requires_human_approval: operation.status === "pending",
    review_path: "/mcp/operations/" + operation.id,
    expires_at: operation.expires_at,
    ...(operation.result_json ? { result: parse(operation.result_json) } : {}),
  };
}
export async function getOperation(env: AIEnv, auth: MCPAuthorization, id: string) {
  await authorizationLive(env, auth);
  const value = await first<Operation>(
    env,
    "SELECT * FROM mcp_tool_operations WHERE id=? AND credential_id=?",
    id,
    auth.credentialId,
  );
  if (!value) fail(404, "AI_NOT_FOUND");
  const tool = builtinTool(value.tool_name);
  if (!tool) fail(404, "AI_NOT_FOUND");
  await scopeTool(env, auth, tool, parse(value.args_json));
  return operationResult(value);
}
export async function executeOperation(env: AIEnv, id: string) {
  const value = await first<Operation>(env, "SELECT * FROM mcp_tool_operations WHERE id=?", id);
  if (!value || value.status !== "approved") return;
  const auth = parse<MCPAuthorization>(value.authorization_json),
    args = parse<ObjectValue>(value.args_json),
    definition = builtinTool(value.tool_name);
  if (!definition) fail(404, "AI_NOT_FOUND");
  try {
    await scopeTool(env, auth, definition, args);
    const intent = await toolIntent(env, auth.principal, definition, args);
    if (intent.snapshot_hash !== value.intent_hash || value.expires_at <= now())
      fail(409, "AI_APPROVAL_STALE");
    const reservation = await beginTool(
      env,
      auth.principal,
      id,
      "mcp.tools",
      "",
      {
        sql: "EXISTS(SELECT 1 FROM mcp_tool_operations WHERE id=? AND status='approved' AND expires_at>unixepoch())",
        args: [id],
      },
      (reservationId, token) => {
        const won = reservationGuard(reservationId, token);
        return [
          statement(
            env,
            `UPDATE mcp_tool_operations SET status='executing',reservation_id=? WHERE id=? AND status='approved' AND ${won.sql}`,
            reservationId,
            id,
            ...won.args,
          ),
        ];
      },
    );
    if (!reservation.inserted) return;
    const claimed = await first(
      env,
      "SELECT id FROM mcp_tool_operations WHERE id=? AND status='executing' AND reservation_id=?",
      id,
      reservation.id,
    );
    if (!claimed) return;
    try {
      const result = await runBuiltinTool(
        env,
        auth.principal,
        value.tool_name,
        args,
        value.operation_key,
      );
      const encoded = canonical(result);
      if (encoded.length > 256 * 1024) fail(413, "AI_LIMIT_REACHED");
      await statement(
        env,
        "UPDATE mcp_tool_operations SET status='succeeded',result_json=?,finished_at=unixepoch() WHERE id=? AND status='executing'",
        encoded,
        id,
      ).run();
    } catch (error) {
      const code = errorCode(error);
      await statement(
        env,
        "UPDATE mcp_tool_operations SET status='unknown',result_json=?,finished_at=unixepoch() WHERE id=? AND status='executing'",
        canonical({ code: code === "AI_PROVIDER_ERROR" ? "AI_RESULT_UNKNOWN" : code }),
        id,
      ).run();
    }
    await settle(env, reservation.id, { tool_calls: 1 });
  } catch (error) {
    await statement(
      env,
      "UPDATE mcp_tool_operations SET status='failed',result_json=?,finished_at=unixepoch() WHERE id=? AND status='approved'",
      canonical({ code: errorCode(error) }),
      id,
    ).run();
  }
}
export const mcpOperations = new Hono<AppEnv>();
mcpOperations.use("*", requireAccess);
mcpOperations.get("/", async (c) =>
  c.json({
    operations: await rows(
      c.env,
      "SELECT id,tool_name,status,created_at,expires_at FROM mcp_tool_operations WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 100",
      c.get("identity").user.id,
    ),
  }),
);
mcpOperations.get("/:id", async (c) => {
  const value = await first<Operation>(
    c.env,
    "SELECT * FROM mcp_tool_operations WHERE id=? AND owner_user_id=?",
    c.req.param("id"),
    c.get("identity").user.id,
  );
  if (!value) fail(404, "AI_NOT_FOUND");
  return c.json({
    operation: {
      ...operationResult(value),
      tool_name: value.tool_name,
      arguments: parse(value.args_json),
      intent_hash: value.intent_hash,
    },
  });
});
mcpOperations.post("/:id/decision", async (c) => {
  const data = object(await c.req.json()),
    decision = text(data.decision, 10);
  if (!["allow", "deny"].includes(decision)) fail(400, "AI_INVALID_INPUT");
  const value = await first<Operation>(
    c.env,
    "SELECT * FROM mcp_tool_operations WHERE id=? AND owner_user_id=? AND status='pending' AND expires_at>unixepoch()",
    c.req.param("id"),
    c.get("identity").user.id,
  );
  if (!value || data.intent_hash !== value.intent_hash) fail(409, "AI_APPROVAL_STALE");
  const auth = parse<MCPAuthorization>(value.authorization_json),
    definition = builtinTool(value.tool_name);
  if (!definition) fail(404, "AI_NOT_FOUND");
  await scopeTool(c.env, auth, definition, parse(value.args_json));
  const intent = await toolIntent(c.env, auth.principal, definition, parse(value.args_json));
  if (intent.snapshot_hash !== value.intent_hash) fail(409, "AI_APPROVAL_STALE");
  const status = decision === "allow" ? "approved" : "denied";
  const guard = identityGuard(userPrincipal(c.get("identity")));
  const committed = await session(c.env).batch([
    statement(
      c.env,
      `UPDATE mcp_tool_operations SET status=?,decision_session_id=? WHERE id=? AND status='pending' AND owner_user_id=? AND expires_at>unixepoch() AND ${guard.sql} RETURNING id`,
      status,
      c.get("identity").session.id,
      value.id,
      c.get("identity").user.id,
      ...guard.args,
    ),
    statement(
      c.env,
      "INSERT INTO ai_jobs(id,kind,entity_id,generation,dedupe_key,available_at,publish_after) SELECT ?,'mcp.operation',?,1,?,unixepoch(),unixepoch() WHERE EXISTS(SELECT 1 FROM mcp_tool_operations WHERE id=? AND status='approved' AND decision_session_id=?) ON CONFLICT(dedupe_key) DO NOTHING",
      uuid(),
      value.id,
      `mcp.operation:${value.id}:1`,
      value.id,
      c.get("identity").session.id,
    ),
  ]);
  if (!committed[0]?.results.length) fail(409, "AI_CONFLICT");
  await audit(
    c.env,
    "user:" + c.get("identity").user.id,
    "mcp.operation." + status,
    "mcp_operation",
    value.id,
  );
  if (status === "approved") await enqueue(c.env, "mcp.operation", value.id);
  return c.json({ status });
});
