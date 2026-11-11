import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { applicationHostname } from "../shared/application-host.ts";

export function deploymentHostnames(config, output) {
  const deployments = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "deploy");
  const latest = deployments.at(-1);
  const targets = [
    ...(latest?.targets ?? []),
    ...(latest?.deployment_urls ?? []),
    ...(config.routes ?? []).map((route) => (typeof route === "string" ? route : route.pattern)),
  ];
  return [...new Set(targets.map(applicationHostname).filter(Boolean))].sort();
}

// Keep the output file supplied by Workers Builds usable by its deployment tracker.
export async function deployAndRememberHosts(
  config,
  args,
  flags,
  wrangler,
  environment = process.env,
) {
  let directory;
  const external =
    environment.WRANGLER_OUTPUT_FILE_PATH || environment.WRANGLER_OUTPUT_FILE_DIRECTORY;
  if (!external) directory = await mkdtemp(join(tmpdir(), "officeflare-deploy-hosts-"));
  const path =
    environment.WRANGLER_OUTPUT_FILE_PATH ||
    join(
      environment.WRANGLER_OUTPUT_FILE_DIRECTORY || directory,
      `wrangler-output-${randomUUID()}.json`,
    );
  try {
    await wrangler(args, { env: { WRANGLER_OUTPUT_FILE_PATH: path } });
    const output = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const hosts = deploymentHostnames(config, output);
    if (hosts.length) {
      const value = JSON.stringify(hosts).replaceAll("'", "''");
      await wrangler(
        [
          "d1",
          "execute",
          "DB",
          "--remote",
          "--json",
          "--command",
          `INSERT OR IGNORE INTO mail_application_hosts (hostname) SELECT value FROM json_each('${value}');`,
          ...flags,
        ],
        { capture: true },
      );
    }
    return hosts;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
