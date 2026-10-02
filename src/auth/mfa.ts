import { and, eq, exists, getTableColumns, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { decryptTotp, digest, totpStep } from "./crypto";
import { unauthorized } from "./input";
import { activeMfa, validChallenge } from "../db/auth-conditions";
import { changedOnce, increment } from "../db/expressions";
import { users, userAuthChallenges, userMfaMethods, userMfaRecoveryCodes, userMfaTotp } from "../db/schema";
import { now, type AuthContext, type Challenge } from "./types";

export type TotpMethod = typeof userMfaMethods.$inferSelect & typeof userMfaTotp.$inferSelect;
export async function loadTotp(c: AuthContext, userId: string, methodId: string) {
  return c.get("db").select({ ...getTableColumns(userMfaMethods), ...getTableColumns(userMfaTotp) })
    .from(userMfaMethods).innerJoin(userMfaTotp, eq(userMfaTotp.method_id, userMfaMethods.id)).where(and(
      eq(userMfaMethods.id, methodId), eq(userMfaMethods.user_id, userId), eq(userMfaMethods.type, "totp"), isNull(userMfaMethods.revoked_at),
    )).get();
}
export async function matchTotp(c: AuthContext, method: TotpMethod, code: string) {
  const secret = await decryptTotp(c.env, method.user_id, method.id, method.key_version, method.secret_nonce, method.secret_ciphertext);
  return totpStep(secret, code, method.algorithm, method.digits, method.period_seconds);
}

export async function countAttempt(c: AuthContext, challenge: Challenge) {
  const row = await c.get("db").update(userAuthChallenges).set({ attempts: increment(userAuthChallenges.attempts) }).where(and(
    eq(userAuthChallenges.id, challenge.id), isNull(userAuthChallenges.used_at), gt(userAuthChallenges.expires_at, now()),
    lt(userAuthChallenges.attempts, 5), isNull(userAuthChallenges.mfa_authenticated_at),
    inArray(userAuthChallenges.purpose, ["login_mfa", "reauth_mfa"]),
  )).returning({ attempts: userAuthChallenges.attempts }).get();
  if (!row) unauthorized();
}
export async function verifyFactor(c: AuthContext, challenge: Challenge, factor: { methodId: string; code: string } | { recoveryCode: string }) {
  const db = c.get("db"), timestamp = now();
  // Recheck proof, account and session state in the same batch that consumes the factor.
  const ready = exists(db.select({ id: userAuthChallenges.id }).from(userAuthChallenges)
    .innerJoin(users, eq(users.id, userAuthChallenges.user_id)).where(and(
      eq(userAuthChallenges.id, challenge.id), eq(userAuthChallenges.user_id, challenge.user_id), validChallenge(db, timestamp),
      inArray(userAuthChallenges.purpose, ["login_mfa", "reauth_mfa"]), isNull(userAuthChallenges.mfa_authenticated_at),
    )));
  let consume: BatchItem<"sqlite">;
  let methodId: string | null = null;
  if ("methodId" in factor) {
    const method = await loadTotp(c, challenge.user_id, factor.methodId);
    if (!method || method.verified_at === null) unauthorized();
    const step = await matchTotp(c, method, factor.code);
    if (step === null) unauthorized();
    methodId = method.id;
    consume = db.update(userMfaTotp).set({ last_accepted_step: step }).where(and(
      eq(userMfaTotp.method_id, method.id), or(isNull(userMfaTotp.last_accepted_step), lt(userMfaTotp.last_accepted_step, step)), ready,
      exists(db.select({ id: userMfaMethods.id }).from(userMfaMethods).where(and(
        eq(userMfaMethods.id, method.id), isNotNull(userMfaMethods.verified_at), isNull(userMfaMethods.revoked_at),
      ))),
    ));
  } else {
    const code = factor.recoveryCode.replace(/-/g, "").toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) unauthorized();
    consume = db.update(userMfaRecoveryCodes).set({ used_at: timestamp }).where(and(
      eq(userMfaRecoveryCodes.user_id, challenge.user_id), eq(userMfaRecoveryCodes.code_hash, await digest(code)),
      isNull(userMfaRecoveryCodes.used_at), isNull(userMfaRecoveryCodes.revoked_at), ready, activeMfa(db, challenge.user_id),
    ));
  }
  const purpose = challenge.purpose === "reauth_mfa" ? "reauth" as const : "login" as const;
  const results = await db.batch([
    consume,
    db.update(userAuthChallenges).set({ mfa_authenticated_at: timestamp, purpose }).where(and(
      eq(userAuthChallenges.id, challenge.id), changedOnce(), isNull(userAuthChallenges.used_at),
    )),
    ...(methodId ? [db.update(userMfaMethods).set({ last_used_at: timestamp }).where(and(eq(userMfaMethods.id, methodId), changedOnce()))] : []),
  ]);
  if (results[1].meta.changes !== 1) unauthorized();
  return { ...challenge, purpose, mfa_authenticated_at: timestamp };
}
