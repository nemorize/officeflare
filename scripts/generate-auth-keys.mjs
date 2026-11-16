import { randomBytes } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateAuthKeys } from "./auth-keys.mjs";

const path = resolve(process.argv[2] ?? ".dev.vars");
const mailKeyLine = `MAIL_ENCRYPTION_KEY='${randomBytes(32).toString("base64url")}'\n`;
try {
  const keys = await generateAuthKeys();
  await writeFile(
    path,
    Object.entries(keys)
      .map(([name, value]) => `${name}='${value}'\n`)
      .join(""),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Created ${path}. Keep this file private; retain encryption keys when rotating secrets.`,
  );
} catch (error) {
  if (error.code === "EEXIST") {
    const existing = await readFile(path, "utf8");
    const mailKeyAssignment = /^\s*(?:export\s+)?MAIL_ENCRYPTION_KEY\s*=([^\r\n]*)/m.exec(existing);
    if (mailKeyAssignment) {
      const configuredValue = mailKeyAssignment[1]
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2")
        .trim();
      if (configuredValue && !/^replace(?:[-_]|$)/i.test(configuredValue)) {
        console.error(`${path} already contains MAIL_ENCRYPTION_KEY; refusing to rotate secrets.`);
        process.exitCode = 1;
      } else {
        await writeFile(path, existing.replace(mailKeyAssignment[0], mailKeyLine.trimEnd()), {
          mode: 0o600,
        });
        console.log(`Added MAIL_ENCRYPTION_KEY to ${path} without changing existing keys.`);
      }
    } else {
      await appendFile(path, `${existing.endsWith("\n") || !existing ? "" : "\n"}${mailKeyLine}`);
      console.log(`Added MAIL_ENCRYPTION_KEY to ${path} without changing existing keys.`);
    }
  } else throw error;
}
