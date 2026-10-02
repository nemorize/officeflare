import { and, eq, exists, gt, isNotNull, isNull, lte, not, or, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from ".";
import { users, userAuthChallenges, userMfaMethods, userSessions } from "./schema";

export const eligibleUser = () => and(isNull(users.disabled_at), isNull(users.deleted_at), isNotNull(users.password_hash));
export function activeMfa(db: Database, userId: string | SQLWrapper) {
  return exists(db.select({ id: userMfaMethods.id }).from(userMfaMethods).where(and(
    eq(userMfaMethods.user_id, userId), isNotNull(userMfaMethods.verified_at), isNull(userMfaMethods.revoked_at),
  )));
}
export function sessionAccountValid(db: Database) {
  return exists(db.select({ id: users.id }).from(users).where(and(
    eq(users.id, userSessions.user_id), eq(users.auth_version, userSessions.auth_version),
    eq(users.password_reset_required, 0), eligibleUser(),
    or(not(activeMfa(db, users.id)), isNotNull(userSessions.mfa_authenticated_at)),
  )));
}
export function validChallenge(db: Database, timestamp: number) {
  const linked = alias(userSessions, "challenge_session");
  return and(
    isNull(userAuthChallenges.used_at), gt(userAuthChallenges.expires_at, timestamp), lte(userAuthChallenges.attempts, 5),
    eq(userAuthChallenges.auth_version, users.auth_version), eligibleUser(),
    or(isNull(userAuthChallenges.session_id), and(eq(users.password_reset_required, 0), exists(
      db.select({ id: linked.id }).from(linked).where(and(
        eq(linked.id, userAuthChallenges.session_id), eq(linked.user_id, users.id),
        eq(linked.auth_version, users.auth_version), isNull(linked.revoked_at), gt(linked.expires_at, timestamp),
      )),
    ))),
  );
}
export function challengeWon(db: Database, operation: string) {
  return exists(db.select({ id: userAuthChallenges.id }).from(userAuthChallenges).where(eq(userAuthChallenges.used_by, operation)));
}
export function accessWon(db: Database, sessionId: string, operation: string) {
  return exists(db.select({ id: userSessions.id }).from(userSessions).where(and(
    eq(userSessions.id, sessionId), eq(userSessions.last_operation_id, operation),
  )));
}
