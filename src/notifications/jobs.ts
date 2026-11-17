import { now, uuid, type AuthEnv } from "../auth/types";
import { deliverMailPush, deliverPush } from "./push";

const outboxes = {
  "notifications.invalidate": "notification_outbox",
  "mail.push": "mail_push_outbox",
} as const;
interface NotificationJob {
  kind: keyof typeof outboxes;
  seq: number;
}

export async function recoverNotifications(env: AuthEnv) {
  const db = env.DB.withSession("first-primary"),
    timestamp = now();
  await db.batch([
    db.prepare("DELETE FROM notification_ws_tickets WHERE expires_at <= ?").bind(timestamp),
    db
      .prepare(
        `UPDATE notification_inbox SET snoozed_until = NULL, updated_at = ?, version = version + 1
      WHERE seq IN (SELECT seq FROM notification_inbox WHERE snoozed_until <= ? AND deleted_at IS NULL LIMIT 100)`,
      )
      .bind(timestamp, timestamp),
    db
      .prepare("DELETE FROM notification_outbox WHERE delivered_at < ?")
      .bind(timestamp - 7 * 86400),
    db
      .prepare("DELETE FROM notification_push_deliveries WHERE delivered_at < ?")
      .bind(timestamp - 7 * 86400),
    db.prepare("DELETE FROM mail_push_outbox WHERE created_at < ?").bind(timestamp - 7 * 86400),
    db
      .prepare(
        `DELETE FROM push_tokens WHERE session_id IN
      (SELECT id FROM user_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?)
      OR user_id IN (SELECT id FROM users WHERE disabled_at IS NOT NULL OR deleted_at IS NOT NULL)
      OR auth_version != (SELECT auth_version FROM users WHERE users.id = push_tokens.user_id)`,
      )
      .bind(timestamp),
  ]);
  if (!env.NOTIFICATION_QUEUE) return;
  for (const kind of Object.keys(outboxes) as NotificationJob["kind"][]) {
    const table = outboxes[kind],
      lease = uuid();
    const claimed = await db
      .prepare(
        `UPDATE ${table} SET lease_until = ?, lease_token = ?
      WHERE seq IN (SELECT seq FROM ${table} WHERE delivered_at IS NULL AND lease_until <= ? ORDER BY seq LIMIT 100)
      AND delivered_at IS NULL AND lease_until <= ? RETURNING seq`,
      )
      .bind(timestamp + 60, lease, timestamp, timestamp)
      .all<{ seq: number }>();
    if (!claimed.results.length) continue;
    try {
      await env.NOTIFICATION_QUEUE.sendBatch(
        claimed.results.map((row) => ({
          body: { kind, seq: row.seq } satisfies NotificationJob,
        })),
      );
    } catch (error) {
      await db
        .prepare(
          `UPDATE ${table} SET lease_until = 0 WHERE lease_token = ? AND delivered_at IS NULL`,
        )
        .bind(lease)
        .run();
      throw error;
    }
  }
}

export async function consumeNotifications(batch: MessageBatch<unknown>, env: AuthEnv) {
  const groups = new Map<NotificationJob["kind"], Map<number, Message<unknown>[]>>();
  for (const message of batch.messages) {
    const job = message.body as Partial<NotificationJob> | null;
    if (
      !job ||
      (job.kind !== "notifications.invalidate" && job.kind !== "mail.push") ||
      !Number.isSafeInteger(job.seq) ||
      job.seq! <= 0
    ) {
      console.error("Invalid notification queue message");
      message.ack();
      continue;
    }
    const jobs = groups.get(job.kind) ?? new Map<number, Message<unknown>[]>();
    jobs.set(job.seq!, [...(jobs.get(job.seq!) ?? []), message]);
    groups.set(job.kind, jobs);
  }
  for (const [kind, jobs] of groups) {
    try {
      const db = env.DB.withSession("first-primary");
      const pending = await db
        .prepare(
          kind === "notifications.invalidate"
            ? `SELECT o.seq, c.user_id FROM notification_outbox o JOIN notification_changes c ON c.seq = o.seq
        WHERE o.seq IN (SELECT value FROM json_each(?)) AND o.delivered_at IS NULL`
            : `SELECT seq, user_id FROM mail_push_outbox
        WHERE seq IN (SELECT value FROM json_each(?)) AND delivered_at IS NULL`,
        )
        .bind(JSON.stringify([...jobs.keys()]))
        .all<{ seq: number; user_id: string }>();
      const users = new Map<string, number[]>();
      for (const row of pending.results)
        users.set(row.user_id, [...(users.get(row.user_id) ?? []), row.seq]);
      const failed = new Set<number>(),
        delivered: number[] = [];
      for (const [userId, seqs] of users) {
        try {
          if (kind === "notifications.invalidate")
            await env.NOTIFICATION_HUB.get(env.NOTIFICATION_HUB.idFromName(userId)).invalidate();
          for (const seq of seqs) {
            try {
              if (kind === "mail.push") await deliverMailPush(env, seq);
              else await deliverPush(env, seq);
              delivered.push(seq);
            } catch {
              console.error("Push delivery failed", { seq });
              failed.add(seq);
            }
          }
        } catch (error) {
          console.error("Notification delivery failed", error);
          for (const seq of seqs) failed.add(seq);
        }
      }
      if (delivered.length)
        await db
          .prepare(
            `UPDATE ${outboxes[kind]} SET delivered_at = ?
      WHERE seq IN (SELECT value FROM json_each(?)) AND delivered_at IS NULL`,
          )
          .bind(now(), JSON.stringify(delivered))
          .run();
      for (const [seq, messages] of jobs)
        for (const message of messages) {
          if (failed.has(seq)) message.retry({ delaySeconds: 30 });
          else message.ack();
        }
    } catch (error) {
      console.error("Notification batch failed", error);
      for (const messages of jobs.values())
        for (const message of messages) message.retry({ delaySeconds: 30 });
    }
  }
}
