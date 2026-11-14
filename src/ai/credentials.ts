import { t } from "../../shared/i18n/index.ts";
import { now, uuid } from "../auth/types";
import { fail } from "./errors";
import { seal, unseal } from "./secrets";
import { first, object, parse, statement } from "./store";
import { safeFetch } from "./providers";
import { boundedBody } from "../mail/remote";
import type { Account, AIEnv, Fetcher, Provider } from "./types";

export async function accountCredentials(
  env: AIEnv,
  account: Account,
  provider: Provider,
  fetcher?: Fetcher,
) {
  if (!account.secret_envelope_json) fail(503, "AI_REAUTH_REQUIRED");
  let value = await unseal<Record<string, unknown>>(
    env,
    "account:" + account.id,
    account.secret_envelope_json,
  );
  if (
    account.auth_kind !== "oauth" ||
    account.credential_expires_at === null ||
    account.credential_expires_at > now() + 60
  )
    return { credentials: value, version: account.credential_version };
  const token = uuid(),
    oauth = object(parse(provider.config_json).oauth ?? {});
  if (
    typeof oauth.token_endpoint !== "string" ||
    typeof value.refresh_token !== "string" ||
    !account.oauth_client_id
  )
    fail(503, "AI_REAUTH_REQUIRED");
  const previous = await first<{
    credential_version: number;
    status: string;
    secret_envelope_json: string;
    credential_expires_at: number;
    metadata_json: string;
  }>(
    env,
    "SELECT credential_version,status,secret_envelope_json,credential_expires_at,metadata_json FROM ai_provider_accounts WHERE id=?",
    account.id,
  );
  if (!previous || previous.status !== "active") fail(503, "AI_REAUTH_REQUIRED");
  if (previous.credential_version !== account.credential_version)
    return {
      credentials: await unseal<Record<string, unknown>>(
        env,
        "account:" + account.id,
        previous.secret_envelope_json,
      ),
      version: previous.credential_version,
    };
  const lock = object(parse(previous.metadata_json)._refresh ?? {});
  if (lock.token) {
    if (Number(lock.expires_at) <= now())
      await statement(
        env,
        "UPDATE ai_provider_accounts SET status='reauth_required',last_error_code='REFRESH_UNKNOWN',version=version+1 WHERE id=? AND credential_version=?",
        account.id,
        account.credential_version,
      ).run();
    fail(409, Number(lock.expires_at) <= now() ? "AI_REAUTH_REQUIRED" : "AI_BUSY");
  }
  const claimed = await statement(
    env,
    "UPDATE ai_provider_accounts SET metadata_json=json_set(metadata_json,'$._refresh',json(?)) WHERE id=? AND credential_version=? AND status='active' AND json_extract(metadata_json,'$._refresh.token') IS NULL RETURNING id",
    JSON.stringify({ token, expires_at: now() + 30 }),
    account.id,
    account.credential_version,
  ).first();
  if (!claimed) fail(409, "AI_BUSY");
  try {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: account.oauth_client_id,
      refresh_token: value.refresh_token as string,
    });
    if (typeof oauth.resource === "string") form.set("resource", oauth.resource);
    if (typeof value.client_secret === "string") form.set("client_secret", value.client_secret);
    const response = await safeFetch(
      oauth.token_endpoint,
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
    if (
      typeof replacement.access_token !== "string" ||
      typeof replacement.expires_in !== "number" ||
      replacement.expires_in < 1
    )
      throw new Error(t("ai.providerError"));
    value = {
      ...value,
      ...replacement,
      refresh_token: replacement.refresh_token ?? value.refresh_token,
    };
    const envelope = await seal(env, "account:" + account.id, value);
    const committed = await statement(
      env,
      "UPDATE ai_provider_accounts SET secret_envelope_json=?,credential_expires_at=?,credential_version=credential_version+1,metadata_json=json_remove(metadata_json,'$._refresh'),updated_at=unixepoch() WHERE id=? AND credential_version=? AND json_extract(metadata_json,'$._refresh.token')=? AND status='active' RETURNING credential_version",
      envelope,
      now() + Math.min(86400, replacement.expires_in),
      account.id,
      account.credential_version,
      token,
    ).first<{ credential_version: number }>();
    if (!committed) fail(409, "AI_CONFLICT");
    return { credentials: value, version: committed.credential_version };
  } catch {
    await statement(
      env,
      "UPDATE ai_provider_accounts SET status='reauth_required',last_error_code='REFRESH_UNKNOWN',version=version+1 WHERE id=? AND credential_version=? AND json_extract(metadata_json,'$._refresh.token')=?",
      account.id,
      account.credential_version,
      token,
    ).run();
    fail(503, "AI_REAUTH_REQUIRED");
  }
}
