import {
  MAX_CODE_BYTES,
  MAX_TIMEOUT_MS,
  validInput,
  type ExecutionInput,
  type ExecutionResult,
} from "./execution.ts";

const PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];
const MAX_REQUEST_BYTES = 256 * 1024;

const outputSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "timeout", "output_limit", "error"] },
    exit_code: { type: ["integer", "null"] },
    stdout: { type: "string" },
    stderr: { type: "string" },
    duration_ms: { type: "integer", minimum: 0 },
  },
  required: ["status", "exit_code", "stdout", "stderr", "duration_ms"],
  additionalProperties: false,
};

const TOOLS = ["python", "javascript"].map((language) => ({
  name: `sandbox.run_${language}`,
  description: `Run ${language === "python" ? "Python 3" : "JavaScript (Node.js)"} code in a new, temporary Linux container without Internet access. Standard library only; files are deleted after execution. Combined output is limited to 64 KiB and total execution time to 30 seconds, including container startup.`,
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", minLength: 1, maxLength: MAX_CODE_BYTES },
      timeout_ms: {
        type: "integer",
        minimum: 100,
        maximum: MAX_TIMEOUT_MS,
        default: MAX_TIMEOUT_MS,
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
  outputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}));

type Execute = (input: ExecutionInput) => Promise<ExecutionResult>;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function rpcError(id: unknown, code: number, message: string) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function authenticated(request: Request, token: string) {
  const provided = request.headers.get("Authorization");
  if (!provided || provided.length > 512) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [provided, `Bearer ${token}`].map(
      async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    ),
  );
  let difference = 0;
  for (let i = 0; i < a!.length; i++) difference |= a![i]! ^ b![i]!;
  return difference === 0;
}

async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get("Content-Length")) > MAX_REQUEST_BYTES) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RangeError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function handleRequest(request: Request, token: string | undefined, execute: Execute) {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && (path === "/" || path === "/health"))
    return json({ service: "officeflare-sandbox", mcp_endpoint: "/mcp" });
  if (path !== "/mcp") return json({ error: "Not found" }, 404);
  if (!token || !/^[\x21-\x7e]{32,256}$/.test(token))
    return json({ error: "Set EXECUTOR_TOKEN to a random token of at least 32 characters" }, 503);
  if (!(await authenticated(request, token)))
    return json({ error: "Unauthorized" }, 401, {
      "WWW-Authenticate": 'Bearer realm="officeflare-sandbox"',
    });
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json")
    return json({ error: "Content-Type must be application/json" }, 415);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: "Origin not allowed" }, 403);
  const protocol = request.headers.get("MCP-Protocol-Version");
  if (protocol && !PROTOCOL_VERSIONS.includes(protocol))
    return json({ error: "Unsupported MCP protocol version" }, 400);

  let message: unknown;
  try {
    message = await body(request);
  } catch (error) {
    return error instanceof RangeError
      ? json({ error: "Request too large" }, 413)
      : rpcError(null, -32700, "Parse error");
  }
  if (
    !object(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (message.id !== undefined &&
      !(
        typeof message.id === "string" ||
        (typeof message.id === "number" && Number.isFinite(message.id))
      )) ||
    (message.params !== undefined && !object(message.params))
  )
    return rpcError(null, -32600, "Invalid Request");

  // Notifications never execute tools and do not have JSON-RPC responses.
  if (message.id === undefined) return new Response(null, { status: 202 });
  const { id, method } = message;
  const params = (message.params ?? {}) as RecordValue;
  const result = (value: unknown) => json({ jsonrpc: "2.0", id, result: value });
  if (method === "initialize") {
    return result({
      protocolVersion: PROTOCOL_VERSIONS.includes(String(params.protocolVersion))
        ? params.protocolVersion
        : PROTOCOL_VERSIONS.at(-1),
      capabilities: { tools: {} },
      serverInfo: { name: "officeflare-sandbox", version: "0.1.0" },
    });
  }
  if (method === "ping") return result({});
  if (method === "tools/list") return result({ tools: TOOLS });
  if (method !== "tools/call") return rpcError(id, -32601, "Method not found");
  const tool = TOOLS.find((tool) => tool.name === params.name);
  if (!tool || !object(params.arguments))
    return rpcError(id, -32602, "Unknown tool or invalid arguments");
  const input = {
    ...params.arguments,
    language: tool.name === "sandbox.run_python" ? "python" : "javascript",
    timeout_ms: params.arguments.timeout_ms ?? MAX_TIMEOUT_MS,
  };
  // Do not allow callers to override fields added by the server.
  if (
    Object.keys(params.arguments).some((key) => !["code", "timeout_ms"].includes(key)) ||
    !validInput(input)
  )
    return rpcError(
      id,
      -32602,
      "Expected code (1–65536 UTF-8 bytes) and optional timeout_ms (100–30000)",
    );
  try {
    const output = await execute(input);
    return result({
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
      isError: output.status !== "completed" || output.exit_code !== 0,
    });
  } catch {
    return result({
      isError: true,
      content: [{ type: "text", text: "Sandbox unavailable. Try again later." }],
    });
  }
}
