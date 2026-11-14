import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Buffer } from "node:buffer";
import { boundedBody } from "../mail/remote";
import { requireAccess } from "../auth/store";
import { can } from "../authorization/access";
import { digest, random } from "../auth/crypto";
import { now, uuid, type AppEnv, type AuthContext } from "../auth/types";
import type { Handler } from "hono";
import { fail } from "./errors";
import { enqueue } from "./jobs";
import { safeFetch, safeUrl } from "./providers";
import { seal, unseal } from "./secrets";
import {
  audit,
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
} from "./store";
import {
  userPrincipal,
  type Account,
  type AIEnv,
  type AIPrincipal,
  type Fetcher,
  type ObjectValue,
} from "./types";

interface FlowSecret {
  principal: AIPrincipal;
  verifier: string;
  nonce: string;
  client_id: string;
  config: ObjectValue;
  expected_version: number;
  config_version: number;
}
interface Target {
  kind: "provider_account" | "mcp_connection";
  id: string;
  providerId?: string;
  serverId?: string;
  version: number;
  configVersion: number;
  config: ObjectValue;
  clientId: string;
  issuer: string;
}
async function providerTarget(c: AuthContext, id: string): Promise<Target> {
  const account = await first<Account>(
    c.env,
    "SELECT * FROM ai_provider_accounts WHERE id=? AND auth_kind='oauth' AND status<>'revoked'",
    id,
  );
  if (
    !account ||
    (account.owner_user_id !== c.get("identity").user.id &&
      !(await can(c, "admin.ai.providers.manage")))
  )
    fail(404, "AI_NOT_FOUND");
  const provider = await first<{ config_json: string }>(
    c.env,
    "SELECT config_json FROM ai_providers WHERE id=? AND enabled=1",
    account.provider_id,
  );
  if (!provider) fail(404, "AI_NOT_FOUND");
  const config = object(parse(provider.config_json).oauth);
  const clientId = account.oauth_client_id ?? text(config.client_id, 500);
  // Hosted deployments use their registered integration. The loopback-only OSS
  // dynamic client is not substituted for an approved hosted OAuth client.
  if (clientId === "dynamic_agent_client" || !config.hosted_authorization_ref)
    fail(422, "AI_CAPABILITY_UNSUPPORTED");
  return {
    kind: "provider_account",
    id,
    providerId: account.provider_id,
    version: account.credential_version,
    configVersion: Number((account as Account & { version: number }).version),
    config,
    clientId,
    issuer: text(config.issuer, 2000),
  };
}
export async function startOAuth(c: AuthContext, target: Target) {
  const principal = userPrincipal(c.get("identity")),
    origin = new URL(c.req.url).origin,
    redirect = origin + "/api/ai/oauth/callback",
    state = random(),
    verifier = random(),
    nonce = random(),
    id = uuid();
  const url = safeUrl(text(target.config.authorization_endpoint, 2000));
  url.searchParams.set("client_id", target.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("scope", text(target.config.scope, 2000));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set(
    "code_challenge",
    Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
      "base64url",
    ),
  );
  if (target.config.resource) url.searchParams.set("resource", String(target.config.resource));
  if (target.kind === "provider_account") {
    let account = (await first<Account>(
      c.env,
      "SELECT * FROM ai_provider_accounts WHERE id=?",
      target.id,
    ))!;
    const host = account.oauth_host_id ?? "urn:uuid:" + uuid();
    await statement(
      c.env,
      "UPDATE ai_provider_accounts SET oauth_host_id=? WHERE id=? AND oauth_host_id IS NULL",
      host,
      target.id,
    ).run();
    url.searchParams.set("ext_agent_host_id", host);
  }
  const secret: FlowSecret = {
    principal,
    verifier,
    nonce,
    client_id: target.clientId,
    config: target.config,
    expected_version: target.version,
    config_version: target.configVersion,
  };
  const auth = identityGuard(principal);
  await statement(
    c.env,
    `INSERT INTO ai_oauth_flows(id,target_kind,provider_id,account_id,mcp_server_id,mcp_connection_id,user_id,session_id,state_hash,issuer,redirect_uri,secret_envelope_json,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${auth.sql}`,
    id,
    target.kind,
    target.providerId ?? null,
    target.kind === "provider_account" ? target.id : null,
    target.serverId ?? null,
    target.kind === "mcp_connection" ? target.id : null,
    c.get("identity").user.id,
    c.get("identity").session.id,
    await digest(state),
    target.issuer,
    redirect,
    await seal(c.env, "oauth:" + id, secret),
    now() + 600,
    ...auth.args,
  ).run();
  return { authorization_url: url.href, expires_at: now() + 600 };
}
export const aiOAuthCallback = new Hono<AppEnv>();
export const oauthCallback =
  (fetcher?: Fetcher): Handler<AppEnv> =>
  async (c) => {
    const state = text(c.req.query("state"), 1000);
    const flow = await first<{
      id: string;
      target_kind: string;
      provider_id: string;
      account_id: string;
      mcp_connection_id: string;
      issuer: string;
      redirect_uri: string;
      secret_envelope_json: string;
    }>(
      c.env,
      "SELECT * FROM ai_oauth_flows WHERE state_hash=? AND status='pending' AND expires_at>unixepoch()",
      await digest(state),
    );
    if (!flow || flow.redirect_uri !== new URL(c.req.url).origin + "/api/ai/oauth/callback")
      fail(400, "AI_INVALID_INPUT");
    const pending = await unseal<FlowSecret>(c.env, "oauth:" + flow.id, flow.secret_envelope_json);
    await identity(c.env, pending.principal);
    if (c.req.query("client_id") && c.req.query("client_id") !== pending.client_id)
      fail(400, "AI_INVALID_INPUT");
    if (c.req.query("error")) {
      await statement(
        c.env,
        "UPDATE ai_oauth_flows SET status='failed',consumed_at=unixepoch() WHERE id=? AND status='pending'",
        flow.id,
      ).run();
      return c.redirect("/mcp/connected?status=denied", 302);
    }
    const code = text(c.req.query("code"), 4096),
      claimed = await statement(
        c.env,
        "UPDATE ai_oauth_flows SET status='exchanging',consumed_at=unixepoch() WHERE id=? AND status='pending' AND expires_at>unixepoch() RETURNING id",
        flow.id,
      ).first();
    if (!claimed) fail(409, "AI_CONFLICT");
    try {
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: pending.client_id,
        code,
        code_verifier: pending.verifier,
        redirect_uri: flow.redirect_uri,
      });
      if (pending.config.resource) form.set("resource", String(pending.config.resource));
      const table =
          flow.target_kind === "provider_account" ? "ai_provider_accounts" : "ai_mcp_connections",
        targetId =
          flow.target_kind === "provider_account" ? flow.account_id : flow.mcp_connection_id,
        purpose = (flow.target_kind === "provider_account" ? "account:" : "mcp:") + targetId;
      const old = await first<{
        secret_envelope_json: string | null;
        oauth_subject?: string | null;
      }>(c.env, `SELECT * FROM ${table} WHERE id=?`, targetId);
      const previous = old?.secret_envelope_json
        ? await unseal<ObjectValue>(c.env, purpose, old.secret_envelope_json)
        : {};
      if (typeof previous.client_secret === "string")
        form.set("client_secret", previous.client_secret);
      const response = await safeFetch(
        text(pending.config.token_endpoint, 2000),
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
      const tokens = object(
        JSON.parse(new TextDecoder().decode(await boundedBody(response, 65536))),
      );
      text(tokens.access_token, 32000);
      integer(tokens.expires_in, 1, 86400);
      if (tokens.token_type && String(tokens.token_type).toLowerCase() !== "bearer")
        fail(400, "AI_INVALID_INPUT");
      let subject: string | null = null;
      if (flow.target_kind === "provider_account") {
        text(tokens.id_token, 32000);
        const jwksResponse = await safeFetch(
          text(pending.config.jwks_uri, 2000),
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
          fetcher,
        );
        if (!jwksResponse.ok) fail(502, "AI_PROVIDER_ERROR");
        const jwks = JSON.parse(new TextDecoder().decode(await boundedBody(jwksResponse, 65536)));
        const verified = await jwtVerify(String(tokens.id_token), createLocalJWKSet(jwks), {
          issuer: flow.issuer,
          audience: pending.client_id,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["sub", "exp", "iat", "nonce"],
        });
        if (
          verified.payload.nonce !== pending.nonce ||
          typeof verified.payload.sub !== "string" ||
          (old?.oauth_subject && old.oauth_subject !== verified.payload.sub)
        )
          fail(403, "AI_FORBIDDEN");
        subject = verified.payload.sub;
        if (
          flow.issuer === "https://auth.openai.com" &&
          !String(tokens.scope ?? "")
            .split(" ")
            .includes("chatgpt.tokens.use.direct")
        )
          fail(403, "AI_FORBIDDEN");
      }
      const envelope = await seal(c.env, purpose, {
        ...previous,
        ...tokens,
        client_id: pending.client_id,
      });
      const auth = identityGuard(pending.principal);
      const committed = await statement(
        c.env,
        `UPDATE ${table} SET secret_envelope_json=?,credential_version=credential_version+1,credential_expires_at=?,status=?,version=version+1,updated_at=unixepoch()${flow.target_kind === "provider_account" ? ",oauth_issuer=?,oauth_subject=?,oauth_client_id=?,metadata_json=json_remove(metadata_json,'$._refresh')" : ",config_json=json_remove(config_json,'$._refresh')"} WHERE id=? AND credential_version=? AND version=? AND status<>? AND ${auth.sql} RETURNING id`,
        envelope,
        now() + (tokens.expires_in as number),
        flow.target_kind === "provider_account" ? "active" : "connected",
        ...(flow.target_kind === "provider_account"
          ? [flow.issuer, subject, pending.client_id]
          : []),
        targetId,
        pending.expected_version,
        pending.config_version,
        flow.target_kind === "provider_account" ? "revoked" : "disabled",
        ...auth.args,
      ).first();
      if (!committed) fail(409, "AI_CONFLICT");
      await statement(
        c.env,
        "UPDATE ai_oauth_flows SET status='completed' WHERE id=? AND status='exchanging'",
        flow.id,
      ).run();
      await audit(
        c.env,
        "user:" + (pending.principal.kind === "user" ? pending.principal.userId : ""),
        "oauth.connect",
        flow.target_kind,
        targetId,
      );
      return c.redirect("/mcp/connected?status=connected", 302);
    } catch {
      await statement(
        c.env,
        "UPDATE ai_oauth_flows SET status='unknown' WHERE id=? AND status='exchanging'",
        flow.id,
      ).run();
      return c.redirect("/mcp/connected?status=failed", 302);
    }
  };
