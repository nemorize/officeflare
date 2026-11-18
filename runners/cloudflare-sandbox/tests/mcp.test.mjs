import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/mcp.ts";

const token = "test-executor-token-".repeat(3);
const completed = { status: "completed", exit_code: 0, stdout: "2\n", stderr: "", duration_ms: 10 };
function request(message, headers = {}, method = "POST") {
  return new Request("https://runner.example/mcp", {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    ...(method === "POST"
      ? { body: typeof message === "string" ? message : JSON.stringify(message) }
      : {}),
  });
}
const rpc = (method, params = {}, id = "call-1") => ({ jsonrpc: "2.0", id, method, params });
const call = (args = { code: "print(1 + 1)" }, name = "sandbox.run_python") =>
  rpc("tools/call", { name, arguments: args });

test("all MCP operations authenticate before execution, including initialization and discovery", async () => {
  for (const message of [rpc("initialize"), rpc("tools/list"), call()]) {
    let calls = 0;
    const response = await handleRequest(
      request(message, { Authorization: "Bearer wrong" }),
      token,
      async () => {
        calls++;
      },
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("WWW-Authenticate"), 'Bearer realm="officeflare-sandbox"');
    assert.equal(calls, 0);
  }
});

test("missing, short, or whitespace-containing configured tokens fail closed", async () => {
  for (const secret of [undefined, "", "short", "a".repeat(32) + " "]) {
    const response = await handleRequest(request(call()), secret, async () =>
      assert.fail("execution"),
    );
    assert.equal(response.status, 503);
  }
});

test("Officeflare initialization, notification, discovery, and invocation sequence works without sessions", async () => {
  const initialized = await handleRequest(
    request(rpc("initialize", { protocolVersion: "2025-11-25" })),
    token,
    async () => assert.fail("execution"),
  );
  assert.equal((await initialized.json()).result.protocolVersion, "2025-11-25");
  assert.equal(initialized.headers.get("Mcp-Session-Id"), null);
  const headers = { "MCP-Protocol-Version": "2025-11-25" };
  const notified = await handleRequest(
    request({ jsonrpc: "2.0", method: "notifications/initialized" }, headers),
    token,
    async () => assert.fail("execution"),
  );
  assert.equal(notified.status, 202);
  const discovered = await handleRequest(request(rpc("tools/list"), headers), token, async () =>
    assert.fail("execution"),
  );
  assert.deepEqual(
    (await discovered.json()).result.tools.map((tool) => tool.name),
    ["sandbox.run_python", "sandbox.run_javascript"],
  );
  let input;
  const called = await handleRequest(request(call(), headers), token, async (value) => {
    input = value;
    return completed;
  });
  assert.deepEqual(input, { language: "python", code: "print(1 + 1)", timeout_ms: 30000 });
  const result = (await called.json()).result;
  assert.deepEqual(result.structuredContent, completed);
  assert.deepEqual(JSON.parse(result.content[0].text), completed);
  assert.equal(result.isError, false);
});

test("JavaScript selects the matching runtime and respects a shorter requested deadline", async () => {
  const response = await handleRequest(
    request(call({ code: "console.log(2)", timeout_ms: 500 }, "sandbox.run_javascript")),
    token,
    async (input) => {
      assert.deepEqual(input, { language: "javascript", code: "console.log(2)", timeout_ms: 500 });
      return completed;
    },
  );
  assert.equal((await response.json()).result.isError, false);
});

test("invalid arguments cannot execute or override server-owned runtime fields", async () => {
  for (const args of [
    {},
    { code: " " },
    { code: "a".repeat(65537) },
    { code: "한".repeat(22000) },
    { code: "1", timeout_ms: 99 },
    { code: "1", timeout_ms: 30001 },
    { code: "1", timeout_ms: 100.5 },
    { code: "1", language: "python" },
    { code: "1", env: { EXECUTOR_TOKEN: "leak" } },
  ]) {
    const response = await handleRequest(request(call(args)), token, async () =>
      assert.fail("execution"),
    );
    assert.equal((await response.json()).error.code, -32602);
  }
  const unknown = await handleRequest(request(call({ code: "1" }, "shell.exec")), token, async () =>
    assert.fail("execution"),
  );
  assert.equal((await unknown.json()).error.code, -32602);
});

test("tool notifications cannot trigger execution", async () => {
  const message = call();
  delete message.id;
  const response = await handleRequest(request(message), token, async () =>
    assert.fail("execution"),
  );
  assert.equal(response.status, 202);
});

test("JSON-RPC parse, message, and method errors remain protocol errors", async () => {
  for (const [message, expected] of [
    ["{", -32700],
    [[], -32600],
    [rpc("unknown"), -32601],
    [rpc("ping", {}, null), -32600],
  ]) {
    const response = await handleRequest(request(message), token, async () =>
      assert.fail("execution"),
    );
    assert.equal((await response.json()).error.code, expected);
  }
});

test("request size is bounded even when Content-Length is missing", async () => {
  const response = await handleRequest(
    request(JSON.stringify(call({ code: "a".repeat(300000) }))),
    token,
    async () => assert.fail("execution"),
  );
  assert.equal(response.status, 413);
});

test("HTTP method, origin, content type, and negotiated protocol are validated", async () => {
  for (const [headers, method, status] of [
    [{}, "GET", 405],
    [{ Origin: "https://untrusted.example" }, "POST", 403],
    [{ "Content-Type": "text/plain" }, "POST", 415],
    [{ "MCP-Protocol-Version": "unknown" }, "POST", 400],
  ]) {
    const response = await handleRequest(request(rpc("ping"), headers, method), token, async () =>
      assert.fail("execution"),
    );
    assert.equal(response.status, status);
  }
});

test("execution failures are tool errors and infrastructure errors do not reveal secrets", async () => {
  for (const value of [
    { ...completed, exit_code: 1 },
    { ...completed, status: "timeout", exit_code: null },
  ]) {
    const response = await handleRequest(request(call()), token, async () => value);
    assert.equal((await response.json()).result.isError, true);
  }
  const response = await handleRequest(request(call()), token, async () => {
    throw new Error(token);
  });
  const text = await response.text();
  assert.ok(!text.includes(token));
  assert.equal(JSON.parse(text).result.isError, true);
});

test("health checks require no credentials and never allocate a container", async () => {
  const response = await handleRequest(
    new Request("https://runner.example/health"),
    undefined,
    async () => assert.fail("execution"),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mcp_endpoint, "/mcp");
});
