export interface NotificationConnection {
  user_id: string;
  session_id: string;
  auth_version: number;
  expires_at: number;
}
export async function connectionValid(db: D1Database, connection: NotificationConnection) {
  if (connection.expires_at <= Math.floor(Date.now() / 1000)) return false;
  return !!(await db
    .withSession("first-primary")
    .prepare(
      `SELECT s.id FROM user_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND u.id = ? AND s.auth_version = ? AND s.auth_version = u.auth_version
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch() AND u.disabled_at IS NULL AND u.deleted_at IS NULL
      AND u.password_hash IS NOT NULL AND u.password_reset_required = 0
      AND (s.mfa_authenticated_at IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM user_mfa_methods m WHERE m.user_id = u.id AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL))`,
    )
    .bind(connection.session_id, connection.user_id, connection.auth_version)
    .first());
}
