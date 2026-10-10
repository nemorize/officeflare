import { now } from "../auth/types";
import { descendants, statement } from "./access";
import type { DriveEnv } from "./types";

export function purgeStatements(env: DriveEnv, id: string, proof: string) {
  return [
    statement(env, `INSERT OR IGNORE INTO drive_garbage(blob_key) SELECT blob_key FROM drive_versions WHERE item_id IN (${descendants("?")}) AND ${proof}`, id),
    statement(env, `INSERT INTO drive_garbage(blob_key,not_before) SELECT blob_key,MAX(lease_until,unixepoch()) FROM drive_uploads
      WHERE (item_id IN (${descendants("?")}) OR parent_id IN (${descendants("?")})) AND status NOT IN ('cancelled','completed') AND ${proof}
      ON CONFLICT(blob_key) DO UPDATE SET not_before=MAX(not_before,excluded.not_before)`, id, id),
    statement(env, `UPDATE drive_uploads SET status='cancelled' WHERE (item_id IN (${descendants("?")}) OR parent_id IN (${descendants("?")})) AND status NOT IN ('cancelled','completed') AND ${proof}`, id, id),
    statement(env, `DELETE FROM drive_versions WHERE item_id IN (${descendants("?")}) AND ${proof}`, id),
    statement(env, `UPDATE drive_items SET purged_at=?,current_version_id=NULL,version=version+1,updated_at=? WHERE id IN (${descendants("?")}) AND purged_at IS NULL AND ${proof}`, now(), now(), id),
    statement(env, `UPDATE drive_links SET revoked_at=? WHERE item_id IN (${descendants("?")}) AND revoked_at IS NULL AND ${proof}`, now(), id),
  ];
}
