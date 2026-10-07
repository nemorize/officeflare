import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

export async function runNode(entry, args = [], { capture = false } = {}) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  if (capture) {
    const { stdout } = await promisify(execFile)(process.execPath, [entry, ...args], { env, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Command failed (${signal ?? code}).`)));
  });
}

export const runWrangler = (args, options) => runNode(cli, args, options);
export const runViteBuild = () => runNode(fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), ["build"]);
export const runTypeScript = async () => {
  const entry = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
  await runNode(entry, ["--noEmit"]);
  await runNode(entry, ["--project", "tsconfig.web.json"]);
};
