import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDatabase } from "../db";
import { requireAccess, throttle } from "../auth/store";
import { random, digest } from "../auth/crypto";
import { now, uuid, type AppEnv, type AuthContext } from "../auth/types";
import { permissionsFor } from "../authorization/access";
import { fail } from "../ai/errors";
import {
  canonical,
  fields,
  first,
  identity,
  identityGuard,
  integer,
  object,
  parse,
  rows,
  session,
  statement,
  text,
} from "../ai/store";
import type { AIEnv, AIPrincipal, ObjectValue } from "../ai/types";
import { userPrincipal } from "../ai/types";
import { safeFetch, safeUrl } from "../ai/providers";
import { boundedBody } from "../mail/remote";
import { scopes, type MCPScope, type ToolDefinition } from "./registry";
import { Buffer } from "node:buffer";

export const resourceUrl = (origin: string) => origin + "/api/mcp";
const oauthError = (error: string, status = 400) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
const challenge = async (value: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "base64url",
  );
export interface MCPAuthorization {
  principal: AIPrincipal;
  credentialId: string;
  credentialKind: "grant" | "key" | "session";
  scopes: MCPScope[];
  constraints: Record<string, string[]>;
  clientId?: string;
}
function requestedScopes(value: unknown): MCPScope[] {
  const values = typeof value === "string" ? value.split(/\s+/).filter(Boolean) : value;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > scopes.length ||
    values.some((scope) => !scopes.includes(scope))
  )
    fail(400, "AI_INVALID_INPUT");
  return [...new Set(values)] as MCPScope[];
}
export function constraints(value: unknown) {
  const result = fields(object(value ?? {}), [
    "mailbox_ids",
    "calendar_ids",
    "drive_root_ids",
  ]) as Record<string, string[]>;
  for (const items of Object.values(result))
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > 100 ||
      items.some((id) => typeof id !== "string" || !id || id.length > 100)
    )
      fail(400, "AI_INVALID_INPUT");
  return result;
}
async function eligibleScopes(env: AIEnv, principal: AIPrincipal, requested: MCPScope[]) {
  const actor = await identity(env, principal),
    permissions = await permissionsFor(createDatabase(env.DB), actor.user.id);
  for (const scope of requested) {
    const [domain, action] = scope.split(".");
    if (!permissions.includes(`${domain}.access` as never)) fail(403, "AI_FORBIDDEN");
    if (
      action === "write" &&
      domain !== "mail" &&
      !permissions.some((key) =>
        domain === "contacts"
          ? /^contacts\.entries\.(create|update|delete)$/.test(key)
          : domain === "calendar"
            ? /^calendar\.events\.(create|update|delete)$/.test(key)
            : /^drive\.files\.(create|update|delete)$/.test(key),
      )
    )
      fail(403, "AI_FORBIDDEN");
  }
}
async function delegationStatements(
  c: AuthContext,
  id: string,
  expires: number,
  guard: { sql: string; args: (string | number | null)[] },
) {
  const actor = c.get("identity");
  return statement(
    c.env,
    `INSERT INTO user_sessions(id,user_id,auth_version,created_at,password_authenticated_at,mfa_authenticated_at,last_used_at,expires_at,user_agent) SELECT ?,?,?,unixepoch(),?,?,unixepoch(),?,'Officeflare MCP delegated session' WHERE ${guard.sql}`,
    id,
    actor.user.id,
    actor.user.auth_version,
    actor.session.password_authenticated_at,
    actor.session.mfa_authenticated_at,
    expires,
    ...guard.args,
  );
}
export async function authenticateMCP(c: AuthContext): Promise<MCPAuthorization> {
  const token = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  c.header(
    "WWW-Authenticate",
    `Bearer error="invalid_token", resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource/api/mcp"`,
  );
  if (!token) {
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    fail(401, "AI_REAUTH_REQUIRED");
  }
  let authorization: MCPAuthorization | null = null;
  if (token.startsWith("ofx_")) {
    const grant = await first<{
      id: string;
      client_id: string;
      user_id: string;
      session_id: string;
      auth_version: number;
      scopes_json: string;
      constraints_json: string;
      resource: string;
    }>(
      c.env,
      `SELECT g.* FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id JOIN mcp_oauth_clients cl ON cl.id=g.client_id WHERE t.token_hash=? AND t.kind='access' AND t.expires_at>unixepoch() AND t.revoked_at IS NULL AND g.revoked_at IS NULL AND g.expires_at>unixepoch() AND cl.status='active'`,
      await digest(token),
    );
    if (grant && grant.resource === resourceUrl(new URL(c.req.url).origin))
      authorization = {
        principal: {
          kind: "user",
          userId: grant.user_id,
          sessionId: grant.session_id,
          authVersion: grant.auth_version,
        },
        credentialId: grant.id,
        credentialKind: "grant",
        scopes: parse(grant.scopes_json),
        constraints: parse(grant.constraints_json),
        clientId: grant.client_id,
      };
  } else if (token.startsWith("ofmk_")) {
    const key = await first<{
      id: string;
      user_id: string;
      session_id: string;
      auth_version: number;
      scopes_json: string;
      constraints_json: string;
    }>(
      c.env,
      "SELECT * FROM mcp_api_keys WHERE token_hash=? AND revoked_at IS NULL AND expires_at>unixepoch()",
      await digest(token),
    );
    if (key)
      authorization = {
        principal: {
          kind: "user",
          userId: key.user_id,
          sessionId: key.session_id,
          authVersion: key.auth_version,
        },
        credentialId: key.id,
        credentialKind: "key",
        scopes: parse(key.scopes_json),
        constraints: parse(key.constraints_json),
      };
  } else {
    try {
      await requireAccess(c, async () => {});
    } catch (error) {
      if (error instanceof HTTPException && error.status === 401) fail(401, "AI_REAUTH_REQUIRED");
      throw error;
    }
    authorization = {
      principal: userPrincipal(c.get("identity")),
      credentialId: c.get("identity").session.id,
      credentialKind: "session",
      scopes: [...scopes],
      constraints: {},
    };
  }
  if (!authorization) {
    c.header(
      "WWW-Authenticate",
      `Bearer error="invalid_token", resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    fail(401, "AI_REAUTH_REQUIRED");
  }
  await identity(c.env, authorization.principal);
  c.header("WWW-Authenticate", undefined);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    const client =
      authorization.clientId &&
      (await first<{ redirect_uris_json: string }>(
        c.env,
        "SELECT redirect_uris_json FROM mcp_oauth_clients WHERE id=? AND status='active'",
        authorization.clientId,
      ));
    if (
      !client ||
      !parse<string[]>(client.redirect_uris_json).some((uri) => new URL(uri).origin === origin)
    )
      fail(403, "AI_FORBIDDEN");
  }
  return authorization;
}
export async function authorizationLive(env: AIEnv, auth: MCPAuthorization) {
  await identity(env, auth.principal);
  if (auth.credentialKind === "grant") {
    const grant = await first<{ scopes_json: string; constraints_json: string }>(
      env,
      "SELECT scopes_json,constraints_json FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id=g.client_id WHERE g.id=? AND g.revoked_at IS NULL AND g.expires_at>unixepoch() AND c.status='active'",
      auth.credentialId,
    );
    if (!grant) fail(401, "AI_REAUTH_REQUIRED");
    auth.scopes = parse(grant.scopes_json);
    auth.constraints = parse(grant.constraints_json);
  } else if (
    auth.credentialKind === "key" &&
    !(await first(
      env,
      "SELECT id FROM mcp_api_keys WHERE id=? AND revoked_at IS NULL AND expires_at>unixepoch()",
      auth.credentialId,
    ))
  )
    fail(401, "AI_REAUTH_REQUIRED");
}
export async function scopeTool(
  env: AIEnv,
  auth: MCPAuthorization,
  tool: ToolDefinition,
  args: ObjectValue,
) {
  await authorizationLive(env, auth);
  if (!auth.scopes.includes(tool.scope)) fail(403, "AI_FORBIDDEN");
  if (
    args.mailbox_id &&
    auth.constraints.mailbox_ids &&
    !auth.constraints.mailbox_ids.includes(String(args.mailbox_id))
  )
    fail(403, "AI_FORBIDDEN");
  if (
    tool.server === "calendar" &&
    auth.constraints.calendar_ids &&
    tool.name !== "calendar.list"
  ) {
    const requested =
      args.calendar_id === "primary" && auth.principal.kind === "user"
        ? (
            await first<{ calendar_id: string }>(
              env,
              "SELECT calendar_id FROM calendar_primary_calendars WHERE user_id=?",
              auth.principal.userId,
            )
          )?.calendar_id
        : args.calendar_id;
    if (!requested || !auth.constraints.calendar_ids.includes(String(requested)))
      fail(403, "AI_FORBIDDEN");
  }
  if (tool.server === "drive" && auth.constraints.drive_root_ids) {
    const id = args.item_id ?? args.parent_id;
    if (
      !id ||
      !(await first(
        env,
        `WITH RECURSIVE parents(id,parent_id) AS(SELECT id,parent_id FROM drive_items WHERE id=? UNION ALL SELECT d.id,d.parent_id FROM drive_items d JOIN parents p ON d.id=p.parent_id) SELECT id FROM parents WHERE id IN(SELECT value FROM json_each(?)) LIMIT 1`,
        String(id),
        canonical(auth.constraints.drive_root_ids),
      ))
    )
      fail(403, "AI_FORBIDDEN");
  }
}
function redirectUri(value: unknown) {
  const raw = text(value, 2048),
    url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    fail(400, "AI_INVALID_INPUT");
  return raw;
}
async function client(env: AIEnv, id: string) {
  let result = await first<{ id: string; name: string; redirect_uris_json: string }>(
    env,
    "SELECT * FROM mcp_oauth_clients WHERE id=? AND status='active'",
    id,
  );
  if (!result && id.startsWith("https://")) {
    safeUrl(id);
    const response = await safeFetch(id, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) fail(400, "AI_INVALID_INPUT");
    const metadata = object(
      JSON.parse(new TextDecoder().decode(await boundedBody(response, 16384))),
    );
    if (
      metadata.client_id !== id ||
      (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== "none") ||
      !Array.isArray(metadata.redirect_uris) ||
      metadata.redirect_uris.length > 10 ||
      !metadata.redirect_uris.length
    )
      fail(400, "AI_INVALID_INPUT");
    const redirects = metadata.redirect_uris.map(redirectUri);
    await statement(
      env,
      "INSERT INTO mcp_oauth_clients(id,name,redirect_uris_json) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      id,
      text(metadata.client_name ?? new URL(id).hostname, 100),
      canonical(redirects),
    ).run();
    result = await first(env, "SELECT * FROM mcp_oauth_clients WHERE id=? AND status='active'", id);
  }
  if (!result) fail(400, "AI_INVALID_INPUT");
  return result;
}
export function oauthMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/api/mcp/oauth/authorize",
    token_endpoint: origin + "/api/mcp/oauth/token",
    registration_endpoint: origin + "/api/mcp/oauth/register",
    revocation_endpoint: origin + "/api/mcp/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: scopes,
    client_id_metadata_document_supported: true,
  };
}
export const mcpOAuth = new Hono<AppEnv>();
mcpOAuth.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  await next();
});
mcpOAuth.options("*", (c) => {
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return c.body(null, 204);
});
mcpOAuth.post("/register", async (c) => {
  await throttle(c, "mcp-register");
  const data = fields(object(await c.req.json()), [
    "client_name",
    "redirect_uris",
    "token_endpoint_auth_method",
    "grant_types",
    "response_types",
    "client_uri",
    "logo_uri",
  ]);
  if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== "none")
    return oauthError("invalid_client_metadata");
  if (
    !Array.isArray(data.redirect_uris) ||
    !data.redirect_uris.length ||
    data.redirect_uris.length > 10
  )
    return oauthError("invalid_redirect_uri");
  const id = uuid(),
    redirects = data.redirect_uris.map(redirectUri),
    name = text(data.client_name ?? t("mcp.client"), 100);
  await statement(
    c.env,
    "INSERT INTO mcp_oauth_clients(id,name,redirect_uris_json) VALUES(?,?,?)",
    id,
    name,
    canonical(redirects),
  ).run();
  return c.json(
    {
      client_id: id,
      client_name: name,
      redirect_uris: redirects,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
});
mcpOAuth.get("/authorize", async (c) => {
  await throttle(c, "mcp-authorize");
  const query = c.req.query(),
    origin = new URL(c.req.url).origin;
  if (
    query.response_type !== "code" ||
    query.code_challenge_method !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? "")
  )
    return oauthError("invalid_request");
  const registered = await client(c.env, text(query.client_id, 2048)),
    redirect = redirectUri(query.redirect_uri);
  if (!parse<string[]>(registered.redirect_uris_json).includes(redirect))
    return oauthError("invalid_redirect_uri");
  if (query.resource !== undefined && query.resource !== resourceUrl(origin))
    return oauthError("invalid_target");
  const requested = requestedScopes(
      query.scope ?? ["mail.read", "contacts.read", "drive.read", "calendar.read"].join(" "),
    ),
    id = uuid();
  await statement(
    c.env,
    "INSERT INTO mcp_oauth_requests(id,client_id,redirect_uri,resource,scopes_json,state,code_challenge,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    id,
    registered.id,
    redirect,
    resourceUrl(origin),
    canonical(requested),
    query.state ? text(query.state, 2048) : null,
    query.code_challenge!,
    now() + 600,
  ).run();
  return c.redirect(origin + "/mcp/authorize?request=" + id, 302);
});
mcpOAuth.get("/requests/:id", requireAccess, async (c) => {
  const request = await first<{
    client_id: string;
    scopes_json: string;
    redirect_uri: string;
    expires_at: number;
  }>(
    c.env,
    "SELECT * FROM mcp_oauth_requests WHERE id=? AND status='pending' AND expires_at>unixepoch()",
    c.req.param("id"),
  );
  if (!request) fail(404, "AI_NOT_FOUND");
  const registered = await client(c.env, request.client_id);
  return c.json({
    request: {
      id: c.req.param("id"),
      client_name: registered.name,
      client_id: registered.id,
      redirect_uri: request.redirect_uri,
      scopes: parse(request.scopes_json),
      expires_at: request.expires_at,
    },
  });
});
mcpOAuth.post("/requests/:id/decision", requireAccess, async (c) => {
  const data = fields(object(await c.req.json()), ["decision", "scopes", "constraints"]),
    principal = userPrincipal(c.get("identity"));
  if (!["allow", "deny"].includes(String(data.decision))) fail(400, "AI_INVALID_INPUT");
  const request = await first<{
    id: string;
    client_id: string;
    scopes_json: string;
    redirect_uri: string;
    state: string | null;
    resource: string;
  }>(
    c.env,
    "SELECT * FROM mcp_oauth_requests WHERE id=? AND status='pending' AND expires_at>unixepoch()",
    c.req.param("id"),
  );
  if (!request || request.resource !== resourceUrl(new URL(c.req.url).origin))
    fail(404, "AI_NOT_FOUND");
  const redirect = new URL(request.redirect_uri);
  if (request.state !== null) redirect.searchParams.set("state", request.state);
  if (data.decision === "deny") {
    const result = await statement(
      c.env,
      "UPDATE mcp_oauth_requests SET status='denied' WHERE id=? AND status='pending' RETURNING id",
      request.id,
    ).first();
    if (!result) fail(409, "AI_CONFLICT");
    redirect.searchParams.set("error", "access_denied");
    return c.json({ redirect_uri: redirect.href });
  }
  const allowed = requestedScopes(data.scopes ?? parse(request.scopes_json));
  if (allowed.some((scope) => !parse<string[]>(request.scopes_json).includes(scope)))
    fail(403, "AI_FORBIDDEN");
  await eligibleScopes(c.env, principal, allowed);
  const bound = constraints(data.constraints),
    grant = uuid(),
    delegatedSession = uuid(),
    code = random(),
    codeHash = await digest(code),
    expires = now() + 30 * 86400;
  const auth = identityGuard(principal),
    claimed = {
      sql: "EXISTS(SELECT 1 FROM mcp_oauth_requests WHERE id=? AND grant_id=? AND status='approved')",
      args: [request.id, grant],
    };
  // Deferred FK lets the request claim, delegated session and grant commit together.
  await session(c.env).batch([
    statement(
      c.env,
      `INSERT INTO user_sessions(id,user_id,auth_version,created_at,password_authenticated_at,mfa_authenticated_at,last_used_at,expires_at,user_agent) SELECT ?,?,?,unixepoch(),?,?,unixepoch(),?,'Officeflare MCP delegated session' WHERE ${auth.sql} AND EXISTS(SELECT 1 FROM mcp_oauth_requests WHERE id=? AND status='pending' AND expires_at>unixepoch())`,
      delegatedSession,
      c.get("identity").user.id,
      c.get("identity").user.auth_version,
      c.get("identity").session.password_authenticated_at,
      c.get("identity").session.mfa_authenticated_at,
      expires,
      ...auth.args,
      request.id,
    ),
    statement(
      c.env,
      `INSERT INTO mcp_oauth_grants(id,client_id,user_id,session_id,auth_version,resource,scopes_json,constraints_json,expires_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM user_sessions WHERE id=?)`,
      grant,
      request.client_id,
      c.get("identity").user.id,
      delegatedSession,
      c.get("identity").user.auth_version,
      request.resource,
      canonical(allowed),
      canonical(bound),
      expires,
      delegatedSession,
    ),
    statement(
      c.env,
      "UPDATE mcp_oauth_requests SET status='approved',code_hash=?,grant_id=?,user_id=?,session_id=?,expires_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM mcp_oauth_grants WHERE id=?)",
      codeHash,
      grant,
      c.get("identity").user.id,
      c.get("identity").session.id,
      now() + 120,
      request.id,
      grant,
    ),
    statement(
      c.env,
      `INSERT INTO ai_audit_events(event_key,actor_key,action,target_type,target_id,details_json) SELECT ?,?,'mcp.grant.create','mcp_grant',?,? WHERE ${claimed.sql}`,
      "grant:" + grant,
      "user:" + c.get("identity").user.id,
      grant,
      canonical({ scopes: allowed, client_id: request.client_id }),
      ...claimed.args,
    ),
  ]);
  if (
    !(await first(
      c.env,
      "SELECT id FROM mcp_oauth_requests WHERE id=? AND grant_id=?",
      request.id,
      grant,
    ))
  )
    fail(409, "AI_CONFLICT");
  redirect.searchParams.set("code", code);
  return c.json({ redirect_uri: redirect.href });
});
mcpOAuth.post("/token", async (c) => {
  await throttle(c, "mcp-token");
  const body = await c.req.parseBody(),
    clientId = typeof body.client_id === "string" ? body.client_id : "";
  if (!clientId) return oauthError("invalid_client");
  const registered = await first(
    c.env,
    "SELECT id FROM mcp_oauth_clients WHERE id=? AND status='active'",
    clientId,
  );
  if (!registered) return oauthError("invalid_client");
  let grant: any, source: any;
  if (body.grant_type === "authorization_code") {
    if (
      typeof body.code !== "string" ||
      typeof body.code_verifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)
    )
      return oauthError("invalid_grant");
    source = await first<any>(
      c.env,
      "SELECT * FROM mcp_oauth_requests WHERE code_hash=? AND client_id=? AND status='approved' AND expires_at>unixepoch()",
      await digest(body.code),
      clientId,
    );
    if (
      !source ||
      source.redirect_uri !== body.redirect_uri ||
      source.code_challenge !== (await challenge(body.code_verifier))
    )
      return oauthError("invalid_grant");
    grant = await first(
      c.env,
      "SELECT * FROM mcp_oauth_grants WHERE id=? AND revoked_at IS NULL AND expires_at>unixepoch()",
      source.grant_id,
    );
  } else if (body.grant_type === "refresh_token") {
    if (typeof body.refresh_token !== "string") return oauthError("invalid_grant");
    source = await first<any>(
      c.env,
      "SELECT t.* FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=? AND t.kind='refresh' AND g.client_id=? AND t.revoked_at IS NULL AND t.expires_at>unixepoch()",
      await digest(body.refresh_token),
      clientId,
    );
    if (!source) return oauthError("invalid_grant");
    if (source.used_by) {
      await statement(
        c.env,
        "UPDATE mcp_oauth_grants SET revoked_at=unixepoch() WHERE id=?",
        source.grant_id,
      ).run();
      return oauthError("invalid_grant");
    }
    grant = await first(
      c.env,
      "SELECT * FROM mcp_oauth_grants WHERE id=? AND revoked_at IS NULL AND expires_at>unixepoch()",
      source.grant_id,
    );
  } else return oauthError("unsupported_grant_type");
  if (
    !grant ||
    grant.resource !== resourceUrl(new URL(c.req.url).origin) ||
    (body.resource && body.resource !== grant.resource)
  )
    return oauthError("invalid_target");
  try {
    await identity(c.env, {
      kind: "user",
      userId: grant.user_id,
      sessionId: grant.session_id,
      authVersion: grant.auth_version,
    });
  } catch {
    return oauthError("invalid_grant");
  }
  const allowed = body.scope ? requestedScopes(body.scope) : parse<MCPScope[]>(grant.scopes_json);
  if (allowed.some((scope) => !parse<string[]>(grant.scopes_json).includes(scope)))
    return oauthError("invalid_scope");
  const operation = uuid(),
    access = "ofx_" + random(),
    refresh = "ofxr_" + random(),
    accessId = uuid(),
    refreshId = uuid();
  const table =
    body.grant_type === "authorization_code" ? "mcp_oauth_requests" : "mcp_oauth_tokens";
  const won = {
    sql: `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND used_by=?)`,
    args: [source.id, operation],
  };
  await session(c.env).batch([
    statement(
      c.env,
      body.grant_type === "authorization_code"
        ? "UPDATE mcp_oauth_requests SET status='consumed',used_by=? WHERE id=? AND status='approved' AND expires_at>unixepoch() AND used_by IS NULL"
        : "UPDATE mcp_oauth_tokens SET used_by=? WHERE id=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>unixepoch()",
      operation,
      source.id,
    ),
    statement(
      c.env,
      `UPDATE mcp_oauth_grants SET scopes_json=? WHERE id=? AND ${won.sql}`,
      canonical(allowed),
      grant.id,
      ...won.args,
    ),
    statement(
      c.env,
      `INSERT INTO mcp_oauth_tokens(id,grant_id,token_hash,kind,parent_id,expires_at) SELECT ?,?,?,'access',?,? WHERE ${won.sql}`,
      accessId,
      grant.id,
      await digest(access),
      body.grant_type === "refresh_token" ? source.id : null,
      Math.min(now() + 900, grant.expires_at),
      ...won.args,
    ),
    statement(
      c.env,
      `INSERT INTO mcp_oauth_tokens(id,grant_id,token_hash,kind,parent_id,expires_at) SELECT ?,?,?,'refresh',?,? WHERE ${won.sql}`,
      refreshId,
      grant.id,
      await digest(refresh),
      body.grant_type === "refresh_token" ? source.id : null,
      grant.expires_at,
      ...won.args,
    ),
  ]);
  if (!(await first(c.env, "SELECT id FROM mcp_oauth_tokens WHERE id=?", accessId))) {
    if (body.grant_type === "refresh_token")
      await statement(
        c.env,
        "UPDATE mcp_oauth_grants SET revoked_at=unixepoch() WHERE id=?",
        grant.id,
      ).run();
    return oauthError("invalid_grant");
  }
  return c.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.min(900, grant.expires_at - now()),
    refresh_token: refresh,
    scope: allowed.join(" "),
  });
});
mcpOAuth.post("/revoke", async (c) => {
  await throttle(c, "mcp-revoke");
  const body = await c.req.parseBody();
  if (typeof body.token === "string" && typeof body.client_id === "string")
    await statement(
      c.env,
      "UPDATE mcp_oauth_grants SET revoked_at=unixepoch() WHERE client_id=? AND id IN(SELECT grant_id FROM mcp_oauth_tokens WHERE token_hash=?)",
      body.client_id,
      await digest(body.token),
    ).run();
  return c.body(null, 200);
});
export const mcpConnections = new Hono<AppEnv>();
// Account-management routes require the user's login session. Their middleware
// must not intercept protocol requests carrying a scoped MCP credential.
for (const path of ["/grants", "/grants/*", "/api-keys", "/api-keys/*"])
  mcpConnections.use(path, requireAccess);
mcpConnections.get("/grants", async (c) =>
  c.json({
    grants: await rows(
      c.env,
      "SELECT g.id,g.client_id,c.name client_name,g.scopes_json,g.constraints_json,g.created_at,g.expires_at,g.revoked_at FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id=g.client_id WHERE g.user_id=? ORDER BY g.created_at DESC LIMIT 100",
      c.get("identity").user.id,
    ),
  }),
);
mcpConnections.delete("/grants/:id", async (c) => {
  await statement(
    c.env,
    "UPDATE mcp_oauth_grants SET revoked_at=unixepoch() WHERE id=? AND user_id=?",
    c.req.param("id"),
    c.get("identity").user.id,
  ).run();
  return c.body(null, 204);
});
mcpConnections.get("/api-keys", async (c) =>
  c.json({
    keys: await rows(
      c.env,
      "SELECT id,name,scopes_json,constraints_json,expires_at,revoked_at,created_at FROM mcp_api_keys WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      c.get("identity").user.id,
    ),
  }),
);
mcpConnections.post("/api-keys", async (c) => {
  const data = fields(object(await c.req.json()), ["name", "scopes", "constraints", "expires_at"]),
    allowed = requestedScopes(data.scopes),
    bound = constraints(data.constraints),
    expires = integer(data.expires_at, now() + 1, now() + 366 * 86400),
    principal = userPrincipal(c.get("identity"));
  await eligibleScopes(c.env, principal, allowed);
  const id = uuid(),
    sid = uuid(),
    token = "ofmk_" + random(),
    auth = identityGuard(principal);
  await session(c.env).batch([
    await delegationStatements(c, sid, expires, auth),
    statement(
      c.env,
      "INSERT INTO mcp_api_keys(id,user_id,session_id,name,token_hash,auth_version,scopes_json,constraints_json,expires_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM user_sessions WHERE id=?)",
      id,
      c.get("identity").user.id,
      sid,
      text(data.name, 100),
      await digest(token),
      c.get("identity").user.auth_version,
      canonical(allowed),
      canonical(bound),
      expires,
      sid,
    ),
  ]);
  if (!(await first(c.env, "SELECT id FROM mcp_api_keys WHERE id=?", id)))
    fail(403, "AI_FORBIDDEN");
  return c.json(
    { key: { id, token, scopes: allowed, constraints: bound, expires_at: expires } },
    201,
  );
});
mcpConnections.delete("/api-keys/:id", async (c) => {
  await statement(
    c.env,
    "UPDATE mcp_api_keys SET revoked_at=unixepoch() WHERE id=? AND user_id=?",
    c.req.param("id"),
    c.get("identity").user.id,
  ).run();
  return c.body(null, 204);
});
