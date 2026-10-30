import { t } from "../../shared/i18n/index.ts";
import { and, eq, exists, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db";
import { eligibleUser } from "../db/auth-conditions";
import { insertWhen } from "../db/conditional-insert";
import { notificationEvents, notificationInbox, notificationRecipients, users } from "../db/schema";
import { now, uuid } from "../auth/types";
import { knownType, notificationTypes, targetPath, type NotificationType } from "./catalog";

export interface NotificationEvent {
  source_key: string;
  type: NotificationType;
  title: string;
  body: string;
  target_path?: string | null;
  recipient_ids: readonly string[];
}

// The producer must include these statements in its domain transaction. Unique source
// and recipient keys make retries safe; the DB triggers also commit the delivery outbox.
export function prepareNotification(
  db: Database,
  input: NotificationEvent,
  condition: SQL = sql`1`,
) {
  if (
    !knownType(input.type) ||
    !input.source_key ||
    input.source_key.length > 256 ||
    !input.title ||
    input.title.length > 160 ||
    input.body.length > 1000
  ) {
    throw new Error(t("notificationsService.invalidNotificationEvent"));
  }
  const recipients = [...new Set(input.recipient_ids)];
  if (!recipients.length || recipients.length > 50)
    throw new Error(t("notificationsService.notificationBatchesNeed1To50Recipients"));
  const definition = notificationTypes[input.type],
    timestamp = now();
  const event = insertWhen(
    db,
    notificationEvents,
    {
      id: uuid(),
      source_key: input.source_key,
      type: input.type,
      title: input.title,
      body: input.body,
      target_path: targetPath(input.type, input.target_path),
      created_at: timestamp,
    },
    condition,
  ).onConflictDoNothing({ target: notificationEvents.source_key });
  const deliveries = recipients.flatMap((userId) => {
    const eventId = sql`(SELECT id FROM notification_events WHERE source_key = ${input.source_key})`;
    const eligible = exists(
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eligibleUser())),
    );
    const allowed = and(
      eligible,
      definition.required
        ? undefined
        : sql`NOT EXISTS (
      SELECT 1 FROM notification_preferences p WHERE p.user_id = ${userId} AND (
        COALESCE(json_extract(p.rules_json, ${`$."type:${input.type}"`}),
          json_extract(p.rules_json, ${`$."category:${definition.service}:${definition.category}"`}),
          json_extract(p.rules_json, ${`$."service:${definition.service}"`}), p.enabled) = 0
      )
    )`,
    )!;
    const recipient = insertWhen(
      db,
      notificationRecipients,
      {
        event_id: eventId,
        user_id: userId,
        decision: sql`CASE WHEN ${allowed} THEN 'deliver' ELSE 'suppressed' END`,
        created_at: timestamp,
      },
      and(
        condition,
        exists(db.select({ id: users.id }).from(users).where(eq(users.id, userId))),
        exists(
          db
            .select({ id: notificationEvents.id })
            .from(notificationEvents)
            .where(eq(notificationEvents.source_key, input.source_key)),
        ),
      )!,
    ).onConflictDoNothing({
      target: [notificationRecipients.event_id, notificationRecipients.user_id],
    });
    const inbox = insertWhen(
      db,
      notificationInbox,
      {
        id: uuid(),
        user_id: userId,
        event_id: eventId,
        created_at: timestamp,
        updated_at: timestamp,
      },
      and(
        condition,
        eligible,
        exists(
          db
            .select({ id: notificationRecipients.user_id })
            .from(notificationRecipients)
            .where(
              and(
                eq(notificationRecipients.event_id, eventId),
                eq(notificationRecipients.user_id, userId),
                eq(notificationRecipients.decision, "deliver"),
              ),
            ),
        ),
      )!,
    ).onConflictDoNothing({ target: [notificationInbox.user_id, notificationInbox.event_id] });
    return [recipient, inbox];
  });
  return [event, ...deliveries] as const;
}

export const visibleInbox = (userId: string) =>
  and(eq(notificationInbox.user_id, userId), isNull(notificationInbox.deleted_at));
