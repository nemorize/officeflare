import { now } from "../auth/types";
import { fail } from "./errors";
import { reserve, settings } from "./quota";
import { ensureUserSubject, first, identityGuard } from "./store";
import type { AIEnv, AIPrincipal, Guard } from "./types";

export async function beginTool(
  env: AIEnv,
  principal: AIPrincipal,
  operationId: string,
  consumer = "mcp.tools",
  profileId = "",
  guard?: Guard,
  tail?: (id: string, token: string) => D1PreparedStatement[],
) {
  if (principal.kind !== "user") fail(403, "AI_FORBIDDEN");
  const subject = await ensureUserSubject(env, principal.userId),
    config = await settings(env);
  const feature = await first<{ budget_subject_id: string; version: number }>(
    env,
    "SELECT budget_subject_id,version FROM ai_consumers WHERE key=? AND enabled=1",
    consumer,
  );
  if (!feature) fail(403, "AI_FORBIDDEN");
  const auth = identityGuard(principal);
  const finalGuard = {
    sql: `${auth.sql} AND EXISTS(SELECT 1 FROM ai_consumers WHERE key=? AND enabled=1 AND version=?)${guard ? ` AND (${guard.sql})` : ""}`,
    args: [...auth.args, consumer, feature.version, ...(guard?.args ?? [])],
  };
  return reserve(env, {
    operationKey: "tool:" + operationId,
    operationId,
    kind: "tool",
    context: {
      subjectIds: [...new Set([subject, config.workspace_subject_id, feature.budget_subject_id])],
      consumer,
      profileId,
      epoch: config.policy_epoch,
    },
    amounts: { tool_calls: 1 },
    guard: finalGuard,
    expiresAt: now() + 600,
    tail,
  });
}
