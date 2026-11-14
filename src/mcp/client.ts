import { t } from "../../shared/i18n/index.ts";
import { now } from "../auth/types";
import { boundedBody } from "../mail/remote";
import { fail } from "../ai/errors";
import { assertSchema, validateSchema } from "../ai/json-schema";
import { safeFetch, ProviderFailure } from "../ai/providers";
import { seal, unseal } from "../ai/secrets";
import { first, integer, object, parse, statement, text } from "../ai/store";
import type { AIEnv, AITool, Fetcher, ObjectValue } from "../ai/types";

export interface MCPConnection {
  id: string;
  server_id: string;
  owner_user_id: string;
  config_json: string;
  status: string;
  version: number;
  secret_envelope_json: string | null;
  credential_expires_at: number | null;
  credential_version: number;
}
async function connectionCredential(
  env: AIEnv,
  connection: MCPConnection,
  serverConfig: string,
  fetcher?: Fetcher,
): Promise<ObjectValue> {
  const current = await first<MCPConnection>(
    env,
    "SELECT * FROM ai_mcp_connections WHERE id=? AND status='connected'",
    connection.id,
  );
  if (!current) fail(403, "AI_FORBIDDEN");
  if (!current.secret_envelope_json) return {};
  const secret = await unseal<ObjectValue>(
    env,
    "mcp:" + connection.id,
    current.secret_envelope_json,
  );
  if (current.credential_expires_at === null || current.credential_expires_at > now() + 60)
    return secret;
  const oauth = object(parse(serverConfig).oauth ?? {}),
    lock = object(parse(current.config_json)._refresh ?? {});
  if (lock.token) {
    if (Number(lock.expires_at) <= now())
      await statement(
        env,
        "UPDATE ai_mcp_connections SET status='reauth_required',version=version+1 WHERE id=? AND credential_version=?",
        current.id,
        current.credential_version,
      ).run();
    fail(409, "AI_BUSY");
  }
  if (!secret.refresh_token || !secret.client_id || !oauth.token_endpoint)
    fail(503, "AI_REAUTH_REQUIRED");
  const token = crypto.randomUUID(),
    claim = await statement(
      env,
      "UPDATE ai_mcp_connections SET config_json=json_set(config_json,'$._refresh',json(?)) WHERE id=? AND status='connected' AND credential_version=? AND json_extract(config_json,'$._refresh.token') IS NULL RETURNING id",
      JSON.stringify({ token, expires_at: now() + 30 }),
      current.id,
      current.credential_version,
    ).first();
  if (!claim) fail(409, "AI_BUSY");
  try {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: String(secret.client_id),
      refresh_token: String(secret.refresh_token),
    });
    if (oauth.resource) form.set("resource", String(oauth.resource));
    const response = await safeFetch(
      text(oauth.token_endpoint, 2000),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(15000),
      },
      fetcher,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(t("ai.providerError"));
    }
    const replacement = object(
      JSON.parse(new TextDecoder().decode(await boundedBody(response, 65536))),
    );
    text(replacement.access_token, 32000);
    integer(replacement.expires_in, 1, 30 * 86400);
    const value = {
      ...secret,
      ...replacement,
      refresh_token: replacement.refresh_token ?? secret.refresh_token,
    };
    const envelope = await seal(env, "mcp:" + current.id, value);
    const updated = await statement(
      env,
      "UPDATE ai_mcp_connections SET secret_envelope_json=?,credential_expires_at=?,credential_version=credential_version+1,config_json=json_remove(config_json,'$._refresh') WHERE id=? AND credential_version=? AND status='connected' AND json_extract(config_json,'$._refresh.token')=? RETURNING id",
      envelope,
      now() + (replacement.expires_in as number),
      current.id,
      current.credential_version,
      token,
    ).first();
    if (!updated) throw new Error(t("ai.providerError"));
    return value;
  } catch {
    await statement(
      env,
      "UPDATE ai_mcp_connections SET status='reauth_required',version=version+1 WHERE id=? AND credential_version=? AND json_extract(config_json,'$._refresh.token')=?",
      current.id,
      current.credential_version,
      token,
    ).run();
    fail(503, "AI_REAUTH_REQUIRED");
  }
}
async function rpcResponse(response: Response, id: string) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderFailure(response.status, response.status >= 500, "MCP_HTTP_ERROR");
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return object(JSON.parse(new TextDecoder().decode(await boundedBody(response, 1024 * 1024))));
  const encoded = new TextDecoder().decode(await boundedBody(response, 1024 * 1024));
  for (const block of encoded.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) {
      const value = object(JSON.parse(data));
      if (value.id === id) return value;
    }
  }
  fail(502, "AI_PROVIDER_ERROR");
}
export async function remoteMCP(
  env: AIEnv,
  connection: MCPConnection,
  method: "tools/list" | "tools/call",
  params: ObjectValue = {},
  fetcher?: Fetcher,
) {
  if (connection.status !== "connected") fail(403, "AI_FORBIDDEN");
  const server = await first<{ endpoint_url: string; config_json: string }>(
    env,
    "SELECT endpoint_url,config_json FROM ai_mcp_servers WHERE id=? AND enabled=1 AND transport='streamable_http'",
    connection.server_id,
  );
  if (!server) fail(403, "AI_FORBIDDEN");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (connection.secret_envelope_json) {
    const secret = await connectionCredential(env, connection, server.config_json, fetcher);
    const token = secret.access_token ?? secret.api_key;
    if (typeof token === "string") headers.Authorization = "Bearer " + token;
  }
  const signal = AbortSignal.timeout(60000),
    initId = crypto.randomUUID();
  const initialized = await safeFetch(
    server.endpoint_url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "officeflare", version: "0.1.0" },
        },
      }),
      signal,
    },
    fetcher,
  );
  const sessionId = initialized.headers.get("mcp-session-id"),
    init = await rpcResponse(initialized, initId);
  if (init.error) fail(502, "AI_PROVIDER_ERROR");
  const version = object(init.result).protocolVersion;
  if (!["2025-03-26", "2025-06-18", "2025-11-25"].includes(String(version)))
    fail(422, "AI_CAPABILITY_UNSUPPORTED");
  headers["MCP-Protocol-Version"] = String(version);
  if (sessionId) headers["Mcp-Session-Id"] = text(sessionId, 512);
  const notification = await safeFetch(
    server.endpoint_url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal,
    },
    fetcher,
  );
  await notification.body?.cancel();
  if (!notification.ok) fail(502, "AI_PROVIDER_ERROR");
  const id = crypto.randomUUID();
  let response: Response;
  try {
    response = await safeFetch(
      server.endpoint_url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal,
      },
      fetcher,
    );
  } catch {
    throw new ProviderFailure(502, method === "tools/call", "MCP_RESULT_UNKNOWN");
  }
  const value = await rpcResponse(response, id);
  if (value.jsonrpc !== "2.0" || value.id !== id || value.error) fail(502, "AI_PROVIDER_ERROR");
  return object(value.result);
}
export async function remoteTools(
  env: AIEnv,
  connection: MCPConnection,
  fetcher?: Fetcher,
): Promise<(AITool & { outputSchema?: ObjectValue })[]> {
  const result = await remoteMCP(env, connection, "tools/list", {}, fetcher);
  if (!Array.isArray(result.tools) || result.tools.length > 64 || result.nextCursor)
    fail(422, "AI_CAPABILITY_UNSUPPORTED");
  return result.tools.map((entry) => {
    const tool = object(entry),
      name = text(tool.name, 64);
    if (!/^[A-Za-z0-9_.\/-]+$/.test(name)) fail(400, "AI_INVALID_INPUT");
    assertSchema(tool.inputSchema);
    if (tool.outputSchema) assertSchema(tool.outputSchema);
    return {
      name,
      description: text(tool.description ?? name, 4000),
      inputSchema: object(tool.inputSchema),
      ...(tool.outputSchema ? { outputSchema: object(tool.outputSchema) } : {}),
    };
  });
}
