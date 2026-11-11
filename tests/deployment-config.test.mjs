import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import {
  experimental_readRawConfig,
  getPlatformProxy,
  unstable_readConfig,
  unstable_getVarsForDev,
} from "wrangler";
import { cloudflare } from "@cloudflare/vite-plugin";
import { createServer } from "vite";
import { localSecretSettings } from "../scripts/local-secrets.ts";
import { withLocalPreviewConfig } from "../scripts/preview.mjs";

const optional = ["MAIL_ENCRYPTION_KEY", "FCM_SERVICE_ACCOUNT", "FCM_WEB_CONFIG", "FCM_VAPID_KEY"];
const required = ["AUTH_SIGNING_KEYS", "MFA_ENCRYPTION_KEYS"];
const localValues = {
  AUTH_SIGNING_KEYS: "test-signing-key",
  MFA_ENCRYPTION_KEYS: "test-mfa-key",
  MAIL_ENCRYPTION_KEY: "test-mail-key",
  FCM_SERVICE_ACCOUNT: JSON.stringify({
    project_id: "test-project",
    private_key: "test-private-key",
  }),
  FCM_WEB_CONFIG: JSON.stringify({ projectId: "test-project", apiKey: "test-api-key" }),
  FCM_VAPID_KEY: "test-public-key",
};
async function fixture(t, values = localValues) {
  const directory = await mkdtemp(join(tmpdir(), "officeflare-local-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "wrangler.jsonc");
  const source = JSON.stringify({
    name: "local-config-test",
    main: "worker.js",
    compatibility_date: "2026-09-29",
    vars: { APP_NAME: "test" },
    secrets: { required },
    env: { staging: { vars: { APP_NAME: "staging" }, secrets: { required } } },
  });
  await writeFile(configPath, source);
  await writeFile(
    join(directory, "worker.js"),
    "export default { fetch(request, env) { return Response.json(env); } };",
  );
  const devVars = (entries) =>
    Object.entries(entries)
      .map(([name, value]) => `${name}='${value}'`)
      .join("\n");
  await writeFile(join(directory, ".dev.vars"), devVars(values));
  return { directory, configPath, source, devVars };
}

test("public deployment defaults contain no account or domain and keep optional values out of installer secrets", async () => {
  const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
  for (const key of ["account_id", "routes", "addresses"]) assert.equal(rawConfig[key], undefined);
  assert.equal(rawConfig.vars.MAIL_RENDER_ORIGIN, undefined);
  assert.equal(rawConfig.keep_vars, true);
  assert.deepEqual(rawConfig.secrets.required, required);
  const installer = parseEnv(await readFile(".dev.vars.example", "utf8"));
  assert.deepEqual(Object.keys(installer).sort(), [...required, "MAIL_ENCRYPTION_KEY"].sort());
  for (const name of optional) assert.ok(!rawConfig.secrets.required.includes(name));
});

test("optional local values reach Wrangler preview without changing production secret requirements", async (t) => {
  const { configPath, source } = await fixture(t);
  const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  const settings = localSecretSettings(config);
  assert.deepEqual(config.secrets.required, required);
  for (const name of optional) assert.ok(settings.required.includes(name));
  assert.ok(!JSON.stringify(settings).includes("test-private-key"));
  const bindings = unstable_getVarsForDev(
    configPath,
    undefined,
    config.vars,
    undefined,
    true,
    settings,
  );
  for (const [name, value] of Object.entries(localValues))
    assert.equal(bindings[name].value, value);
  let temporary;
  await withLocalPreviewConfig({ config: configPath }, async (path) => {
    temporary = path;
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(path, "utf8")).includes("test-private-key"));
    const proxy = await getPlatformProxy({ configPath: path, persist: false });
    try {
      for (const [name, value] of Object.entries(localValues)) assert.equal(proxy.env[name], value);
    } finally {
      await proxy.dispose();
    }
  });
  await assert.rejects(stat(temporary), { code: "ENOENT" });
  assert.equal(await readFile(configPath, "utf8"), source);
});

test("omitted optional values remain optional and named local files follow Wrangler precedence", async (t) => {
  const { directory, configPath, devVars, source } = await fixture(t, {
    AUTH_SIGNING_KEYS: "test-signing-key",
    MFA_ENCRYPTION_KEYS: "test-mfa-key",
  });
  let config = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  assert.deepEqual(localSecretSettings(config).required, required);
  await writeFile(
    join(directory, ".dev.vars.staging"),
    devVars({ ...localValues, FCM_VAPID_KEY: "staging-public-key" }),
  );
  let temporary;
  await assert.rejects(
    withLocalPreviewConfig({ config: configPath, env: "staging" }, async (path) => {
      temporary = path;
      config = unstable_readConfig({ config: path, env: "staging" }, { hideWarnings: true });
      const bindings = unstable_getVarsForDev(
        path,
        undefined,
        config.vars,
        "staging",
        true,
        config.secrets,
      );
      assert.equal(bindings.FCM_VAPID_KEY.value, "staging-public-key");
      throw new Error("test callback failure");
    }),
    /test callback failure/,
  );
  await assert.rejects(stat(temporary), { code: "ENOENT" });
  assert.equal(await readFile(configPath, "utf8"), source);
  await writeFile(join(directory, "selected.env"), devVars(localValues));
  await withLocalPreviewConfig({ config: configPath, envFiles: ["selected.env"] }, async (path) => {
    const selected = unstable_readConfig({ config: path }, { hideWarnings: true });
    const bindings = unstable_getVarsForDev(
      path,
      ["selected.env"],
      selected.vars,
      undefined,
      true,
      selected.secrets,
    );
    assert.equal(bindings.FCM_VAPID_KEY.value, localValues.FCM_VAPID_KEY);
  });
});

test("Vite dev passes optional local credentials through the Cloudflare plugin", async (t) => {
  const { directory, configPath } = await fixture(t);
  const server = await createServer({
    configFile: false,
    root: directory,
    logLevel: "error",
    plugins: [
      cloudflare({
        configPath,
        inspectorPort: false,
        config(config) {
          config.secrets = localSecretSettings(config);
        },
      }),
    ],
    server: { host: "127.0.0.1", port: 0 },
  });
  t.after(() => server.close());
  await server.listen();
  const port = server.httpServer.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  const env = await response.json();
  for (const [name, value] of Object.entries(localValues)) assert.equal(env[name], value);
});
