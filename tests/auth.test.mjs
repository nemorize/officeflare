import { workerModules } from "./worker-modules.mjs";
import { permissionCatalog, permissionClosure } from "../src/authorization/permissions.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { scryptSync, createHmac, randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../src/db/schema.ts";

const {
  users,
  userSessions,
  userAuthChallenges,
  userMfaMethods,
  userMfaRecoveryCodes,
  userMfaTotp,
  userProfileFields,
  roles,
  rolePermissions,
  userRoles,
} = schema;

const PASSWORD = "correct horse battery staple";
const hash = (value = PASSWORD) => {
  const salt = randomBytes(16);
  return `scrypt$16384$8$5$${salt.toString("base64url")}$${scryptSync(value, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 24 * 1024 * 1024 }).toString("base64url")}`;
};
const sha = async (value) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );
const timestamp = () => Math.floor(Date.now() / 1000);
function decodeBase32(value) {
  let bits = 0,
    accumulator = 0;
  const output = [];
  for (const char of value) {
    accumulator = (accumulator << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
function code(secret, step = Math.floor(timestamp() / 30)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest(),
    offset = mac.at(-1) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}

test("Bearer account API in the Workers runtime", async (t) => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const signing = { active_kid: "test", keys: [{ ...(await exportJWK(privateKey)), kid: "test" }] };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: "officeflare",
          modules: workerModules,
          compatibilityDate: "2026-09-29",
          d1Databases: { DB: "auth-tests" },
          r2Buckets: { PROFILE_BUCKET: "profile-tests" },
          bindings: {
            AUTH_SIGNING_KEYS: JSON.stringify(signing),
            MFA_ENCRYPTION_KEYS: JSON.stringify({
              active_version: 1,
              keys: { 1: randomBytes(32).toString("base64url") },
            }),
            AUTH_ISSUER: "officeflare",
            AUTH_AUDIENCE: "officeflare-api",
          },
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const binding = await mf.getD1Database("DB");
  // Bootstrap the existing Wrangler DDL, including STRICT tables and triggers.
  for (const file of (await readdir("migrations")).sort()) {
    let sql = "",
      trigger = false;
    for (const line of (await readFile(`migrations/${file}`, "utf8")).split("\n")) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      sql += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
        await binding.prepare(sql).run();
        sql = "";
        trigger = false;
      }
    }
    assert.equal(sql.trim(), "");
  }
  const db = drizzle(binding, { schema });
  const seed = async (id, extra = {}) => {
    await db.insert(users).values({
      id,
      email_address: `${id}@office.test`,
      password_hash: extra.hash ?? hash(),
      password_reset_required: extra.reset ? 1 : 0,
    });
  };
  let ip = 0;
  const request = async (
    path,
    { method = "GET", token, data, expected = 200, headers = {} } = {},
  ) => {
    const response = await mf.dispatchFetch(`https://office.test${path}`, {
      method,
      headers: {
        "cf-connecting-ip": `192.0.2.${++ip % 250}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`);
    assert.equal(response.headers.get("set-cookie"), null);
    if (path.startsWith("/api") && expected !== 413)
      assert.equal(response.headers.get("cache-control"), "no-store");
    return expected === 204 ? null : response.json();
  };
  const login = (id, expected = 200) =>
    request("/api/auth/login", {
      method: "POST",
      data: { email_address: `${id}@office.test`, password: PASSWORD },
      expected,
    });
  const reauth = (access) =>
    request("/api/auth/reauthenticate", {
      method: "POST",
      token: access,
      data: { password: PASSWORD },
    });
  const verify = (challenge, methodId, supplied) =>
    request("/api/auth/mfa/verify", {
      method: "POST",
      token: challenge,
      data: { method_id: methodId, code: supplied },
    });

  await t.test("login, token purpose, JWT validation, rotation and logout", async () => {
    await seed("basic");
    await db.update(users).set({ email_address: "BASIC@OFFICE.TEST" }).where(eq(users.id, "basic"));
    await request("/api/auth/login", {
      method: "POST",
      data: { email_address: "missing@office.test", password: PASSWORD },
      expected: 401,
    });
    await request("/api/auth/login", {
      method: "POST",
      data: { email_address: "basic@office.test", password: "wrong password" },
      expected: 401,
    });
    const first = await login("basic");
    assert.equal(first.token_type, "Bearer");
    assert.ok(first.access_token);
    assert.ok(first.refresh_token);
    const user = await request("/api/me", { token: first.access_token });
    assert.equal(user.user.id, "basic");
    assert.equal(user.user.password_hash, undefined);
    await request("/api/me", { token: first.refresh_token, expected: 401 });
    await request("/api/auth/refresh", {
      method: "POST",
      token: first.access_token,
      expected: 401,
    });
    const pending = await reauth(first.access_token);
    await request("/api/me", { token: pending.reauthentication_token, expected: 401 });
    const tokens = await request("/api/auth/refresh", {
      method: "POST",
      token: first.refresh_token,
    });
    assert.notEqual(tokens.refresh_token, first.refresh_token);
    await request("/api/auth/refresh", {
      method: "POST",
      token: first.refresh_token,
      expected: 401,
    });
    await request("/api/me", { token: tokens.access_token, expected: 401 });
    await request("/api/auth/refresh", {
      method: "POST",
      token: tokens.refresh_token,
      expected: 401,
    });
    const second = await login("basic");
    for (const overrides of [
      { aud: "wrong" },
      { iss: "wrong" },
      { exp: timestamp() - 1 },
      { ver: 999 },
      { sid: "missing" },
    ]) {
      const jwt = await new SignJWT({
        sub: "basic",
        sid: second.session_id,
        ver: 1,
        iat: timestamp(),
        exp: timestamp() + 900,
        iss: "officeflare",
        aud: "officeflare-api",
        jti: crypto.randomUUID(),
        ...overrides,
      })
        .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "test" })
        .sign(privateKey);
      await request("/api/me", { token: jwt, expected: 401 });
    }
    await request("/api/me", {
      token: second.access_token.slice(0, -8) + "aaaaaaaa",
      expected: 401,
    });
    await request("/api/auth/logout", {
      method: "POST",
      token: second.access_token,
      expected: 204,
    });
    await request("/api/me", { token: second.access_token, expected: 401 });
    await request("/api/auth/refresh", {
      method: "POST",
      token: second.refresh_token,
      expected: 401,
    });
  });

  await t.test(
    "durable refresh ids recover lost responses and simultaneous retries without revoking the session",
    async () => {
      await seed("refresh-retry");
      const first = await login("refresh-retry"),
        requestId = randomBytes(32).toString("hex");
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          request("/api/auth/refresh", {
            method: "POST",
            token: first.refresh_token,
            data: { request_id: requestId },
          }),
        ),
      );
      assert.equal(new Set(responses.map((result) => result.refresh_token)).size, 1);
      assert.ok(responses.every((result) => result.session_id === first.session_id));
      for (const result of responses) await request("/api/me", { token: result.access_token });
      const recovered = await request("/api/auth/refresh", {
        method: "POST",
        token: first.refresh_token,
        data: { request_id: requestId },
      });
      assert.equal(recovered.refresh_token, responses[0].refresh_token);
      const next = await request("/api/auth/refresh", {
        method: "POST",
        token: recovered.refresh_token,
        data: { request_id: randomBytes(32).toString("hex") },
      });
      await request("/api/auth/refresh", {
        method: "POST",
        token: first.refresh_token,
        data: { request_id: requestId },
        expected: 401,
      });
      await request("/api/me", { token: next.access_token });
      // A different request id for an already consumed token remains a replay and revokes the session.
      await request("/api/auth/refresh", {
        method: "POST",
        token: first.refresh_token,
        data: { request_id: randomBytes(32).toString("hex") },
        expected: 401,
      });
      await request("/api/me", { token: next.access_token, expected: 401 });
    },
  );

  await t.test("durable refresh retries cannot restore revoked or expired sessions", async () => {
    await seed("refresh-ended");
    const first = await login("refresh-ended"),
      requestId = randomBytes(32).toString("hex");
    await request("/api/auth/refresh", {
      method: "POST",
      token: first.refresh_token,
      data: { request_id: "invalid" },
      expected: 400,
    });
    const rotated = await request("/api/auth/refresh", {
      method: "POST",
      token: first.refresh_token,
      data: { request_id: requestId },
    });
    await request("/api/auth/logout", {
      method: "POST",
      token: rotated.access_token,
      expected: 204,
    });
    await request("/api/auth/refresh", {
      method: "POST",
      token: first.refresh_token,
      data: { request_id: requestId },
      expected: 401,
    });
    const expired = await login("refresh-ended"),
      expiredId = randomBytes(32).toString("hex");
    await request("/api/auth/refresh", {
      method: "POST",
      token: expired.refresh_token,
      data: { request_id: expiredId },
    });
    await db
      .update(userSessions)
      .set({ created_at: timestamp() - 2, expires_at: timestamp() - 1 })
      .where(eq(userSessions.id, expired.session_id));
    await request("/api/auth/refresh", {
      method: "POST",
      token: expired.refresh_token,
      data: { request_id: expiredId },
      expected: 401,
    });
  });

  await t.test("forced password reset is restricted and one-use", async () => {
    await seed("reset", { reset: true });
    const reset = await login("reset");
    assert.equal(reset.next, "password_reset");
    assert.equal(reset.access_token, undefined);
    await request("/api/me", { token: reset.challenge_token, expected: 401 });
    await request("/api/me/mfa/totp", {
      method: "POST",
      token: reset.challenge_token,
      data: {},
      expected: 401,
    });
    await request("/api/me/password", {
      method: "PUT",
      token: reset.challenge_token,
      data: { new_password: "short" },
      expected: 400,
    });
    const changed = await request("/api/me/password", {
      method: "PUT",
      token: reset.challenge_token,
      data: { new_password: "a very long replacement password" },
    });
    await request("/api/me", { token: changed.access_token });
    await request("/api/me/password", {
      method: "PUT",
      token: reset.challenge_token,
      data: { new_password: PASSWORD },
      expected: 401,
    });
    await login("reset", 401);
    const result = await db
      .select({
        password_hash: users.password_hash,
        password_reset_required: users.password_reset_required,
        password_changed_at: users.password_changed_at,
      })
      .from(users)
      .where(eq(users.id, "reset"))
      .get();
    assert.match(result.password_hash, /^scrypt\$/);
    assert.equal(result.password_reset_required, 0);
    assert.ok(result.password_changed_at);
  });

  await t.test("password changes invalidate every old session and challenge", async () => {
    await seed("password");
    const first = await login("password"),
      second = await login("password");
    const grant = await reauth(first.access_token),
      other = await reauth(second.access_token);
    await request("/api/me/password", {
      method: "PUT",
      token: first.access_token,
      data: { new_password: PASSWORD },
      expected: 401,
    });
    const changed = await request("/api/me/password", {
      method: "PUT",
      token: grant.reauthentication_token,
      data: { new_password: "replacement password 12345" },
    });
    await request("/api/me", { token: changed.access_token });
    for (const tokens of [first, second]) {
      await request("/api/me", { token: tokens.access_token, expected: 401 });
      await request("/api/auth/refresh", {
        method: "POST",
        token: tokens.refresh_token,
        expected: 401,
      });
    }
    await request("/api/me/password", {
      method: "PUT",
      token: other.reauthentication_token,
      data: { new_password: PASSWORD },
      expected: 401,
    });
  });

  await t.test("concurrent password changes can consume a grant only once", async () => {
    await seed("password-race");
    const original = await login("password-race"),
      grant = await reauth(original.access_token);
    const responses = await Promise.all(
      [1, 2].map((number) =>
        mf.dispatchFetch("https://office.test/api/me/password", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.reauthentication_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ new_password: `a valid replacement password ${number}` }),
        }),
      ),
    );
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    const success = await responses.find((response) => response.status === 200).json();
    await request("/api/me", { token: success.access_token });
    assert.equal(
      (
        await db
          .select({ auth_version: users.auth_version })
          .from(users)
          .where(eq(users.id, "password-race"))
          .get()
      ).auth_version,
      2,
    );
    assert.equal(
      (
        await db
          .select({ count: count() })
          .from(userSessions)
          .where(and(eq(userSessions.user_id, "password-race"), isNull(userSessions.revoked_at)))
          .get()
      ).count,
      1,
    );
  });

  await t.test(
    "TOTP enrollment, replay, recovery, revocation and forced reset with MFA",
    async () => {
      await seed("mfa");
      const initial = await login("mfa");
      const setupGrant = await reauth(initial.access_token);
      const setup = await request("/api/me/mfa/totp", {
        method: "POST",
        token: setupGrant.reauthentication_token,
        data: { name: "Phone" },
        expected: 201,
      });
      const secret = decodeBase32(new URL(setup.provisioning_uri).searchParams.get("secret"));
      const stored = await db
        .select({
          secret_ciphertext: userMfaTotp.secret_ciphertext,
          secret_nonce: userMfaTotp.secret_nonce,
        })
        .from(userMfaTotp)
        .where(eq(userMfaTotp.method_id, setup.method_id))
        .get();
      assert.notDeepEqual(Buffer.from(stored.secret_ciphertext).subarray(0, 20), secret);
      assert.equal(stored.secret_nonce.length, 12);
      const activationGrant = await reauth(initial.access_token),
        step = Math.floor(timestamp() / 30);
      const activated = await request(`/api/me/mfa/totp/${setup.method_id}/verify`, {
        method: "POST",
        token: activationGrant.reauthentication_token,
        data: { code: code(secret, step) },
      });
      await request("/api/me", { token: initial.access_token, expected: 401 });
      const challenge = await login("mfa");
      assert.equal(challenge.next, "mfa");
      assert.equal(challenge.access_token, undefined);
      await request("/api/me", { token: challenge.challenge_token, expected: 401 });
      await request("/api/auth/mfa/verify", {
        method: "POST",
        token: challenge.challenge_token,
        data: { method_id: setup.method_id, code: code(secret, step) },
        expected: 401,
      });
      const reauthChallenge = await reauth(activated.access_token);
      const verified = await verify(
        reauthChallenge.challenge_token,
        setup.method_id,
        code(secret, step + 1),
      );
      const generated = await request("/api/me/mfa/recovery-codes", {
        method: "POST",
        token: verified.reauthentication_token,
        expected: 201,
      });
      assert.equal(generated.recovery_codes.length, 10);
      await request("/api/me", { token: activated.access_token, expected: 401 });
      const codes = [...generated.recovery_codes];
      const recoveredLogin = await login("mfa");
      const recovered = await request("/api/auth/mfa/recovery", {
        method: "POST",
        token: recoveredLogin.challenge_token,
        data: { recovery_code: codes[0] },
      });
      await request("/api/auth/mfa/recovery", {
        method: "POST",
        token: recoveredLogin.challenge_token,
        data: { recovery_code: codes[1] },
        expected: 401,
      });
      const another = await login("mfa");
      await request("/api/auth/mfa/recovery", {
        method: "POST",
        token: another.challenge_token,
        data: { recovery_code: codes[0] },
        expected: 401,
      });
      const remaining = await request("/api/me/mfa/recovery-codes", {
        token: recovered.access_token,
      });
      assert.equal(remaining.remaining, 9);
      await db.update(users).set({ password_reset_required: 1 }).where(eq(users.id, "mfa"));
      await request("/api/me", { token: recovered.access_token, expected: 401 });
      const resetChallenge = await login("mfa");
      assert.equal(resetChallenge.next, "mfa");
      const reset = await request("/api/auth/mfa/recovery", {
        method: "POST",
        token: resetChallenge.challenge_token,
        data: { recovery_code: codes[1] },
      });
      assert.equal(reset.next, "password_reset");
      const changed = await request("/api/me/password", {
        method: "PUT",
        token: reset.challenge_token,
        data: { new_password: PASSWORD },
      });
      const removalChallenge = await reauth(changed.access_token);
      const removalGrant = await request("/api/auth/mfa/recovery", {
        method: "POST",
        token: removalChallenge.challenge_token,
        data: { recovery_code: codes[2] },
      });
      const removed = await request(`/api/me/mfa/methods/${setup.method_id}`, {
        method: "DELETE",
        token: removalGrant.reauthentication_token,
      });
      await request("/api/me", { token: removed.access_token });
      assert.equal((await login("mfa")).next, undefined);
      assert.equal(
        (await request("/api/me/mfa/recovery-codes", { token: removed.access_token })).remaining,
        0,
      );
    },
  );

  await t.test(
    "profile field policies, types, required values and no credential leakage",
    async () => {
      await seed("profile");
      for (const [key, type, editable, visibility, required, options] of [
        [
          "department",
          "select",
          "user",
          "organization",
          1,
          '[{"value":"engineering","label":{"default":"Engineering"}}]',
        ],
        ["title", "text", "admin", "private", 0, null],
        ["internal", "text", "user", "admin", 0, null],
        ["birthday", "date", "user", "private", 0, null],
        ["website", "url", "user", "private", 0, null],
      ])
        await db.insert(userProfileFields).values({
          id: key,
          key,
          label: JSON.stringify({ default: key, en: key }),
          value_type: type,
          editable_by: editable,
          visibility,
          required,
          options_json: options,
        });
      const loginResult = await login("profile"),
        token = loginResult.access_token;
      const definitions = await request("/api/me/profile-fields", { token });
      assert.equal(
        definitions.fields.some((field) => field.key === "internal"),
        false,
      );
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { fields: { title: "Admin" } },
        expected: 403,
      });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { fields: { internal: "Hidden" } },
        expected: 400,
      });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { email_address: "hacked@test" },
        expected: 400,
      });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { display_name: "Jane" },
        expected: 400,
      });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { fields: { department: "bad" } },
        expected: 400,
      });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { fields: { department: "engineering", birthday: "2026-02-30" } },
        expected: 400,
      });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { fields: { department: "engineering", website: "javascript:alert(1)" } },
        expected: 400,
      });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: {
          display_name: "Jane",
          fields: {
            department: "engineering",
            birthday: "2000-02-29",
            website: "https://example.com",
          },
        },
      });
      const result = await request("/api/me/profile", { token });
      assert.equal(result.display_name, "Jane");
      assert.equal(result.fields.department, "engineering");
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { fields: { department: null } },
        expected: 400,
      });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { fields: { birthday: null } },
      });
      assert.equal((await request("/api/me/profile", { token })).fields.birthday, undefined);
      for (let index = 0; index < 25; index++)
        await db.insert(userProfileFields).values({
          id: `extra-${index}`,
          key: `extra-${index}`,
          label: JSON.stringify({ default: `extra-${index}` }),
          value_type: "text",
          editable_by: "user",
        });
      await request("/api/me/profile", {
        method: "PATCH",
        token,
        data: { fields: { "extra-24": "Many fields" } },
      });
    },
  );

  await t.test(
    "profile images require ownership, validate bytes and clean up replaced images",
    async () => {
      await seed("photo-owner");
      await seed("photo-other");
      const owner = await login("photo-owner"),
        other = await login("photo-other");
      const bucket = await mf.getR2Bucket("PROFILE_BUCKET");
      const deleted = async (key) => {
        for (let attempt = 0; attempt < 50 && (await bucket.head(key)); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(await bucket.head(key), null);
      };
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ9kAAAAASUVORK5CYII=",
        "base64",
      );
      const photo = async (method, token, bytes, type = "image/png") =>
        mf.dispatchFetch("https://office.test/api/me/profile-image", {
          method,
          headers: {
            "cf-connecting-ip": `192.0.2.${++ip % 250}`,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(bytes ? { "Content-Type": type } : {}),
          },
          body: bytes,
        });
      assert.equal((await photo("GET")).status, 401);
      assert.equal((await photo("PUT", undefined, png)).status, 401);
      assert.equal((await photo("GET", owner.access_token)).status, 404);
      assert.equal((await photo("PUT", owner.access_token, Buffer.from("<svg/>"))).status, 400);
      assert.equal((await photo("PUT", owner.access_token, png, "image/svg+xml")).status, 400);
      const oversizedDimensions = Buffer.from(png);
      oversizedDimensions.writeUInt32BE(8192, 16);
      assert.equal((await photo("PUT", owner.access_token, oversizedDimensions)).status, 400);
      assert.equal(
        (await photo("PUT", owner.access_token, Buffer.alloc(2 * 1024 * 1024 + 1))).status,
        413,
      );
      const upload = await photo("PUT", owner.access_token, png);
      assert.equal(upload.status, 200);
      const original = (await upload.json()).user.profile_image_key;
      assert.match(original, /^profiles\/photo-owner\//);
      const fetched = await photo("GET", owner.access_token);
      assert.equal(fetched.headers.get("content-type"), "image/png");
      assert.equal(fetched.headers.get("cache-control"), "no-store");
      assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
      assert.equal(fetched.headers.get("set-cookie"), null);
      assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png);
      assert.equal((await photo("GET", other.access_token)).status, 404);
      // Even a legacy administrator-controlled key must not expose another user's file.
      await db
        .update(users)
        .set({ profile_image_key: original })
        .where(eq(users.id, "photo-other"));
      assert.equal((await photo("GET", other.access_token)).status, 404);
      assert.equal((await photo("DELETE", other.access_token)).status, 200);
      assert.ok(await bucket.head(original));
      const replacement = await photo("PUT", owner.access_token, png);
      assert.equal(replacement.status, 200);
      const next = (await replacement.json()).user.profile_image_key;
      assert.notEqual(next, original);
      assert.ok(await bucket.head(next));
      await deleted(original);
      const removed = await photo("DELETE", owner.access_token);
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).user.profile_image_key, null);
      await deleted(next);
      assert.equal((await photo("GET", owner.access_token)).status, 404);
      // Image changes do not invalidate an otherwise valid login.
      await request("/api/me", { token: owner.access_token });
    },
  );

  await t.test(
    "pending TOTP enrollment expires, limits guesses and is invalidated on password change",
    async () => {
      await seed("pending");
      const original = await login("pending");
      const start = await reauth(original.access_token);
      const setup = await request("/api/me/mfa/totp", {
        method: "POST",
        token: start.reauthentication_token,
        data: {},
        expected: 201,
      });
      const secret = decodeBase32(new URL(setup.provisioning_uri).searchParams.get("secret"));
      const grant = await reauth(original.access_token);
      const wrong = String((Number(code(secret)) + 100) % 1000000).padStart(6, "0");
      for (let attempt = 0; attempt < 5; attempt++)
        await request(`/api/me/mfa/totp/${setup.method_id}/verify`, {
          method: "POST",
          token: grant.reauthentication_token,
          data: { code: wrong },
          expected: 401,
        });
      await request(`/api/me/mfa/totp/${setup.method_id}/verify`, {
        method: "POST",
        token: grant.reauthentication_token,
        data: { code: code(secret) },
        expected: 401,
      });
      await db
        .update(userMfaMethods)
        .set({ created_at: timestamp() - 602, setup_expires_at: timestamp() - 2 })
        .where(eq(userMfaMethods.id, setup.method_id));
      const secondGrant = await reauth(original.access_token);
      await request(`/api/me/mfa/totp/${setup.method_id}/verify`, {
        method: "POST",
        token: secondGrant.reauthentication_token,
        data: { code: code(secret) },
        expected: 401,
      });
      const freshGrant = await reauth(original.access_token);
      const pending = await request("/api/me/mfa/totp", {
        method: "POST",
        token: freshGrant.reauthentication_token,
        data: {},
        expected: 201,
      });
      const passwordGrant = await reauth(original.access_token);
      const changed = await request("/api/me/password", {
        method: "PUT",
        token: passwordGrant.reauthentication_token,
        data: { new_password: PASSWORD },
      });
      assert.ok(
        (
          await db
            .select({ revoked_at: userMfaMethods.revoked_at })
            .from(userMfaMethods)
            .where(eq(userMfaMethods.id, pending.method_id))
            .get()
        ).revoked_at,
      );
      await request("/api/me", { token: changed.access_token });
    },
  );

  await t.test("parallel recovery use grants only one login", async () => {
    // Restore the previously enrolled test method; its ciphertext remains bound to this user and method.
    await db
      .update(userMfaMethods)
      .set({ revoked_at: null })
      .where(and(eq(userMfaMethods.user_id, "mfa"), isNotNull(userMfaMethods.verified_at)));
    const plaintext = randomBytes(16).toString("hex");
    await db
      .insert(userMfaRecoveryCodes)
      .values({ id: crypto.randomUUID(), user_id: "mfa", code_hash: await sha(plaintext) });
    const one = await login("mfa"),
      two = await login("mfa");
    const responses = await Promise.all(
      [one, two].map((challenge) =>
        mf.dispatchFetch("https://office.test/api/auth/mfa/recovery", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${challenge.challenge_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ recovery_code: plaintext }),
        }),
      ),
    );
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    const success = await responses.find((response) => response.status === 200).json();
    await request("/api/me", { token: success.access_token });
  });

  await t.test("TOTP enrollment cap prevents extra method and secret rows", async () => {
    await seed("mfa-cap");
    const initial = await login("mfa-cap");
    for (let index = 0; index < 6; index++) {
      const grant = await reauth(initial.access_token);
      await request("/api/me/mfa/totp", {
        method: "POST",
        token: grant.reauthentication_token,
        data: { name: `Device ${index}` },
        expected: index < 5 ? 201 : 409,
      });
    }
    assert.equal(
      (
        await db
          .select({ count: count() })
          .from(userMfaMethods)
          .where(eq(userMfaMethods.user_id, "mfa-cap"))
          .get()
      ).count,
      5,
    );
    assert.equal(
      (
        await db
          .select({ count: count() })
          .from(userMfaTotp)
          .innerJoin(userMfaMethods, eq(userMfaMethods.id, userMfaTotp.method_id))
          .where(eq(userMfaMethods.user_id, "mfa-cap"))
          .get()
      ).count,
      5,
    );
  });

  await t.test("disabled/deleted accounts and reassigned email remain isolated", async () => {
    await seed("deleted");
    const old = await login("deleted");
    await db.update(users).set({ deleted_at: timestamp() }).where(eq(users.id, "deleted"));
    await request("/api/me", { token: old.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: old.refresh_token, expected: 401 });
    await login("deleted", 401);
    await seed("replacement");
    await db
      .update(users)
      .set({ email_address: "deleted@office.test" })
      .where(eq(users.id, "replacement"));
    const replacement = await login("deleted");
    assert.equal(
      (await request("/api/me", { token: replacement.access_token })).user.id,
      "replacement",
    );
    await db.update(users).set({ disabled_at: timestamp() }).where(eq(users.id, "replacement"));
    await request("/api/me", { token: replacement.access_token, expected: 401 });
    await login("deleted", 401);
  });

  await t.test("concurrent refresh reuse revokes the session", async () => {
    await seed("concurrent");
    const session = await login("concurrent");
    const responses = await Promise.all(
      [1, 2].map(() =>
        mf.dispatchFetch("https://office.test/api/auth/refresh", {
          method: "POST",
          headers: { Authorization: `Bearer ${session.refresh_token}` },
        }),
      ),
    );
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    const success = await responses.find((response) => response.status === 200).json();
    await request("/api/me", { token: success.access_token, expected: 401 });
  });

  await t.test("expiry, session ownership, revoke-all and rate limits", async () => {
    await seed("sessions");
    await seed("stranger");
    const first = await login("sessions"),
      second = await login("sessions"),
      stranger = await login("stranger");
    await request(`/api/me/sessions/${stranger.session_id}`, {
      method: "DELETE",
      token: first.access_token,
      expected: 204,
    });
    await request("/api/me", { token: stranger.access_token });
    await db
      .update(userSessions)
      .set({ created_at: timestamp() - 2, expires_at: timestamp() - 1 })
      .where(eq(userSessions.id, second.session_id));
    await request("/api/me", { token: second.access_token, expected: 401 });
    await request("/api/auth/refresh", {
      method: "POST",
      token: second.refresh_token,
      expected: 401,
    });
    const pending = await reauth(first.access_token);
    await db
      .update(userAuthChallenges)
      .set({ created_at: timestamp() - 2, expires_at: timestamp() - 1 })
      .where(eq(userAuthChallenges.token_hash, await sha(pending.reauthentication_token)));
    await request("/api/me/password", {
      method: "PUT",
      token: pending.reauthentication_token,
      data: { new_password: PASSWORD },
      expected: 401,
    });
    await request("/api/me/sessions", {
      method: "DELETE",
      token: first.access_token,
      expected: 204,
    });
    await request("/api/me", { token: first.access_token, expected: 401 });
    await request("/api/me", { token: second.access_token, expected: 401 });
    // Allow a fixed-window boundary during the loop; within two windows at most 20 attempts are admitted.
    let blocked = false;
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await mf.dispatchFetch("https://office.test/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": `198.51.100.${attempt}`,
        },
        body: JSON.stringify({ email_address: "missing-rate@office.test", password: PASSWORD }),
      });
      assert.ok([401, 429].includes(response.status));
      if (response.status === 429) {
        assert.ok(Number(response.headers.get("retry-after")) > 0);
        blocked = true;
        break;
      }
    }
    assert.equal(blocked, true);
    await request("/api/auth/login", {
      method: "POST",
      data: {},
      headers: { "Content-Type": "text/plain" },
      expected: 415,
    });
    await request("/api/auth/login", {
      method: "POST",
      data: { padding: "x".repeat(70 * 1024) },
      expected: 413,
    });
    await request("/api/me", { expected: 401 });
    await request("/api/missing", { expected: 404 });
  });

  let administratorId, administratorToken, otherAdministratorId;
  const createRole = (key, permissions, token = administratorToken) =>
    request("/api/roles", {
      method: "POST",
      token,
      data: { key, label: key, permissions: permissionClosure(permissions) },
      expected: 201,
    });
  const assignRoles = async (id, roleIds, token = administratorToken, expected = 204) =>
    request(`/api/users/${id}/roles`, {
      method: "PUT",
      token,
      data: {
        role_ids: roleIds,
        version:
          (await db.select().from(users).where(eq(users.id, id)).get())?.role_assignment_version ??
          1,
      },
      expected,
    });

  await t.test(
    "authorization denies by default and only assigned roles grant permissions",
    async () => {
      await seed("rbac-user");
      const user = await login("rbac-user");
      assert.deepEqual(
        (await request("/api/me/permissions", { token: user.access_token })).permissions,
        [],
      );
      for (const path of ["/api/roles", "/api/permissions", "/api/users/rbac-user/roles"]) {
        await request(path, { expected: 401 });
        await request(path, { token: user.access_token, expected: 403 });
        await request(path, { token: user.refresh_token, expected: 401 });
      }
      await request("/api/roles", {
        method: "POST",
        token: user.access_token,
        data: { key: "denied", label: "Denied", permissions: [] },
        expected: 403,
      });
      await assignRoles("rbac-user", ["system-administrator"], user.access_token, 403);
      await request("/api/me/profile", { token: user.access_token });
      await request("/api/me/sessions", { token: user.access_token });
      await seed("administrator-one");
      await seed("administrator-two");
      administratorId = "administrator-one";
      otherAdministratorId = "administrator-two";
      await db
        .insert(userRoles)
        .values({ user_id: administratorId, role_id: "system-administrator" });
      administratorToken = (await login(administratorId)).access_token;
      const catalog = (await request("/api/permissions", { token: administratorToken })).permissions
        .map((entry) => entry.key)
        .sort();
      assert.deepEqual(
        (await request("/api/me/permissions", { token: administratorToken })).permissions,
        catalog,
      );
      assert.deepEqual(catalog, Object.keys(permissionCatalog).sort());
    },
  );

  await t.test(
    "role administration validates permissions, preserves system roles and rejects stale edits",
    async () => {
      const reader = (await createRole("role-reader", ["admin.roles.read"])).role;
      assert.equal(reader.is_system, false);
      assert.equal(reader.version, 1);
      assert.deepEqual(reader.permissions, permissionClosure(["admin.roles.read"]).sort());
      await request("/api/roles", {
        method: "POST",
        token: administratorToken,
        data: { key: "role-reader", label: "Duplicate", permissions: [] },
        expected: 409,
      });
      for (const permissions of [
        ["*"],
        ["invented.permission"],
        ["admin.roles.read", "admin.roles.read"],
        "admin.roles.read",
      ]) {
        await request("/api/roles", {
          method: "POST",
          token: administratorToken,
          data: { key: "invalid", label: "Invalid", permissions },
          expected: 400,
        });
      }
      await request("/api/roles", {
        method: "POST",
        token: administratorToken,
        data: { key: "invalid", label: "Invalid", permissions: [], is_system: true },
        expected: 400,
      });
      const edited = (
        await request(`/api/roles/${reader.id}`, {
          method: "PUT",
          token: administratorToken,
          data: {
            label: "Updated reader",
            description: "Reads roles",
            permissions: permissionClosure(["admin.roles.read"]),
            version: reader.version,
          },
        })
      ).role;
      assert.equal(edited.label, "Updated reader");
      assert.equal(edited.version, 2);
      await request(`/api/roles/${reader.id}`, {
        method: "PUT",
        token: administratorToken,
        data: { label: "Stale", permissions: [], version: 1 },
        expected: 409,
      });
      assert.deepEqual(
        (await request(`/api/roles/${reader.id}`, { token: administratorToken })).role.permissions,
        permissionClosure(["admin.roles.read"]).sort(),
      );
      for (const method of ["PUT", "DELETE"])
        await request("/api/roles/system-administrator", {
          method,
          token: administratorToken,
          data: method === "PUT" ? { label: "Changed", permissions: [], version: 1 } : undefined,
          expected: 403,
        });
      await request("/api/roles/missing", { token: administratorToken, expected: 404 });
      await assignRoles("rbac-user", ["missing"], administratorToken, 400);
      await assignRoles("missing-user", [], administratorToken, 404);
      await assignRoles("deleted", [], administratorToken, 404);
      assert.equal(
        (await request("/api/users/rbac-user/roles", { token: administratorToken })).roles.length,
        0,
      );
    },
  );

  await t.test(
    "multiple roles are additive and changes apply to the same JWT without ending the session",
    async () => {
      const reader = (await request("/api/roles", { token: administratorToken })).roles.find(
        (role) => role.key === "role-reader",
      );
      const inspector = (
        await createRole("user-role-inspector", ["admin.users.roles.read", "admin.roles.read"])
      ).role;
      const user = await login("rbac-user");
      await assignRoles("rbac-user", [reader.id, inspector.id]);
      assert.deepEqual(
        (await request("/api/me/permissions", { token: user.access_token })).permissions,
        permissionClosure(["admin.roles.read", "admin.users.roles.read"]).sort(),
      );
      const assigned = await request("/api/users/rbac-user/roles", { token: administratorToken });
      assert.equal(assigned.roles.length, 2);
      assert.ok(
        assigned.roles.every(
          (role) => role.assigned_by === administratorId && role.assigned_at > 0,
        ),
      );
      await request("/api/roles", { token: user.access_token });
      await request("/api/users/rbac-user/roles", { token: user.access_token });
      await assignRoles("rbac-user", [], user.access_token, 403);
      const changed = (
        await request(`/api/roles/${inspector.id}`, {
          method: "PUT",
          token: administratorToken,
          data: { label: inspector.label, permissions: [], version: inspector.version },
        })
      ).role;
      assert.deepEqual(changed.permissions, []);
      await request("/api/users/rbac-user/roles", { token: user.access_token, expected: 403 });
      assert.deepEqual(
        (await request("/api/me/permissions", { token: user.access_token })).permissions,
        permissionClosure(["admin.roles.read"]).sort(),
      );
      await request(`/api/roles/${reader.id}`, {
        method: "DELETE",
        token: administratorToken,
        expected: 204,
      });
      await request("/api/roles", { token: user.access_token, expected: 403 });
      assert.equal(
        (
          await db
            .select()
            .from(userRoles)
            .where(and(eq(userRoles.user_id, "rbac-user"), eq(userRoles.role_id, reader.id)))
        ).length,
        0,
      );
      await request("/api/me", { token: user.access_token });
      await assignRoles("rbac-user", []);
      assert.deepEqual(
        (await request("/api/me/permissions", { token: user.access_token })).permissions,
        [],
      );
    },
  );

  await t.test(
    "delegated managers cannot create or assign privileges they do not hold",
    async () => {
      await seed("role-manager");
      await seed("role-assigner");
      const managerRole = (
        await createRole("role-manager", [
          "admin.roles.create",
          "admin.roles.update",
          "admin.roles.delete",
        ])
      ).role;
      const assignerRole = (await createRole("role-assigner", ["admin.users.roles.assign"])).role;
      await assignRoles("role-manager", [managerRole.id]);
      await assignRoles("role-assigner", [assignerRole.id]);
      const manager = (await login("role-manager")).access_token,
        assigner = (await login("role-assigner")).access_token;
      await request("/api/roles", {
        method: "POST",
        token: manager,
        data: {
          key: "escalated",
          label: "Escalated",
          permissions: permissionClosure(["admin.users.roles.assign"]),
        },
        expected: 403,
      });
      await request(`/api/roles/${managerRole.id}`, {
        method: "PUT",
        token: manager,
        data: {
          label: "Escalated",
          permissions: permissionClosure(["admin.roles.update", "admin.users.roles.assign"]),
          version: 1,
        },
        expected: 403,
      });
      assert.equal((await db.select().from(roles).where(eq(roles.key, "escalated"))).length, 0);
      assert.deepEqual(
        (await request("/api/me/permissions", { token: manager })).permissions,
        managerRole.permissions,
      );
      await assignRoles("role-assigner", ["system-administrator"], assigner, 403);
      await assignRoles("rbac-user", [managerRole.id], assigner, 403);
      await assignRoles("rbac-user", [assignerRole.id], assigner);
      assert.deepEqual(
        (await request("/api/me/permissions", { token: (await login("rbac-user")).access_token }))
          .permissions,
        assignerRole.permissions,
      );
      await assignRoles("rbac-user", []);
    },
  );

  await t.test("roles stay attached to user IDs across email reuse", async () => {
    await seed("role-email");
    const role = (await createRole("email-reader", ["admin.roles.read"])).role;
    await assignRoles("role-email", [role.id]);
    const old = await login("role-email");
    await db.update(users).set({ deleted_at: timestamp() }).where(eq(users.id, "role-email"));
    await seed("role-email-new");
    await db
      .update(users)
      .set({ email_address: "role-email@office.test" })
      .where(eq(users.id, "role-email-new"));
    const replacement = await login("role-email");
    await request("/api/roles", { token: old.access_token, expected: 401 });
    await request("/api/roles", { token: replacement.access_token, expected: 403 });
    assert.deepEqual(
      (await request("/api/me/permissions", { token: replacement.access_token })).permissions,
      [],
    );
    assert.equal(
      (await db.select().from(userRoles).where(eq(userRoles.user_id, "role-email-new"))).length,
      0,
    );
  });

  await t.test(
    "concurrent role creation and updates cannot overwrite another administrator's change",
    async () => {
      const changes = await Promise.all(
        ["admin.roles.read", "admin.users.roles.read"].map((permission) =>
          mf.dispatchFetch("https://office.test/api/roles", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${administratorToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              key: "concurrent-role",
              label: "Concurrent role",
              permissions: permissionClosure([permission]),
            }),
          }),
        ),
      );
      assert.deepEqual(changes.map((response) => response.status).sort(), [201, 409]);
      const created = (await changes.find((response) => response.status === 201).json()).role;
      const edits = await Promise.all(
        ["admin.roles.read", "admin.users.roles.read"].map((permission) =>
          mf.dispatchFetch(`https://office.test/api/roles/${created.id}`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${administratorToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              label: permission,
              permissions: permissionClosure([permission]),
              version: created.version,
            }),
          }),
        ),
      );
      assert.deepEqual(edits.map((response) => response.status).sort(), [200, 409]);
      const winner = (await edits.find((response) => response.status === 200).json()).role;
      const stored = (await request(`/api/roles/${created.id}`, { token: administratorToken }))
        .role;
      assert.equal(stored.version, 2);
      assert.equal(stored.label, winner.label);
      assert.deepEqual(stored.permissions, winner.permissions);
    },
  );

  await t.test("paginated roles do not omit or duplicate entries", async () => {
    await db.batch(
      Array.from({ length: 51 }, (_, index) =>
        db.insert(roles).values({
          id: `page-${index}`,
          key: `page-${String(index).padStart(2, "0")}`,
          label: `Page ${index}`,
        }),
      ),
    );
    const first = await request("/api/roles", { token: administratorToken });
    assert.equal(first.roles.length, 50);
    assert.ok(first.next_cursor);
    const second = await request(`/api/roles?cursor=${first.next_cursor}`, {
      token: administratorToken,
    });
    assert.equal(second.next_cursor, null);
    const keys = [...first.roles, ...second.roles].map((role) => role.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(keys.length, (await db.select({ count: count() }).from(roles).get()).count);
    await assignRoles(
      "rbac-user",
      Array.from({ length: 50 }, (_, index) => `page-${index}`),
    );
    assert.equal(
      (await request("/api/users/rbac-user/roles", { token: administratorToken })).roles.length,
      50,
    );
    await assignRoles("rbac-user", []);
  });

  await t.test("the last eligible administrator survives concurrent removals", async () => {
    await assignRoles(administratorId, [], administratorToken, 409);
    assert.deepEqual(
      (await request("/api/me/permissions", { token: administratorToken })).permissions,
      Object.keys(permissionCatalog).sort(),
    );
    await assignRoles(otherAdministratorId, ["system-administrator"]);
    const otherToken = (await login(otherAdministratorId)).access_token;
    const attempts = await Promise.all(
      [
        [administratorId, administratorToken],
        [otherAdministratorId, otherToken],
      ].map(async ([id, token]) =>
        mf.dispatchFetch(`https://office.test/api/users/${id}/roles`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            role_ids: [],
            version: (await db.select().from(users).where(eq(users.id, id)).get())
              .role_assignment_version,
          }),
        }),
      ),
    );
    assert.deepEqual(attempts.map((response) => response.status).sort(), [204, 409]);
    const remaining = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.role_id, "system-administrator"));
    assert.equal(remaining.length, 1);
    const remainingId = remaining[0].user_id,
      remainingToken = remainingId === administratorId ? administratorToken : otherToken;
    const removedId = remainingId === administratorId ? otherAdministratorId : administratorId;
    await assignRoles(removedId, ["system-administrator"], remainingToken);
    await db.update(users).set({ disabled_at: timestamp() }).where(eq(users.id, removedId));
    await assignRoles(remainingId, [], remainingToken, 409);
    await request("/api/roles", { token: remainingToken });
  });
});
