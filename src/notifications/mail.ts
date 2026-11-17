import { t } from "../../shared/i18n/index.ts";
import { now } from "../auth/types";
import { recoverNotifications } from "./jobs";

export async function notifyIncomingMail(
  env: Env,
  mailboxId: string,
  ingestId: string,
  subject: string,
  from: string,
) {
  const db = env.DB.withSession("first-primary"),
    timestamp = now();
  const recipients = await db
    .prepare(
      `SELECT u.id FROM users u
    JOIN mail_mailboxes b ON b.id = ?
    LEFT JOIN mail_mailbox_members m ON m.mailbox_id = b.id AND m.user_id = u.id
    WHERE b.status = 'active' AND (b.owner_user_id = u.id OR m.can_read = 1)
      AND u.disabled_at IS NULL AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL
      AND u.password_reset_required = 0
      AND EXISTS (SELECT 1 FROM user_roles r JOIN role_permissions p ON p.role_id = r.role_id
        WHERE r.user_id = u.id AND p.permission_key = 'mail.access')`,
    )
    .bind(mailboxId)
    .all<{ id: string }>();
  for (let start = 0; start < recipients.results.length; start += 50) {
    await db.batch(
      recipients.results.slice(start, start + 50).map((row) =>
        db
          .prepare(
            `INSERT INTO mail_push_outbox (source_key, mailbox_id, user_id, title, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (source_key, user_id) DO NOTHING`,
          )
          .bind(
            `mail:${mailboxId}:${ingestId}`,
            mailboxId,
            row.id,
            (subject || t("push.newMail")).slice(0, 160),
            from.slice(0, 254),
            timestamp,
          ),
      ),
    );
  }
  if (recipients.results.length && env.NOTIFICATION_QUEUE)
    await recoverNotifications(env).catch((error) =>
      console.error("Notification recovery failed", error),
    );
}
