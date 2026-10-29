import { and, count, eq, exists, gt, isNotNull, isNull, lt, not, or } from "drizzle-orm";
import { Hono } from "hono";
import { Buffer } from "node:buffer";
import { base32, digest, encryptTotp } from "../auth/crypto";
import { body, conflict, string, unauthorized } from "../auth/input";
import { loadTotp, matchTotp } from "../auth/mfa";
import {
  claim,
  getGrant,
  hasMfa,
  invalidateCredentials,
  prepareSession,
  requireAccess,
  throttle,
} from "../auth/store";
import { activeMfa, challengeWon } from "../db/auth-conditions";
import { changedOnce, coalesce, increment } from "../db/expressions";
import { insertWhen } from "../db/conditional-insert";
import {
  users,
  userAuthChallenges,
  userMfaMethods,
  userMfaRecoveryCodes,
  userMfaTotp,
} from "../db/schema";
import { now, uuid, type AppEnv } from "../auth/types";

const mfa = new Hono<AppEnv>();
mfa.get("/methods", requireAccess, async (c) => {
  const timestamp = now();
  const rows = await c
    .get("db")
    .select({
      id: userMfaMethods.id,
      type: userMfaMethods.type,
      name: userMfaMethods.name,
      created_at: userMfaMethods.created_at,
      verified_at: userMfaMethods.verified_at,
      last_used_at: userMfaMethods.last_used_at,
      setup_expires_at: userMfaMethods.setup_expires_at,
    })
    .from(userMfaMethods)
    .where(
      and(eq(userMfaMethods.user_id, c.get("identity").user.id), isNull(userMfaMethods.revoked_at)),
    )
    .orderBy(userMfaMethods.created_at);
  return c.json({
    methods: rows.map((method) => ({
      ...method,
      status:
        method.verified_at !== null
          ? "active"
          : (method.setup_expires_at ?? 0) > timestamp
            ? "pending"
            : "expired",
    })),
  });
});

mfa.post("/totp", async (c) => {
  const data = await body(c, ["name"]),
    grant = await getGrant(c);
  const name = data.name === undefined ? null : string(data.name, "name", 100).trim();
  if (name === "") conflict("Method name cannot be empty");
  await throttle(c, "mfa-setup", grant.user_id);
  const db = c.get("db"),
    id = uuid(),
    operation = uuid(),
    timestamp = now();
  const secret = crypto.getRandomValues(new Uint8Array(20));
  const encrypted = await encryptTotp(c.env, grant.user_id, id, secret);
  const user = await db
    .select({ email_address: users.email_address })
    .from(users)
    .where(eq(users.id, grant.user_id))
    .get();
  if (!user) unauthorized();
  const methodCount = db
    .select({ count: count() })
    .from(userMfaMethods)
    .where(
      and(
        eq(userMfaMethods.user_id, grant.user_id),
        isNull(userMfaMethods.revoked_at),
        or(isNotNull(userMfaMethods.verified_at), gt(userMfaMethods.setup_expires_at, timestamp)),
      ),
    );
  const results = await db.batch([
    claim(c, grant, operation),
    insertWhen(
      db,
      userMfaMethods,
      {
        id,
        user_id: grant.user_id,
        type: "totp",
        name,
        created_at: timestamp,
        setup_expires_at: timestamp + 600,
      },
      and(challengeWon(db, operation), lt(methodCount, 5))!,
    ),
    insertWhen(
      db,
      userMfaTotp,
      {
        method_id: id,
        secret_ciphertext: Buffer.from(encrypted.ciphertext),
        secret_nonce: Buffer.from(encrypted.nonce),
        key_version: encrypted.version,
      },
      exists(
        db.select({ id: userMfaMethods.id }).from(userMfaMethods).where(eq(userMfaMethods.id, id)),
      ),
    ),
  ]);
  if (results[0].meta.changes !== 1) unauthorized();
  if (results[1].meta.changes !== 1) conflict("At most five active or pending methods are allowed");
  const uri = `otpauth://totp/${encodeURIComponent(`Officeflare:${user.email_address}`)}?${new URLSearchParams(
    {
      secret: base32(secret),
      issuer: "Officeflare",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    },
  )}`;
  return c.json({ method_id: id, provisioning_uri: uri, setup_expires_at: timestamp + 600 }, 201);
});

