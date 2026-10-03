import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { drizzle as compile } from "drizzle-orm/sqlite-proxy";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import * as schema from "../src/db/schema.ts";
import { verifyPassword } from "../src/auth/password.ts";
import { bootstrapAdministrator, ADMINISTRATOR_EMAIL } from "../scripts/bootstrap-administrator.mjs";
import { runWrangler } from "../scripts/wrangler.mjs";
import { withDatabaseConfig } from "../scripts/deploy.mjs";

const { installationState, users, userRoles, roles } = schema;
const migrations = async () => Promise.all((await readdir("migrations")).sort().map((file) => readFile(`migrations/${file}`, "utf8")));
const temporaryPassword = (logs) => logs.join("\n").match(/Temporary password: ([A-Za-z0-9_-]{32})/)?.[1];

async function fixture(t) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [{
    name: "officeflare", modules: true, scriptPath: "dist/index.js", compatibilityDate: "2026-09-29",
    d1Databases: { DB: "bootstrap-tests" }, bindings: {
      AUTH_SIGNING_KEYS: JSON.stringify({ active_kid: "test", keys: [{ ...await exportJWK(privateKey), kid: "test" }] }),
      MFA_ENCRYPTION_KEYS: JSON.stringify({ active_version: 1, keys: { 1: randomBytes(32).toString("base64url") } }),
      AUTH_ISSUER: "officeflare", AUTH_AUDIENCE: "officeflare-api",
    },
  }] }));
  t.after(() => mf.dispose());
  const binding = await mf.getD1Database("DB");
  for (const migration of await migrations()) {
    let statement = "", trigger = false;
    for (const line of migration.split("\n")) {
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
  // Execute the same Drizzle-generated statements as Wrangler, in an actual atomic D1 batch.
  const wrangler = async (args, options) => {
    assert.deepEqual(args.slice(0, 6), ["d1", "execute", "DB", "--remote", "--json", "--command"]);
    assert.equal(options.capture, true);
    const statements = args[6].split(";\n").map((query) => query.replace(/;$/, ""));
    return JSON.stringify(await binding.batch(statements.map((query) => binding.prepare(query))));
  };
  const logs = [];
  const bootstrap = () => bootstrapAdministrator({ wrangler, log: (message) => logs.push(message) });
  let requestId = 0;
  const request = async (path, { method = "GET", token, data, expected = 200 } = {}) => {
    const response = await mf.dispatchFetch(`https://office.test${path}`, { method,
      headers: { "cf-connecting-ip": `192.0.2.${++requestId}`, ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}) },
      body: data ? JSON.stringify(data) : undefined });
    assert.equal(response.status, expected, `${method} ${path}`);
    return response.json();
  };
  return { db, logs, bootstrap, request };
}

test("first deployment creates an administrator, forces password change and never resets it", async (t) => {
  const { db, logs, bootstrap, request } = await fixture(t);
  const result = await bootstrap();
  assert.equal(result.created, true);
  const password = temporaryPassword(logs);
  assert.ok(password);
  const user = await db.select().from(users).get();
  assert.equal(user.id, result.userId); assert.equal(user.email_address, ADMINISTRATOR_EMAIL);
  assert.equal(user.password_reset_required, 1); assert.ok(user.password_changed_at);
  assert.equal(await verifyPassword(password, user.password_hash), true);
  assert.equal((await db.select().from(userRoles).get()).role_id, "system-administrator");
  const marker = await db.select().from(installationState).get();
  assert.equal(marker.id, 1); assert.equal(marker.bootstrap_user_id, user.id);
  assert.ok(marker.initialized_at);
  const login = () => request("/api/auth/login", { method: "POST", data: { email_address: ADMINISTRATOR_EMAIL, password } });
  const pending = await login();
  assert.equal(pending.next, "password_reset"); assert.equal(pending.access_token, undefined);
  await request("/api/roles", { token: pending.challenge_token, expected: 401 });
  const changed = await request("/api/me/password", { method: "PUT", token: pending.challenge_token,
    data: { new_password: "my replacement administrator password" } });
  assert.equal((await request("/api/me/permissions", { token: changed.access_token })).permissions.length, 9);
  await request("/api/roles", { token: changed.access_token });
  const changedUser = await db.select().from(users).get();
  assert.equal(changedUser.password_reset_required, 0);
  logs.length = 0;
  assert.equal((await bootstrap()).created, false);
  assert.equal(temporaryPassword(logs), undefined);
  assert.deepEqual(await db.select().from(users).get(), changedUser);
  for (const update of [{ disabled_at: 1 }, { deleted_at: 1 }]) {
    await db.update(users).set(update).where(eq(users.id, user.id));
    logs.length = 0;
    assert.equal((await bootstrap()).created, false);
    assert.equal(temporaryPassword(logs), undefined);
    assert.equal((await db.select().from(users)).length, 1);
  }
  await db.delete(users).where(eq(users.id, user.id));
  assert.equal((await bootstrap()).created, false);
  assert.equal((await db.select().from(users)).length, 0);
  assert.deepEqual(await db.select().from(installationState).get(), marker);
});

