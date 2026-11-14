import { now } from "../auth/types";
import { fail } from "./errors";
import { price } from "./providers";
import { settle } from "./quota";
import { first, hash, parse, rows, statement } from "./store";
import type { AIEnv, AIUsage, Guard } from "./types";

// No external request is repeated. Unknown inference is closed at its reserved
// conservative upper bound; a later receipt can be recorded as a signed delta.
export async function reconcileInvocation(env: AIEnv, id: string) {
  const invocation = await first<{
    id: string;
    admission_reservation_id: string | null;
    source_ref_json: string;
  }>(env, "SELECT * FROM ai_invocations WHERE id=? AND status='unknown'", id);
  if (!invocation) fail(409, "AI_CONFLICT");
  const attempts = await rows<{
    id: string;
    reservation_id: string;
    route_snapshot_json: string;
    pricing_snapshot_json: string;
    lease_expires_at: number;
  }>(env, "SELECT * FROM ai_inference_attempts WHERE invocation_id=? AND status='unknown'", id);
  if (attempts.some((attempt) => attempt.lease_expires_at > now())) fail(409, "AI_BUSY");
  for (const attempt of attempts) {
    const snapshot = parse<{ bound: { usage: AIUsage; cost: number | null } }>(
        attempt.route_snapshot_json,
      ),
      usage = snapshot.bound.usage,
      cost = snapshot.bound.cost;
    await settle(
      env,
      attempt.reservation_id,
      {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
        ...(cost === null ? {} : { cost_micro_usd: cost }),
      },
      false,
      (won) => [
        statement(
          env,
          `INSERT INTO ai_usage_events(attempt_id,event_key,event_kind,usage_source,cost_source,input_tokens_delta,output_tokens_delta,cost_micro_usd_delta,reason) SELECT ?,?,'measurement','estimated',?,?,?,?, 'Unresolved provider response: conservative reserved upper bound' WHERE ${won.sql} ON CONFLICT(event_key) DO NOTHING`,
          attempt.id,
          "usage:" + attempt.id,
          cost === null
            ? "unknown"
            : parse(attempt.pricing_snapshot_json).source === "internal_rate"
              ? "internal_rate"
              : "catalog",
          usage.input_tokens,
          usage.output_tokens,
          cost,
          ...won.args,
        ),
        statement(
          env,
          `UPDATE ai_inference_attempts SET status='failed',usage_state='estimated',error_code='AI_RESULT_UNKNOWN',finished_at=unixepoch() WHERE id=? AND ${won.sql}`,
          attempt.id,
          ...won.args,
        ),
      ],
    );
  }
  if (invocation.admission_reservation_id)
    await settle(env, invocation.admission_reservation_id, { invocations: 1 });
  await statement(
    env,
    "UPDATE ai_invocations SET status='failed',error_code='AI_RESULT_UNKNOWN',finished_at=unixepoch() WHERE id=? AND status='unknown'",
    id,
  ).run();
  const source = parse<{ type: string; id: string }>(invocation.source_ref_json);
  if (source.type === "run") await closeReconciledRun(env, source.id);
}
export async function closeReconciledRun(env: AIEnv, id: string) {
  const run = await first<{
    admission_reservation_id: string | null;
    slot_reservation_id: string | null;
  }>(env, "SELECT * FROM ai_runs WHERE id=? AND status='reconciling'", id);
  if (!run) return;
  if (
    (await first(
      env,
      "SELECT id FROM ai_tool_calls WHERE run_id=? AND status IN('unknown','executing') LIMIT 1",
      id,
    )) ||
    (await first(
      env,
      "SELECT id FROM ai_invocations WHERE json_extract(source_ref_json,'$.type')='run' AND json_extract(source_ref_json,'$.id')=? AND status='unknown' LIMIT 1",
      id,
    ))
  )
    return;
  if (run.admission_reservation_id)
    await settle(env, run.admission_reservation_id, { chat_runs: 1 });
  if (run.slot_reservation_id && run.slot_reservation_id !== run.admission_reservation_id)
    await settle(env, run.slot_reservation_id, {});
  await statement(
    env,
    "UPDATE ai_runs SET status='failed',error_code='AI_RESULT_UNKNOWN',finished_at=unixepoch() WHERE id=? AND status='reconciling'",
    id,
  ).run();
  await statement(
    env,
    "UPDATE ai_room_messages SET status='interrupted' WHERE run_id=? AND status='streaming'",
    id,
  ).run();
}
export async function usageAdjustment(
  env: AIEnv,
  attemptId: string,
  eventKey: string,
  usage: AIUsage,
  reason: string,
) {
  const attempt = await first<{ reservation_id: string; pricing_snapshot_json: string }>(
    env,
    "SELECT reservation_id,pricing_snapshot_json FROM ai_inference_attempts WHERE id=? AND status IN('succeeded','failed')",
    attemptId,
  );
  if (!attempt) fail(409, "AI_CONFLICT");
  const total = await first<{ input: number; output: number; cost: number | null; seq: number }>(
    env,
    "SELECT COALESCE(sum(input_tokens_delta),0) input,COALESCE(sum(output_tokens_delta),0) output,sum(cost_micro_usd_delta) cost,COALESCE(max(seq),0) seq FROM ai_usage_events WHERE attempt_id=?",
    attemptId,
  );
  const cost = price(parse(attempt.pricing_snapshot_json), usage),
    inputDelta = usage.input_tokens - total!.input,
    outputDelta = usage.output_tokens - total!.output,
    costDelta = cost === null ? null : cost - (total!.cost ?? 0);
  const token = crypto.randomUUID(),
    requestHash = await hash([attemptId, usage, reason]),
    receipt = JSON.stringify({ operation: token, request_hash: requestHash });
  const won = {
    sql: "EXISTS(SELECT 1 FROM ai_usage_events WHERE event_key=? AND receipt_json=?)",
    args: [eventKey, receipt],
  };
  const items = await rows<{ bucket_id: string; metric: string }>(
    env,
    "SELECT i.bucket_id,b.metric FROM ai_quota_reservation_items i JOIN ai_quota_buckets b ON b.id=i.bucket_id WHERE i.reservation_id=?",
    attempt.reservation_id,
  );
  const writes = [
    statement(
      env,
      "INSERT INTO ai_usage_events(attempt_id,event_key,event_kind,usage_source,cost_source,input_tokens_delta,output_tokens_delta,cost_micro_usd_delta,receipt_json,reason) SELECT ?,?,'adjustment','reconciliation',?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM ai_usage_events WHERE event_key=?) AND (SELECT COALESCE(max(seq),0) FROM ai_usage_events WHERE attempt_id=?)=?",
      attemptId,
      eventKey,
      cost === null
        ? "unknown"
        : parse(attempt.pricing_snapshot_json).source === "internal_rate"
          ? "internal_rate"
          : "catalog",
      inputDelta,
      outputDelta,
      costDelta,
      receipt,
      reason,
      eventKey,
      attemptId,
      total!.seq,
    ),
  ];
  for (const item of items) {
    const delta =
      item.metric === "input_tokens"
        ? inputDelta
        : item.metric === "output_tokens"
          ? outputDelta
          : item.metric === "total_tokens"
            ? inputDelta + outputDelta
            : item.metric === "cost_micro_usd"
              ? (costDelta ?? 0)
              : 0;
    writes.push(
      statement(
        env,
        `UPDATE ai_quota_buckets SET used_amount=used_amount+?,version=version+1 WHERE id=? AND ${won.sql}`,
        delta,
        item.bucket_id,
        ...won.args,
      ),
    );
    writes.push(
      statement(
        env,
        `INSERT INTO ai_quota_ledger(reservation_id,bucket_id,event_key,event_kind,used_delta,reserved_delta,reason) SELECT ?,?,?,'adjust',?,0,? WHERE ${won.sql}`,
        attempt.reservation_id,
        item.bucket_id,
        eventKey,
        delta,
        reason,
        ...won.args,
      ),
    );
  }
  await env.DB.withSession("first-primary").batch(writes);
  const committed = await first<{ attempt_id: string; receipt_json: string }>(
    env,
    "SELECT attempt_id,receipt_json FROM ai_usage_events WHERE event_key=?",
    eventKey,
  );
  if (
    !committed ||
    committed.attempt_id !== attemptId ||
    parse<{ request_hash: string }>(committed.receipt_json).request_hash !== requestHash
  )
    fail(409, "AI_CONFLICT");
}
