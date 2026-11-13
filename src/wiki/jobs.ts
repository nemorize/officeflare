export async function recoverWiki(env: Env) {
  const assets = await env.DB.prepare(
    `SELECT a.id,a.object_key FROM wiki_assets a JOIN wiki_pages p ON p.id=a.page_id
    WHERE p.purged_at IS NOT NULL OR (a.ready_at IS NULL AND a.created_at<unixepoch()-3600) LIMIT 100`,
  ).all<{ id: string; object_key: string }>();
  for (const asset of assets.results) {
    await env.WIKI_BUCKET.delete(asset.object_key);
    await env.DB.prepare("DELETE FROM wiki_assets WHERE id=?").bind(asset.id).run();
  }
  // Keep only ID tombstones and audit metadata after permanent deletion.
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM wiki_comments WHERE page_id IN(SELECT id FROM wiki_pages WHERE purged_at IS NOT NULL)",
    ),
    env.DB.prepare(
      "DELETE FROM wiki_favorites WHERE page_id IN(SELECT id FROM wiki_pages WHERE purged_at IS NOT NULL)",
    ),
    env.DB.prepare(
      "DELETE FROM wiki_page_grants WHERE page_id IN(SELECT id FROM wiki_pages WHERE purged_at IS NOT NULL)",
    ),
    env.DB.prepare("DELETE FROM wiki_operations WHERE created_at<unixepoch()-86400"),
  ]);
}