aiOAuthCallback.get("/callback", oauthCallback());
export const aiAccounts = new Hono<AppEnv>();
aiAccounts.use("*", requireAccess);
aiAccounts.get("/accounts", async (c) =>
  c.json({
    accounts: await rows(
      c.env,
      "SELECT a.id,a.provider_id,p.name provider_name,a.name,a.status,a.share_scope,a.auth_kind,a.credential_expires_at,a.version FROM ai_provider_accounts a JOIN ai_providers p ON p.id=a.provider_id WHERE a.owner_user_id=? ORDER BY a.created_at DESC LIMIT 100",
      c.get("identity").user.id,
    ),
  }),
);
aiAccounts.post("/accounts", async (c) => {
  if (!(await can(c, "ai.connections.manage"))) fail(403, "AI_FORBIDDEN");
  const data = fields(object(await c.req.json()), ["provider_id", "name"]),
    id = uuid();
  const provider = await first<{ config_json: string }>(
    c.env,
    "SELECT config_json FROM ai_providers WHERE id=? AND enabled=1",
    text(data.provider_id),
  );
  if (!provider || !parse(provider.config_json).oauth) fail(422, "AI_CAPABILITY_UNSUPPORTED");
  await statement(
    c.env,
    "INSERT INTO ai_provider_accounts(id,provider_id,name,auth_kind,owner_user_id,status) VALUES(?,?,?,'oauth',?,'disabled')",
    id,
    String(data.provider_id),
    text(data.name, 100),
    c.get("identity").user.id,
  ).run();
  return c.json({ account: { id, status: "disabled", share_scope: "owner" } }, 201);
});
aiAccounts.post("/accounts/:id/oauth/start", async (c) => {
  if (!(await can(c, "ai.connections.manage")) && !(await can(c, "admin.ai.providers.manage")))
    fail(403, "AI_FORBIDDEN");
  return c.json(await startOAuth(c, await providerTarget(c, c.req.param("id"))));
});
aiAccounts.delete("/accounts/:id", async (c) => {
  const id = c.req.param("id"),
    target = await first<Account>(c.env, "SELECT * FROM ai_provider_accounts WHERE id=?", id);
  if (
    !target ||
    (target.owner_user_id !== c.get("identity").user.id &&
      !(await can(c, "admin.ai.providers.manage")))
  )
    fail(404, "AI_NOT_FOUND");
  await statement(
    c.env,
    "UPDATE ai_provider_accounts SET status='revoked',version=version+1 WHERE id=?",
    id,
  ).run();
  if (target.auth_kind === "oauth" && target.secret_envelope_json)
    await enqueue(c.env, "account.revoke", id, target.credential_version);
  else
    await statement(
      c.env,
      "UPDATE ai_provider_accounts SET secret_envelope_json=NULL,credential_version=credential_version+1 WHERE id=?",
      id,
    ).run();
  return c.body(null, 204);
});
export async function revokeAccount(env: AIEnv, id: string) {
  const account = await first<Account>(
    env,
    "SELECT * FROM ai_provider_accounts WHERE id=? AND status='revoked'",
    id,
  );
  if (!account?.secret_envelope_json) return;
  const provider = await first<{ config_json: string }>(
    env,
    "SELECT config_json FROM ai_providers WHERE id=?",
    account.provider_id,
  );
  const config = object(parse(provider!.config_json).oauth ?? {}),
    secret = await unseal<ObjectValue>(env, "account:" + id, account.secret_envelope_json);
  if (!config.revocation_endpoint || !secret.refresh_token) fail(503, "AI_REAUTH_REQUIRED");
  const response = await safeFetch(text(config.revocation_endpoint, 2000), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: String(secret.refresh_token),
      token_type_hint: "refresh_token",
      client_id: String(account.oauth_client_id),
    }),
    signal: AbortSignal.timeout(15000),
  });
  await response.body?.cancel();
  if (!response.ok) fail(502, "AI_PROVIDER_ERROR");
  await statement(
    env,
    "UPDATE ai_provider_accounts SET secret_envelope_json=NULL,credential_version=credential_version+1,metadata_json=json_set(metadata_json,'$.remote_revocation','confirmed') WHERE id=? AND credential_version=? AND status='revoked'",
    id,
    account.credential_version,
  ).run();
}
export async function startConnectionOAuth(c: AuthContext, id: string) {
  const value = await first<{
    server_id: string;
    credential_version: number;
    version: number;
    config_json: string;
  }>(
    c.env,
    "SELECT c.server_id,c.credential_version,c.version,s.config_json FROM ai_mcp_connections c JOIN ai_mcp_servers s ON s.id=c.server_id WHERE c.id=? AND c.owner_user_id=? AND c.status<>'disabled' AND s.enabled=1 AND s.transport='streamable_http'",
    id,
    c.get("identity").user.id,
  );
  if (!value) fail(404, "AI_NOT_FOUND");
  const config = object(parse(value.config_json).oauth);
  return startOAuth(c, {
    kind: "mcp_connection",
    id,
    serverId: value.server_id,
    version: value.credential_version,
    configVersion: value.version,
    config,
    clientId: text(config.client_id, 500),
    issuer: text(config.issuer, 2000),
  });
}