mfa.post("/totp/:id/verify", async (c) => {
  const data = await body(c, ["code"]),
    grant = await getGrant(c),
    timestamp = now(),
    db = c.get("db");
  await throttle(c, "mfa-setup", grant.user_id);
  const attempt = await db
    .update(userAuthChallenges)
    .set({ attempts: increment(userAuthChallenges.attempts) })
    .where(
      and(
        eq(userAuthChallenges.id, grant.id),
        isNull(userAuthChallenges.used_at),
        lt(userAuthChallenges.attempts, 5),
        gt(userAuthChallenges.expires_at, timestamp),
      ),
    )
    .returning({ id: userAuthChallenges.id })
    .get();
  if (!attempt) unauthorized();
  const method = await loadTotp(c, grant.user_id, c.req.param("id"));
  if (!method || method.verified_at !== null || (method.setup_expires_at ?? 0) <= timestamp)
    unauthorized();
  const step = await matchTotp(c, method, string(data.code, "code", 8));
  if (step === null) unauthorized();
  const operation = uuid(),
    version = grant.auth_version + 1;
  const pair = await prepareSession(c, { ...grant, mfa_authenticated_at: timestamp }, version);
  const invalidations = invalidateCredentials(c, grant.user_id, operation, version);
  const results = await db.batch([
    claim(c, grant, operation),
    db
      .update(userMfaTotp)
      .set({ last_accepted_step: step })
      .where(
        and(
          eq(userMfaTotp.method_id, method.id),
          or(isNull(userMfaTotp.last_accepted_step), lt(userMfaTotp.last_accepted_step, step)),
          challengeWon(db, operation),
          exists(
            db
              .select({ id: userMfaMethods.id })
              .from(userMfaMethods)
              .where(
                and(
                  eq(userMfaMethods.id, method.id),
                  eq(userMfaMethods.user_id, grant.user_id),
                  isNull(userMfaMethods.verified_at),
                  isNull(userMfaMethods.revoked_at),
                  gt(userMfaMethods.setup_expires_at, timestamp),
                ),
              ),
          ),
        ),
      ),
    db
      .update(userMfaMethods)
      .set({ verified_at: timestamp, last_used_at: timestamp })
      .where(and(eq(userMfaMethods.id, method.id), changedOnce())),
    db
      .update(users)
      .set({ auth_version: increment(users.auth_version), updated_at: timestamp })
      .where(
        and(eq(users.id, grant.user_id), eq(users.auth_version, grant.auth_version), changedOnce()),
      ),
    ...invalidations,
    ...pair.statements(operation),
  ]);
  if (results[3].meta.changes !== 1 || results[4 + invalidations.length]!.meta.changes !== 1)
    unauthorized();
  return c.json({ ...pair.response, method_id: method.id });
});

mfa.delete("/methods/:id", async (c) => {
  const grant = await getGrant(c),
    timestamp = now(),
    operation = uuid(),
    version = grant.auth_version + 1,
    db = c.get("db");
  await throttle(c, "mfa-change", grant.user_id);
  const pair = await prepareSession(c, grant, version);
  const invalidations = invalidateCredentials(c, grant.user_id, operation, version);
  const results = await db.batch([
    claim(c, grant, operation),
    db
      .update(userMfaMethods)
      .set({ revoked_at: timestamp })
      .where(
        and(
          eq(userMfaMethods.id, c.req.param("id")),
          eq(userMfaMethods.user_id, grant.user_id),
          isNull(userMfaMethods.revoked_at),
          challengeWon(db, operation),
        ),
      ),
    db
      .update(users)
      .set({ auth_version: increment(users.auth_version), updated_at: timestamp })
      .where(
        and(eq(users.id, grant.user_id), eq(users.auth_version, grant.auth_version), changedOnce()),
      ),
    db
      .update(userMfaRecoveryCodes)
      .set({ revoked_at: coalesce(userMfaRecoveryCodes.revoked_at, timestamp) })
      .where(
        and(
          eq(userMfaRecoveryCodes.user_id, grant.user_id),
          challengeWon(db, operation),
          not(activeMfa(db, grant.user_id)),
          exists(
            db
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.id, grant.user_id), eq(users.auth_version, version))),
          ),
        ),
      ),
    ...invalidations,
    ...pair.statements(operation),
  ]);
  if (results[2].meta.changes !== 1 || results[4 + invalidations.length]!.meta.changes !== 1)
    unauthorized();
  return c.json(pair.response);
});

mfa.get("/recovery-codes", requireAccess, async (c) => {
  const result = await c
    .get("db")
    .select({ remaining: count() })
    .from(userMfaRecoveryCodes)
    .where(
      and(
        eq(userMfaRecoveryCodes.user_id, c.get("identity").user.id),
        isNull(userMfaRecoveryCodes.used_at),
        isNull(userMfaRecoveryCodes.revoked_at),
      ),
    )
    .get();
  return c.json({ remaining: result!.remaining });
});
mfa.post("/recovery-codes", async (c) => {
  const grant = await getGrant(c);
  await throttle(c, "mfa-change", grant.user_id);
  if (!(await hasMfa(c, grant.user_id))) conflict("Enable MFA before generating recovery codes");
  const db = c.get("db"),
    timestamp = now(),
    operation = uuid(),
    version = grant.auth_version + 1;
  const codes = Array.from({ length: 10 }, () =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
  );
  const hashes = await Promise.all(codes.map(digest));
  const pair = await prepareSession(c, grant, version);
  const invalidations = invalidateCredentials(c, grant.user_id, operation, version);
  const results = await db.batch([
    claim(c, grant, operation),
    db
      .update(users)
      .set({ auth_version: increment(users.auth_version), updated_at: timestamp })
      .where(
        and(
          eq(users.id, grant.user_id),
          eq(users.auth_version, grant.auth_version),
          challengeWon(db, operation),
        ),
      ),
    db
      .update(userMfaRecoveryCodes)
      .set({ revoked_at: coalesce(userMfaRecoveryCodes.revoked_at, timestamp) })
      .where(and(eq(userMfaRecoveryCodes.user_id, grant.user_id), challengeWon(db, operation))),
    ...hashes.map((hash) =>
      insertWhen(
        db,
        userMfaRecoveryCodes,
        {
          id: uuid(),
          user_id: grant.user_id,
          code_hash: hash,
          created_at: timestamp,
        },
        challengeWon(db, operation),
      ),
    ),
    ...invalidations,
    ...pair.statements(operation),
  ]);
  if (
    results[1].meta.changes !== 1 ||
    results[3 + hashes.length + invalidations.length]!.meta.changes !== 1
  )
    unauthorized();
  return c.json(
    { ...pair.response, recovery_codes: codes.map((code) => code.match(/.{8}/g)!.join("-")) },
    201,
  );
});
export default mfa;
