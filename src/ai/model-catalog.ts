import type { AIProviderModel } from "../../shared/ai-configuration.ts";
import { boundedBody } from "../mail/remote";
import { accountCredentials } from "./credentials";
import { fail } from "./errors";
import { safeFetch } from "./providers";
import { first, object } from "./store";
import type { Account, AIEnv, Fetcher, Provider } from "./types";

export async function providerModelCatalog(
  env: AIEnv,
  id: string,
  userId: string,
  cursor?: string,
  fetcher?: Fetcher,
) {
  const provider = await first<Provider>(
    env,
    "SELECT * FROM ai_providers WHERE id=? AND archived_at IS NULL",
    id,
  );
  if (!provider) fail(404, "AI_NOT_FOUND");
  const account = await first<Account>(
    env,
    `SELECT * FROM ai_provider_accounts WHERE provider_id=? AND status='active' AND (owner_user_id=? OR (share_scope='workspace' AND sharing_authorization='provider_permitted')) ORDER BY created_at,id LIMIT 1`,
    id,
    userId,
  );
  if (!account) fail(503, "AI_NO_AVAILABLE_ACCOUNT");
  const { credentials } = await accountCredentials(env, account, provider, fetcher);
  const token = String(credentials.access_token ?? credentials.api_key ?? "");
  const base = provider.base_url.replace(/\/$/, "");
  const url = new URL(
    base + (provider.adapter_key === "cloudflare" ? "/models/search" : "/models"),
  );
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.adapter_key === "anthropic") {
    headers[account.auth_kind === "oauth" ? "Authorization" : "x-api-key"] =
      account.auth_kind === "oauth" ? "Bearer " + token : token;
    headers["anthropic-version"] = "2023-06-01";
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("after_id", cursor.slice(0, 500));
  } else if (provider.adapter_key === "google") {
    headers["x-goog-api-key"] = token;
    url.searchParams.set("pageSize", "100");
    if (cursor) url.searchParams.set("pageToken", cursor.slice(0, 1000));
  } else {
    headers.Authorization = "Bearer " + token;
    if (provider.adapter_key === "cloudflare") {
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", /^\d{1,4}$/.test(cursor ?? "") ? cursor! : "1");
    }
  }
  const response = await safeFetch(
    url.href,
    { headers, signal: AbortSignal.timeout(15000) },
    fetcher,
  );
  if (!response.ok) {
    await response.body?.cancel();
    fail(502, "AI_PROVIDER_ERROR");
  }
  const data = object(
    JSON.parse(new TextDecoder().decode(await boundedBody(response, 4 * 1024 * 1024))),
  );
  const list = data.data ?? data.models ?? data.result;
  if (!Array.isArray(list)) fail(502, "AI_PROVIDER_ERROR");
  const models: AIProviderModel[] = [];
  for (const entry of list.slice(0, 2000)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, any>;
    if (
      provider.adapter_key === "google" &&
      Array.isArray(item.supportedGenerationMethods) &&
      !item.supportedGenerationMethods.includes("generateContent")
    )
      continue;
    if (
      provider.adapter_key === "cloudflare" &&
      item.task?.name &&
      !["Text Generation", "Summarization"].includes(item.task.name)
    )
      continue;
    if (
      provider.adapter_key === "openai" &&
      account.auth_kind === "oauth" &&
      item.visibility &&
      item.visibility !== "list"
    )
      continue;
    const modelId =
      provider.adapter_key === "google"
        ? String(item.name ?? "").replace(/^models\//, "")
        : provider.adapter_key === "cloudflare"
          ? item.name
          : (item.id ?? item.slug);
    if (typeof modelId !== "string" || !modelId || modelId.length > 300) continue;
    const model: AIProviderModel = {
      id: modelId,
      name: String(item.display_name ?? item.displayName ?? item.name ?? modelId).slice(0, 300),
    };
    const context = item.context_length ?? item.inputTokenLimit;
    const output =
      item.top_provider?.max_completion_tokens ?? item.outputTokenLimit ?? item.max_output_tokens;
    if (Number.isSafeInteger(context) && context > 0)
      model.context_tokens =
        context + (provider.adapter_key === "google" && Number.isSafeInteger(output) ? output : 0);
    if (Number.isSafeInteger(output) && output > 0) model.max_output_tokens = output;
    if (
      provider.adapter_key === "openrouter" &&
      item.pricing?.prompt != null &&
      item.pricing?.completion != null
    ) {
      const input = Math.round(Number(item.pricing.prompt) * 1e12),
        output = Math.round(Number(item.pricing.completion) * 1e12);
      if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0)
        model.pricing = { input, output };
    }
    models.push(model);
  }
  const info = data.result_info as { total_pages?: number } | undefined;
  const page = Number(url.searchParams.get("page") ?? 1);
  const next =
    typeof data.nextPageToken === "string"
      ? data.nextPageToken
      : data.has_more && typeof data.last_id === "string"
        ? data.last_id
        : info?.total_pages && page < info.total_pages
          ? String(page + 1)
          : null;
  return { models, next_cursor: next };
}
