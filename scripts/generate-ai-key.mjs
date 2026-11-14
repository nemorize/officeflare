import { randomBytes } from "node:crypto";
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const path = resolve(process.argv[2] ?? ".dev.vars");
let existing = "";
let exists = true;
try {
  existing = await readFile(path, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  exists = false;
}
if (/^\s*(?:export\s+)?AI_ENCRYPTION_KEYS\s*=/m.test(existing)) {
  console.error("AI_ENCRYPTION_KEYS is already configured; refusing to rotate it.");
  process.exitCode = 1;
} else {
  const key = JSON.stringify({
    active_version: 1,
    keys: { 1: randomBytes(32).toString("base64url") },
  });
  const line = `${existing && !existing.endsWith("\n") ? "\n" : ""}AI_ENCRYPTION_KEYS='${key}'\n`;
  if (exists) {
    await chmod(path, 0o600);
    await appendFile(path, line);
  } else await writeFile(path, line, { flag: "wx", mode: 0o600 });
  console.log(
    "Added AI_ENCRYPTION_KEYS. Keep the file private and retain this key when redeploying.",
  );
}
