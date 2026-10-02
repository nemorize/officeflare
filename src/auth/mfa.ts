import { decryptTotp, digest, totpStep } from "./crypto";
import { unauthorized } from "./input";
import { activeMfaSql, eligibleUserSql } from "./store";
import { now, type AuthContext, type Challenge } from "./types";

export interface TotpMethod {
  id: string; user_id: string; verified_at: number | null; revoked_at: number | null;
  setup_expires_at: number | null; secret_ciphertext: number[]; secret_nonce: number[];
  key_version: number; algorithm: string; digits: number; period_seconds: number;
  last_accepted_step: number | null;
}
export async function loadTotp(c: AuthContext, userId: string, methodId: string) {
  return c.get("db").prepare(`SELECT m.*, t.* FROM user_mfa_methods m
    JOIN user_mfa_totp t ON t.method_id = m.id WHERE m.id = ? AND m.user_id = ? AND m.type = 'totp' AND m.revoked_at IS NULL`)
    .bind(methodId, userId).first<TotpMethod>();
}
export async function matchTotp(c: AuthContext, method: TotpMethod, code: string) {
  const secret = await decryptTotp(c.env, method.user_id, method.id, method.key_version, method.secret_nonce, method.secret_ciphertext);
  return totpStep(secret, code, method.algorithm, method.digits, method.period_seconds);
}

// The same guard is evaluated inside the factor consumption transaction.
const ready = `EXISTS (SELECT 1 FROM user_auth_challenges q JOIN users u ON u.id = q.user_id
  WHERE q.id = ? AND q.user_id = ? AND q.used_at IS NULL AND q.expires_at > ? AND q.attempts <= 5
  AND q.auth_version = u.auth_version AND ${eligibleUserSql}
  AND q.purpose IN ('login_mfa', 'reauth_mfa') AND q.mfa_authenticated_at IS NULL
  AND (q.session_id IS NULL OR (u.password_reset_required = 0 AND EXISTS (SELECT 1 FROM user_sessions s WHERE s.id = q.session_id
    AND s.revoked_at IS NULL AND s.auth_version = u.auth_version AND s.expires_at > ?))))`;
export async function countAttempt(c: AuthContext, challenge: Challenge) {
  const row = await c.get("db").prepare(`UPDATE user_auth_challenges SET attempts = attempts + 1
    WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < 5 AND mfa_authenticated_at IS NULL
    AND purpose IN ('login_mfa', 'reauth_mfa') RETURNING attempts`).bind(challenge.id, now()).first();
  if (!row) unauthorized();
}
export async function verifyFactor(c: AuthContext, challenge: Challenge, factor: { methodId: string; code: string } | { recoveryCode: string }) {
  const timestamp = now();
  let consume: D1PreparedStatement;
  let methodId: string | null = null;
  if ("methodId" in factor) {
    const method = await loadTotp(c, challenge.user_id, factor.methodId);
    if (!method || method.verified_at === null) unauthorized();
    const step = await matchTotp(c, method, factor.code);
    if (step === null) unauthorized();
    methodId = method.id;
    consume = c.get("db").prepare(`UPDATE user_mfa_totp SET last_accepted_step = ?
      WHERE method_id = ? AND (last_accepted_step IS NULL OR last_accepted_step < ?)
      AND EXISTS (SELECT 1 FROM user_mfa_methods WHERE id = ? AND verified_at IS NOT NULL AND revoked_at IS NULL)
      AND ${ready}`).bind(step, method.id, step, method.id, challenge.id, challenge.user_id, timestamp, timestamp);
  } else {
    const code = factor.recoveryCode.replace(/-/g, "").toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) unauthorized();
    consume = c.get("db").prepare(`UPDATE user_mfa_recovery_codes SET used_at = ?
      WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND ${ready}
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND ${activeMfaSql})`)
      .bind(timestamp, challenge.user_id, await digest(code), challenge.id, challenge.user_id, timestamp, timestamp);
  }
  const results = await c.get("db").batch([
    consume,
    c.get("db").prepare(`UPDATE user_auth_challenges SET mfa_authenticated_at = ?,
      purpose = CASE WHEN purpose = 'reauth_mfa' THEN 'reauth' ELSE 'login' END
      WHERE id = ? AND changes() = 1 AND used_at IS NULL`)
      .bind(timestamp, challenge.id),
    ...(methodId ? [c.get("db").prepare(`UPDATE user_mfa_methods SET last_used_at = ?
      WHERE id = ? AND changes() = 1`).bind(timestamp, methodId)] : []),
  ]);
  if (results[1]!.meta.changes !== 1) unauthorized();
  return { ...challenge, purpose: challenge.purpose === "reauth_mfa" ? "reauth" as const : "login" as const, mfa_authenticated_at: timestamp };
}
