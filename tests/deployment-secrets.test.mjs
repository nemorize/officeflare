import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { importJWK, SignJWT, jwtVerify } from "jose";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { ensureDeploymentSecrets } from "../scripts/deployment-secrets.mjs";
import { generateAuthKeys, managedSecretNames } from "../scripts/auth-keys.mjs";
import { runWrangler } from "../scripts/wrangler.mjs";

const existingKeys = await generateAuthKeys();
const config = { name: "officeflare-production" };
const flags = ["--config", "/test/wrangler.jsonc", "--env", "production"];
async function fixture(t, names = [], options = {}) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      compatibilityDate: "2026-09-29",
      modules: [
        {
          type: "ESModule",
          path: "secrets-fixture.mjs",
          contents: "export default { fetch() { return new Response('ok'); } };",
        },
      ],
      d1Databases: { DB: "deployment-secrets" },
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await db.batch([
    db.prepare("CREATE TABLE users (id TEXT PRIMARY KEY)"),
    db.prepare("CREATE TABLE installation_state (id INTEGER PRIMARY KEY)"),
    db.prepare("CREATE TABLE mail_webhooks (id TEXT PRIMARY KEY)"),
    db.prepare(
      "CREATE TABLE mail_domains (id TEXT PRIMARY KEY, provider_settings_json TEXT NOT NULL)",
    ),
    db.prepare(await readFile("migrations/0033_deployment_locks.sql", "utf8")),
  ]);
  const remote = new Map(
    names.map((name) => [name, existingKeys[name] ?? "existing-provider-secret"]),
  );
  const calls = [],
    uploads = [];
  let workerExists = options.workerExists !== false;
  const wrangler = async (args, settings) => {
    calls.push(args);
    assert.deepEqual(args.slice(-flags.length), flags);
    assert.equal(settings.capture, true);
    if (args[0] === "d1") {
      assert.deepEqual(args.slice(0, 6), [
        "d1",
        "execute",
        "DB",
        "--remote",
        "--json",
        "--command",
      ]);
      const result = await db.prepare(args[6]).all();
      return JSON.stringify([result]);
    }
    assert.equal(args[0], "secret");
    if (args[1] === "list") {
      if (options.listFailure) throw new Error(options.listFailure);
      assert.deepEqual(args.slice(0, 4), ["secret", "list", "--format", "json"]);
      if (!workerExists)
        throw Object.assign(new Error("Worker not found"), {
          stderr: 'Worker "officeflare-production" (env: production) not found.',
        });
      return JSON.stringify([...remote.keys()].map((name) => ({ name, type: "secret_text" })));
    }
    assert.equal(args[1], "bulk");
    assert.equal((await stat(args[2])).mode & 0o777, 0o600);
    const values = JSON.parse(await readFile(args[2], "utf8"));
    uploads.push({ path: args[2], values });
    if (options.onBulk) await options.onBulk(values, remote);
    else for (const [name, value] of Object.entries(values)) remote.set(name, value);
    workerExists = true;
    return "Secret names uploaded";
  };
  const ensure = (supplied = {}) => ensureDeploymentSecrets(config, flags, supplied, wrangler);
  const locks = async () =>
    (await db.prepare("SELECT COUNT(*) count FROM deployment_locks").first()).count;
  return { db, remote, calls, uploads, ensure, locks, options };
}
async function secretFile(t, contents, extension = "json") {
  const directory = await mkdtemp(join(tmpdir(), "officeflare-supplied-secrets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, `secrets.${extension}`);
  await writeFile(path, contents, { mode: 0o600 });
  return { "secrets-file": path };
}

test("the build-only Worker check succeeds before any deployment secrets exist", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "officeflare-first-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "wrangler.jsonc");
  await writeFile(
    path,
    JSON.stringify({
      name: "officeflare-first-build",
      main: "worker.js",
      compatibility_date: "2026-09-29",
      secrets: { required: managedSecretNames.slice(0, 2) },
    }),
  );
  await writeFile(
    join(directory, "worker.js"),
    "export default { fetch() { return new Response('ok'); } };",
  );
  const output = await runWrangler(
    ["deploy", "--dry-run", "--outdir", join(directory, "output"), "--config", path],
    { capture: true, env: { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } },
  );
  assert.match(output, /dry-run: exiting now/);
});

test("first deployment creates valid, per-installation signing and encryption keys and preserves them on retry", async (t) => {
  const f = await fixture(t, [], { workerExists: false });
  await f.ensure();
  assert.deepEqual([...f.remote.keys()].sort(), [...managedSecretNames].sort());
  assert.equal(f.uploads.length, 1);
  const ring = JSON.parse(f.remote.get("AUTH_SIGNING_KEYS"));
  assert.equal(ring.keys[0].kid, ring.active_kid);
  const { d, ...publicJwk } = ring.keys[0];
  assert.ok(d);
  const token = await new SignJWT({ subject: "test" })
    .setProtectedHeader({ alg: "ES256" })
    .sign(await importJWK(ring.keys[0], "ES256"));
  assert.equal(
    (await jwtVerify(token, await importJWK(publicJwk, "ES256"))).payload.subject,
    "test",
  );
  const encryption = JSON.parse(f.remote.get("MFA_ENCRYPTION_KEYS"));
  assert.equal(Buffer.from(encryption.keys[encryption.active_version], "base64url").length, 32);
  assert.equal(Buffer.from(f.remote.get("MAIL_ENCRYPTION_KEY"), "base64url").length, 32);
  for (const name of managedSecretNames) assert.notEqual(f.remote.get(name), existingKeys[name]);
  const snapshot = [...f.remote];
  await f.ensure();
  assert.deepEqual([...f.remote], snapshot);
  assert.equal(f.uploads.length, 1);
  assert.equal(await f.locks(), 0);
  await assert.rejects(stat(dirname(f.uploads[0].path)), { code: "ENOENT" });
});

test("partial new setups retain configured keys and older installations can add an unused mail encryption key", async (t) => {
  const f = await fixture(t, ["MFA_ENCRYPTION_KEYS", "FCM_SERVICE_ACCOUNT"]);
  await f.ensure();
  assert.deepEqual(Object.keys(f.uploads[0].values).sort(), [
    "AUTH_SIGNING_KEYS",
    "MAIL_ENCRYPTION_KEY",
  ]);
  assert.equal(f.remote.get("MFA_ENCRYPTION_KEYS"), existingKeys.MFA_ENCRYPTION_KEYS);
  assert.equal(f.remote.get("FCM_SERVICE_ACCOUNT"), "existing-provider-secret");
  const older = await fixture(t, ["AUTH_SIGNING_KEYS", "MFA_ENCRYPTION_KEYS"]);
  await older.db.prepare("INSERT INTO users VALUES ('existing')").run();
  await older.ensure();
  assert.deepEqual(Object.keys(older.uploads[0].values), ["MAIL_ENCRYPTION_KEY"]);
  assert.equal(older.remote.get("AUTH_SIGNING_KEYS"), existingKeys.AUTH_SIGNING_KEYS);
  assert.equal(older.remote.get("MFA_ENCRYPTION_KEYS"), existingKeys.MFA_ENCRYPTION_KEYS);
});

test("existing installations never silently replace lost authentication or MFA encryption keys", async (t) => {
  for (const name of ["AUTH_SIGNING_KEYS", "MFA_ENCRYPTION_KEYS"]) {
    const f = await fixture(
      t,
      managedSecretNames.filter((candidate) => candidate !== name),
    );
    await f.db.prepare("INSERT INTO installation_state VALUES (1)").run();
    await assert.rejects(f.ensure(), /Restore its original Secrets/);
    assert.equal(f.uploads.length, 0);
    assert.equal(await f.locks(), 0);
  }
});

test("encrypted webhook and provider credentials require the original missing mail key", async (t) => {
  for (const kind of ["webhook", "inbound", "outbound"]) {
    const f = await fixture(t, ["AUTH_SIGNING_KEYS", "MFA_ENCRYPTION_KEYS"]);
    if (kind === "webhook")
      await f.db.prepare("INSERT INTO mail_webhooks VALUES ('existing')").run();
    else
      await f.db
        .prepare("INSERT INTO mail_domains VALUES ('existing', ?)")
        .bind(JSON.stringify({ [kind]: { secret_ciphertext: "existing-ciphertext" } }))
        .run();
    await assert.rejects(f.ensure(), /Restore the original Secret/);
    assert.equal(f.uploads.length, 0);
  }
});

test("permission or connection errors are not mistaken for a new Worker", async (t) => {
  for (const listFailure of ["Authentication failed", "Request timed out"]) {
    const f = await fixture(t, [], { listFailure });
    await assert.rejects(f.ensure(), /Could not inspect Worker secrets/);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.calls.length, 1);
  }
});