test("concurrent initialization has one winner and prints one password", async (t) => {
  const { db, logs, bootstrap } = await fixture(t);
  const results = await Promise.all([bootstrap(), bootstrap()]);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal((await db.select().from(users)).length, 1);
  assert.equal((await db.select().from(userRoles)).length, 1);
  assert.equal((await db.select().from(installationState)).length, 1);
  assert.equal(logs.filter((message) => message.includes("Temporary password:")).length, 1);
});

test("existing accounts are adopted without assigning privileges or changing passwords", async (t) => {
  const { db, logs, bootstrap } = await fixture(t);
  await db.insert(users).values({ id: "existing", email_address: ADMINISTRATOR_EMAIL, password_hash: "existing-hash", deleted_at: 1 });
  const before = await db.select().from(users).get();
  assert.equal((await bootstrap()).created, false);
  assert.deepEqual(await db.select().from(users).get(), before);
  assert.equal((await db.select().from(userRoles)).length, 0);
  assert.equal((await db.select().from(installationState).get()).bootstrap_user_id, null);
  assert.equal(temporaryPassword(logs), undefined);
  await db.delete(users);
  assert.equal((await bootstrap()).created, false);
  assert.equal((await db.select().from(users)).length, 0);
});

test("failed initialization rolls back the account and marker and prints no password", async (t) => {
  const { db, logs, bootstrap } = await fixture(t);
  await db.delete(roles).where(eq(roles.id, "system-administrator"));
  await assert.rejects(bootstrap(), /Administrator initialization failed/);
  assert.equal((await db.select().from(users)).length, 0);
  assert.equal((await db.select().from(installationState)).length, 0);
  assert.equal(logs.length, 0);
});

test("Wrangler executes the initialization batch against an isolated local D1", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "officeflare-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "wrangler.jsonc");
  await writeFile(configPath, JSON.stringify({ name: "officeflare-bootstrap-test", compatibility_date: "2026-09-29",
    d1_databases: [{ binding: "DB", database_name: "bootstrap-test", migrations_dir: "migrations" }],
  }));
  await mkdir(join(directory, "migrations"));
  for (const file of (await readdir("migrations")).sort()) {
    await writeFile(join(directory, "migrations", file), await readFile(`migrations/${file}`, "utf8"));
  }
  await withDatabaseConfig({ configPath }, {}, { name: "bootstrap-test", uuid: "00000000-0000-0000-0000-000000000000" }, async (path) => {
    const flags = ["--config", path];
    await runWrangler(["d1", "migrations", "apply", "DB", "--local", ...flags], { capture: true });
    const logs = [];
    assert.equal((await bootstrapAdministrator({ flags, local: true, log: (message) => logs.push(message) })).created, true);
    assert.ok(temporaryPassword(logs));
    logs.length = 0;
    assert.equal((await bootstrapAdministrator({ flags, local: true, log: (message) => logs.push(message) })).created, false);
    assert.equal(temporaryPassword(logs), undefined);
    const db = compile(async () => { throw new Error("Query compilation only"); });
    const query = db.select({ email_address: users.email_address, password_reset_required: users.password_reset_required }).from(users);
    const sql = new SQLiteAsyncDialect().sqlToQuery(query.getSQL().inlineParams()).sql;
    const rows = JSON.parse(await runWrangler(["d1", "execute", "DB", "--local", "--json", "--command", sql, ...flags], { capture: true }));
    assert.deepEqual(rows[0].results, [{ email_address: ADMINISTRATOR_EMAIL, password_reset_required: 1 }]);
  });
});
