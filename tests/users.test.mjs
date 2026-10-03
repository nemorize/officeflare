import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { and, count, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../src/db/schema.ts";
import { hashPassword, verifyPassword } from "../src/auth/password.ts";
import { permissionCatalog } from "../src/authorization/permissions.ts";

const { users, userRoles, roles, rolePermissions, userSessions, userAuthChallenges, userMfaMethods, userMfaRecoveryCodes } = schema;
const PASSWORD = "a password for user management tests";
const passwordHash = await hashPassword(PASSWORD);

async function fixture(t, administratorCount = 1) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [{
    name: "officeflare", modules: true, scriptPath: "dist/index.js", compatibilityDate: "2026-09-29",
    d1Databases: { DB: "user-management-tests" }, bindings: {
      AUTH_SIGNING_KEYS: JSON.stringify({ active_kid: "test", keys: [{ ...await exportJWK(privateKey), kid: "test" }] }),
      MFA_ENCRYPTION_KEYS: JSON.stringify({ active_version: 1, keys: { 1: randomBytes(32).toString("base64url") } }),
      AUTH_ISSUER: "officeflare", AUTH_AUDIENCE: "officeflare-api",
    },
  }] }));
  t.after(() => mf.dispose());
  const binding = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    let statement = "", trigger = false;
    for (const line of (await readFile(`migrations/${file}`, "utf8")).split("\n")) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      statement += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
        await binding.prepare(statement).run(); statement = ""; trigger = false;
      }
    }
    assert.equal(statement.trim(), "");
  }
  const db = drizzle(binding, { schema });
  const seed = async (id) => db.insert(users).values({ id, email_address: `${id}@office.test`, password_hash: passwordHash });
  let ip = 0;
  const raw = (path, { method = "GET", token, data } = {}) => mf.dispatchFetch(`https://office.test${path}`, { method,
    headers: { "cf-connecting-ip": `192.0.2.${++ip % 250}`, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const request = async (path, { expected = 200, ...options } = {}) => {
    const response = await raw(path, options);
    assert.equal(response.status, expected, `${options.method ?? "GET"} ${path}: ${await response.clone().text()}`);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return expected === 204 ? null : response.json();
  };
  const login = (email, password = PASSWORD, expected = 200) => request("/api/auth/login", {
    method: "POST", data: { email_address: email, password }, expected,
  });
  const administrators = [];
  for (let index = 0; index < administratorCount; index++) {
    const id = `administrator-${index}`;
    await seed(id);
    await db.insert(userRoles).values({ user_id: id, role_id: "system-administrator" });
    administrators.push({ id, token: (await login(`${id}@office.test`)).access_token });
  }
  const token = administrators[0].token;
  const create = async (email, extra = {}) => (await request("/api/users", {
    method: "POST", token, data: { email_address: email, password: PASSWORD, password_reset_required: false, ...extra }, expected: 201,
  })).user;
  const edit = (id, data, expected = 200, actor = token) => request(`/api/users/${id}`, { method: "PATCH", token: actor, data, expected });
  return { db, token, seed, raw, request, login, create, edit, administrators };
}

test("user management in the Workers runtime", async (t) => {
  const { db, token, seed, raw, request, login, create, edit, administrators } = await fixture(t);
  const administratorId = administrators[0].id;
  await seed("regular");
  const regular = await login("regular@office.test");

  await t.test("each action requires its own permission and an access Bearer token", async () => {
    const permissions = (await request("/api/me/permissions", { token })).permissions;
    assert.deepEqual(permissions, Object.keys(permissionCatalog).sort());
    for (const [path, method, data] of [
      ["/api/users", "GET"], ["/api/users/regular", "GET"],
      ["/api/users", "POST", { email_address: "denied@office.test", password: PASSWORD }],
      ["/api/users/regular", "PATCH", { display_name: "Denied" }], ["/api/users/regular", "DELETE"],
    ]) {
      await request(path, { method, data, expected: 401 });
      await request(path, { method, data, token: regular.access_token, expected: 403 });
      await request(path, { method, data, token: regular.refresh_token, expected: 401 });
    }
    await request("/api/users/missing", { token, expected: 404 });
    await edit("missing", { display_name: "Missing" }, 404);
    await request("/api/users/missing", { method: "DELETE", token, expected: 404 });
  });

  await t.test("creation normalizes email, hashes passwords and requires first-login password change", async () => {
    const response = await raw("/api/users", { method: "POST", token, data: {
      email_address: " NEW@OFFICE.TEST ", password: PASSWORD, display_name: " New User ", profile_image_key: "profiles/new.png",
    } });
    assert.equal(response.status, 201);
    const { user } = await response.json();
    assert.equal(response.headers.get("location"), `/api/users/${user.id}`);
    assert.equal(user.email_address, "new@office.test"); assert.equal(user.display_name, "New User");
    assert.equal(user.profile_image_key, "profiles/new.png"); assert.equal(user.password_reset_required, true);
    assert.equal(user.password_hash, undefined); assert.equal(user.auth_version, undefined);
    const stored = await db.select().from(users).where(eq(users.id, user.id)).get();
    assert.equal(await verifyPassword(PASSWORD, stored.password_hash), true);
    assert.equal((await db.select().from(userRoles).where(eq(userRoles.user_id, user.id))).length, 0);
    const pending = await login(user.email_address);
    assert.equal(pending.next, "password_reset"); assert.equal(pending.access_token, undefined);
    const changed = await request("/api/me/password", { method: "PUT", token: pending.challenge_token,
      data: { new_password: "the new user's own replacement password" } });
    assert.deepEqual((await request("/api/me/permissions", { token: changed.access_token })).permissions, []);
    const listed = (await request(`/api/users/${user.id}`, { token })).user;
    assert.equal(listed.password_reset_required, false); assert.ok(listed.password_changed_at);
  });

  await t.test("input validation rejects privilege fields, bad addresses and invalid account values", async () => {
    for (const data of [
      {}, { email_address: "invalid", password: PASSWORD }, { email_address: "a..b@office.test", password: PASSWORD },
      { email_address: "a@-office.test", password: PASSWORD }, { email_address: "a@office..test", password: PASSWORD },
      { email_address: "a@office.test", password: "short" },
      { email_address: "a@office.test", password: PASSWORD, role_ids: ["system-administrator"] },
      { email_address: "a@office.test", password: PASSWORD, auth_version: 100 },
      { email_address: "a@office.test", password: PASSWORD, disabled: 1 },
      { email_address: "a@office.test", password: PASSWORD, password_reset_required: "false" },
      { email_address: "a@office.test", password: PASSWORD, display_name: " " },
    ]) await request("/api/users", { method: "POST", token, data, expected: 400 });
    for (const data of [{}, { deleted_at: 1 }, { password_hash: "plain" }, { disabled: null },
      { password_reset_required: 0 }, { email_address: "bad address@office.test" }, { password: "short" },
      { profile_image_key: "x".repeat(1025) }, { display_name: "x".repeat(201) }]) await edit("regular", data, 400);
  });

  await t.test("case-insensitive duplicates and concurrent address assignments return conflicts", async () => {
    await request("/api/users", { method: "POST", token, data: { email_address: "REGULAR@office.test", password: PASSWORD }, expected: 409 });
    const duplicate = await create("duplicate@office.test");
    await edit(duplicate.id, { email_address: "Regular@Office.Test" }, 409);
    assert.equal((await request(`/api/users/${duplicate.id}`, { token })).user.email_address, duplicate.email_address);
    const creates = await Promise.all(["RACE@office.test", "race@office.test"].map((email_address) => raw("/api/users", {
      method: "POST", token, data: { email_address, password: PASSWORD },
    })));
    assert.deepEqual(creates.map((response) => response.status).sort(), [201, 409]);
    const one = await create("rename-one@office.test"), two = await create("rename-two@office.test");
    const renames = await Promise.all([one, two].map((user) => raw(`/api/users/${user.id}`, {
      method: "PATCH", token, data: { email_address: "renamed@office.test" },
    })));
    assert.deepEqual(renames.map((response) => response.status).sort(), [200, 409]);
  });

  await t.test("profile-only updates preserve sessions while email changes revoke previous credentials", async () => {
    const user = await create("editable@office.test"), old = await login(user.email_address);
    const grant = await request("/api/auth/reauthenticate", { method: "POST", token: old.access_token, data: { password: PASSWORD } });
    const changed = (await edit(user.id, { display_name: "Edited", profile_image_key: "profiles/edited.png" })).user;
    assert.equal(changed.display_name, "Edited"); assert.equal(changed.profile_image_key, "profiles/edited.png");
    await request("/api/me", { token: old.access_token });
    await edit(user.id, { display_name: null, profile_image_key: null, email_address: "EDITED@OFFICE.TEST" });
    await request("/api/me", { token: old.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: old.refresh_token, expected: 401 });
    await request("/api/me/password", { method: "PUT", token: grant.reauthentication_token, data: { new_password: PASSWORD }, expected: 401 });
    await login(user.email_address, PASSWORD, 401);
    await login("edited@office.test");
  });

  await t.test("administrator password resets invalidate sessions and outstanding grants", async () => {
    const user = await create("resettable@office.test"), old = await login(user.email_address);
    const grant = await request("/api/auth/reauthenticate", { method: "POST", token: old.access_token, data: { password: PASSWORD } });
    const replacement = "a temporary replacement from the administrator";
    const changed = (await edit(user.id, { password: replacement })).user;
    assert.equal(changed.password_reset_required, true); assert.equal(changed.password_hash, undefined);
    await request("/api/me", { token: old.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: old.refresh_token, expected: 401 });
    await request("/api/me/password", { method: "PUT", token: grant.reauthentication_token, data: { new_password: PASSWORD }, expected: 401 });
    await login(user.email_address, PASSWORD, 401);
    const pending = await login(user.email_address, replacement);
    assert.equal(pending.next, "password_reset");
    await edit(user.id, { password_reset_required: false });
    await request("/api/me/password", { method: "PUT", token: pending.challenge_token, data: { new_password: PASSWORD }, expected: 401 });
    assert.ok((await login(user.email_address, replacement)).access_token);
  });

  await t.test("disabling and reenabling users never restores old tokens or pending MFA enrollment", async () => {
    const user = await create("disabled@office.test"), old = await login(user.email_address);
    const grant = await request("/api/auth/reauthenticate", { method: "POST", token: old.access_token, data: { password: PASSWORD } });
    await db.insert(userMfaMethods).values({ id: "pending-disable", user_id: user.id, type: "totp", setup_expires_at: Math.floor(Date.now() / 1000) + 600 });
    const disabled = (await edit(user.id, { disabled: true })).user;
    assert.ok(disabled.disabled_at);
    await login(user.email_address, PASSWORD, 401);
    await request("/api/me", { token: old.access_token, expected: 401 });
    await edit(user.id, { disabled: false });
    await request("/api/me", { token: old.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: old.refresh_token, expected: 401 });
    await request("/api/me/password", { method: "PUT", token: grant.reauthentication_token, data: { new_password: PASSWORD }, expected: 401 });
    assert.ok((await login(user.email_address)).access_token);
    assert.ok((await db.select().from(userMfaMethods).where(eq(userMfaMethods.id, "pending-disable")).get()).revoked_at);
  });

  await t.test("soft deletion revokes credentials and allows email reuse without inheriting roles or MFA", async () => {
    const user = await create("deleted@office.test"), old = await login(user.email_address);
    await db.insert(roles).values({ id: "deleted-reader", key: "deleted-reader", label: "Deleted reader" });
    await db.insert(rolePermissions).values({ role_id: "deleted-reader", permission_key: "users.read" });
    await db.insert(userRoles).values({ user_id: user.id, role_id: "deleted-reader" });
    await db.insert(userMfaMethods).values({ id: "deleted-mfa", user_id: user.id, type: "totp", created_at: 1, verified_at: 2 });
    await db.insert(userMfaRecoveryCodes).values({ id: "deleted-recovery", user_id: user.id, code_hash: "test-only-recovery-hash" });
    await request(`/api/users/${user.id}`, { method: "DELETE", token, expected: 204 });
    const stored = await db.select().from(users).where(eq(users.id, user.id)).get();
    assert.ok(stored.deleted_at);
    await request(`/api/users/${user.id}`, { token, expected: 404 });
    await edit(user.id, { display_name: "Cannot restore" }, 404);
    await request(`/api/users/${user.id}`, { method: "DELETE", token, expected: 404 });
    await request("/api/me", { token: old.access_token, expected: 401 });
    await request("/api/auth/refresh", { method: "POST", token: old.refresh_token, expected: 401 });
    assert.ok((await db.select().from(userSessions).where(eq(userSessions.user_id, user.id)).get()).revoked_at);
    assert.ok((await db.select().from(userMfaMethods).where(eq(userMfaMethods.user_id, user.id)).get()).revoked_at);
    assert.ok((await db.select().from(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.user_id, user.id)).get()).revoked_at);
    const replacement = await create(user.email_address);
    assert.notEqual(replacement.id, user.id);
    const fresh = await login(replacement.email_address);
    assert.deepEqual((await request("/api/me/permissions", { token: fresh.access_token })).permissions, []);
    assert.deepEqual((await request("/api/me/mfa/methods", { token: fresh.access_token })).methods, []);
  });

  await t.test("delegated account managers cannot take over more privileged users", async () => {
    await seed("delegated-manager");
    await db.insert(roles).values({ id: "account-manager", key: "account-manager", label: "Account manager" });
    await db.batch(["users.read", "users.create", "users.update", "users.delete"].map((permission_key) =>
      db.insert(rolePermissions).values({ role_id: "account-manager", permission_key })));
    await db.insert(userRoles).values({ user_id: "delegated-manager", role_id: "account-manager" });
    const actor = (await login("delegated-manager@office.test")).access_token;
    await request("/api/users", { token: actor });
    const created = (await request("/api/users", { method: "POST", token: actor,
      data: { email_address: "delegated@office.test", password: PASSWORD }, expected: 201 })).user;
    await edit(created.id, { display_name: "Delegated update" }, 200, actor);
    await request(`/api/users/${created.id}`, { method: "DELETE", token: actor, expected: 204 });
    for (const data of [{ password: "a malicious replacement administrator password" }, { disabled: true },
      { email_address: "takeover@office.test" }, { display_name: "Impersonation" }]) await edit(administratorId, data, 403, actor);
    await request(`/api/users/${administratorId}`, { method: "DELETE", token: actor, expected: 403 });
    await db.delete(userRoles).where(eq(userRoles.user_id, "delegated-manager"));
    await request("/api/users", { token: actor, expected: 403 });
    await edit("regular", { display_name: "Revoked" }, 403, actor);
    await request("/api/me", { token: actor });
  });

  await t.test("a read-only role does not permit account mutations", async () => {
    await seed("read-only");
    await db.insert(userRoles).values({ user_id: "read-only", role_id: "deleted-reader" });
    const actor = (await login("read-only@office.test")).access_token;
    await request("/api/users", { token: actor }); await request("/api/users/regular", { token: actor });
    await request("/api/users", { method: "POST", token: actor, data: { email_address: "reader-create@office.test", password: PASSWORD }, expected: 403 });
    await edit("regular", { display_name: "Read-only" }, 403, actor);
    await request("/api/users/regular", { method: "DELETE", token: actor, expected: 403 });
  });

  await t.test("email changes require a separate grant, including self changes and mixed updates", async () => {
    await seed("email-operator");
    const role = (await request("/api/roles", { method: "POST", token,
      data: { key: "email-operator", label: "Email operator", permissions: ["users.update"] }, expected: 201 })).role;
    await request("/api/users/email-operator/roles", { method: "PUT", token, data: { role_ids: [role.id] }, expected: 204 });
    const actor = (await login("email-operator@office.test")).access_token;
    const target = await create("email-target@office.test");
    const existingSession = await login(target.email_address);
    await edit(target.id, { display_name: "Ordinary update" }, 200, actor);
    const before = await db.select().from(users).where(eq(users.id, target.id)).get();
    await edit(target.id, { email_address: "email-denied@office.test" }, 403, actor);
    await edit(target.id, { email_address: "email-denied@office.test", display_name: "Must not change", password: "must not replace the user's password" }, 403, actor);
    await edit("email-operator", { email_address: "self-denied@office.test" }, 403, actor);
    await request("/api/me/profile", { method: "PATCH", token: actor, data: { email_address: "profile-denied@office.test" }, expected: 400 });
    assert.deepEqual(await db.select().from(users).where(eq(users.id, target.id)).get(), before);
    await request("/api/me", { token: existingSession.access_token });
    // An explicit role grant applies to the same JWT; general editing does not imply this grant.
    const granted = (await request(`/api/roles/${role.id}`, { method: "PUT", token,
      data: { label: role.label, permissions: ["users.update", "users.email.update"], version: role.version } })).role;
    const changed = (await edit(target.id, { email_address: "EMAIL-CHANGED@OFFICE.TEST" }, 200, actor)).user;
    assert.equal(changed.email_address, "email-changed@office.test");
    await request("/api/me", { token: existingSession.access_token, expected: 401 });
    await login("email-changed@office.test");
    await request(`/api/roles/${role.id}`, { method: "PUT", token,
      data: { label: granted.label, permissions: ["users.update"], version: granted.version } });
    await edit(target.id, { email_address: "email-revoked@office.test" }, 403, actor);
    await edit(target.id, { display_name: "General permission retained" }, 200, actor);
    assert.equal((await db.select().from(users).where(eq(users.id, target.id)).get()).email_address, "email-changed@office.test");
    assert.equal((await db.select().from(users).where(eq(users.id, "email-operator")).get()).email_address, "email-operator@office.test");
  });

  await t.test("pagination includes disabled users, excludes deleted users and exposes no secrets", async () => {
    const pageUsers = Array.from({ length: 55 }, (_, index) => ({ id: `page-user-${String(index).padStart(3, "0")}`,
      email_address: `page-${index}@office.test`, password_hash: passwordHash, disabled_at: index === 0 ? 1 : null }));
    await db.batch([0, 10, 20, 30, 40, 50].map((offset) => db.insert(users).values(pageUsers.slice(offset, offset + 10))));
    const first = await request("/api/users", { token });
    assert.equal(first.users.length, 50); assert.ok(first.next_cursor);
    const second = await request(`/api/users?cursor=${first.next_cursor}`, { token });
    assert.equal(second.next_cursor, null);
    const all = [...first.users, ...second.users], ids = all.map((user) => user.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, (await db.select({ count: count() }).from(users).where(isNull(users.deleted_at)).get()).count);
    assert.equal(all.find((user) => user.id === "page-user-000").disabled_at, 1);
    assert.ok(all.every((user) => user.password_hash === undefined && user.auth_version === undefined && user.deleted_at === null));
    assert.equal((await request("/api/users?limit=1", { token })).users.length, 1);
    for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=-1", "limit=", "cursor=bad%20cursor"])
      await request(`/api/users?${query}`, { token, expected: 400 });
  });

  await t.test("the last administrator cannot be disabled or deleted", async () => {
    await edit(administratorId, { disabled: true }, 409);
    await request(`/api/users/${administratorId}`, { method: "DELETE", token, expected: 409 });
    await request("/api/users", { token });
    const administrator = await db.select().from(users).where(eq(users.id, administratorId)).get();
    assert.equal(administrator.disabled_at, null); assert.equal(administrator.deleted_at, null);
  });
});

test("concurrent administrator deletion and disabling preserve one active administrator", async (t) => {
  const { db, raw, administrators } = await fixture(t, 2);
  const responses = await Promise.all(administrators.map(({ id, token }, index) => raw(`/api/users/${id}`, {
    method: index === 0 ? "DELETE" : "PATCH", token, data: index === 0 ? undefined : { disabled: true },
  })));
  assert.equal(responses.filter((response) => [200, 204].includes(response.status)).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 1);
  const remaining = await db.select().from(users).innerJoin(userRoles, eq(users.id, userRoles.user_id)).where(and(
    eq(userRoles.role_id, "system-administrator"), isNull(users.deleted_at), isNull(users.disabled_at),
  ));
  assert.equal(remaining.length, 1);
});

test("concurrent role removal and account deletion use the same administrator protection", async (t) => {
  const { db, raw, administrators } = await fixture(t, 2);
  const [one, two] = administrators;
  const responses = await Promise.all([
    raw(`/api/users/${one.id}`, { method: "DELETE", token: one.token }),
    raw(`/api/users/${two.id}/roles`, { method: "PUT", token: two.token, data: { role_ids: [] } }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [204, 409]);
  const remaining = await db.select().from(users).innerJoin(userRoles, eq(users.id, userRoles.user_id)).where(and(
    eq(userRoles.role_id, "system-administrator"), isNull(users.deleted_at), isNull(users.disabled_at),
  ));
  assert.equal(remaining.length, 1);
});
