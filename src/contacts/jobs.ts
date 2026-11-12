import type { ContactEnv } from "./types";

export async function recoverContacts(env: ContactEnv) {
  await env.DB.prepare(
    "DELETE FROM contact_operations WHERE id IN (SELECT id FROM contact_operations WHERE expires_at<=unixepoch() ORDER BY expires_at LIMIT 500)",
  ).run();
}
