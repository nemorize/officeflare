import { now, uuid, type AuthEnv } from "../auth/types";

interface InvalidationJob {
  kind: "notifications.invalidate";
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
  ]);
  if (!env.NOTIFICATION_QUEUE) return;
  const lease = uuid();
  const claimed = await db
    .prepare(
      `UPDATE notification_outbox SET lease_until = ?, lease_token = ?
    WHERE seq IN (SELECT seq FROM notification_outbox WHERE delivered_at IS NULL AND lease_until <= ? ORDER BY seq LIMIT 100)
    AND delivered_at IS NULL AND lease_until <= ? RETURNING seq`,
    )
    .bind(timestamp + 60, lease, timestamp, timestamp)
    .all<{ seq: number }>();
  if (!claimed.results.length) return;
  try {
    await env.NOTIFICATION_QUEUE.sendBatch(
      claimed.results.map((row) => ({
        body: { kind: "notifications.invalidate", seq: row.seq } satisfies InvalidationJob,
      })),
    );
  } catch (error) {
    await db
      .prepare(
        "UPDATE notification_outbox SET lease_until = 0 WHERE lease_token = ? AND delivered_at IS NULL",
      )
      .bind(lease)
      .run();
    throw error;
  }
}

export async function consumeNotifications(batch: MessageBatch<unknown>, env: AuthEnv) {
  const jobs = new Map<number, Message<unknown>[]>();
  for (const message of batch.messages) {
    const job = message.body as Partial<InvalidationJob> | null;
    if (
      !job ||
      job.kind !== "notifications.invalidate" ||
      !Number.isSafeInteger(job.seq) ||
      job.seq! <= 0
    ) {
      console.error("Invalid notification queue message");
      message.ack();
      continue;
    }
    jobs.set(job.seq!, [...(jobs.get(job.seq!) ?? []), message]);
  }
  if (!jobs.size) return;
  try {
    const db = env.DB.withSession("first-primary");
    const pending = await db
      .prepare(
        `SELECT o.seq, c.user_id FROM notification_outbox o JOIN notification_changes c ON c.seq = o.seq
      WHERE o.seq IN (SELECT value FROM json_each(?)) AND o.delivered_at IS NULL`,
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
        await env.NOTIFICATION_HUB.get(env.NOTIFICATION_HUB.idFromName(userId)).invalidate();
        delivered.push(...seqs);
      } catch (error) {
        console.error("Notification delivery failed", error);
        for (const seq of seqs) failed.add(seq);
      }
    }
    if (delivered.length)
      await db
        .prepare(
          `UPDATE notification_outbox SET delivered_at = ?
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
