import type { CollaborationActor, CollaborationAdapters, CollaborationResource } from "./types";
export async function actorAccount(env: Env, actor: CollaborationActor) {
  return env.DB.withSession("first-primary")
    .prepare(
      `SELECT u.id,u.display_name,u.email_address
    FROM user_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND u.id=? AND s.auth_version=? AND s.auth_version=u.auth_version
    AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND u.disabled_at IS NULL
    AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL AND u.password_reset_required=0
    AND (s.mfa_authenticated_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM user_mfa_methods m
      WHERE m.user_id=u.id AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL))`,
    )
    .bind(actor.session_id, actor.user_id, actor.auth_version)
    .first<{ id: string; display_name: string | null; email_address: string }>();
}
export async function resourceFor(env: Env, id: string, adapters: CollaborationAdapters) {
  const resource = await env.DB.withSession("first-primary")
    .prepare("SELECT * FROM collaboration_resources WHERE id=? AND retired_at IS NULL")
    .bind(id)
    .first<CollaborationResource>();
  return resource && adapters[resource.service] ? resource : null;
}
export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
