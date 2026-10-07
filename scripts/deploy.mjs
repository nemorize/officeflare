import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { unstable_readConfig as readConfig, experimental_readRawConfig as readRawConfig } from "wrangler";
import { bootstrapAdministrator } from "./bootstrap-administrator.mjs";
import { runWrangler, runTypeScript, runViteBuild } from "./wrangler.mjs";

export function deploymentOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!["--config", "--env", "--secrets-file"].includes(flag) || !value || value.startsWith("--") || flag.slice(2) in options) {
      throw new Error("Usage: npm run deploy -- [--config PATH] [--env NAME] [--secrets-file PATH]");
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

export async function ensureDatabase(config, flags, wrangler = runWrangler) {
  const binding = config.d1_databases?.find((entry) => entry.binding === "DB");
  if (!binding) throw new Error("The Wrangler configuration must contain a D1 binding named DB.");
  const name = binding.database_name ?? (config.name && `${config.name}-db`);
  if (!binding.database_id && !name) throw new Error("DB needs a database_name, database_id or Worker name.");
  const list = async () => {
    const databases = JSON.parse(await wrangler(["d1", "list", "--json", ...flags], { capture: true }));
    if (!Array.isArray(databases)) throw new Error("Invalid D1 database list response.");
    return databases;
  };
  const find = (databases) => databases.find((entry) => binding.database_id ? entry.uuid === binding.database_id : entry.name === name);
  let database = find(await list());
  if (database) {
    if (!database.uuid) throw new Error("D1 database identity could not be confirmed; deployment stopped.");
    return database;
  }
  // A configured ID is authoritative, including IDs supplied by Deploy to Cloudflare.
  if (binding.database_id) throw new Error("The configured D1 database_id was not found; deployment stopped.");
  try {
    await wrangler(["d1", "create", name, "--no-update-config", ...flags], { capture: true });
  } catch (error) {
    // Concurrent first deployments may create the same named database. Other failures stop deployment.
    if (!/A database with that name already exists/.test(error.stderr ?? error.message)) throw error;
  }
  database = find(await list());
  if (!database?.uuid) throw new Error("D1 creation could not be confirmed; deployment stopped.");
  return database;
}

export async function withDatabaseConfig(config, options, database, action) {
  const { rawConfig } = readRawConfig({ config: config.configPath });
  const snapshot = structuredClone(rawConfig);
  const environment = options.env ? snapshot.env?.[options.env] : snapshot;
  if (!environment?.d1_databases?.some((entry) => entry.binding === "DB")) throw new Error("DB binding missing from the deployment configuration.");
  environment.d1_databases = environment.d1_databases.map((entry) => entry.binding === "DB" ?
    { ...entry, database_id: database.uuid, database_name: database.name } : entry);
  // Same directory preserves relative entrypoint, migration and asset paths.
  // Pin the confirmed DB for every remaining step without writing account IDs to the source config.
  const path = join(dirname(config.configPath), `.officeflare-deploy-${randomUUID()}.jsonc`);
  await writeFile(path, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
  try { return await action(path); }
  finally { await rm(path, { force: true }); }
}

export async function deploy(options = {}, {
  loadConfig = readConfig, wrangler = runWrangler, typecheck = runTypeScript, buildWeb = runViteBuild,
  bootstrap = bootstrapAdministrator, bindDatabase = withDatabaseConfig, log = console.log,
} = {}) {
  const config = loadConfig(options, { hideWarnings: true });
  if (!config.configPath) throw new Error("A Wrangler configuration file is required.");
  const flags = ["--config", config.configPath, ...(options.env ? ["--env", options.env] : [])];
  const secrets = options["secrets-file"] ? ["--secrets-file", resolve(options["secrets-file"])] : [];
  log("Checking types and building the web UI and Worker...");
  await wrangler(["types", ...flags]);
  await typecheck();
  await buildWeb();
  await wrangler(["deploy", "--dry-run", "--outdir", "dist", ...secrets, ...flags]);
  log("Preparing the D1 database...");
  const database = await ensureDatabase(config, flags, wrangler);
  await bindDatabase(config, options, database, async (path) => {
    const boundFlags = ["--config", path, ...(options.env ? ["--env", options.env] : [])];
    log("Applying D1 migrations...");
    await wrangler(["d1", "migrations", "apply", "DB", "--remote", ...boundFlags]);
    log("Initializing the first administrator...");
    await bootstrap({ flags: boundFlags, wrangler, log });
    log("Deploying the Worker...");
    await wrangler(["deploy", ...secrets, ...boundFlags]);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => deploy(deploymentOptions(process.argv.slice(2)))).catch((error) => {
    console.error(error.stderr?.trim() || error.message);
    process.exitCode = 1;
  });
}
