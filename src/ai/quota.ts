import { Temporal } from "@js-temporal/polyfill";
import { now, uuid } from "../auth/types";
import { fail } from "./errors";
import { canonical, first, hash, rows, session, statement } from "./store";
import type { AIEnv, Amounts, Guard, Metric, QuotaContext } from "./types";

interface Rule {
  subject_id: string;
  metric: Metric;
  window_kind: string;
  scope_key: string;
  limit_value: number | null;
}
interface Item {
  id: string;
  metric: Metric;
  amount: number;
  limit: number | null;
  start: number;
  end: number;
  subject: string;
  window: string;
  scope: string;
}
export async function settings(env: AIEnv) {
  const value = await first<{
    enabled: number;
    policy_epoch: number;
    quota_time_zone: string;
    workspace_subject_id: string;
    default_user_plan_id: string;
    version: number;
  }>(env, "SELECT * FROM ai_settings WHERE id=1");
  if (!value) fail(503, "AI_DISABLED");
  return value;
}
export async function rulesFor(env: AIEnv, subjectIds: string[]) {
  return rows<Rule>(
    env,
    `WITH base AS (
    SELECT s.id subject_id,r.metric,r.window_kind,r.scope_key,r.limit_value FROM ai_subjects s JOIN ai_settings a ON a.id=1
    JOIN ai_quota_plans p ON p.id=COALESCE(s.plan_id,CASE WHEN s.kind='user' THEN a.default_user_plan_id END) AND p.enabled=1
    JOIN ai_quota_rules r ON r.plan_id=p.id WHERE s.id IN (SELECT value FROM json_each(?))
  ) SELECT b.subject_id,b.metric,b.window_kind,b.scope_key,CASE WHEN o.id IS NULL THEN b.limit_value ELSE o.limit_value END limit_value
    FROM base b LEFT JOIN ai_quota_overrides o ON o.subject_id=b.subject_id AND o.metric=b.metric AND o.window_kind=b.window_kind AND o.scope_key=b.scope_key
    UNION ALL SELECT o.subject_id,o.metric,o.window_kind,o.scope_key,o.limit_value FROM ai_quota_overrides o
    WHERE o.subject_id IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM base b WHERE b.subject_id=o.subject_id AND b.metric=o.metric AND b.window_kind=o.window_kind AND b.scope_key=o.scope_key)`,
    canonical(subjectIds),
    canonical(subjectIds),
  );
}
export function period(window: string, zone: string, timestamp = now()): [number, number] {
  if (window === "concurrent" || window === "lifetime") return [0, Number.MAX_SAFE_INTEGER];
  if (window === "minute") {
    const start = Math.floor(timestamp / 60) * 60;
    return [start, start + 60];
  }
  const current = Temporal.Instant.fromEpochMilliseconds(timestamp * 1000).toZonedDateTimeISO(zone);
  const start = window === "month" ? current.with({ day: 1 }).startOfDay() : current.startOfDay();
  const end = start.add(window === "month" ? { months: 1 } : { days: 1 });
  return [Math.floor(start.epochMilliseconds / 1000), Math.floor(end.epochMilliseconds / 1000)];
}
async function itemsFor(env: AIEnv, context: QuotaContext, amounts: Amounts) {
  const config = await settings(env),
    applicable = ["*", "consumer:" + context.consumer, "profile:" + context.profileId];
  const rules = (await rulesFor(env, context.subjectIds)).filter(
    (rule) => applicable.includes(rule.scope_key) && (amounts[rule.metric] ?? 0) > 0,
  );
  if (rules.length > 128) fail(400, "AI_INVALID_INPUT");
  return Promise.all(
    rules.map(async (rule): Promise<Item> => {
      const [start, end] = period(rule.window_kind, config.quota_time_zone);
      const amount = amounts[rule.metric]!;
      if (!Number.isSafeInteger(amount) || amount < 0) fail(400, "AI_INVALID_INPUT");
      const id = await hash([
        rule.subject_id,
        rule.metric,
        rule.window_kind,
        rule.scope_key,
        start,
      ]);
      return {
        id,
        metric: rule.metric,
        amount,
        limit: rule.limit_value,
        start,
        end,
        subject: rule.subject_id,
        window: rule.window_kind,
        scope: rule.scope_key,
      };
    }),
  );
}
export interface ReserveInput {
  operationKey: string;
  kind: "run" | "invocation" | "attempt" | "tool";
  operationId: string;
  invocationId?: string;
  context: QuotaContext;
  amounts: Amounts;
  guard?: Guard;
  expiresAt: number;
  tail?: (reservationId: string, mutationToken: string) => D1PreparedStatement[];
}
export async function reserve(
  env: AIEnv,
  input: ReserveInput,
): Promise<{ id: string; inserted: boolean }> {
  const requestHash = await hash([
    input.kind,
    input.operationId,
    input.context.subjectIds,
    input.context.consumer,
    input.context.profileId,
    input.amounts,
  ]);
  const existing = await first<{ id: string; request_hash: string; status: string }>(
    env,
    "SELECT id,request_hash,status FROM ai_quota_reservations WHERE operation_key=?",
    input.operationKey,
  );
  if (existing) {
    if (existing.request_hash !== requestHash) fail(409, "AI_CONFLICT");
    return { id: existing.id, inserted: false };
  }
  const id = uuid(),
    token = uuid(),
    items = await itemsFor(env, input.context, input.amounts),
    encoded = canonical(items);
  const db = session(env),
    guard = input.guard ?? { sql: "1", args: [] };
  const won =
    "EXISTS(SELECT 1 FROM ai_quota_reservations WHERE id=? AND mutation_token=? AND status='preparing')";
  const writes = items.map((item) =>
    db
      .prepare(
        "INSERT INTO ai_quota_buckets(id,subject_id,metric,window_kind,scope_key,window_start,window_end) VALUES(?,?,?,?,?,?,?) ON CONFLICT(subject_id,metric,window_kind,scope_key,window_start) DO NOTHING",
      )
      .bind(item.id, item.subject, item.metric, item.window, item.scope, item.start, item.end),
  );
  writes.push(
    db
      .prepare(
        `INSERT INTO ai_quota_reservations(id,operation_key,operation_kind,operation_id,invocation_id,request_hash,status,policy_epoch,mutation_token,expires_at)
    SELECT ?,?,?,?,?,?,'preparing',?,?,? WHERE (SELECT policy_epoch FROM ai_settings WHERE id=1)=?
    AND NOT EXISTS(SELECT 1 FROM ai_subjects WHERE id IN(SELECT value FROM json_each(?)) AND status<>'active')
    AND NOT EXISTS(SELECT 1 FROM ai_subjects s JOIN ai_settings a ON a.id=1 LEFT JOIN ai_quota_plans p ON p.id=COALESCE(s.plan_id,CASE WHEN s.kind='user' THEN a.default_user_plan_id END) WHERE s.id IN(SELECT value FROM json_each(?)) AND (p.id IS NULL OR p.enabled=0))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN ai_quota_buckets b ON b.id=json_extract(j.value,'$.id') WHERE b.id IS NULL OR (json_extract(j.value,'$.limit') IS NOT NULL AND b.used_amount+b.reserved_amount+json_extract(j.value,'$.amount')>json_extract(j.value,'$.limit')))
    AND (${guard.sql}) ON CONFLICT(operation_key) DO NOTHING`,
      )
      .bind(
        id,
        input.operationKey,
        input.kind,
        input.operationId,
        input.invocationId ?? null,
        requestHash,
        input.context.epoch,
        token,
        input.expiresAt,
        input.context.epoch,
        canonical(input.context.subjectIds),
        canonical(input.context.subjectIds),
        encoded,
        ...guard.args,
      ),
  );
  writes.push(
    db
      .prepare(
        `INSERT INTO ai_quota_reservation_items(reservation_id,bucket_id,reserved_amount,limit_snapshot) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.amount'),json_extract(value,'$.limit') FROM json_each(?) WHERE ${won}`,
      )
      .bind(id, encoded, id, token),
  );
  writes.push(
    db
      .prepare(
        `UPDATE ai_quota_buckets SET reserved_amount=reserved_amount+(SELECT reserved_amount FROM ai_quota_reservation_items i WHERE i.reservation_id=? AND i.bucket_id=ai_quota_buckets.id),version=version+1,updated_at=unixepoch() WHERE id IN(SELECT bucket_id FROM ai_quota_reservation_items WHERE reservation_id=?) AND ${won}`,
      )
      .bind(id, id, id, token),
  );
  writes.push(
    db
      .prepare(
        `INSERT INTO ai_quota_ledger(reservation_id,bucket_id,event_key,event_kind,used_delta,reserved_delta) SELECT reservation_id,bucket_id,'reserve','reserve',0,reserved_amount FROM ai_quota_reservation_items WHERE reservation_id=? AND ${won}`,
      )
      .bind(id, id, token),
  );
  writes.push(
    db
      .prepare(
        "UPDATE ai_quota_reservations SET status='held' WHERE id=? AND mutation_token=? AND status='preparing'",
      )
      .bind(id, token),
  );
  writes.push(...(input.tail?.(id, token) ?? []));
  await db.batch(writes);
  if (
    await first(
      env,
      "SELECT id FROM ai_quota_reservations WHERE id=? AND mutation_token=?",
      id,
      token,
    )
  )
    return { id, inserted: true };
  const raced = await first<{ id: string; request_hash: string }>(
    env,
    "SELECT id,request_hash FROM ai_quota_reservations WHERE operation_key=?",
    input.operationKey,
  );
  if (raced) {
    if (raced.request_hash !== requestHash) fail(409, "AI_CONFLICT");
    return { id: raced.id, inserted: false };
  }
  if ((await settings(env)).policy_epoch !== input.context.epoch) fail(409, "AI_CONFLICT");
  if (!(await first(env, `SELECT 1 WHERE ${guard.sql}`, ...guard.args))) fail(409, "AI_CONFLICT");
  const violated = await first<{ window_kind: string; window_end: number }>(
    env,
    "SELECT b.window_kind,b.window_end FROM json_each(?) j JOIN ai_quota_buckets b ON b.id=json_extract(j.value,'$.id') WHERE json_extract(j.value,'$.limit') IS NOT NULL AND b.used_amount+b.reserved_amount+json_extract(j.value,'$.amount')>json_extract(j.value,'$.limit') LIMIT 1",
    encoded,
  );
  fail(
    429,
    violated?.window_kind === "concurrent" ? "AI_CONCURRENCY_EXCEEDED" : "AI_QUOTA_EXCEEDED",
    {
      resets_at:
        violated && !["concurrent", "lifetime"].includes(violated.window_kind)
          ? violated.window_end
          : null,
    },
  );
}
export const reservationGuard = (id: string, token: string) => ({
  sql: "EXISTS(SELECT 1 FROM ai_quota_reservations WHERE id=? AND mutation_token=? AND status='held')",
  args: [id, token] as (string | number | null)[],
});
export async function settle(
  env: AIEnv,
  id: string,
  amounts: Amounts,
  release = false,
  effects?: (guard: Guard) => D1PreparedStatement[],
) {
  const items = await rows<{
    bucket_id: string;
    metric: Metric;
    reserved_amount: number;
    window_kind: string;
  }>(
    env,
    "SELECT i.bucket_id,b.metric,i.reserved_amount,b.window_kind FROM ai_quota_reservation_items i JOIN ai_quota_buckets b ON b.id=i.bucket_id WHERE reservation_id=?",
    id,
  );
  const token = uuid(),
    db = session(env),
    status = release ? "released" : "settled";
  const won =
    "EXISTS(SELECT 1 FROM ai_quota_reservations WHERE id=? AND mutation_token=? AND status=?)";
  const writes = [
    db
      .prepare(
        "UPDATE ai_quota_reservations SET status=?,mutation_token=?,updated_at=unixepoch() WHERE id=? AND status IN('held','uncertain')",
      )
      .bind(status, token, id),
  ];
  for (const item of items) {
    const actual = item.window_kind === "concurrent" ? 0 : (amounts[item.metric] ?? 0);
    if (!Number.isSafeInteger(actual) || actual < 0) fail(400, "AI_INVALID_INPUT");
    writes.push(
      db
        .prepare(
          `UPDATE ai_quota_buckets SET used_amount=used_amount+?,reserved_amount=reserved_amount-?,version=version+1,updated_at=unixepoch() WHERE id=? AND ${won}`,
        )
        .bind(actual, item.reserved_amount, item.bucket_id, id, token, status),
    );
    writes.push(
      db
        .prepare(
          `UPDATE ai_quota_reservation_items SET settled_amount=? WHERE reservation_id=? AND bucket_id=? AND ${won}`,
        )
        .bind(actual, id, item.bucket_id, id, token, status),
    );
    writes.push(
      db
        .prepare(
          `INSERT INTO ai_quota_ledger(reservation_id,bucket_id,event_key,event_kind,used_delta,reserved_delta) SELECT ?,?,?,?,?,? WHERE ${won}`,
        )
        .bind(
          id,
          item.bucket_id,
          status,
          release ? "release" : "settle",
          actual,
          -item.reserved_amount,
          id,
          token,
          status,
        ),
    );
  }
  writes.push(...(effects?.({ sql: won, args: [id, token, status] }) ?? []));
  await db.batch(writes);
}
export const uncertain = (env: AIEnv, id: string) =>
  statement(
    env,
    "UPDATE ai_quota_reservations SET status='uncertain',updated_at=unixepoch() WHERE id=? AND status='held'",
    id,
  ).run();
