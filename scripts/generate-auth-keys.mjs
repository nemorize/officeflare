import { generateKeyPair, exportJWK } from "jose";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? ".dev.vars");
const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const kid = randomUUID();
const signing = { active_kid: kid, keys: [{ ...await exportJWK(privateKey), kid }] };
const encryption = { active_version: 1, keys: { 1: randomBytes(32).toString("base64url") } };
try {
  await writeFile(path, `AUTH_SIGNING_KEYS='${JSON.stringify(signing)}'\nMFA_ENCRYPTION_KEYS='${JSON.stringify(encryption)}'\n`, { flag: "wx", mode: 0o600 });
  console.log(`Created ${path}. Keep this file private; retain MFA keys when rotating secrets.`);
} catch (error) {
  if (error.code === "EEXIST") { console.error(`${path} already exists; refusing to overwrite secrets.`); process.exitCode = 1; }
  else throw error;
}
