import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/generate-auth-keys.mjs", import.meta.url));
function cleanNodeEnv() {
  const env = { ...process.env };
  delete env.DYLD_INSERT_LIBRARIES;
  return env;
}
function generatedMailKey(contents) {
  const value = /^MAIL_ENCRYPTION_KEY='([^']+)'$/m.exec(contents)?.[1];
  assert.ok(value, "MAIL_ENCRYPTION_KEY is present");
  assert.equal(Buffer.from(value, "base64url").length, 32);
  return value;
}

test("auth key generation creates and adds a stable mail encryption key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "officeflare-auth-keys-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fresh = join(directory, "fresh.vars");
  execFileSync(process.execPath, [script, fresh], { env: cleanNodeEnv() });
  const freshContents = await readFile(fresh, "utf8");
  generatedMailKey(freshContents);
  assert.match(freshContents, /^AUTH_SIGNING_KEYS=/m);
  assert.match(freshContents, /^MFA_ENCRYPTION_KEYS=/m);
  assert.equal((await stat(fresh)).mode & 0o777, 0o600);

  const template = join(directory, "template.vars");
  await writeFile(template, "AUTH_SIGNING_KEYS='keep-auth'\nMAIL_ENCRYPTION_KEY='replace-with-32-random-bytes-in-base64url'\n");
  execFileSync(process.execPath, [script, template], { env: cleanNodeEnv() });
  const templateContents = await readFile(template, "utf8");
  assert.ok(templateContents.startsWith("AUTH_SIGNING_KEYS='keep-auth'\n"));
  generatedMailKey(templateContents);

  const existing = join(directory, "existing.vars");
  const original = "AUTH_SIGNING_KEYS='keep-auth'\nMFA_ENCRYPTION_KEYS='keep-mfa'\n";
  await writeFile(existing, original, { mode: 0o600 });
  execFileSync(process.execPath, [script, existing], { env: cleanNodeEnv() });
  const updated = await readFile(existing, "utf8");
  assert.ok(updated.startsWith(original));
  const existingMailKey = generatedMailKey(updated);

  const rerun = spawnSync(process.execPath, [script, existing], { env: cleanNodeEnv(), encoding: "utf8" });
  assert.notEqual(rerun.status, 0);
  assert.match(rerun.stderr, /refusing to rotate secrets/);
  assert.equal(await readFile(existing, "utf8"), updated);
  assert.equal(generatedMailKey(updated), existingMailKey);
});
