import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db";
import { prepareNotification, type NotificationEvent } from "../src/notifications/service";
import { consumeNotifications, recoverNotifications } from "../src/notifications/jobs";
import { notifyIncomingMail } from "../src/notifications/mail";
import type { AuthEnv } from "../src/auth/types";

// Test-only producer and delivery controls; none of these endpoints ship in the Worker.
export default {
  async fetch(request: Request, env: AuthEnv) {
    const data = (await request.json()) as NotificationEvent & {
      condition?: boolean;
      rollback?: boolean;
      seq?: number;
      kind?: "notifications.invalidate" | "mail.push";
      mailbox_id?: string;
      ingest_id?: string;
    };
    const path = new URL(request.url).pathname;
    if (path === "/recover") await recoverNotifications(env);
    else if (path === "/mail")
      await notifyIncomingMail(env, data.mailbox_id!, data.ingest_id!, data.title, data.body);
    else if (path === "/deliver") {
      let action = "";
      const message = {
        body: { kind: data.kind ?? "notifications.invalidate", seq: data.seq },
        ack: () => {
          action = "ack";
        },
        retry: () => {
          action = "retry";
        },
      };
      await consumeNotifications({ messages: [message] } as unknown as MessageBatch<unknown>, env);
      return Response.json({ action });
    } else {
      const db = createDatabase(env.DB),
        statements = prepareNotification(db, data, sql`${data.condition !== false ? 1 : 0}`);
      try {
        await db.batch(
          data.rollback
            ? [
                ...statements,
                db.run(
                  sql`INSERT INTO notification_events (id, source_key, type, title, body) VALUES ('invalid', 'invalid', 'invalid', '', '')`,
                ),
              ]
            : statements,
        );
      } catch {
        return new Response("Rolled back", { status: 409 });
      }
    }
    return Response.json({ ok: true });
  },
};
