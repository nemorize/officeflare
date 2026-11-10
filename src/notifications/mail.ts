import { sql } from "drizzle-orm";
import { t } from "../../shared/i18n/index.ts";
import { createDatabase } from "../db";
import { prepareNotification } from "./service";
import { recoverNotifications } from "./jobs";

export async function notifyIncomingMail(
  env: Env,
  mailboxId: string,
  ingestId: string,
  subject: string,
  from: string,
) {
  const db = createDatabase(env.DB);
  const recipients = await env.DB.withSession("first-primary")
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
    const statements = prepareNotification(
      db,
      {
        source_key: `mail:${mailboxId}:${ingestId}`,
        type: "mail.received",
        title: (subject || t("push.newMail")).slice(0, 160),
        body: from.slice(0, 254),
        target_path: "/mail",
        recipient_ids: recipients.results.slice(start, start + 50).map((row) => row.id),
      },
      sql`1`,
    );
    await db.batch(statements);
  }
  if (recipients.results.length && env.NOTIFICATION_QUEUE)
    await recoverNotifications(env).catch((error) =>
      console.error("Notification recovery failed", error),
    );
}
