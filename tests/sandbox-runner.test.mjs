import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";
import { handleRequest } from "../runners/cloudflare-sandbox/src/mcp.ts";

const built = await build({
  stdin: {
    contents: `export { remoteMCP, remoteTools } from "./src/mcp/client.ts";
      export { seal } from "./src/ai/secrets.ts";
      export { validateSchema } from "./src/ai/json-schema.ts";`,
    resolveDir: process.cwd(),
    sourcefile: "sandbox-client-test.ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json");',
  },
});
const { remoteMCP, remoteTools, seal, validateSchema } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64")
);

test("Officeflare discovers and invokes the standalone runner using an encrypted connection API key", async () => {
  const token = randomBytes(32).toString("hex");
  const connection = {
    id: "sandbox-connection",
    server_id: "sandbox-server",
    status: "connected",
    credential_expires_at: null,
  };
  const server = { endpoint_url: "https://sandbox.example/mcp", config_json: "{}" };
  const env = {
    AUTH_ISSUER: "sandbox-test",
    AI_ENCRYPTION_KEYS: JSON.stringify({
      active_version: 1,
      keys: { 1: randomBytes(32).toString("base64url") },
    }),
    DB: {
      withSession() {
        return {
          prepare(query) {
            return {
              bind() {
                return {
                  async first() {
                    return query.includes("FROM ai_mcp_servers") ? server : connection;
                  },
                };
              },
            };
          },
        };
      },
    },
  };
  connection.secret_envelope_json = await seal(env, "mcp:" + connection.id, { api_key: token });
  const methods = [];
  let executions = 0;
  const output = { status: "completed", exit_code: 0, stdout: "2\n", stderr: "", duration_ms: 5 };
  const fetcher = async (url, init) => {
    if (new URL(url).hostname === "cloudflare-dns.com")
      return Response.json({ Status: 0, Answer: [{ type: 1, data: "104.16.123.96" }] });
    const request = new Request(url, init);
    assert.equal(request.headers.get("Authorization"), `Bearer ${token}`);
    methods.push((await request.clone().json()).method);
    return handleRequest(request, token, async (input) => {
      executions++;
      assert.equal(input.language, "python");
      assert.equal(input.code, "print(1 + 1)");
      return output;
    });
  };
  const tools = await remoteTools(env, connection, fetcher);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["sandbox.run_python", "sandbox.run_javascript"],
  );
  assert.equal(executions, 0);
  const result = await remoteMCP(
    env,
    connection,
    "tools/call",
    {
      name: tools[0].name,
      arguments: { code: "print(1 + 1)" },
    },
    fetcher,
  );
  assert.deepEqual(result.structuredContent, output);
  validateSchema(tools[0].outputSchema, result.structuredContent);
  assert.equal(result.isError, false);
  assert.equal(executions, 1);
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
});
