import { now, uuid } from "../auth/types";
import { digest } from "../auth/crypto";
import { canonical, first, statement } from "./store";
import { fail } from "./errors";
import type { AIEnv } from "./types";

export async function putPayload(
  env: AIEnv,
  subject: string,
  user: string | null,
  purpose: string,
  value: unknown,
) {
  const id = uuid(),
    content = canonical(value),
    size = new TextEncoder().encode(content).length;
  if (size > 2 * 1024 * 1024) fail(413, "AI_INVALID_INPUT");
  const config = await first<{ payload_retention_days: number }>(
    env,
    "SELECT payload_retention_days FROM ai_settings WHERE id=1",
  );
  const key = size > 65536 ? "ai/" + id : null;
  if (key) {
    if (!env.AI_BUCKET) fail(503, "AI_DISABLED");
    await env.AI_BUCKET.put(key, content, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        expires_at: String(now() + (config?.payload_retention_days ?? 30) * 86400),
      },
    });
  }
  await statement(
    env,
    "INSERT INTO ai_payloads(id,owner_subject_id,owner_user_id,purpose,storage_kind,content_json,r2_key,content_type,size_bytes,sha256,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id,
    subject,
    user,
    purpose,
    key ? "r2" : "inline",
    key ? null : content,
    key,
    "application/json",
    size,
    await digest(content),
    now() + (config?.payload_retention_days ?? 30) * 86400,
  ).run();
  return id;
}
// Payloads have no public fetch-by-id endpoint; callers authorize their parent resource first.
export async function getPayload<T>(env: AIEnv, id: string | null): Promise<T> {
  const value =
    id &&
    (await first<{
      storage_kind: string;
      content_json: string | null;
      r2_key: string | null;
      expires_at: number | null;
    }>(
      env,
      "SELECT storage_kind,content_json,r2_key,expires_at FROM ai_payloads WHERE id=? AND deleted_at IS NULL",
      id,
    ));
  if (!value || (value.expires_at !== null && value.expires_at <= now())) fail(404, "AI_NOT_FOUND");
  const content =
    value.content_json ??
    (value.r2_key && (await (await env.AI_BUCKET?.get(value.r2_key))?.text()));
  if (!content) fail(404, "AI_NOT_FOUND");
  return JSON.parse(content) as T;
}
