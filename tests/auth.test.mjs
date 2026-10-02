import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { scryptSync, createHmac, randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";

const PASSWORD = "correct horse battery staple";
const hash = (value = PASSWORD) => {
  const salt = randomBytes(16);
  return `scrypt$16384$8$5$${salt.toString("base64url")}$${scryptSync(value, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 24 * 1024 * 1024 }).toString("base64url")}`;
};
const sha = async (value) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
const timestamp = () => Math.floor(Date.now() / 1000);
function decodeBase32(value) {
  let bits = 0, accumulator = 0; const output = [];
  for (const char of value) {
    accumulator = (accumulator << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); bits += 5;
    if (bits >= 8) { output.push((accumulator >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}
function code(secret, step = Math.floor(timestamp() / 30)) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest(), offset = mac.at(-1) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}

test("Bearer account API in the Workers runtime", async (t) => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const signing = { active_kid: "test", keys: [{ ...await exportJWK(privateKey), kid: "test" }] };
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [{ name: "officeflare", modules: true, scriptPath: "dist/index.js", compatibilityDate: "2026-09-29",
    d1Databases: { DB: "auth-tests" }, bindings: {
      AUTH_SIGNING_KEYS: JSON.stringify(signing), MFA_ENCRYPTION_KEYS: JSON.stringify({ active_version: 1, keys: { 1: randomBytes(32).toString("base64url") } }),
      AUTH_ISSUER: "officeflare", AUTH_AUDIENCE: "officeflare-api",
    } }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    let sql = "", trigger = false;
    for (const line of (await readFile(`migrations/${file}`, "utf8")).split("\n")) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      sql += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
        await db.prepare(sql).run(); sql = ""; trigger = false;
      }
    }
    assert.equal(sql.trim(), "");
  }
  const seed = async (id, extra = {}) => {
    await db.prepare("INSERT INTO users(id, email_address, password_hash, password_reset_required) VALUES (?, ?, ?, ?)")
      .bind(id, `${id}@office.test`, extra.hash ?? hash(), extra.reset ? 1 : 0).run();
  };
  let ip = 0;
  const request = async (path, { method = "GET", token, data, expected = 200, headers = {} } = {}) => {
    const response = await mf.dispatchFetch(`https://office.test${path}`, { method,
      headers: { "cf-connecting-ip": `192.0.2.${++ip % 250}`, ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data) });
    assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`);
    assert.equal(response.headers.get("set-cookie"), null);
    if (path.startsWith("/api") && expected !== 413) assert.equal(response.headers.get("cache-control"), "no-store");
    return expected === 204 ? null : response.json();
  };
  const login = (id, expected = 200) => request("/api/auth/login", { method: "POST", data: { email_address: `${id}@office.test`, password: PASSWORD }, expected });
  const reauth = (access) => request("/api/auth/reauthenticate", { method: "POST", token: access, data: { password: PASSWORD } });
  const verify = (challenge, methodId, supplied) => request("/api/auth/mfa/verify", {
    method: "POST", token: challenge, data: { method_id: methodId, code: supplied },
  });

  await t.test("login, token purpose, JWT validation, rotation and logout", async () => {
    await seed("basic");
    await request("/api/auth/login", { method: "POST", data: { email_address: "missing@office.test", password: PASSWORD }, expected: 401 });
    await request("/api/auth/login", { method: "POST", data: { email_address: "basic@office.test", password: "wrong password" }, expected: 401 });
    const first = await login("basic");
    assert.equal(first.token_type, "Bearer"); assert.ok(first.access_token); assert.ok(first.refresh_token);
    const user = await request("/api/me", { token: first.access_token });
    assert.equal(user.user.id, "basic"); assert.equal(user.user.password_hash, undefined);
    await request("/api/me", { token: first.refresh_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: first.access_token, expected: 401 });
    const pending = await reauth(first.access_token);
    await request("/api/me", { token: pending.reauthentication_token, expected: 401 });
    const tokens = await request("/api/auth/refresh", { method: "POST", token: first.refresh_token });
    assert.notEqual(tokens.refresh_token, first.refresh_token);
    await request("/api/auth/refresh", { method: "POST", token: first.refresh_token, expected: 401 });
    await request("/api/me", { token: tokens.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: tokens.refresh_token, expected: 401 });
    const second = await login("basic");
    for (const overrides of [{ aud: "wrong" }, { iss: "wrong" }, { exp: timestamp() - 1 }, { ver: 999 }, { sid: "missing" }]) {
      const jwt = await new SignJWT({ sub: "basic", sid: second.session_id, ver: 1, iat: timestamp(), exp: timestamp() + 900,
        iss: "officeflare", aud: "officeflare-api", jti: crypto.randomUUID(), ...overrides })
        .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "test" }).sign(privateKey);
      await request("/api/me", { token: jwt, expected: 401 });
    }
    await request("/api/me", { token: second.access_token.slice(0, -8) + "aaaaaaaa", expected: 401 });
    await request("/api/auth/logout", { method: "POST", token: second.access_token, expected: 204 });
    await request("/api/me", { token: second.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: second.refresh_token, expected: 401 });
  });

  await t.test("forced password reset is restricted and one-use", async () => {
    await seed("reset", { reset: true });
    const reset = await login("reset");
    assert.equal(reset.next, "password_reset"); assert.equal(reset.access_token, undefined);
    await request("/api/me", { token: reset.challenge_token, expected: 401 });
    await request("/api/me/mfa/totp", { method: "POST", token: reset.challenge_token, data: {}, expected: 401 });
    await request("/api/me/password", { method: "PUT", token: reset.challenge_token, data: { new_password: "short" }, expected: 400 });
    const changed = await request("/api/me/password", { method: "PUT", token: reset.challenge_token, data: { new_password: "a very long replacement password" } });
    await request("/api/me", { token: changed.access_token });
    await request("/api/me/password", { method: "PUT", token: reset.challenge_token, data: { new_password: PASSWORD }, expected: 401 });
    await login("reset", 401);
    const result = await db.prepare("SELECT password_hash, password_reset_required, password_changed_at FROM users WHERE id = 'reset'").first();
    assert.match(result.password_hash, /^scrypt\$/); assert.equal(result.password_reset_required, 0); assert.ok(result.password_changed_at);
  });

  await t.test("password changes invalidate every old session and challenge", async () => {
    await seed("password");
    const first = await login("password"), second = await login("password");
    const grant = await reauth(first.access_token), other = await reauth(second.access_token);
    await request("/api/me/password", { method: "PUT", token: first.access_token, data: { new_password: PASSWORD }, expected: 401 });
    const changed = await request("/api/me/password", { method: "PUT", token: grant.reauthentication_token, data: { new_password: "replacement password 12345" } });
    await request("/api/me", { token: changed.access_token });
    for (const tokens of [first, second]) {
      await request("/api/me", { token: tokens.access_token, expected: 401 });
      await request("/api/auth/refresh", { method: "POST", token: tokens.refresh_token, expected: 401 });
    }
    await request("/api/me/password", { method: "PUT", token: other.reauthentication_token, data: { new_password: PASSWORD }, expected: 401 });
  });

  await t.test("concurrent password changes can consume a grant only once", async () => {
    await seed("password-race");
    const original = await login("password-race"), grant = await reauth(original.access_token);
    const responses = await Promise.all([1, 2].map((number) => mf.dispatchFetch("https://office.test/api/me/password", {
      method: "PUT", headers: { Authorization: `Bearer ${grant.reauthentication_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ new_password: `a valid replacement password ${number}` }),
    })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    const success = await responses.find((response) => response.status === 200).json();
    await request("/api/me", { token: success.access_token });
    assert.equal((await db.prepare("SELECT auth_version FROM users WHERE id = 'password-race'").first()).auth_version, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = 'password-race' AND revoked_at IS NULL").first()).count, 1);
  });

  await t.test("TOTP enrollment, replay, recovery, revocation and forced reset with MFA", async () => {
    await seed("mfa");
    const initial = await login("mfa");
    const setupGrant = await reauth(initial.access_token);
    const setup = await request("/api/me/mfa/totp", { method: "POST", token: setupGrant.reauthentication_token, data: { name: "Phone" }, expected: 201 });
    const secret = decodeBase32(new URL(setup.provisioning_uri).searchParams.get("secret"));
    const stored = await db.prepare("SELECT secret_ciphertext, secret_nonce FROM user_mfa_totp WHERE method_id = ?").bind(setup.method_id).first();
    assert.notDeepEqual(Buffer.from(stored.secret_ciphertext).subarray(0, 20), secret); assert.equal(stored.secret_nonce.length, 12);
    const activationGrant = await reauth(initial.access_token), step = Math.floor(timestamp() / 30);
    const activated = await request(`/api/me/mfa/totp/${setup.method_id}/verify`, { method: "POST", token: activationGrant.reauthentication_token, data: { code: code(secret, step) } });
    await request("/api/me", { token: initial.access_token, expected: 401 });
    const challenge = await login("mfa"); assert.equal(challenge.next, "mfa"); assert.equal(challenge.access_token, undefined);
    await request("/api/me", { token: challenge.challenge_token, expected: 401 });
    await request("/api/auth/mfa/verify", { method: "POST", token: challenge.challenge_token, data: { method_id: setup.method_id, code: code(secret, step) }, expected: 401 });
    const reauthChallenge = await reauth(activated.access_token);
    const verified = await verify(reauthChallenge.challenge_token, setup.method_id, code(secret, step + 1));
    const generated = await request("/api/me/mfa/recovery-codes", { method: "POST", token: verified.reauthentication_token, expected: 201 });
    assert.equal(generated.recovery_codes.length, 10);
    await request("/api/me", { token: activated.access_token, expected: 401 });
    const codes = [...generated.recovery_codes];
    const recoveredLogin = await login("mfa");
    const recovered = await request("/api/auth/mfa/recovery", { method: "POST", token: recoveredLogin.challenge_token, data: { recovery_code: codes[0] } });
    await request("/api/auth/mfa/recovery", { method: "POST", token: recoveredLogin.challenge_token, data: { recovery_code: codes[1] }, expected: 401 });
    const another = await login("mfa");
    await request("/api/auth/mfa/recovery", { method: "POST", token: another.challenge_token, data: { recovery_code: codes[0] }, expected: 401 });
    const remaining = await request("/api/me/mfa/recovery-codes", { token: recovered.access_token }); assert.equal(remaining.remaining, 9);
    await db.prepare("UPDATE users SET password_reset_required = 1 WHERE id = 'mfa'").run();
    await request("/api/me", { token: recovered.access_token, expected: 401 });
    const resetChallenge = await login("mfa"); assert.equal(resetChallenge.next, "mfa");
    const reset = await request("/api/auth/mfa/recovery", { method: "POST", token: resetChallenge.challenge_token, data: { recovery_code: codes[1] } });
    assert.equal(reset.next, "password_reset");
    const changed = await request("/api/me/password", { method: "PUT", token: reset.challenge_token, data: { new_password: PASSWORD } });
    const removalChallenge = await reauth(changed.access_token);
    const removalGrant = await request("/api/auth/mfa/recovery", { method: "POST", token: removalChallenge.challenge_token, data: { recovery_code: codes[2] } });
    const removed = await request(`/api/me/mfa/methods/${setup.method_id}`, { method: "DELETE", token: removalGrant.reauthentication_token });
    await request("/api/me", { token: removed.access_token });
    assert.equal((await login("mfa")).next, undefined);
    assert.equal((await request("/api/me/mfa/recovery-codes", { token: removed.access_token })).remaining, 0);
  });

  await t.test("profile field policies, types, required values and no credential leakage", async () => {
    await seed("profile");
    for (const [key, type, editable, visibility, required, options] of [
      ["department", "select", "user", "organization", 1, '[{"value":"engineering","label":{"default":"Engineering"}}]'],
      ["title", "text", "admin", "private", 0, null], ["internal", "text", "user", "admin", 0, null],
      ["birthday", "date", "user", "private", 0, null], ["website", "url", "user", "private", 0, null],
    ]) await db.prepare("INSERT INTO user_profile_fields(id, key, label, value_type, editable_by, visibility, required, options_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(key, key, JSON.stringify({ default: key, en: key }), type, editable, visibility, required, options).run();
    const loginResult = await login("profile"), token = loginResult.access_token;
    const definitions = await request("/api/me/profile-fields", { token }); assert.equal(definitions.fields.some((field) => field.key === "internal"), false);
    await request("/api/me/profile", { method: "PATCH", token, data: { fields: { title: "Admin" } }, expected: 403 });
    await request("/api/me/profile", { method: "PATCH", token, data: { fields: { internal: "Hidden" } }, expected: 400 });
    await request("/api/me/profile", { method: "PATCH", token, data: { email_address: "hacked@test" }, expected: 400 });
    await request("/api/me/profile", { method: "PATCH", token, data: { display_name: "Jane" }, expected: 400 });
    await request("/api/me/profile", { method: "PATCH", token, data: { fields: { department: "bad" } }, expected: 400 });
    await request("/api/me/profile", { method: "PATCH", token, data: { fields: { department: "engineering", birthday: "2026-02-30" } }, expected: 400 });
    await request("/api/me/profile", { method: "PATCH", token, data: { fields: { department: "engineering", website: "javascript:alert(1)" } }, expected: 400 });
    await request("/api/me/profile", { method: "PATCH", token, data: { display_name: "Jane", fields: { department: "engineering", birthday: "2000-02-29", website: "https://example.com" } } });
    const result = await request("/api/me/profile", { token }); assert.equal(result.display_name, "Jane"); assert.equal(result.fields.department, "engineering");
    await request("/api/me/profile", { method: "PATCH", token, data: { fields: { department: null } }, expected: 400 });
    await request("/api/me/profile", { method: "PATCH", token, data: { fields: { birthday: null } } });
    assert.equal((await request("/api/me/profile", { token })).fields.birthday, undefined);
    for (let index = 0; index < 25; index++) await db.prepare("INSERT INTO user_profile_fields(id, key, label, value_type, editable_by) VALUES (?, ?, ?, 'text', 'user')")
      .bind(`extra-${index}`, `extra-${index}`, JSON.stringify({ default: `extra-${index}` })).run();
    await request("/api/me/profile", { method: "PATCH", token, data: { fields: { "extra-24": "Many fields" } } });
  });

  await t.test("pending TOTP enrollment expires, limits guesses and is invalidated on password change", async () => {
    await seed("pending");
    const original = await login("pending");
    const start = await reauth(original.access_token);
    const setup = await request("/api/me/mfa/totp", { method: "POST", token: start.reauthentication_token, data: {}, expected: 201 });
    const secret = decodeBase32(new URL(setup.provisioning_uri).searchParams.get("secret"));
    const grant = await reauth(original.access_token);
    const wrong = String((Number(code(secret)) + 100) % 1000000).padStart(6, "0");
    for (let attempt = 0; attempt < 5; attempt++) await request(`/api/me/mfa/totp/${setup.method_id}/verify`, {
      method: "POST", token: grant.reauthentication_token, data: { code: wrong }, expected: 401,
    });
    await request(`/api/me/mfa/totp/${setup.method_id}/verify`, {
      method: "POST", token: grant.reauthentication_token, data: { code: code(secret) }, expected: 401,
    });
    await db.prepare("UPDATE user_mfa_methods SET created_at = ?, setup_expires_at = ? WHERE id = ?")
      .bind(timestamp() - 602, timestamp() - 2, setup.method_id).run();
    const secondGrant = await reauth(original.access_token);
    await request(`/api/me/mfa/totp/${setup.method_id}/verify`, {
      method: "POST", token: secondGrant.reauthentication_token, data: { code: code(secret) }, expected: 401,
    });
    const freshGrant = await reauth(original.access_token);
    const pending = await request("/api/me/mfa/totp", { method: "POST", token: freshGrant.reauthentication_token, data: {}, expected: 201 });
    const passwordGrant = await reauth(original.access_token);
    const changed = await request("/api/me/password", { method: "PUT", token: passwordGrant.reauthentication_token, data: { new_password: PASSWORD } });
    assert.ok((await db.prepare("SELECT revoked_at FROM user_mfa_methods WHERE id = ?").bind(pending.method_id).first()).revoked_at);
    await request("/api/me", { token: changed.access_token });
  });

  await t.test("parallel recovery use grants only one login", async () => {
    // Restore the previously enrolled test method; its ciphertext remains bound to this user and method.
    await db.prepare("UPDATE user_mfa_methods SET revoked_at = NULL WHERE user_id = 'mfa' AND verified_at IS NOT NULL").run();
    const plaintext = randomBytes(16).toString("hex");
    await db.prepare("INSERT INTO user_mfa_recovery_codes(id, user_id, code_hash) VALUES (?, 'mfa', ?)")
      .bind(crypto.randomUUID(), await sha(plaintext)).run();
    const one = await login("mfa"), two = await login("mfa");
    const responses = await Promise.all([one, two].map((challenge) => mf.dispatchFetch("https://office.test/api/auth/mfa/recovery", {
      method: "POST", headers: { Authorization: `Bearer ${challenge.challenge_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recovery_code: plaintext }),
    })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    const success = await responses.find((response) => response.status === 200).json();
    await request("/api/me", { token: success.access_token });
  });

  await t.test("disabled/deleted accounts and reassigned email remain isolated", async () => {
    await seed("deleted");
    const old = await login("deleted");
    await db.prepare("UPDATE users SET deleted_at = ? WHERE id = 'deleted'").bind(timestamp()).run();
    await request("/api/me", { token: old.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: old.refresh_token, expected: 401 });
    await login("deleted", 401);
    await seed("replacement");
    await db.prepare("UPDATE users SET email_address = 'deleted@office.test' WHERE id = 'replacement'").run();
    const replacement = await login("deleted");
    assert.equal((await request("/api/me", { token: replacement.access_token })).user.id, "replacement");
    await db.prepare("UPDATE users SET disabled_at = ? WHERE id = 'replacement'").bind(timestamp()).run();
    await request("/api/me", { token: replacement.access_token, expected: 401 }); await login("deleted", 401);
  });

  await t.test("concurrent refresh reuse revokes the session", async () => {
    await seed("concurrent"); const session = await login("concurrent");
    const responses = await Promise.all([1, 2].map(() => mf.dispatchFetch("https://office.test/api/auth/refresh", { method: "POST", headers: { Authorization: `Bearer ${session.refresh_token}` } })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    const success = await responses.find((response) => response.status === 200).json();
    await request("/api/me", { token: success.access_token, expected: 401 });
  });

  await t.test("expiry, session ownership, revoke-all and rate limits", async () => {
    await seed("sessions"); await seed("stranger");
    const first = await login("sessions"), second = await login("sessions"), stranger = await login("stranger");
    await request(`/api/me/sessions/${stranger.session_id}`, { method: "DELETE", token: first.access_token, expected: 204 });
    await request("/api/me", { token: stranger.access_token });
    await db.prepare("UPDATE user_sessions SET created_at = ?, expires_at = ? WHERE id = ?").bind(timestamp() - 2, timestamp() - 1, second.session_id).run();
    await request("/api/me", { token: second.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: second.refresh_token, expected: 401 });
    const pending = await reauth(first.access_token);
    await db.prepare("UPDATE user_auth_challenges SET created_at = ?, expires_at = ? WHERE token_hash = ?")
      .bind(timestamp() - 2, timestamp() - 1, await sha(pending.reauthentication_token)).run();
    await request("/api/me/password", { method: "PUT", token: pending.reauthentication_token, data: { new_password: PASSWORD }, expected: 401 });
    await request("/api/me/sessions", { method: "DELETE", token: first.access_token, expected: 204 });
    await request("/api/me", { token: first.access_token, expected: 401 }); await request("/api/me", { token: second.access_token, expected: 401 });
    // Allow a fixed-window boundary during the loop; within two windows at most 20 attempts are admitted.
    let blocked = false;
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await mf.dispatchFetch("https://office.test/api/auth/login", { method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": `198.51.100.${attempt}` },
        body: JSON.stringify({ email_address: "missing-rate@office.test", password: PASSWORD }) });
      assert.ok([401, 429].includes(response.status));
      if (response.status === 429) { assert.ok(Number(response.headers.get("retry-after")) > 0); blocked = true; break; }
    }
    assert.equal(blocked, true);
    await request("/api/auth/login", { method: "POST", data: {}, headers: { "Content-Type": "text/plain" }, expected: 415 });
    await request("/api/auth/login", { method: "POST", data: { padding: "x".repeat(70 * 1024) }, expected: 413 });
    await request("/api/me", { expected: 401 });
    await request("/api/missing", { expected: 404 });
  });
});
