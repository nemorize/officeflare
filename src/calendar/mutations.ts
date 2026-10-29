import { now, uuid } from "../auth/types";
import { digest } from "../auth/crypto";
import type { Permission } from "../authorization/permissions";
import type { Bind, CalendarContext, Condition } from "./types";
import { combine, condition, first, identity, statement } from "./access";
import { fail, text } from "./input";
import { seal, receipt } from "./secrets";

export function insert(
  c: CalendarContext,
  table: string,
  values: Record<string, Bind>,
  proof: string,
) {
  const entries = Object.entries(values);
  return statement(
    c.env,
    `INSERT INTO ${table}(${entries.map(([key]) => key).join(",")}) SELECT ${entries.map(() => "?").join(",")} WHERE ${proof}`,
    ...entries.map(([, value]) => value),
  );
}
export function update(
  c: CalendarContext,
  table: string,
  values: Record<string, Bind>,
  where: string,
  args: Bind[],
  proof: string,
) {
  const entries = Object.entries(values);
  return statement(
    c.env,
    `UPDATE ${table} SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE ${where} AND ${proof}`,
    ...entries.map(([, value]) => value),
    ...args,
  );
}
export function change(
  c: CalendarContext,
  proof: string,
  calendar: string | null,
  type: string,
  id: string,
  version: number,
  operation = "upsert",
  user: string | null = null,
  occurrence: string | null = null,
) {
  return insert(
    c,
    "calendar_changes",
    {
      calendar_id: calendar,
      audience_user_id: user,
      resource_type: type,
      resource_id: id,
      occurrence_key: occurrence,
      operation,
      version,
    },
    proof,
  );
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export interface Mutation<T> {
  action?: Permission;
  checks?: Condition[];
  operation: string;
  request: unknown;
  result: T;
  idempotent?: boolean;
  secretResult?: boolean;
  principal?: {
    actor_key: string;
    actor_user_id: string | null;
    auth: Condition;
  };
  build: (proof: string, operationId: string) => D1PreparedStatement[];
  calendar?: string;
  event?: string;
  details?: Record<string, unknown>;
}
export async function replay<T>(
  c: CalendarContext,
  operation: string,
  request: unknown,
  action: Permission,
): Promise<{ result: T } | null> {
  const auth = identity(c, action);
  if (!(await first(c.env, `SELECT 1 WHERE ${auth.sql}`, ...auth.args)))
    fail(403, "PERMISSION_DENIED", "Calendar action is not permitted");
  const key = text(c.req.header("Idempotency-Key"), "Idempotency-Key", 128),
    actor = c.get("identity").user.id;
  const old = await first<{ request_hash: string; result_json: string }>(
    c.env,
    "SELECT request_hash,result_json FROM calendar_operations WHERE actor_key=? AND operation=? AND idempotency_key=?",
    `user:${actor}`,
    operation,
    key,
  );
  if (!old) return null;
  if (old.request_hash !== (await digest(stable(request))))
    fail(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was used with another request");
  return {
    result: await receipt<T>(
      c.env,
      `receipt:user:${actor}:${operation}:${old.request_hash}`,
      old.result_json,
    ),
  };
}
export async function mutate<T>(c: CalendarContext, input: Mutation<T>): Promise<T> {
  const actor =
      input.principal?.actor_user_id ?? (input.principal ? null : c.get("identity").user.id),
    actorKey = input.principal?.actor_key ?? `user:${actor}`,
    auth = input.principal?.auth ?? identity(c, input.action),
    hash = await digest(stable(input.request));
  const key = input.idempotent
    ? text(c.req.header("Idempotency-Key"), "Idempotency-Key", 128)
    : null;
  const existing = async () =>
    key
      ? first<{ request_hash: string; result_json: string }>(
          c.env,
          "SELECT request_hash,result_json FROM calendar_operations WHERE actor_key=? AND operation=? AND idempotency_key=?",
          actorKey,
          input.operation,
          key,
        )
      : null;
  if (!(await first(c.env, `SELECT 1 WHERE ${auth.sql}`, ...auth.args)))
    fail(403, "PERMISSION_DENIED", "Calendar action is not permitted");
  const previous = await existing();
  if (previous) {
    if (previous.request_hash !== hash)
      fail(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was used with another request");
    return receipt<T>(
      c.env,
      `receipt:${actorKey}:${input.operation}:${hash}`,
      previous.result_json,
    );
  }
  const operation = uuid(),
    proof = `EXISTS(SELECT 1 FROM calendar_operations WHERE id='${operation}')`,
    checks = combine(
      auth,
      ...(input.checks ?? []),
      ...(key
        ? [
            condition(
              "NOT EXISTS(SELECT 1 FROM calendar_operations WHERE actor_key=? AND operation=? AND idempotency_key=?)",
              actorKey,
              input.operation,
              key,
            ),
          ]
        : []),
    );
  const values = {
    id: operation,
    actor_key: actorKey,
    actor_user_id: actor,
    operation: input.operation,
    idempotency_key: key,
    request_hash: hash,
    result_json: JSON.stringify(
      input.secretResult
        ? await seal(c.env, `receipt:${actorKey}:${input.operation}:${hash}`, input.result)
        : input.result,
    ),
    expires_at: now() + 86400,
  };
  const statements = [
    statement(
      c.env,
      `INSERT INTO calendar_operations(${Object.keys(values).join(",")}) SELECT ${Object.keys(
        values,
      )
        .map(() => "?")
        .join(",")} WHERE ${checks.sql}`,
      ...Object.values(values),
      ...checks.args,
    ),
  ];
  statements.push(...input.build(proof, operation));
  statements.push(
    insert(
      c,
      "calendar_activity",
      {
        id: uuid(),
        operation_id: operation,
        actor_user_id: actor,
        calendar_id: input.calendar ?? null,
        event_id: input.event ?? null,
        action: input.operation,
        details_json: JSON.stringify(input.details ?? {}),
      },
      proof,
    ),
  );
  const results = await c.env.DB.withSession("first-primary").batch(statements);
  if (results[0]!.meta.changes !== 1) {
    if (!(await first(c.env, `SELECT 1 WHERE ${auth.sql}`, ...auth.args)))
      fail(403, "PERMISSION_DENIED", "Calendar permissions changed");
    const raced = await existing();
    if (raced) {
      if (raced.request_hash !== hash)
        fail(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was used with another request");
      return receipt<T>(c.env, `receipt:${actorKey}:${input.operation}:${hash}`, raced.result_json);
    }
    fail(412, "VERSION_CONFLICT", "Calendar resource or permissions changed. Reload and try again");
  }
  return input.result;
}