test("explicit secret files remain authoritative and optional provider values are not uploaded by initialization", async (t) => {
  for (const format of ["json", "env"]) {
    const contents =
      format === "json"
        ? JSON.stringify(existingKeys)
        : Object.entries(existingKeys)
            .map(([name, value]) => `${name}='${value}'`)
            .join("\n");
    const supplied = await secretFile(t, contents, format);
    const f = await fixture(t);
    await f.ensure(supplied);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.calls.length, 1);
  }
  const provider = await secretFile(
    t,
    JSON.stringify({ FCM_SERVICE_ACCOUNT: "explicit-provider-secret" }),
  );
  const f = await fixture(t);
  await f.ensure(provider);
  assert.deepEqual(Object.keys(f.uploads[0].values).sort(), [...managedSecretNames].sort());
  assert.equal(f.remote.has("FCM_SERVICE_ACCOUNT"), false);
  assert.equal(
    JSON.parse(await readFile(provider["secrets-file"], "utf8")).FCM_SERVICE_ACCOUNT,
    "explicit-provider-secret",
  );
});

test("invalid supplied keys stop without leaking their values or changing remote state", async (t) => {
  const supplied = await secretFile(
    t,
    JSON.stringify({ AUTH_SIGNING_KEYS: "private-invalid-canary" }),
  );
  const f = await fixture(t);
  await assert.rejects(f.ensure(supplied), (error) => {
    assert.match(error.message, /Invalid deployment secrets file/);
    assert.ok(!error.message.includes("private-invalid-canary"));
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test("concurrent first deployments cannot overwrite one another's generated keys", async (t) => {
  let proceed, reached;
  const hold = new Promise((resolve) => (proceed = resolve));
  const entered = new Promise((resolve) => (reached = resolve));
  t.after(() => proceed());
  const f = await fixture(t, [], {
    onBulk: async (values, remote) => {
      reached();
      await hold;
      for (const [name, value] of Object.entries(values)) remote.set(name, value);
    },
  });
  const first = f.ensure();
  await entered;
  await assert.rejects(f.ensure(), /Another deployment/);
  proceed();
  await first;
  const snapshot = [...f.remote];
  await f.ensure();
  assert.deepEqual([...f.remote], snapshot);
  assert.equal(f.uploads.length, 1);
  assert.equal(await f.locks(), 0);
});

test("failed partial uploads leave stable keys for retry and always remove temporary files and locks", async (t) => {
  const f = await fixture(t, [], {
    onBulk: async (values, remote) => {
      remote.set("AUTH_SIGNING_KEYS", values.AUTH_SIGNING_KEYS);
      throw new Error("private-failure-canary");
    },
  });
  await assert.rejects(f.ensure(), (error) => {
    assert.match(error.message, /secret initialization failed/);
    assert.ok(!error.message.includes("private-failure-canary"));
    return true;
  });
  const signing = f.remote.get("AUTH_SIGNING_KEYS");
  assert.equal(await f.locks(), 0);
  await assert.rejects(stat(dirname(f.uploads[0].path)), { code: "ENOENT" });
  f.options.onBulk = undefined;
  await f.ensure();
  assert.equal(f.remote.get("AUTH_SIGNING_KEYS"), signing);
  assert.deepEqual(Object.keys(f.uploads[1].values).sort(), [
    "MAIL_ENCRYPTION_KEY",
    "MFA_ENCRYPTION_KEYS",
  ]);
  assert.equal(await f.locks(), 0);
});
