/** Repair using the same aggregates as the migration; only used by internal maintenance/tests. */
export function rebuildReadModels(sql: SqlStorage) {
  sql.exec("DELETE FROM mailbox_counts");
  sql.exec("DELETE FROM thread_summaries");
  sql.exec(
    `INSERT INTO mailbox_counts SELECT coalesce(draft_owner_id,''),folder_id,is_starred,coalesce(snoozed_until,0),count(*),sum(1-is_read) FROM messages GROUP BY coalesce(draft_owner_id,''),folder_id,is_starred,coalesce(snoozed_until,0)`,
  );
  sql.exec(`INSERT INTO thread_summaries
SELECT m.thread_id,m.folder_id,coalesce(m.snoozed_until,0),
  (SELECT lead.id FROM messages lead WHERE lead.thread_id=m.thread_id AND lead.folder_id=m.folder_id AND coalesce(lead.snoozed_until,0)=coalesce(m.snoozed_until,0) AND lead.draft_owner_id IS NULL ORDER BY lead.received_at DESC,lead.id DESC LIMIT 1),
  max(m.received_at),count(*),sum(1-m.is_read),sum(m.is_starred),max(m.has_attachments),group_concat(DISTINCT nullif(m.from_address,''))
FROM messages m WHERE m.draft_owner_id IS NULL GROUP BY m.thread_id,m.folder_id,coalesce(m.snoozed_until,0)`);
}

export function rebuildDirtyThreads(sql: SqlStorage) {
  sql.exec(
    "DELETE FROM thread_summaries WHERE thread_id IN (SELECT thread_id FROM thread_summary_dirty)",
  );
  sql.exec(`INSERT INTO thread_summaries
SELECT m.thread_id,m.folder_id,coalesce(m.snoozed_until,0),
  (SELECT lead.id FROM messages lead WHERE lead.thread_id=m.thread_id AND lead.folder_id=m.folder_id AND coalesce(lead.snoozed_until,0)=coalesce(m.snoozed_until,0) AND lead.draft_owner_id IS NULL ORDER BY lead.received_at DESC,lead.id DESC LIMIT 1),
  max(m.received_at),count(*),sum(1-m.is_read),sum(m.is_starred),max(m.has_attachments),group_concat(DISTINCT nullif(m.from_address,''))
FROM messages m WHERE m.draft_owner_id IS NULL AND m.thread_id IN (SELECT thread_id FROM thread_summary_dirty) GROUP BY m.thread_id,m.folder_id,coalesce(m.snoozed_until,0)`);
  sql.exec("DELETE FROM thread_summary_dirty");
}
