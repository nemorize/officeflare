import { Hono } from "hono";
import { requirePermission } from "../authorization/access";
import { now, uuid, type AppEnv } from "../auth/types";
import {
  availableTools,
  builtinTool,
  ensureToolRecord,
  runBuiltinTool,
  toolIntent,
} from "../mcp/registry";
import { remoteMCP, remoteTools, type MCPConnection } from "../mcp/client";
import { fail } from "./errors";
import { assertSchema, validateSchema } from "./json-schema";
import { seal } from "./secrets";
import { startConnectionOAuth } from "./oauth";
import {
  canonical,
  fields,
  first,
  flag,
  hash,
  identityGuard,
  integer,
  object,
  parse,
  rows,
  session,
  statement,
  text,
} from "./store";
import {
  userPrincipal,
  type AIEnv,
  type AIPrincipal,
  type AITool,
  type ObjectValue,
} from "./types";

export interface RoomTool extends AITool {
  id: string;
  serverId: string;
  connectionId: string;
  connectionVersion: number;
  schemaHash: string;
  execution: "read" | "write" | "external";
  intent: (args: ObjectValue) => Promise<string>;
  execute: (args: ObjectValue, key: string) => Promise<unknown>;
}
export async function connectionTools(
  env: AIEnv,
  principal: AIPrincipal,
  connection: MCPConnection,
): Promise<RoomTool[]> {
  if (
    principal.kind !== "user" ||
    connection.owner_user_id !== principal.userId ||
    connection.status !== "connected"
  )
    fail(403, "AI_FORBIDDEN");
  const server = await first<{
    id: string;
    transport: string;
    builtin_key: string;
    version: number;
  }>(env, "SELECT * FROM ai_mcp_servers WHERE id=? AND enabled=1", connection.server_id);
  if (!server) fail(404, "AI_NOT_FOUND");
  if (server.transport === "builtin") {
    const definitions = (await availableTools(env, principal)).filter(
      (tool) => tool.server === server.builtin_key,
    );
    return Promise.all(
      definitions.map(async (definition): Promise<RoomTool> => {
        const record = await ensureToolRecord(env, definition);
        return {
          ...definition,
          id: record.toolId,
          serverId: server.id,
          connectionId: connection.id,
          connectionVersion: connection.version,
          schemaHash: record.schemaHash,
          intent: async (args) =>
            hash([
              (await toolIntent(env, principal, definition, args)).snapshot_hash,
              connection.version,
              server.version,
            ]),
          execute: async (args, key) => {
            await liveConnection(env, principal, connection, server.version);
            return runBuiltinTool(env, principal, definition.name, args, key);
          },
        };
      }),
    );
  }
  const definitions = await remoteTools(env, connection);
  const result: RoomTool[] = [];
  for (const definition of definitions) {
    const schemaHash = await hash([
      definition.inputSchema,
      definition.outputSchema ?? null,
      definition.description,
    ]);
    const id = "remote:" + (await hash([server.id, definition.name, schemaHash]));
    let record = await first<{ id: string }>(env, "SELECT id FROM ai_mcp_tools WHERE id=?", id);
    if (!record) {
      await statement(
        env,
        "INSERT INTO ai_mcp_tools(id,server_id,name,revision,description,input_schema_json,output_schema_json,schema_hash,execution_class,approval_policy,replay_policy,enabled) SELECT ?,?,?,COALESCE((SELECT max(revision)+1 FROM ai_mcp_tools WHERE server_id=? AND name=?),1),?,?,?,?,'external','always','never',1 ON CONFLICT(id) DO NOTHING",
        id,
        server.id,
        definition.name,
        server.id,
        definition.name,
        definition.description,
        canonical(definition.inputSchema),
        definition.outputSchema ? canonical(definition.outputSchema) : null,
        schemaHash,
      ).run();
    }
    const name = "mcp_" + connection.id.replaceAll("-", "") + "." + definition.name;
    result.push({
      ...definition,
      name,
      id,
      serverId: server.id,
      connectionId: connection.id,
      connectionVersion: connection.version,
      schemaHash,
      execution: "external",
      intent: async (args) => {
        validateSchema(definition.inputSchema, args);
        return hash([name, schemaHash, connection.version, server.version, args]);
      },
      execute: async (args) => {
        await liveConnection(env, principal, connection, server.version);
        validateSchema(definition.inputSchema, args);
        const latest = (await remoteTools(env, connection)).find(
          (tool) => tool.name === definition.name,
        );
        if (
          !latest ||
          (await hash([latest.inputSchema, latest.outputSchema ?? null, latest.description])) !==
            schemaHash
        )
          fail(409, "AI_APPROVAL_STALE");
        const output = await remoteMCP(env, connection, "tools/call", {
          name: definition.name,
          arguments: args,
        });
        if (definition.outputSchema && output.structuredContent)
          validateSchema(definition.outputSchema, output.structuredContent);
        return output;
      },
    });
  }
  return result;
}
async function liveConnection(
  env: AIEnv,
  principal: AIPrincipal,
  connection: MCPConnection,
  serverVersion: number,
) {
  const auth = identityGuard(principal);
  if (
    !(await first(
      env,
      `SELECT c.id FROM ai_mcp_connections c JOIN ai_mcp_servers s ON s.id=c.server_id WHERE c.id=? AND c.version=? AND c.status='connected' AND s.version=? AND s.enabled=1 AND ${auth.sql}`,
      connection.id,
      connection.version,
      serverVersion,
      ...auth.args,
    ))
  )
    fail(403, "AI_FORBIDDEN");
}
export async function roomTools(env: AIEnv, principal: AIPrincipal, roomId: string) {
  if (principal.kind !== "user") fail(403, "AI_FORBIDDEN");
  const bindings = await rows<MCPConnection & { allowed_tools_json: string }>(
    env,
    "SELECT c.*,b.allowed_tools_json FROM ai_room_mcp_bindings b JOIN ai_mcp_connections c ON c.id=b.connection_id JOIN ai_rooms r ON r.id=b.room_id WHERE b.room_id=? AND r.owner_user_id=? AND r.deleted_at IS NULL AND b.enabled=1 AND c.status='connected'",
    roomId,
    principal.userId,
  );
  const result: RoomTool[] = [];
  for (const binding of bindings) {
    const allowed = parse<string[]>(binding.allowed_tools_json);
    for (const tool of await connectionTools(env, principal, binding))
      if (allowed.includes(tool.name)) result.push(tool);
  }
  if (result.length > 64) fail(422, "AI_LIMIT_REACHED");
  return result;
}
export const aiConnections = new Hono<AppEnv>();
aiConnections.use("*", requirePermission("ai.connections.manage"));
aiConnections.get("/servers", async (c) =>
  c.json({
    servers: await rows(
      c.env,
      "SELECT id,key,name,transport,builtin_key,version,CASE WHEN json_type(config_json,'$.oauth')='object' THEN 1 ELSE 0 END oauth FROM ai_mcp_servers WHERE enabled=1 ORDER BY name",
    ),
  }),
);
aiConnections.get("/connections", async (c) =>
  c.json({
    connections: await rows(
      c.env,
      "SELECT id,server_id,name,status,version,credential_expires_at FROM ai_mcp_connections WHERE owner_user_id=? ORDER BY name LIMIT 100",
      c.get("identity").user.id,
    ),
  }),
);
aiConnections.post("/connections", async (c) => {
  const data = fields(object(await c.req.json()), ["server_id", "name", "secret"]),
    id = uuid(),
    server = await first<{ transport: string }>(
      c.env,
      "SELECT transport FROM ai_mcp_servers WHERE id=? AND enabled=1",
      text(data.server_id),
    );
  if (!server) fail(404, "AI_NOT_FOUND");
  let secret: string | null = null;
  if (data.secret !== undefined) {
    if (server.transport === "builtin") fail(400, "AI_INVALID_INPUT");
    const value = fields(object(data.secret), ["api_key"]);
    text(value.api_key, 16384);
    secret = await seal(c.env, "mcp:" + id, value);
  }
  const auth = identityGuard(userPrincipal(c.get("identity")));
  await statement(
    c.env,
    `INSERT INTO ai_mcp_connections(id,server_id,owner_user_id,name,secret_envelope_json,status) SELECT ?,?,?,?,?,'connected' WHERE ${auth.sql}`,
    id,
    String(data.server_id),
    c.get("identity").user.id,
    text(data.name, 100),
    secret,
    ...auth.args,
  ).run();
  return c.json(
    {
      connection: {
        id,
        server_id: data.server_id,
        name: data.name,
        status: "connected",
        version: 1,
      },
    },
    201,
  );
});
aiConnections.get("/connections/:id/tools", async (c) => {
  const value = await first<MCPConnection>(
    c.env,
    "SELECT * FROM ai_mcp_connections WHERE id=? AND owner_user_id=?",
    c.req.param("id"),
    c.get("identity").user.id,
  );
  if (!value) fail(404, "AI_NOT_FOUND");
  return c.json({
    tools: (await connectionTools(c.env, userPrincipal(c.get("identity")), value)).map(
      ({ name, description, inputSchema, execution }) => ({
        name,
        description,
        inputSchema,
        execution,
      }),
    ),
  });
});
aiConnections.post("/connections/:id/oauth/start", async (c) =>
  c.json(await startConnectionOAuth(c, c.req.param("id"))),
);
aiConnections.patch("/connections/:id", async (c) => {
  const data = fields(object(await c.req.json()), ["version", "name", "status", "secret"]),
    version = integer(data.version, 1),
    id = c.req.param("id");
  const current = await first<MCPConnection & { name: string }>(
    c.env,
    "SELECT * FROM ai_mcp_connections WHERE id=? AND owner_user_id=? AND version=?",
    id,
    c.get("identity").user.id,
    version,
  );
  if (!current) fail(409, "AI_CONFLICT");
  if (data.status !== undefined && !["connected", "disabled"].includes(String(data.status)))
    fail(400, "AI_INVALID_INPUT");
  let envelope = current.secret_envelope_json;
  if (data.secret !== undefined) {
    const value = fields(object(data.secret), ["api_key"]);
    text(value.api_key, 16384);
    envelope = await seal(c.env, "mcp:" + id, value);
  }
  const auth = identityGuard(userPrincipal(c.get("identity")));
  const updated = await statement(
    c.env,
    `UPDATE ai_mcp_connections SET name=?,status=?,secret_envelope_json=?,credential_version=credential_version+?,version=version+1,updated_at=unixepoch() WHERE id=? AND owner_user_id=? AND version=? AND ${auth.sql} RETURNING id,version,status`,
    data.name === undefined ? current.name : text(data.name, 100),
    String(data.status ?? current.status),
    envelope,
    data.secret === undefined ? 0 : 1,
    id,
    c.get("identity").user.id,
    version,
    ...auth.args,
  ).first();
  if (!updated) fail(409, "AI_CONFLICT");
  return c.json({ connection: updated });
});
aiConnections.delete("/connections/:id", async (c) => {
  await statement(
    c.env,
    "UPDATE ai_mcp_connections SET status='disabled',secret_envelope_json=NULL,credential_version=credential_version+1,version=version+1 WHERE id=? AND owner_user_id=?",
    c.req.param("id"),
    c.get("identity").user.id,
  ).run();
  return c.body(null, 204);
});
