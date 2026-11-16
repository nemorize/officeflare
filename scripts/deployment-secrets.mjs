import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { importJWK } from "jose";
import { generateAuthKeys, managedSecretNames } from "./auth-keys.mjs";

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
async function query(flags, sql, wrangler) {
  const output = await wrangler(
    ["d1", "execute", "DB", "--remote", "--json", "--command", sql, ...flags],
    { capture: true },
  );
  const data = JSON.parse(output);
  if (
    !Array.isArray(data) ||
    data.length !== 1 ||
    data[0].success !== true ||
    !Array.isArray(data[0].results)
  )
    throw new Error("Could not confirm deployment initialization state.");
  return data[0].results;
}

async function secretNames(flags, wrangler) {
  let output;
  try {
    output = await wrangler(["secret", "list", "--format", "json", ...flags], { capture: true });
  } catch (error) {
    const message = `${error.stderr ?? ""}\n${error.message ?? ""}`;
    if (/Worker "[^"\r\n]+"(?: \(env: [^)\r\n]+\))? not found\./.test(message)) return new Set();
    throw new Error("Could not inspect Worker secrets; refusing to generate replacement keys.");
  }
  let data;
  try {
    data = JSON.parse(output);
  } catch {
    throw new Error("Invalid Worker secrets response.");
  }
  if (
    !Array.isArray(data) ||
    data.some((row) => typeof row?.name !== "string" || row.type !== "secret_text")
  )
    throw new Error("Invalid Worker secrets response.");
  return new Set(data.map((row) => row.name));
}

async function suppliedNames(path) {
  if (!path) return new Set();
  let values;
  try {
    const contents = await readFile(path, "utf8");
    values = contents.trimStart().startsWith("{") ? JSON.parse(contents) : parseEnv(contents);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error();
    for (const name of managedSecretNames) {
      if (!Object.hasOwn(values, name)) continue;
      const value = values[name];
      if (typeof value !== "string" || !value) throw new Error();
      if (name === "AUTH_SIGNING_KEYS") {
        const ring = JSON.parse(value);
        const active = ring.keys?.find((key) => key.kid === ring.active_kid);
        if (!active?.d || active.kty !== "EC" || active.crv !== "P-256") throw new Error();
        await importJWK(active, "ES256");
      } else if (name === "MFA_ENCRYPTION_KEYS") {
        const ring = JSON.parse(value);
        if (
          !Number.isSafeInteger(ring.active_version) ||
          ring.active_version < 1 ||
          !/^[A-Za-z0-9_-]{43}$/.test(ring.keys?.[ring.active_version] ?? "")
        )
          throw new Error();
      } else if (
        !/^[A-Za-z0-9_+/=-]+$/.test(value) ||
        Buffer.from(value, "base64url").length !== 32
      )
        throw new Error();
    }
  } catch {
    throw new Error(
      "Invalid deployment secrets file. Supply valid keys rather than example placeholders.",
    );
  }
  return new Set(Object.keys(values));
}

export async function ensureDeploymentSecrets(config, flags, options = {}, wrangler) {
  const supplied = await suppliedNames(options["secrets-file"]);
  const missing = (remote) =>
    managedSecretNames.filter((name) => !remote.has(name) && !supplied.has(name));
  if (!missing(await secretNames(flags, wrangler)).length) return;
  const name = literal(`secrets:${config.name}`),
    token = literal(randomUUID());
  const claim = await query(
    flags,
    `INSERT INTO deployment_locks (name, lease_token, expires_at)
    VALUES (${name}, ${token}, unixepoch() + 900)
    ON CONFLICT (name) DO UPDATE SET lease_token = excluded.lease_token, expires_at = excluded.expires_at
    WHERE deployment_locks.expires_at <= unixepoch() RETURNING lease_token;`,
    wrangler,
  );
  if (!claim.length)
    throw new Error("Another deployment is initializing Worker secrets. Retry after it completes.");
  try {
    // Recheck after the lease: a deployment that just finished may have supplied the keys.
    const absent = missing(await secretNames(flags, wrangler));
    if (!absent.length) return;
    const state = (
      await query(
        flags,
        `SELECT
      (EXISTS (SELECT 1 FROM installation_state) OR EXISTS (SELECT 1 FROM users)) AS installed,
      (EXISTS (SELECT 1 FROM mail_webhooks) OR EXISTS (SELECT 1 FROM mail_domains
        WHERE json_extract(provider_settings_json, '$.inbound.secret_ciphertext') IS NOT NULL
          OR json_extract(provider_settings_json, '$.outbound.secret_ciphertext') IS NOT NULL)) AS encrypted_mail;`,
        wrangler,
      )
    )[0];
    if (!state || ![0, 1].includes(state.installed) || ![0, 1].includes(state.encrypted_mail))
      throw new Error("Could not confirm existing installation data.");
    if (state.installed && absent.some((name) => name !== "MAIL_ENCRYPTION_KEY"))
      throw new Error(
        "An existing installation is missing authentication or MFA keys. Restore its original Secrets before deploying.",
      );
    if (state.encrypted_mail && absent.includes("MAIL_ENCRYPTION_KEY"))
      throw new Error(
        "Encrypted mail credentials exist without MAIL_ENCRYPTION_KEY. Restore the original Secret before deploying.",
      );
    const generated = await generateAuthKeys();
    const directory = await mkdtemp(join(tmpdir(), "officeflare-deployment-secrets-"));
    try {
      const path = join(directory, "secrets.json");
      await writeFile(
        path,
        JSON.stringify(Object.fromEntries(absent.map((name) => [name, generated[name]]))),
        { mode: 0o600, flag: "wx" },
      );
      // Persist before administrator bootstrap so retries never lose the installation's keys.
      try {
        await wrangler(["secret", "bulk", path, ...flags], { capture: true });
      } catch {
        throw new Error(
          "Worker secret initialization failed. Deployment stopped; existing Secrets were not replaced.",
        );
      }
      const confirmed = await secretNames(flags, wrangler);
      if (absent.some((name) => !confirmed.has(name)))
        throw new Error("Worker secret initialization could not be confirmed.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await query(
      flags,
      `DELETE FROM deployment_locks WHERE name = ${name} AND lease_token = ${token};`,
      wrangler,
    ).catch(() => {});
  }
}
