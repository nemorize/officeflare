import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { localSecretSettings } from "./local-secrets.ts";
import { runWrangler } from "./wrangler.mjs";

export async function withLocalPreviewConfig(options, action) {
  const config = unstable_readConfig(options, { hideWarnings: true });
  const { rawConfig } = experimental_readRawConfig({ config: config.configPath });
  const snapshot = structuredClone(rawConfig);
  const target = options.env ? ((snapshot.env ??= {})[options.env] ??= {}) : snapshot;
  const secrets = localSecretSettings(config, options.env, options.envFiles);
  if (secrets) target.secrets = secrets;
  // Only names are added to this local snapshot. Secret values stay in .dev.vars/.env.
  const path = join(dirname(config.configPath), `.officeflare-dev-${randomUUID()}.jsonc`);
  await writeFile(path, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
  try {
    return await action(path);
  } finally {
    await rm(path, { force: true });
  }
}

export async function preview(args = []) {
  const { values } = parseArgs({
    args,
    strict: false,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      env: { type: "string", short: "e" },
      "env-file": { type: "string", multiple: true },
    },
  });
  if (values.remote) return runWrangler(["dev", ...args]);
  const forwarded = [];
  for (let index = 0; index < args.length; index++) {
    if (["--config", "-c"].includes(args[index])) index++;
    else if (!args[index].startsWith("--config=")) forwarded.push(args[index]);
  }
  return withLocalPreviewConfig(
    { config: values.config, env: values.env, envFiles: values["env-file"] },
    (path) => runWrangler(["dev", ...forwarded, "--config", path]),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preview(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
