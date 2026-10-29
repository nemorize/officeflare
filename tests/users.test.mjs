import { workerModules } from "./worker-modules.mjs";
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
import { permissionCatalog, permissionClosure } from "../src/authorization/permissions.ts";

const {
  users,
  userRoles,
  roles,
  rolePermissions,
  userSessions,
  userAuthChallenges,
  userMfaMethods,
  userMfaRecoveryCodes,
} = schema;
const PASSWORD = "a password for user management tests";
const passwordHash = await hashPassword(PASSWORD);

async function fixture(
  t,
  administratorCount = 1,
  { beforePolicyMigration, mailStore = true } = {},
) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: "officeflare",
          modules: workerModules,
          compatibilityDate: "2026-09-29",
          ...(mailStore
            ? {
                durableObjects: {
                  MAILBOX: { className: "MailboxDO", useSQLite: true },
                  MAIL_PARTITION: { className: "MailPartitionDO", useSQLite: true },
                },
              }
            : {}),
          d1Databases: { DB: "user-management-tests" },
          r2Buckets: { PROFILE_BUCKET: "user-profile-tests" },
          bindings: {
            AUTH_SIGNING_KEYS: JSON.stringify({
              active_kid: "test",
              keys: [{ ...(await exportJWK(privateKey)), kid: "test" }],
            }),
            MFA_ENCRYPTION_KEYS: JSON.stringify({
              active_version: 1,
              keys: { 1: randomBytes(32).toString("base64url") },
            }),
            AUTH_ISSUER: "officeflare",
            AUTH_AUDIENCE: "officeflare-api",
            MAIL_PARTITION_TARGET_BYTES: "6000000000",
          },
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const binding = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    if (file.startsWith("0010_") && beforePolicyMigration) await beforePolicyMigration(binding);
    let statement = "",
      trigger = false;
    for (const line of (await readFile(`migrations/${file}`, "utf8")).split("\n")) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      statement += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
        await binding.prepare(statement).run();
        statement = "";
        trigger = false;
      }
    }
    assert.equal(statement.trim(), "");
  }
  const db = drizzle(binding, { schema });
  const seed = async (id) =>
    db
      .insert(users)
      .values({ id, email_address: `${id}@office.test`, password_hash: passwordHash });
  let ip = 0;
  const raw = (path, { method = "GET", token, data } = {}) =>
    mf.dispatchFetch(`https://office.test${path}`, {
      method,
      headers: {
        "cf-connecting-ip": `192.0.2.${++ip % 250}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const request = async (path, { expected = 200, ...options } = {}) => {
    const assignment = /^\/api\/users\/([^/]+)\/roles$/.exec(path);
    if (
      assignment &&
      options.method === "PUT" &&
      options.data &&
      options.data.version === undefined
    )
      options.data = {
        ...options.data,
        version:
          (await db.select().from(users).where(eq(users.id, assignment[1])).get())
            ?.role_assignment_version ?? 1,
      };
    const response = await raw(path, options);
    assert.equal(
      response.status,
      expected,
      `${options.method ?? "GET"} ${path}: ${await response.clone().text()}`,
    );
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return expected === 204 ? null : response.json();
  };
  const login = (email, password = PASSWORD, expected = 200) =>
    request("/api/auth/login", {
      method: "POST",
      data: { email_address: email, password },
      expected,
    });
  const administrators = [];
  for (let index = 0; index < administratorCount; index++) {
    const id = `administrator-${index}`;
    await seed(id);
    await db.insert(userRoles).values({ user_id: id, role_id: "system-administrator" });
    administrators.push({ id, token: (await login(`${id}@office.test`)).access_token });
  }
  const token = administrators[0].token;
  const create = async (email, extra = {}) =>
    (
      await request("/api/users", {
        method: "POST",
        token,
        data: {
          email_address: email,
          password: PASSWORD,
          password_reset_required: false,
          ...extra,
        },
        expected: 201,
      })
    ).user;
  const edit = (id, data, expected = 200, actor = token) =>
    request(`/api/users/${id}`, { method: "PATCH", token: actor, data, expected });
  return { mf, db, token, seed, raw, request, login, create, edit, administrators };
}

test("user profile photos require user-read permission and stay within the target account's storage", async (t) => {
  const { mf, db, token, seed, raw, request, login } = await fixture(t);
  await seed("photo-owner");
  await seed("photo-reader");
  await seed("photo-unprivileged");
  const owner = await login("photo-owner@office.test");
  const regular = await login("photo-unprivileged@office.test");
  await db
    .insert(roles)
    .values({ id: "photo-reader-role", key: "photo-reader-role", label: "Photo reader" });
  await db.batch(
    permissionClosure(["admin.users.read"]).map((permission_key) =>
      db.insert(rolePermissions).values({ role_id: "photo-reader-role", permission_key }),
    ),
  );
  await db.insert(userRoles).values({ user_id: "photo-reader", role_id: "photo-reader-role" });
  const reader = await login("photo-reader@office.test");
  const bucket = await mf.getR2Bucket("PROFILE_BUCKET");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ9kAAAAASUVORK5CYII=",
    "base64",
  );
  const key = "profiles/photo-owner/photo.png",
    path = "/api/users/photo-owner/profile-image";
  await bucket.put(key, png, { httpMetadata: { contentType: "image/png" } });
  await db.update(users).set({ profile_image_key: key }).where(eq(users.id, "photo-owner"));

  await request(path, { expected: 401 });
  await request(path, { token: regular.access_token, expected: 403 });
  await request(path, { token: owner.access_token, expected: 403 });
  await request(path, { token: reader.refresh_token, expected: 401 });
  for (const actor of [token, reader.access_token]) {
    const response = await raw(path, { token: actor });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-disposition"), "inline");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  }
  await request("/api/users/missing/profile-image", { token, expected: 404 });
  await request("/api/users/photo-reader/profile-image", { token, expected: 404 });
  await db.update(users).set({ profile_image_key: key }).where(eq(users.id, "photo-reader"));
  await request("/api/users/photo-reader/profile-image", { token, expected: 404 });
  await bucket.delete(key);
  await request(path, { token, expected: 404 });
  await bucket.put(key, "<svg/>", { httpMetadata: { contentType: "image/svg+xml" } });
  await request(path, { token, expected: 404 });
  await bucket.put(key, png, { httpMetadata: { contentType: "image/png" } });
  await db.update(users).set({ deleted_at: 1 }).where(eq(users.id, "photo-owner"));
  await request(path, { token, expected: 404 });
  await db.delete(userRoles).where(eq(userRoles.user_id, "photo-reader"));
  await request(path, { token: reader.access_token, expected: 403 });
});

test("self-disable is denied even with another administrator and mixed edits cannot partially save", async (t) => {
  const { db, edit, request, administrators, seed, login } = await fixture(t, 2);
  const [actor, other] = administrators;
  const before = await db.select().from(users).where(eq(users.id, actor.id)).get();
  const sessionBefore = await db
    .select()
    .from(userSessions)
    .where(eq(userSessions.user_id, actor.id))
    .get();
  for (const changes of [{ disabled: true }, { disabled: true, display_name: "Must not save" }]) {
    const response = await edit(actor.id, changes, 403);
    assert.equal(response.error, "You cannot disable your own account.");
    assert.deepEqual(await db.select().from(users).where(eq(users.id, actor.id)).get(), before);
    assert.deepEqual(
      await db.select().from(userSessions).where(eq(userSessions.user_id, actor.id)).get(),
      sessionBefore,
    );
    await request("/api/me", { token: actor.token });
  }
  await edit(actor.id, { disabled: false, display_name: "Updated name" });
  await request("/api/me", { token: actor.token });
  const disabled = (await edit(other.id, { disabled: true })).user;
  assert.ok(disabled.disabled_at);
  await edit(other.id, { disabled: false });
  await seed("self-editor");
  await db
    .insert(roles)
    .values({ id: "self-editor-role", key: "self-editor-role", label: "Account editor" });
  await db.batch(
    permissionClosure(["admin.users.profile.update", "admin.users.status.update"]).map(
      (permission_key) =>
        db.insert(rolePermissions).values({ role_id: "self-editor-role", permission_key }),
    ),
  );
  await db.insert(userRoles).values({ user_id: "self-editor", role_id: "self-editor-role" });
  const editor = await login("self-editor@office.test");
  await edit("self-editor", { disabled: true }, 403, editor.access_token);
  await request("/api/me", { token: editor.access_token });
});

test("user management in the Workers runtime", async (t) => {
  const { db, token, seed, raw, request, login, create, edit, administrators } = await fixture(t);
  const administratorId = administrators[0].id;
  await seed("regular");
  const regular = await login("regular@office.test");

  await t.test("each action requires its own permission and an access Bearer token", async () => {
    const permissions = (await request("/api/me/permissions", { token })).permissions;
    assert.deepEqual(permissions, Object.keys(permissionCatalog).sort());
    for (const [path, method, data] of [
      ["/api/users", "GET"],
      ["/api/users/regular", "GET"],
      ["/api/users", "POST", { email_address: "denied@office.test", password: PASSWORD }],
      ["/api/users/regular", "PATCH", { display_name: "Denied" }],
      ["/api/users/regular", "DELETE"],
    ]) {
      await request(path, { method, data, expected: 401 });
      await request(path, { method, data, token: regular.access_token, expected: 403 });
      await request(path, { method, data, token: regular.refresh_token, expected: 401 });
    }
    await request("/api/users/missing", { token, expected: 404 });
    await edit("missing", { display_name: "Missing" }, 404);
    await request("/api/users/missing", { method: "DELETE", token, expected: 404 });
  });

  await t.test(
    "creation normalizes email, hashes passwords and requires first-login password change",
    async () => {
      const response = await raw("/api/users", {
        method: "POST",
        token,
        data: {
          email_address: " NEW@OFFICE.TEST ",
          password: PASSWORD,
          display_name: " New User ",
          profile_image_key: "profiles/new.png",
        },
      });
      assert.equal(response.status, 201);
      const { user } = await response.json();
      assert.equal(response.headers.get("location"), `/api/users/${user.id}`);
      assert.equal(user.email_address, "new@office.test");
      assert.equal(user.display_name, "New User");
      assert.equal(user.profile_image_key, "profiles/new.png");
      assert.equal(user.password_reset_required, true);
      assert.equal(user.password_hash, undefined);
      assert.equal(user.auth_version, undefined);
      const stored = await db.select().from(users).where(eq(users.id, user.id)).get();
      assert.equal(await verifyPassword(PASSWORD, stored.password_hash), true);
      assert.deepEqual(
        (await db.select().from(userRoles).where(eq(userRoles.user_id, user.id))).map(
          (row) => row.role_id,
        ),
        ["system-mail-user"],
      );
      const pending = await login(user.email_address);
      assert.equal(pending.next, "password_reset");
      assert.equal(pending.access_token, undefined);
      const changed = await request("/api/me/password", {
        method: "PUT",
        token: pending.challenge_token,
        data: { new_password: "the new user's own replacement password" },
      });
      assert.deepEqual(
        (await request("/api/me/permissions", { token: changed.access_token })).permissions,
        ["mail.access"],
      );
      const listed = (await request(`/api/users/${user.id}`, { token })).user;
      assert.equal(listed.password_reset_required, false);
      assert.ok(listed.password_changed_at);
    },
  );

  await t.test(
    "input validation rejects privilege fields, bad addresses and invalid account values",
    async () => {
      for (const data of [
        {},
        { email_address: "invalid", password: PASSWORD },
        { email_address: "a..b@office.test", password: PASSWORD },
        { email_address: "a@-office.test", password: PASSWORD },
        { email_address: "a@office..test", password: PASSWORD },
        { email_address: "a@office.test", password: "short" },
        { email_address: "a@office.test", password: PASSWORD, auth_version: 100 },
        { email_address: "a@office.test", password: PASSWORD, disabled: 1 },
        { email_address: "a@office.test", password: PASSWORD, password_reset_required: "false" },
        { email_address: "a@office.test", password: PASSWORD, display_name: " " },
      ])
        await request("/api/users", { method: "POST", token, data, expected: 400 });
      for (const data of [
        {},
        { deleted_at: 1 },
        { password_hash: "plain" },
        { disabled: null },
        { password_reset_required: 0 },
        { email_address: "bad address@office.test" },
        { password: "short" },
        { profile_image_key: "x".repeat(1025) },
        { display_name: "x".repeat(201) },
      ])
        await edit("regular", data, 400);
    },
  );

  await t.test(
    "case-insensitive duplicates and concurrent address assignments return conflicts",
    async () => {
      await request("/api/users", {
        method: "POST",
        token,
        data: { email_address: "REGULAR@office.test", password: PASSWORD },
        expected: 409,
      });
      const duplicate = await create("duplicate@office.test");
      await edit(duplicate.id, { email_address: "Regular@Office.Test" }, 409);
      assert.equal(
        (await request(`/api/users/${duplicate.id}`, { token })).user.email_address,
        duplicate.email_address,
      );
      const creates = await Promise.all(
        ["RACE@office.test", "race@office.test"].map((email_address) =>
          raw("/api/users", {
            method: "POST",
            token,
            data: { email_address, password: PASSWORD },
          }),
        ),
      );
      assert.deepEqual(creates.map((response) => response.status).sort(), [201, 409]);
      const one = await create("rename-one@office.test"),
        two = await create("rename-two@office.test");
      const renames = await Promise.all(
        [one, two].map((user) =>
          raw(`/api/users/${user.id}`, {
            method: "PATCH",
            token,
            data: { email_address: "renamed@office.test" },
          }),
        ),
      );
      assert.deepEqual(renames.map((response) => response.status).sort(), [200, 409]);
    },
  );

  await t.test(
    "profile-only updates preserve sessions while email changes revoke previous credentials",
    async () => {
      const user = await create("editable@office.test"),
        old = await login(user.email_address);
      const grant = await request("/api/auth/reauthenticate", {
        method: "POST",
        token: old.access_token,
        data: { password: PASSWORD },
      });
      const changed = (
        await edit(user.id, { display_name: "Edited", profile_image_key: "profiles/edited.png" })
      ).user;
      assert.equal(changed.display_name, "Edited");
      assert.equal(changed.profile_image_key, "profiles/edited.png");
      await request("/api/me", { token: old.access_token });
      await edit(user.id, {
        display_name: null,
        profile_image_key: null,
        email_address: "EDITED@OFFICE.TEST",
      });
      await request("/api/me", { token: old.access_token, expected: 401 });
      await request("/api/auth/refresh", {
        method: "POST",
        token: old.refresh_token,
        expected: 401,
      });
      await request("/api/me/password", {
        method: "PUT",
        token: grant.reauthentication_token,
        data: { new_password: PASSWORD },
        expected: 401,
      });
      await login(user.email_address, PASSWORD, 401);
      await login("edited@office.test");
    },
  );

  await t.test(
    "administrator password resets invalidate sessions and outstanding grants",
    async () => {
      const user = await create("resettable@office.test"),
        old = await login(user.email_address);
      const grant = await request("/api/auth/reauthenticate", {
        method: "POST",
        token: old.access_token,
        data: { password: PASSWORD },
      });
      const replacement = "a temporary replacement from the administrator";
      const changed = (await edit(user.id, { password: replacement })).user;
      assert.equal(changed.password_reset_required, true);
      assert.equal(changed.password_hash, undefined);
      await request("/api/me", { token: old.access_token, expected: 401 });
      await request("/api/auth/refresh", {
        method: "POST",
        token: old.refresh_token,
        expected: 401,
      });
      await request("/api/me/password", {
        method: "PUT",
        token: grant.reauthentication_token,
        data: { new_password: PASSWORD },
        expected: 401,
      });
      await login(user.email_address, PASSWORD, 401);
      const pending = await login(user.email_address, replacement);
      assert.equal(pending.next, "password_reset");
      await edit(user.id, { password_reset_required: false });
      await request("/api/me/password", {
        method: "PUT",
        token: pending.challenge_token,
        data: { new_password: PASSWORD },
        expected: 401,
      });
      assert.ok((await login(user.email_address, replacement)).access_token);
    },
  );

  await t.test(
    "disabling and reenabling users never restores old tokens or pending MFA enrollment",
    async () => {
      const user = await create("disabled@office.test"),
        old = await login(user.email_address);
      const grant = await request("/api/auth/reauthenticate", {
        method: "POST",
        token: old.access_token,
        data: { password: PASSWORD },
      });
      await db.insert(userMfaMethods).values({
        id: "pending-disable",
        user_id: user.id,
        type: "totp",
        setup_expires_at: Math.floor(Date.now() / 1000) + 600,
      });
      const disabled = (await edit(user.id, { disabled: true })).user;
      assert.ok(disabled.disabled_at);
      await login(user.email_address, PASSWORD, 401);
      await request("/api/me", { token: old.access_token, expected: 401 });
      await edit(user.id, { disabled: false });
      await request("/api/me", { token: old.access_token, expected: 401 });
      await request("/api/auth/refresh", {
        method: "POST",
        token: old.refresh_token,
        expected: 401,
      });
      await request("/api/me/password", {
        method: "PUT",
        token: grant.reauthentication_token,
        data: { new_password: PASSWORD },
        expected: 401,
      });
      assert.ok((await login(user.email_address)).access_token);
      assert.ok(
        (
          await db
            .select()
            .from(userMfaMethods)
            .where(eq(userMfaMethods.id, "pending-disable"))
            .get()
        ).revoked_at,
      );
    },
  );

  await t.test(
    "soft deletion revokes credentials and allows email reuse without inheriting roles or MFA",
    async () => {
      const user = await create("deleted@office.test"),
        old = await login(user.email_address);
      await db
        .insert(roles)
        .values({ id: "deleted-reader", key: "deleted-reader", label: "Deleted reader" });
      await db.batch(
        permissionClosure(["admin.users.read"]).map((permission_key) =>
          db.insert(rolePermissions).values({ role_id: "deleted-reader", permission_key }),
        ),
      );
      await db.insert(userRoles).values({ user_id: user.id, role_id: "deleted-reader" });
      await db.insert(userMfaMethods).values({
        id: "deleted-mfa",
        user_id: user.id,
        type: "totp",
        created_at: 1,
        verified_at: 2,
      });
      await db
        .insert(userMfaRecoveryCodes)
        .values({ id: "deleted-recovery", user_id: user.id, code_hash: "test-only-recovery-hash" });
      await request(`/api/users/${user.id}`, { method: "DELETE", token, expected: 204 });
      const stored = await db.select().from(users).where(eq(users.id, user.id)).get();
      assert.ok(stored.deleted_at);
      await request(`/api/users/${user.id}`, { token, expected: 404 });
      await edit(user.id, { display_name: "Cannot restore" }, 404);
      await request(`/api/users/${user.id}`, { method: "DELETE", token, expected: 404 });
      await request("/api/me", { token: old.access_token, expected: 401 });
      await request("/api/auth/refresh", {
        method: "POST",
        token: old.refresh_token,
        expected: 401,
      });
      assert.ok(
        (await db.select().from(userSessions).where(eq(userSessions.user_id, user.id)).get())
          .revoked_at,
      );
      assert.ok(
        (await db.select().from(userMfaMethods).where(eq(userMfaMethods.user_id, user.id)).get())
          .revoked_at,
      );
      assert.ok(
        (
          await db
            .select()
            .from(userMfaRecoveryCodes)
            .where(eq(userMfaRecoveryCodes.user_id, user.id))
            .get()
        ).revoked_at,
      );
      const replacement = await create(user.email_address);
      assert.notEqual(replacement.id, user.id);
      const fresh = await login(replacement.email_address);
      assert.deepEqual(
        (await request("/api/me/permissions", { token: fresh.access_token })).permissions,
        ["mail.access"],
      );
      assert.deepEqual(
        (await request("/api/me/mfa/methods", { token: fresh.access_token })).methods,
        [],
      );
    },
  );

  await t.test("delegated account managers cannot take over more privileged users", async () => {
    await seed("delegated-manager");
    await db
      .insert(roles)
      .values({ id: "account-manager", key: "account-manager", label: "Account manager" });
    await db.batch(
      permissionClosure([
        "admin.users.read",
        "admin.users.create",
        "admin.users.profile.update",
        "admin.users.status.update",
        "admin.users.credentials.reset",
        "admin.users.delete",
        "mail.access",
      ]).map((permission_key) =>
        db.insert(rolePermissions).values({ role_id: "account-manager", permission_key }),
      ),
    );
    await db.insert(userRoles).values({ user_id: "delegated-manager", role_id: "account-manager" });
    const actor = (await login("delegated-manager@office.test")).access_token;
    await request("/api/users", { token: actor });
    const created = (
      await request("/api/users", {
        method: "POST",
        token: actor,
        data: { email_address: "delegated@office.test", password: PASSWORD },
        expected: 201,
      })
    ).user;
    await edit(created.id, { display_name: "Delegated update" }, 200, actor);
    await request(`/api/users/${created.id}`, { method: "DELETE", token: actor, expected: 204 });
    for (const data of [
      { password: "a malicious replacement administrator password" },
      { disabled: true },
      { email_address: "takeover@office.test" },
      { display_name: "Impersonation" },
    ])
      await edit(administratorId, data, 403, actor);
    await request(`/api/users/${administratorId}`, {
      method: "DELETE",
      token: actor,
      expected: 403,
    });
    await db.delete(userRoles).where(eq(userRoles.user_id, "delegated-manager"));
    await request("/api/users", { token: actor, expected: 403 });
    await edit("regular", { display_name: "Revoked" }, 403, actor);
    await request("/api/me", { token: actor });
  });

  await t.test("a read-only role does not permit account mutations", async () => {
    await seed("read-only");
    await db.insert(userRoles).values({ user_id: "read-only", role_id: "deleted-reader" });
    const actor = (await login("read-only@office.test")).access_token;
    await request("/api/users", { token: actor });
    await request("/api/users/regular", { token: actor });
    await request("/api/users", {
      method: "POST",
      token: actor,
      data: { email_address: "reader-create@office.test", password: PASSWORD },
      expected: 403,
    });
    await edit("regular", { display_name: "Read-only" }, 403, actor);
    await request("/api/users/regular", { method: "DELETE", token: actor, expected: 403 });
  });

  await t.test(
    "email changes require a separate grant, including self changes and mixed updates",
    async () => {
      await seed("email-operator");
      const role = (
        await request("/api/roles", {
          method: "POST",
          token,
          data: {
            key: "email-operator",
            label: "Email operator",
            permissions: permissionClosure(["admin.users.profile.update", "mail.access"]),
          },
          expected: 201,
        })
      ).role;
      await request("/api/users/email-operator/roles", {
        method: "PUT",
        token,
        data: { role_ids: [role.id] },
        expected: 204,
      });
      const actor = (await login("email-operator@office.test")).access_token;
      const target = await create("email-target@office.test");
      const existingSession = await login(target.email_address);
      await edit(target.id, { display_name: "Ordinary update" }, 200, actor);
      const before = await db.select().from(users).where(eq(users.id, target.id)).get();
      await edit(target.id, { email_address: "email-denied@office.test" }, 403, actor);
      await edit(
        target.id,
        {
          email_address: "email-denied@office.test",
          display_name: "Must not change",
          password: "must not replace the user's password",
        },
        403,
        actor,
      );
      await edit("email-operator", { email_address: "self-denied@office.test" }, 403, actor);
      await request("/api/me/profile", {
        method: "PATCH",
        token: actor,
        data: { email_address: "profile-denied@office.test" },
        expected: 400,
      });
      assert.deepEqual(await db.select().from(users).where(eq(users.id, target.id)).get(), before);
      await request("/api/me", { token: existingSession.access_token });
      // An explicit role grant applies to the same JWT; general editing does not imply this grant.
      const granted = (
        await request(`/api/roles/${role.id}`, {
          method: "PUT",
          token,
          data: {
            label: role.label,
            permissions: permissionClosure([
              "admin.users.profile.update",
              "admin.users.email.update",
              "mail.access",
            ]),
            version: role.version,
          },
        })
      ).role;
      const changed = (
        await edit(target.id, { email_address: "EMAIL-CHANGED@OFFICE.TEST" }, 200, actor)
      ).user;
      assert.equal(changed.email_address, "email-changed@office.test");
      await request("/api/me", { token: existingSession.access_token, expected: 401 });
      await login("email-changed@office.test");
      await request(`/api/roles/${role.id}`, {
        method: "PUT",
        token,
        data: {
          label: granted.label,
          permissions: permissionClosure(["admin.users.profile.update", "mail.access"]),
          version: granted.version,
        },
      });
      await edit(target.id, { email_address: "email-revoked@office.test" }, 403, actor);
      await edit(target.id, { display_name: "General permission retained" }, 200, actor);
      assert.equal(
        (await db.select().from(users).where(eq(users.id, target.id)).get()).email_address,
        "email-changed@office.test",
      );
      assert.equal(
        (await db.select().from(users).where(eq(users.id, "email-operator")).get()).email_address,
        "email-operator@office.test",
      );
    },
  );

  await t.test(
    "pagination includes disabled users, excludes deleted users and exposes no secrets",
    async () => {
      const pageUsers = Array.from({ length: 55 }, (_, index) => ({
        id: `page-user-${String(index).padStart(3, "0")}`,
        email_address: `page-${index}@office.test`,
        password_hash: passwordHash,
        disabled_at: index === 0 ? 1 : null,
      }));
      await db.batch(
        [0, 10, 20, 30, 40, 50].map((offset) =>
          db.insert(users).values(pageUsers.slice(offset, offset + 10)),
        ),
      );
      const first = await request("/api/users", { token });
      assert.equal(first.users.length, 50);
      assert.ok(first.next_cursor);
      const second = await request(`/api/users?cursor=${first.next_cursor}`, { token });
      assert.equal(second.next_cursor, null);
      const all = [...first.users, ...second.users],
        ids = all.map((user) => user.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(
        ids.length,
        (await db.select({ count: count() }).from(users).where(isNull(users.deleted_at)).get())
          .count,
      );
      assert.equal(all.find((user) => user.id === "page-user-000").disabled_at, 1);
      assert.ok(
        all.every(
          (user) =>
            user.password_hash === undefined &&
            user.auth_version === undefined &&
            user.deleted_at === null,
        ),
      );
      assert.equal((await request("/api/users?limit=1", { token })).users.length, 1);
      for (const query of [
        "limit=0",
        "limit=101",
        "limit=1.5",
        "limit=-1",
        "limit=",
        "cursor=bad%20cursor",
      ])
        await request(`/api/users?${query}`, { token, expected: 400 });
    },
  );

  await t.test("the last administrator cannot be disabled or deleted", async () => {
    await edit(administratorId, { disabled: true }, 403);
    await request(`/api/users/${administratorId}`, { method: "DELETE", token, expected: 409 });
    await request("/api/users", { token });
    const administrator = await db.select().from(users).where(eq(users.id, administratorId)).get();
    assert.equal(administrator.disabled_at, null);
    assert.equal(administrator.deleted_at, null);
  });
});

test("concurrent administrator deletion and disabling preserve one active administrator", async (t) => {
  const { db, raw, administrators } = await fixture(t, 2);
  const [actor, other] = administrators;
  // Deleting the actor can also invalidate the simultaneous request to disable the other account.
  const responses = await Promise.all([
    raw(`/api/users/${actor.id}`, { method: "DELETE", token: actor.token }),
    raw(`/api/users/${other.id}`, {
      method: "PATCH",
      token: actor.token,
      data: { disabled: true },
    }),
  ]);
  assert.equal(responses.filter((response) => [200, 204].includes(response.status)).length, 1);
  assert.equal(responses.filter((response) => [401, 403, 409].includes(response.status)).length, 1);
  const remaining = await db
    .select()
    .from(users)
    .innerJoin(userRoles, eq(users.id, userRoles.user_id))
    .where(
      and(
        eq(userRoles.role_id, "system-administrator"),
        isNull(users.deleted_at),
        isNull(users.disabled_at),
      ),
    );
  assert.equal(remaining.length, 1);
});

test("concurrent role removal and account deletion use the same administrator protection", async (t) => {
  const { db, raw, administrators } = await fixture(t, 2);
  const [one, two] = administrators;
  const responses = await Promise.all([
    raw(`/api/users/${one.id}`, { method: "DELETE", token: one.token }),
    raw(`/api/users/${two.id}/roles`, {
      method: "PUT",
      token: two.token,
      data: {
        role_ids: [],
        version: (await db.select().from(users).where(eq(users.id, two.id)).get())
          .role_assignment_version,
      },
    }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [204, 409]);
  const remaining = await db
    .select()
    .from(users)
    .innerJoin(userRoles, eq(users.id, userRoles.user_id))
    .where(
      and(
        eq(userRoles.role_id, "system-administrator"),
        isNull(users.deleted_at),
        isNull(users.disabled_at),
      ),
    );
  assert.equal(remaining.length, 1);
});

test("permission migration preserves legacy actions, completes parents and seeds the default mail role", async (t) => {
  const { db } = await fixture(t, 1, {
    beforePolicyMigration: async (binding) => {
      await binding
        .prepare(
          "INSERT INTO users(id,email_address,password_hash) VALUES('existing-member','existing@office.test',?)",
        )
        .bind(passwordHash)
        .run();
      await binding
        .prepare("INSERT INTO roles(id,key,label) VALUES('legacy','legacy','Legacy')")
        .run();
      await binding
        .prepare(
          "INSERT INTO roles(id,key,label) VALUES('existing-mail-key','mail-user','Existing custom role')",
        )
        .run();
      for (const key of ["users.update", "roles.manage", "mail.domains.manage"])
        await binding
          .prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('legacy',?)")
          .bind(key)
          .run();
      await binding
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('existing-member','legacy')")
        .run();
    },
  });
  const grants = (
    await db.select().from(rolePermissions).where(eq(rolePermissions.role_id, "legacy"))
  )
    .map((row) => row.permission_key)
    .sort();
  assert.deepEqual(
    grants,
    permissionClosure([
      "admin.users.profile.update",
      "admin.users.status.update",
      "admin.users.credentials.reset",
      "admin.roles.create",
      "admin.roles.update",
      "admin.roles.delete",
      "admin.mail.domains.manage",
    ]).sort(),
  );
  assert.ok(!grants.includes("admin.users.email.update"));
  assert.ok(!grants.includes("admin.roles.defaults.manage"));
  const mail = await db.select().from(roles).where(eq(roles.id, "system-mail-user")).get();
  assert.equal(mail.is_default, 1);
  assert.equal(mail.is_system, 0);
  assert.match(mail.key, /^officeflare-mail-user-/);
  assert.equal(
    (await db.select().from(roles).where(eq(roles.id, "existing-mail-key")).get()).label,
    "Existing custom role",
  );
  assert.deepEqual(
    (await db.select().from(rolePermissions).where(eq(rolePermissions.role_id, mail.id))).map(
      (row) => row.permission_key,
    ),
    ["mail.access"],
  );
  assert.ok(
    (await db.select().from(userRoles).where(eq(userRoles.user_id, "existing-member"))).some(
      (row) => row.role_id === mail.id,
    ),
  );
});

test("service entry, administrative actions, role defaults and assignment concurrency are enforced in the API", async (t) => {
  const { db, token, seed, request, raw, login, create, edit } = await fixture(t, 2);
  const role = async (key, permissions) =>
    (
      await request("/api/roles", {
        method: "POST",
        token,
        data: { key, label: key, permissions: permissionClosure(permissions) },
        expected: 201,
      })
    ).role;
  const grant = async (id, permissions) => {
    await seed(id);
    const assigned = await role(`${id}-role`, permissions);
    await db.insert(userRoles).values({ user_id: id, role_id: assigned.id });
    return (await login(`${id}@office.test`)).access_token;
  };
  await t.test(
    "incomplete roles are rejected and missing parents deny existing raw grants",
    async () => {
      const denied = await request("/api/roles", {
        method: "POST",
        token,
        data: { key: "incomplete", label: "Incomplete", permissions: ["admin.users.create"] },
        expected: 400,
      });
      assert.match(denied.error, /admin.users.read/);
      assert.equal(
        await db.select().from(roles).where(eq(roles.key, "incomplete")).get(),
        undefined,
      );
      const actor = await grant("parent-check", ["admin.users.profile.update"]);
      await request("/api/users", { token: actor });
      const actorRole = await db
        .select()
        .from(userRoles)
        .where(eq(userRoles.user_id, "parent-check"))
        .get();
      await db
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.role_id, actorRole.role_id),
            eq(rolePermissions.permission_key, "console.access"),
          ),
        );
      await request("/api/users", { token: actor, expected: 403 });
      assert.deepEqual((await request("/api/me/permissions", { token: actor })).permissions, []);
    },
  );
  await t.test(
    "profile-only editing cannot change account security and mixed edits are atomic",
    async () => {
      const actor = await grant("profile-only", ["admin.users.profile.update", "mail.access"]),
        target = await create("granular-target@office.test");
      const active = await login(target.email_address);
      await edit(target.id, { display_name: "Allowed profile change" }, 200, actor);
      const before = await db.select().from(users).where(eq(users.id, target.id)).get();
      for (const change of [
        { disabled: true },
        { password_reset_required: true },
        { password: "a proposed temporary replacement password" },
        { email_address: "denied@office.test" },
        { display_name: "Must not save", disabled: true },
      ])
        await edit(target.id, change, 403, actor);
      assert.deepEqual(await db.select().from(users).where(eq(users.id, target.id)).get(), before);
      await request("/api/me", { token: active.access_token });
      const support = await grant("credential-only", [
        "admin.users.credentials.reset",
        "mail.access",
      ]);
      await edit(target.id, { display_name: "Denied profile change" }, 403, support);
      await edit(target.id, { password_reset_required: true }, 200, support);
      await request("/api/me", { token: active.access_token, expected: 401 });
    },
  );
  await t.test("role creation, editing and deletion are independent actions", async () => {
    const creator = await grant("role-creator", ["admin.roles.create"]);
    const created = (
      await request("/api/roles", {
        method: "POST",
        token: creator,
        data: { key: "creator-empty", label: "Created", permissions: [] },
        expected: 201,
      })
    ).role;
    await request(`/api/roles/${created.id}`, {
      method: "PUT",
      token: creator,
      data: { label: "Denied", permissions: [], version: created.version },
      expected: 403,
    });
    await request(`/api/roles/${created.id}`, { method: "DELETE", token: creator, expected: 403 });
    const updater = await grant("role-updater", ["admin.roles.update"]);
    await request("/api/roles", {
      method: "POST",
      token: updater,
      data: { key: "updater-empty", label: "Denied", permissions: [] },
      expected: 403,
    });
    await request(`/api/roles/${created.id}`, {
      method: "PUT",
      token: updater,
      data: { label: "Updated", permissions: [], version: created.version },
    });
    await request(`/api/roles/${created.id}`, { method: "DELETE", token: updater, expected: 403 });
    const deleter = await grant("role-deleter", ["admin.roles.delete"]);
    await request(`/api/roles/${created.id}`, { method: "DELETE", token: deleter, expected: 204 });
  });
  await t.test("delegated managers cannot strip or delete more privileged roles", async () => {
    const actor = await grant("restricted-manager", [
      "admin.roles.update",
      "admin.roles.delete",
      "admin.users.roles.assign",
      "admin.users.roles.remove",
    ]);
    const powerful = await role("powerful-role", ["admin.users.delete"]);
    await request(`/api/roles/${powerful.id}`, {
      method: "PUT",
      token: actor,
      data: { label: "Stripped", permissions: [], version: powerful.version },
      expected: 403,
    });
    await request(`/api/roles/${powerful.id}`, { method: "DELETE", token: actor, expected: 403 });
    await seed("privileged-target");
    await db.insert(userRoles).values({ user_id: "privileged-target", role_id: powerful.id });
    await request("/api/users/privileged-target/roles", {
      method: "PUT",
      token: actor,
      data: { role_ids: [] },
      expected: 403,
    });
    assert.deepEqual(
      (await request(`/api/roles/${powerful.id}`, { token })).role.permissions,
      powerful.permissions,
    );
  });
  await t.test(
    "approved defaults are selected by the server and cannot be bypassed by basic creators",
    async () => {
      const actor = await grant("basic-creator", ["admin.users.create"]);
      const defaults = (await request("/api/users/default-roles", { token: actor })).roles;
      assert.deepEqual(
        defaults.map((role) => role.id),
        ["system-mail-user"],
      );
      const created = (
        await request("/api/users", {
          method: "POST",
          token: actor,
          data: {
            email_address: "defaulted@office.test",
            password: PASSWORD,
            password_reset_required: false,
          },
          expected: 201,
        })
      ).user;
      assert.deepEqual(
        (await request(`/api/users/${created.id}/roles`, { token })).roles.map((role) => role.id),
        ["system-mail-user"],
      );
      assert.deepEqual(
        (
          await request("/api/me/permissions", {
            token: (await login(created.email_address)).access_token,
          })
        ).permissions,
        ["mail.access"],
      );
      await request("/api/users", {
        method: "POST",
        token: actor,
        data: { email_address: "omitted-default@office.test", password: PASSWORD, role_ids: [] },
        expected: 403,
      });
      await request("/api/users", {
        method: "POST",
        token: actor,
        data: {
          email_address: "privileged-default@office.test",
          password: PASSWORD,
          role_ids: ["system-mail-user", "system-administrator"],
        },
        expected: 403,
      });
      assert.equal(
        await db
          .select()
          .from(users)
          .where(eq(users.email_address, "omitted-default@office.test"))
          .get(),
        undefined,
      );
    },
  );
  await t.test(
    "default settings reject administrative roles and apply only to future accounts",
    async () => {
      const mail = (await request("/api/roles/system-mail-user", { token })).role;
      const updated = (
        await request(`/api/roles/${mail.id}/default`, {
          method: "PATCH",
          token,
          data: { is_default: false, version: mail.version },
        })
      ).role;
      await request(`/api/roles/${mail.id}/default`, {
        method: "PATCH",
        token,
        data: { is_default: true, version: mail.version },
        expected: 409,
      });
      assert.ok((await request("/api/users/default-roles", { token })).roles.length === 0);
      const created = await create("no-default@office.test");
      assert.equal((await request(`/api/users/${created.id}/roles`, { token })).roles.length, 0);
      const previous = await db
        .select()
        .from(users)
        .where(eq(users.email_address, "defaulted@office.test"))
        .get();
      assert.equal(
        (await request(`/api/users/${previous.id}/roles`, { token })).roles[0].id,
        mail.id,
      );
      const administrative = await role("not-a-default", ["admin.users.read"]);
      await request(`/api/roles/${administrative.id}/default`, {
        method: "PATCH",
        token,
        data: { is_default: true, version: administrative.version },
        expected: 400,
      });
      await request("/api/roles/system-administrator/default", {
        method: "PATCH",
        token,
        data: { is_default: true, version: 4 },
        expected: 403,
      });
      const restored = (
        await request(`/api/roles/${mail.id}/default`, {
          method: "PATCH",
          token,
          data: { is_default: true, version: updated.version },
        })
      ).role;
      await request(`/api/roles/${mail.id}`, {
        method: "PUT",
        token,
        data: {
          label: mail.label,
          permissions: permissionClosure(["admin.users.read"]),
          version: restored.version,
        },
        expected: 400,
      });
      const editor = await grant("default-editor", ["admin.roles.update", "mail.access"]);
      await request(`/api/roles/${mail.id}`, {
        method: "PUT",
        token: editor,
        data: { label: "Changed default", permissions: ["mail.access"], version: restored.version },
        expected: 403,
      });
    },
  );
  await t.test(
    "assignment add and remove are separate and stale changes cannot overwrite newer selections",
    async () => {
      await seed("assignment-target");
      const mailRole = await role("assignment-mail", ["mail.access"]),
        driveRole = await role("assignment-drive", ["drive.access"]);
      const assigner = await grant("only-assign", [
        "admin.users.roles.assign",
        "mail.access",
        "drive.access",
      ]);
      const old = await request("/api/users/assignment-target/roles", { token });
      await request("/api/users/assignment-target/roles", {
        method: "PUT",
        token: assigner,
        data: { role_ids: [mailRole.id], version: old.version },
        expected: 204,
      });
      await request("/api/users/assignment-target/roles", {
        method: "PUT",
        token: assigner,
        data: { role_ids: [] },
        expected: 403,
      });
      await request("/api/users/assignment-target/roles", {
        method: "PUT",
        token,
        data: { role_ids: [driveRole.id], version: old.version },
        expected: 409,
      });
      const current = await request("/api/users/assignment-target/roles", { token });
      const responses = await Promise.all([
        raw("/api/users/assignment-target/roles", {
          method: "PUT",
          token,
          data: { role_ids: [driveRole.id], version: current.version },
        }),
        raw("/api/users/assignment-target/roles", {
          method: "PUT",
          token,
          data: { role_ids: [], version: current.version },
        }),
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [204, 409]);
      const remover = await grant("only-remove", [
        "admin.users.roles.remove",
        "mail.access",
        "drive.access",
      ]);
      await request("/api/users/assignment-target/roles", {
        method: "PUT",
        token: remover,
        data: { role_ids: [mailRole.id, driveRole.id] },
        expected: 403,
      });
      await request("/api/users/assignment-target/roles", {
        method: "PUT",
        token: remover,
        data: { role_ids: [] },
        expected: 204,
      });
      await request("/api/users/assignment-target/roles", {
        method: "PUT",
        token,
        data: { role_ids: [mailRole.id] },
        expected: 204,
      });
      const beforeDelete = await request("/api/users/assignment-target/roles", { token });
      await request(`/api/roles/${mailRole.id}`, { method: "DELETE", token, expected: 204 });
      assert.ok(
        (await request("/api/users/assignment-target/roles", { token })).version >
          beforeDelete.version,
      );
    },
  );
});

test("account creation retains recoverable mail provisioning when the mailbox service is unavailable", async (t) => {
  const { request, token, db } = await fixture(t, 1, { mailStore: false });
  const result = await request("/api/users", {
    method: "POST",
    token,
    data: { email_address: "pending@external.test", password: PASSWORD },
    expected: 201,
  });
  assert.equal(result.mail.mailbox.status, "provisioning");
  assert.equal((await request(`/api/users/${result.user.id}`, { token })).user.id, result.user.id);
  const retried = await request(`/api/users/${result.user.id}/mailbox`, {
    method: "POST",
    token,
    data: { domain_id: null },
  });
  assert.equal(retried.mailbox.id, result.mail.mailbox.id);
  assert.equal(
    (
      await db
        .select({ n: count() })
        .from(schema.mailMailboxes)
        .where(eq(schema.mailMailboxes.owner_user_id, result.user.id))
        .get()
    ).n,
    1,
  );
});
