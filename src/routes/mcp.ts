import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, AuthContext } from "../auth/types";
import { uuid } from "../auth/types";
import { fail } from "../ai/errors";
import { safeAPIError } from "../ai/http";
import { beginTool } from "../ai/tool-meter";
import { settle } from "../ai/quota";
import { canonical, object, parse, text } from "../ai/store";
import { authenticateMCP, scopeTool, mcpOAuth, mcpConnections } from "../mcp/authorization";
import { availableTools, builtinTool, runBuiltinTool } from "../mcp/registry";
import { getOperation, mcpOperations, proposeOperation } from "../mcp/operations";

const versions = ["2025-03-26", "2025-06-18", "2025-11-25"];
const mcp = new Hono<AppEnv>();
mcp.onError(safeAPIError);
mcp.route("/oauth", mcpOAuth);
mcp.route("/", mcpConnections);
mcp.route("/operations", mcpOperations);
mcp.options("/", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  c.header(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, MCP-Protocol-Version, Idempotency-Key",
  );
  return c.body(null, 204);
});
mcp.get("/", async (c) => {
  await authenticateMCP(c);
  return c.body(null, 405);
});
mcp.post("/", async (c) => {
  const auth = await authenticateMCP(c),
    version = c.req.header("mcp-protocol-version"),
    accept = c.req.header("accept") ?? "";
  if (
    (version && !versions.includes(version)) ||
    !accept.includes("application/json") ||
    !accept.includes("text/event-stream")
  )
    fail(400, "AI_INVALID_INPUT");
  const origin = c.req.header("origin");
  if (origin) c.header("Access-Control-Allow-Origin", origin);
  const request = object(await c.req.json());
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string")
    return c.json(
      {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32600, message: t("mcp.invalidRequest") },
      },
      400,
    );
  if (!("id" in request)) return c.body(null, 202);
  if (
    !(typeof request.id === "string" || typeof request.id === "number") ||
    String(request.id).length > 128
  )
    fail(400, "AI_INVALID_INPUT");
  const params = request.params === undefined ? {} : object(request.params);
  let result: unknown;
  if (request.method === "initialize")
    result = {
      protocolVersion: versions.includes(String(params.protocolVersion))
        ? params.protocolVersion
        : "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "officeflare", version: "0.1.0" },
      instructions: t("mcp.instructions"),
    };
  else if (request.method === "ping") result = {};
  else if (request.method === "tools/list")
    result = {
      tools: [
        ...(await availableTools(c.env, auth.principal))
          .filter((tool) => auth.scopes.includes(tool.scope))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: {
              readOnlyHint: tool.execution === "read",
              destructiveHint: tool.execution !== "read",
              idempotentHint: tool.replay === "idempotent",
              openWorldHint: tool.execution === "external",
            },
          })),
        {
          name: "officeflare.get_operation",
          description: t("mcp.getOperation"),
          inputSchema: {
            type: "object",
            properties: { operation_id: { type: "string" } },
            required: ["operation_id"],
            additionalProperties: false,
          },
        },
      ],
    };
  else if (request.method === "tools/call") {
    try {
      const name = text(params.name, 128),
        args = object(params.arguments ?? {});
      let value: unknown;
      if (name === "officeflare.get_operation")
        value = await getOperation(c.env, auth, text(args.operation_id, 200));
      else {
        const tool = builtinTool(name);
        if (!tool) fail(404, "AI_NOT_FOUND");
        await scopeTool(c.env, auth, tool, args);
        if (tool.execution !== "read")
          value = await proposeOperation(
            c.env,
            auth,
            name,
            args,
            c.req.header("idempotency-key") ?? uuid(),
          );
        else {
          const operationId = uuid(),
            reservation = await beginTool(c.env, auth.principal, operationId);
          try {
            value = await runBuiltinTool(c.env, auth.principal, name, args, operationId);
          } finally {
            await settle(c.env, reservation.id, { tool_calls: 1 });
          }
          if (name === "mail.list_mailboxes" && auth.constraints.mailbox_ids) {
            const output = object(value);
            output.mailboxes = (output.mailboxes as { id: string }[]).filter((item) =>
              auth.constraints.mailbox_ids!.includes(item.id),
            );
          }
          if (name === "calendar.list" && auth.constraints.calendar_ids) {
            const output = object(value);
            output.calendars = (output.calendars as { id: string }[]).filter((item) =>
              auth.constraints.calendar_ids!.includes(item.id),
            );
          }
        }
      }
      const encoded = canonical(value);
      if (new TextEncoder().encode(encoded).length > 256 * 1024) fail(413, "AI_LIMIT_REACHED");
      result = {
        content: [{ type: "text", text: encoded }],
        structuredContent:
          value && typeof value === "object" && !Array.isArray(value) ? value : { result: value },
        isError: false,
      };
    } catch (error) {
      result = {
        content: [
          {
            type: "text",
            text: error instanceof HTTPException ? error.message : t("mcp.toolFailed"),
          },
        ],
        isError: true,
      };
    }
  } else
    return c.json({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: t("mcp.methodNotFound") },
    });
  return c.json({ jsonrpc: "2.0", id: request.id, result });
});
export default mcp;
