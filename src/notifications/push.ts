import { pushTarget } from "../../shared/push";
import { t } from "../../shared/i18n/index.ts";
import { now } from "../auth/types";
import { fcmWebConfig, sendFcm } from "./fcm";
import { connectionValid } from "./session";
import { knownType, notificationTypes } from "./catalog";

function truncateUtf8(value: string, limit: number) {
  const encoder = new TextEncoder();
  let result = "",
    bytes = 0;
  for (const character of value) {
    bytes += encoder.encode(character).length;
    if (bytes > limit) break;
    result += character;
  }
  return result;
}

interface PushEvent {
  user_id: string;
  id: string;
  title: string;
  body: string;
  target_path: string | null;
  type: string;
  source_key: string;
}
export async function deliverPush(env: Env, seq: number) {
  if (!fcmWebConfig(env)) return;
  const db = env.DB.withSession("first-primary");
  const event = await db
    .prepare(
      `SELECT c.user_id, i.id, e.title, e.body, e.target_path, e.type, e.source_key
    FROM notification_changes c JOIN notification_inbox i ON i.id = c.notification_id
    JOIN notification_events e ON e.id = i.event_id JOIN push_settings p ON p.id = 1
    WHERE c.seq = ? AND c.kind = 'created' AND p.web_push_enabled = 1
      AND i.deleted_at IS NULL AND i.read_at IS NULL AND i.archived_at IS NULL
      AND (i.snoozed_until IS NULL OR i.snoozed_until <= unixepoch())
      AND c.created_at > unixepoch() - 86400`,
    )
    .bind(seq)
    .first<PushEvent>();
  if (!event) return;
  if (!knownType(event.type)) return;
  const definition = notificationTypes[event.type];
  if (!definition.required) {
    const suppressed = await db
      .prepare(
        `SELECT user_id FROM notification_preferences WHERE user_id = ?
      AND COALESCE(json_extract(rules_json, ?), json_extract(rules_json, ?),
        json_extract(rules_json, ?), enabled) = 0`,
      )
      .bind(
        event.user_id,
        `$."type:${event.type}"`,
        `$."category:${definition.service}:${definition.category}"`,
        `$."service:${definition.service}"`,
      )
      .first();
    if (suppressed) return;
  }
  if (event.type === "mail.received") {
    const mailboxId = event.source_key.split(":")[1];
    const access = await db
      .prepare(
        `SELECT b.id FROM mail_mailboxes b
      JOIN users u ON u.id = ? LEFT JOIN mail_mailbox_members m ON m.mailbox_id = b.id AND m.user_id = u.id
      WHERE b.id = ? AND b.status = 'active' AND (b.owner_user_id = u.id OR m.can_read = 1)
      AND EXISTS (SELECT 1 FROM user_roles r JOIN role_permissions p ON p.role_id = r.role_id
        WHERE r.user_id = u.id AND p.permission_key = 'mail.access')`,
      )
      .bind(event.user_id, mailboxId ?? "")
      .first();
    if (!access) return;
  }
  const tokens = await db
    .prepare(
      `SELECT t.* FROM push_tokens t
    JOIN notification_changes c ON c.seq = ?
    WHERE t.user_id = ? AND t.created_at <= c.created_at
    AND NOT EXISTS (SELECT 1 FROM notification_push_deliveries d
      WHERE d.seq = c.seq AND d.token_id = t.id AND d.delivered_at IS NOT NULL)`,
    )
    .bind(seq, event.user_id)
    .all<{
      id: string;
      token: string;
      token_type: string;
      user_id: string;
      session_id: string;
      auth_version: number;
    }>();
  let failed = false;
  // Bound concurrent external calls and isolate failure to one device.
  for (let start = 0; start < tokens.results.length; start += 4) {
    const results = await Promise.allSettled(
      tokens.results.slice(start, start + 4).map(async (token) => {
        const active = await connectionValid(env.DB, { ...token, expires_at: now() + 60 });
        if (!active) {
          await db
            .prepare("DELETE FROM push_tokens WHERE id = ? AND session_id = ?")
            .bind(token.id, token.session_id)
            .run();
          return;
        }
        const claim = await db
          .prepare(
            `INSERT INTO notification_push_deliveries (seq, token_id, lease_until)
        SELECT ?, id, ? FROM push_tokens WHERE id = ? AND session_id = ? AND token = ?
        ON CONFLICT (seq, token_id) DO UPDATE SET lease_until = excluded.lease_until
        WHERE notification_push_deliveries.delivered_at IS NULL AND notification_push_deliveries.lease_until <= ?
        RETURNING token_id`,
          )
          .bind(seq, now() + 60, token.id, token.session_id, token.token, now())
          .first();
        if (!claim) {
          const pending = await db
            .prepare(
              "SELECT token_id FROM notification_push_deliveries WHERE seq = ? AND token_id = ? AND delivered_at IS NULL",
            )
            .bind(seq, token.id)
            .first();
          if (pending) throw new Error(t("push.connecting"));
          return;
        }
        try {
          const result = await sendFcm(env, token.token, token.token_type, {
            title: truncateUtf8(event.title, 512),
            body: truncateUtf8(event.body, 2000),
            target_path: pushTarget(event.target_path),
            notification_id: event.id,
            user_id: event.user_id,
            session_id: token.session_id,
          });
          if (result === "unregistered")
            await db
              .prepare("DELETE FROM push_tokens WHERE id = ? AND token = ?")
              .bind(token.id, token.token)
              .run();
          else
            await db
              .prepare(
                "UPDATE notification_push_deliveries SET delivered_at = ?, lease_until = 0 WHERE seq = ? AND token_id = ?",
              )
              .bind(now(), seq, token.id)
              .run();
        } catch (error) {
          await db
            .prepare(
              "UPDATE notification_push_deliveries SET lease_until = 0 WHERE seq = ? AND token_id = ? AND delivered_at IS NULL",
            )
            .bind(seq, token.id)
            .run();
          throw error;
        }
      }),
    );
    if (results.some((result) => result.status === "rejected")) failed = true;
  }
  if (failed) throw new Error(t("push.failed"));
}
