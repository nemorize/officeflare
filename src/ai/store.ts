import { createDatabase } from "../db";
import { eq, and, gt, isNull, isNotNull, or, not } from "drizzle-orm";
import { users, userSessions } from "../db/schema";
import { activeMfa } from "../db/auth-conditions";
import { permissionsFor } from "../authorization/access";
import { now, uuid, type Identity } from "../auth/types";
import { digest } from "../auth/crypto";
import { fail } from "./errors";
import type { AIEnv, AIPrincipal, Bind, Guard } from "./types";

export const session = (env: AIEnv) => env.DB.withSession("first-primary");
export const statement = (env: AIEnv, query: string, ...args: Bind[]) =>
  session(env)
    .prepare(query)
    .bind(...args);
export const first = <T>(env: AIEnv, query: string, ...args: Bind[]) =>
  statement(env, query, ...args).first<T>();
export const rows = async <T>(env: AIEnv, query: string, ...args: Bind[]) =>
  (await statement(env, query, ...args).all<T>()).results;
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "AI_INVALID_INPUT");
  return value as Record<string, unknown>;
};
export const parse = <T = Record<string, unknown>>(json: string): T => JSON.parse(json) as T;
export const text = (value: unknown, maximum = 1000, empty = false) => {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    value.includes("\u0000")
  )
    fail(400, "AI_INVALID_INPUT");
  return value;
};
export const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail(400, "AI_INVALID_INPUT");
  return value as number;
};
export const flag = (value: unknown) =>
  value === true || value === 1
    ? 1
    : value === false || value === 0
      ? 0
      : fail(400, "AI_INVALID_INPUT");
export function fields(data: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(data).some((key) => !allowed.includes(key))) fail(400, "AI_INVALID_INPUT");
  return data;
}
export const canonical = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]))
      .join(",") +
    "}"
  );
};
export const hash = (value: unknown) => digest(canonical(value));
export async function identity(env: AIEnv, principal: AIPrincipal): Promise<Identity> {
  if (principal.kind !== "user") fail(403, "AI_FORBIDDEN");
  const db = createDatabase(env.DB);
  const found = await db
    .select({ user: users, session: userSessions })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.user_id))
    .where(
      and(
        eq(users.id, principal.userId),
        eq(userSessions.id, principal.sessionId),
        eq(users.auth_version, principal.authVersion),
        eq(userSessions.auth_version, users.auth_version),
        isNull(users.deleted_at),
        isNull(users.disabled_at),
        isNotNull(users.password_hash),
        eq(users.password_reset_required, 0),
        isNull(userSessions.revoked_at),
        gt(userSessions.expires_at, now()),
        or(not(activeMfa(db, users.id)), isNotNull(userSessions.mfa_authenticated_at)),
      ),
    )
    .get();
  if (!found) fail(401, "AI_REAUTH_REQUIRED");
  return found;
}
export async function requireUserPermission(env: AIEnv, principal: AIPrincipal, key: string) {
  await identity(env, principal);
  if (
    !(
      await permissionsFor(
        createDatabase(env.DB),
        principal.kind === "user" ? principal.userId : "",
      )
    ).includes(key as never)
  )
    fail(403, "AI_FORBIDDEN");
}
export function identityGuard(principal: AIPrincipal): Guard {
  if (principal.kind !== "user") return { sql: "1", args: [] };
  return {
    sql: `EXISTS(SELECT 1 FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.id=? AND s.auth_version=? AND u.auth_version=s.auth_version AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND u.disabled_at IS NULL AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL AND u.password_reset_required=0 AND (s.mfa_authenticated_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM user_mfa_methods m WHERE m.user_id=u.id AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL)))`,
    args: [principal.sessionId, principal.userId, principal.authVersion],
  };
}
export async function ensureUserSubject(env: AIEnv, userId: string) {
  const key = "user:" + userId;
  await statement(
    env,
    "INSERT INTO ai_subjects(id,key,kind,user_id) VALUES(?,?,'user',?) ON CONFLICT(key) DO NOTHING",
    uuid(),
    key,
    userId,
  ).run();
  return (await first<{ id: string }>(env, "SELECT id FROM ai_subjects WHERE key=?", key))!.id;
}
export async function audit(
  env: AIEnv,
  actor: string,
  action: string,
  targetType: string,
  targetId: string | null,
  details: unknown = {},
  eventKey = uuid(),
) {
  await statement(
    env,
    "INSERT INTO ai_audit_events(event_key,actor_key,action,target_type,target_id,details_json) VALUES(?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING",
    eventKey,
    actor,
    action,
    targetType,
    targetId,
    canonical(details),
  ).run();
}
