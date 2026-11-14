import { t } from "../../shared/i18n/index.ts";
import { now, uuid } from "../auth/types";
import { first, rows, statement } from "./store";
import { settle } from "./quota";
import type { AIEnv } from "./types";

export async function enqueue(
  env: AIEnv,
  kind: string,
  entityId: string,
  generation = 1,
  delay = 0,
) {
  const key = `${kind}:${entityId}:${generation}`;
  await statement(
    env,
    "INSERT INTO ai_jobs(id,kind,entity_id,generation,dedupe_key,available_at,publish_after) VALUES(?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING",
    uuid(),
    kind,
    entityId,
    generation,
    key,
    now() + delay,
    now() + delay,
  ).run();
  const job = (await first<{ id: string; status: string }>(
    env,
    "SELECT id,status FROM ai_jobs WHERE dedupe_key=?",
    key,
  ))!;
  if (job.status === "pending") await publish(env, job.id, delay);
  return job.id;
}
async function publish(env: AIEnv, id: string, delay = 0) {
  if (!env.AI_QUEUE) return;
  try {
    await env.AI_QUEUE.send({ id }, { delaySeconds: Math.min(86400, Math.max(0, delay)) });
    await statement(
      env,
      "UPDATE ai_jobs SET publish_after=? WHERE id=? AND status='pending'",
      now() + Math.max(delay, 300),
      id,
    ).run();
  } catch {
    /* The durable pending job is recovered by cron. */
  }
}
export async function processAIJob(env: AIEnv, id: string) {
  const token = uuid();
  const job = await statement(
    env,
    "UPDATE ai_jobs SET status='leased',lease_token=?,lease_expires_at=?,fencing_version=fencing_version+1,delivery_count=delivery_count+1,updated_at=unixepoch() WHERE id=? AND status='pending' AND available_at<=unixepoch() RETURNING *",
    token,
    now() + 600,
    id,
  ).first<{ id: string; kind: string; entity_id: string; delivery_count: number }>();
  if (!job) return;
  try {
    if (job.kind === "invocation")
      await (await import("./service")).executeInvocation(env, job.entity_id);
    else if (job.kind === "run") await (await import("./hub")).advanceRun(env, job.entity_id);
    else if (job.kind === "mcp.operation")
      await (await import("../mcp/operations")).executeOperation(env, job.entity_id);
    else if (job.kind === "account.revoke")
      await (await import("./oauth")).revokeAccount(env, job.entity_id);
    else throw new Error(t("ai.providerError"));
    await statement(
      env,
      "UPDATE ai_jobs SET status='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=unixepoch() WHERE id=? AND lease_token=?",
      id,
      token,
    ).run();
  } catch {
    const terminal = job.delivery_count >= 5;
    await statement(
      env,
      "UPDATE ai_jobs SET status=?,lease_token=NULL,lease_expires_at=NULL,available_at=?,publish_after=?,last_error_code='AI_JOB_FAILED',updated_at=unixepoch() WHERE id=? AND lease_token=?",
      terminal ? "dead" : "pending",
      now() + 30 * job.delivery_count,
      now() + 30 * job.delivery_count,
      id,
      token,
    ).run();
    if (!terminal) await publish(env, id, 30 * job.delivery_count);
  }
}
export async function consumeAI(batch: MessageBatch<{ id?: unknown }>, env: AIEnv) {
  for (const message of batch.messages) {
    if (typeof message.body?.id === "string") await processAIJob(env, message.body.id);
    message.ack();
  }
}
export async function recoverAI(env: AIEnv) {
  await (await import("./service")).recoverInvocations(env);
  await statement(
    env,
    "UPDATE ai_jobs SET status='pending',lease_token=NULL,lease_expires_at=NULL,publish_after=unixepoch(),updated_at=unixepoch() WHERE status='leased' AND lease_expires_at<=unixepoch()",
  ).run();
  const jobs = await rows<{ id: string }>(
    env,
    "SELECT id FROM ai_jobs WHERE status='pending' AND publish_after<=unixepoch() AND available_at<=unixepoch() ORDER BY publish_after LIMIT 50",
  );
  for (const job of jobs) {
    if (env.AI_QUEUE) await publish(env, job.id);
    else await processAIJob(env, job.id);
  }
  const expired = await rows<{ id: string; r2_key: string | null }>(
    env,
    "SELECT id,r2_key FROM ai_payloads WHERE deleted_at IS NULL AND expires_at<=unixepoch() LIMIT 50",
  );
  for (const payload of expired) {
    if (payload.r2_key) await env.AI_BUCKET?.delete(payload.r2_key);
    await statement(
      env,
      "UPDATE ai_payloads SET storage_kind='deleted',content_json=NULL,r2_key=NULL,deleted_at=unixepoch() WHERE id=?",
      payload.id,
    ).run();
  }
  await statement(env, "DELETE FROM ai_oauth_flows WHERE expires_at<unixepoch()-86400").run();
  await statement(
    env,
    "UPDATE mcp_tool_operations SET status='expired',finished_at=unixepoch() WHERE status IN('pending','approved') AND expires_at<=unixepoch()",
  ).run();
  await statement(
    env,
    "UPDATE mcp_tool_operations SET status='unknown',finished_at=unixepoch() WHERE status='executing' AND expires_at<=unixepoch()",
  ).run();
  const meters = await rows<{ id: string }>(
    env,
    "SELECT r.id FROM ai_quota_reservations r WHERE r.operation_kind='tool' AND r.status='held' AND (r.expires_at<=unixepoch() OR EXISTS(SELECT 1 FROM ai_tool_calls t WHERE t.reservation_id=r.id AND t.status IN('succeeded','failed','unknown')) OR EXISTS(SELECT 1 FROM mcp_tool_operations o WHERE o.reservation_id=r.id AND o.status IN('succeeded','failed','unknown'))) LIMIT 50",
  );
  for (const meter of meters) await settle(env, meter.id, { tool_calls: 1 });
}
