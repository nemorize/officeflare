/** Lifecycle recovery for every registered service, without business-domain imports. */
export async function recoverCollaboration(env: Env) {
  await env.DB.prepare("DELETE FROM collaboration_tickets WHERE expires_at<unixepoch()-60").run();
  const resources = await env.DB.prepare(
    "SELECT id FROM collaboration_resources WHERE retired_at IS NOT NULL AND purged_at IS NULL ORDER BY retired_at LIMIT 50",
  ).all<{ id: string }>();
  for (const resource of resources.results) {
    await env.COLLABORATION_ROOM.get(env.COLLABORATION_ROOM.idFromName(resource.id)).purge(
      resource.id,
    );
  }
}
