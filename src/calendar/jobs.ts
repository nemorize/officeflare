import { createDatabase } from "../db";
import { now, uuid, type AuthEnv } from "../auth/types";
import { provider } from "../mail/providers";
import type { SubmissionSnapshot, Attachment } from "../mail/types";
import type { DeliveryPayload } from "./collaboration-types";
import type { CalendarContext, Event } from "./types";
import { first, rows, active } from "./access";
import { unseal, seal } from "./secrets";
import { endpoint } from "./time";
import { recipientUser, noInternalRecipientSql } from "./recipients";
import { calendarFile, plainText } from "./ical";
import { notificationStatements } from "./delivery";
import { recoverNotifications } from "../notifications/jobs";
import {
  personalInvitationSender,
  personalSenderCondition,
  type PersonalInvitationSender,
} from "./sender";
export async function recoverCalendar(env: AuthEnv) {
  const db = env.DB.withSession("first-primary");
  const unresolved = await rows<{ id: string }>(
    env,
    "SELECT id FROM calendar_invitation_deliveries WHERE status IN('unknown','sending') ORDER BY created_at,id LIMIT 50",
  );
  for (const item of unresolved) {
    const object = await env.MAIL_BUCKET?.get(`calendar/receipts/${item.id}.json`);
    if (object) {
      const receipt = await object.json<{ provider_message_id: string }>();
      await db.batch([
        db
          .prepare(
            "UPDATE calendar_invitation_deliveries SET status='accepted',provider_message_id=?,accepted_at=COALESCE(accepted_at,unixepoch()),error_code=NULL WHERE id=? AND status IN('unknown','sending')",
          )
          .bind(receipt.provider_message_id, item.id),
        db
          .prepare("UPDATE calendar_outbox SET completed_at=unixepoch(),lease_until=0 WHERE id=?")
          .bind(item.id),
      ]);
    }
  }
  // A crashed worker may have submitted its message. Never blindly resend it.
  await db.batch([
    db.prepare(
      "UPDATE calendar_invitation_deliveries SET status='unknown',error_code='acceptance_unknown' WHERE status='sending' AND id IN(SELECT id FROM calendar_outbox WHERE lease_until<=unixepoch())",
    ),
    db.prepare("DELETE FROM calendar_public_limits WHERE window_start<unixepoch()-86400"),
    db.prepare("DELETE FROM calendar_external_email_challenges WHERE expires_at<unixepoch()-86400"),
  ]);
  if (!env.MAIL_QUEUE) return;
  const pending = await rows<{ id: string }>(
    env,
    "SELECT o.id FROM calendar_outbox o JOIN calendar_invitation_deliveries d ON d.id=o.id WHERE o.completed_at IS NULL AND o.run_at<=unixepoch() AND o.lease_until<=unixepoch() AND d.status IN('queued','retry_wait') ORDER BY o.run_at,o.id LIMIT 50",
  );
  if (pending.length)
    await env.MAIL_QUEUE.sendBatch(
      pending.map((value) => ({
        body: { kind: "calendar.delivery", id: value.id },
      })),
    );
}
async function systemSender(env: AuthEnv) {
  const value = await first<{
    email_address: string;
    provider: string;
    max_send_bytes: number | null;
    id: string;
    name: string;
    enabled: number;
    version: number;
    config_json: string;
    secret_ciphertext: string | null;
    secret_nonce: string | null;
  }>(
    env,
    "SELECT a.local_part||'@'||d.name email_address,p.provider,d.max_send_bytes,p.id,p.name,p.enabled,p.version,p.config_json,p.secret_ciphertext,p.secret_nonce FROM calendar_workspace_settings s JOIN mail_addresses a ON a.id=s.system_address_id JOIN mail_domains d ON d.id=a.domain_id JOIN mail_provider_connections p ON p.id=d.outbound_connection_id WHERE s.id='workspace' AND a.send_enabled=1 AND d.outbound_enabled=1 AND p.enabled=1",
  );
  if (!value)
    throw Object.assign(new Error("System invitation sender is not configured"), {
      code: "CALENDAR_SENDER_UNAVAILABLE",
      retryable: true,
    });
  return value;
}
export async function deliverCalendar(env: AuthEnv, id: string) {
  const lease = uuid(),
    db = env.DB.withSession("first-primary"),
    job = await db
      .prepare(
        `UPDATE calendar_outbox SET lease_token=?,lease_until=unixepoch()+120,attempts=attempts+1 WHERE id=? AND completed_at IS NULL AND run_at<=unixepoch() AND lease_until<=unixepoch() AND EXISTS(SELECT 1 FROM calendar_invitation_deliveries d WHERE d.id=calendar_outbox.id AND d.status IN('queued','retry_wait')) RETURNING *`,
      )
      .bind(lease, id)
      .first<{ payload_json: string; attempts: number }>();
  if (!job) return;
  const guard = "EXISTS(SELECT 1 FROM calendar_outbox WHERE id=? AND lease_token=?)";
  const finish = async (
    status: string,
    error: string | null = null,
    receipt: string | null = null,
  ) =>
    db.batch([
      db
        .prepare(
          `UPDATE calendar_invitation_deliveries SET status=?,error_code=?,provider_message_id=COALESCE(?,provider_message_id),accepted_at=CASE WHEN ?='accepted' THEN unixepoch() ELSE accepted_at END,retry_at=CASE WHEN ?='retry_wait' THEN unixepoch()+? ELSE NULL END WHERE id=? AND ${guard}`,
        )
        .bind(
          status,
          error,
          receipt,
          status,
          status,
          Math.min(3600, 30 * 2 ** Math.min(job.attempts, 6)),
          id,
          id,
          lease,
        ),
      db
        .prepare(
          "UPDATE calendar_outbox SET lease_until=0,completed_at=CASE WHEN ?='retry_wait' THEN NULL ELSE unixepoch() END,run_at=unixepoch()+? WHERE id=? AND lease_token=?",
        )
        .bind(status, Math.min(3600, 30 * 2 ** Math.min(job.attempts, 6)), id, lease),
    ]);
  const delivery = await first<{
    event_id: string | null;
    attendee_id: string | null;
    recipient_email: string;
    recipient_user_id: string | null;
    action: string;
    sequence: number;
    occurrence_key: string;
    message_id: string;
  }>(env, "SELECT * FROM calendar_invitation_deliveries WHERE id=?", id);
  if (!delivery) return;
  let acceptedId: string | undefined;
  try {
    const receipt = await env.MAIL_BUCKET.get(`calendar/receipts/${id}.json`);
    if (receipt) {
      const value = await receipt.json<{ provider_message_id: string }>();
      return void (await finish("accepted", null, value.provider_message_id));
    }
    const payload = await unseal<DeliveryPayload>(
      env,
      `delivery:${id}`,
      JSON.parse(job.payload_json),
    );
    if (payload.kind === "invitation") {
      const event = await first<Event>(
        env,
        `SELECT e.* FROM calendar_events e JOIN calendars cal ON cal.id=e.organizer_calendar_id JOIN users owner ON owner.id=cal.data_owner_user_id WHERE e.id=? AND cal.status='active' AND (cal.trashed_at IS NULL OR ?='cancel') AND ${active("owner")}`,
        delivery.event_id,
        delivery.action,
      );
      if (!event) return void (await finish("suppressed", "event_unavailable"));
      if (event.sequence !== delivery.sequence)
        return void (await finish("superseded", "newer_event_sequence"));
      const attendee = await first<{
        user_id: string | null;
        email_address: string;
        email_key: string;
        removed_at: number | null;
        scope_id: string;
      }>(env, "SELECT * FROM calendar_event_attendees WHERE id=?", delivery.attendee_id);
      if (!attendee || ((event.trashed_at || attendee.removed_at) && delivery.action !== "cancel"))
        return void (await finish("suppressed", "invitation_revoked"));
      const resolved = attendee.user_id ? null : await recipientUser(env, attendee.email_key);
      if (resolved?.ambiguous)
        return void (await finish("suppressed", "ambiguous_internal_recipient"));
      const mapped = attendee.user_id ? { id: attendee.user_id } : resolved?.user;
      if (mapped) {
        const c = {
          env,
          get: (key: string) => (key === "db" ? createDatabase(env.DB) : undefined),
        } as unknown as CalendarContext;
        // The proof is bound through a literal UUID generated by this worker.
        const literal = `EXISTS(SELECT 1 FROM calendar_outbox WHERE id='${id}' AND lease_token='${lease}')`;
        await db.batch([
          db
            .prepare(
              `UPDATE calendar_event_attendees SET user_id=?,principal_type='user',version=version+1 WHERE id=? AND user_id IS NULL AND ${literal}`,
            )
            .bind(mapped.id, delivery.attendee_id),
          db
            .prepare(
              `UPDATE calendar_event_registrations SET user_id=? WHERE attendee_id=? AND user_id IS NULL AND ${literal}`,
            )
            .bind(mapped.id, delivery.attendee_id),
          ...notificationStatements(
            c,
            literal,
            `calendar:${id}`,
            mapped.id,
            delivery.action,
            `/calendar/invitations/${delivery.attendee_id}`,
          ),
          db
            .prepare(
              `UPDATE calendar_invitation_deliveries SET recipient_user_id=?,recipient_email=NULL,recipient_key=?,channel='notification_center',status=CASE WHEN EXISTS(SELECT 1 FROM notification_inbox i JOIN notification_events n ON n.id=i.event_id WHERE n.source_key=?) THEN 'inbox_committed' ELSE 'suppressed' END WHERE id=? AND ${literal}`,
            )
            .bind(mapped.id, `user:${mapped.id}`, `calendar:${id}`, id),
          db
            .prepare(
              `UPDATE calendar_outbox SET completed_at=unixepoch(),lease_until=0 WHERE id=? AND ${literal}`,
            )
            .bind(id),
        ]);
        if (env.NOTIFICATION_QUEUE) await recoverNotifications(env);
        return;
      }
    }
    if (payload.kind === "recovery" && payload.automatic) {
      const resolved = await recipientUser(env, delivery.recipient_email.toLowerCase());
      if (resolved.user || resolved.ambiguous)
        return void (await finish("suppressed", "internal_recipient"));
    }
    const personal =
      payload.kind === "invitation"
        ? await personalInvitationSender(env, payload.event?.organizer_user_id ?? null)
        : null;
    if (payload.kind === "invitation" && !personal)
      return void (await finish("suppressed", "personal_sender_unavailable"));
    const from = personal ?? (await systemSender(env)),
      adapter = provider(from.provider),
      attachments: Attachment[] = [];
    const snapshotKey = `calendar/snapshots/${id}.json`,
      previousSnapshot = await env.MAIL_BUCKET.get(snapshotKey);
    let text = "",
      subject = "";
    if (payload.kind === "invitation") {
      const event = payload.event!,
        method = payload.action === "cancel" ? "CANCEL" : "REQUEST",
        filename =
          payload.action === "cancel"
            ? "cancel.ics"
            : payload.action === "update"
              ? "update.ics"
              : "invite.ics",
        ics = calendarFile(payload, from.email_address),
        key = `calendar/deliveries/${id}/${filename}`;
      if (!previousSnapshot)
        await env.MAIL_BUCKET.put(key, ics, {
          httpMetadata: {
            contentType: `text/calendar; charset=UTF-8; method=${method}`,
          },
        });
      attachments.push({
        id: uuid(),
        filename,
        content_type: `text/calendar; charset=UTF-8; method=${method}`,
        size_bytes: new TextEncoder().encode(ics).length,
        r2_key: key,
        disposition: "attachment",
        content_id: null,
      });
      subject =
        `${payload.action === "cancel" ? "Cancelled" : payload.action === "update" ? "Updated" : "Invitation"}: ${event.title}`.replace(
          /[\r\n]/g,
          " ",
        );
      text = `${event.title}\n${event.time_kind === "all_day" ? `All day: ${event.start_date} – ${new Date(Date.parse(event.end_date!) - 86400000).toISOString().slice(0, 10)}` : `${endpoint(event, "start").date_time} – ${endpoint(event, "end").date_time} (${event.start_time_zone})`}\n${plainText(event.description_html)}${payload.url ? `\n\nView and respond: ${payload.url}` : ""}`;
    } else if (payload.kind === "verify") {
      subject = "Verify your calendar registration email";
      text = `Your verification code is ${payload.code}. It expires in 10 minutes.`;
    } else {
      subject = "Manage your calendar registration";
      text = `Manage your registration: ${payload.url}`;
    }
    let snapshot: SubmissionSnapshot = {
      from: from.email_address,
      to: [delivery.recipient_email],
      cc: [],
      bcc: [],
      subject,
      text,
      html: "",
      headers: { "Message-ID": delivery.message_id },
      attachments,
    };
    if (previousSnapshot) {
      snapshot = await unseal<SubmissionSnapshot & { calendar_sender?: PersonalInvitationSender }>(
        env,
        `snapshot:${id}`,
        (await previousSnapshot.json()) as Parameters<typeof unseal>[2],
      );
      if (snapshot.from !== from.email_address)
        return void (await finish("failed", "sender_configuration_changed"));
      const binding = (
        snapshot as SubmissionSnapshot & {
          calendar_sender?: PersonalInvitationSender;
        }
      ).calendar_sender;
      if (
        personal &&
        (!binding ||
          binding.user_id !== personal.user_id ||
          binding.auth_version !== personal.auth_version ||
          binding.mailbox_id !== personal.mailbox_id ||
          binding.address_id !== personal.address_id ||
          binding.connection_id !== personal.connection_id ||
          binding.provider !== personal.provider ||
          binding.version !== personal.version)
      )
        return void (await finish("failed", "sender_configuration_changed"));
    } else
      await env.MAIL_BUCKET.put(
        snapshotKey,
        JSON.stringify(
          await seal(env, `snapshot:${id}`, {
            ...snapshot,
            ...(personal ? { calendar_sender: personal } : {}),
          }),
        ),
      );
    if (
      new TextEncoder().encode(snapshot.text).length +
        snapshot.attachments.reduce((sum, file) => sum + (file.size_bytes * 4) / 3, 0) >
      Math.min(adapter.capabilities.max_send_bytes, from.max_send_bytes ?? Infinity)
    )
      return void (await finish("failed", "message_too_large"));
    const sendGuard =
      payload.kind === "invitation"
        ? ` AND EXISTS(SELECT 1 FROM calendar_events e JOIN calendars cal ON cal.id=e.organizer_calendar_id JOIN users owner ON owner.id=cal.data_owner_user_id WHERE e.id=calendar_invitation_deliveries.event_id AND e.sequence=calendar_invitation_deliveries.sequence AND ${active("owner")} AND cal.status='active' AND (cal.trashed_at IS NULL OR calendar_invitation_deliveries.action='cancel')) AND EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.id=calendar_invitation_deliveries.attendee_id AND a.user_id IS NULL AND ${noInternalRecipientSql("a.email_key")} AND (a.removed_at IS NULL OR calendar_invitation_deliveries.action='cancel'))`
        : "";
    const senderGuard = personal ? personalSenderCondition(personal) : null;
    const started = await db
      .prepare(
        `UPDATE calendar_invitation_deliveries SET status='sending' WHERE id=? AND ${guard}${sendGuard}${senderGuard ? ` AND (${senderGuard.sql})` : ""}`,
      )
      .bind(id, id, lease, ...(senderGuard?.args ?? []))
      .run();
    if (started.meta.changes !== 1)
      return void (await finish("retry_wait", "delivery_state_changed"));
    const accepted = await adapter.send(env, snapshot, from, id);
    acceptedId = accepted.provider_message_id;
    await env.MAIL_BUCKET.put(`calendar/receipts/${id}.json`, JSON.stringify(accepted));
    await finish("accepted", null, accepted.provider_message_id);
  } catch (error) {
    if (acceptedId) return void (await finish("accepted", null, acceptedId));
    const value = error as { code?: string; retryable?: boolean };
    const sending = await first<{ status: string }>(
      env,
      "SELECT status FROM calendar_invitation_deliveries WHERE id=?",
      id,
    );
    const retryable =
        value.retryable ||
        ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"].includes(value.code ?? ""),
      definite = [
        "LOCAL_ATTACHMENT_MISSING",
        "E_VALIDATION_ERROR",
        "E_FIELD_MISSING",
        "E_SENDER_NOT_VERIFIED",
        "E_RECIPIENT_NOT_ALLOWED",
        "E_RECIPIENT_SUPPRESSED",
        "E_CONTENT_TOO_LARGE",
        "E_SENDER_DOMAIN_NOT_AVAILABLE",
      ].includes(value.code ?? "");
    await finish(
      sending?.status === "sending" && !value.retryable
        ? retryable
          ? job.attempts >= 8
            ? "failed"
            : "retry_wait"
          : definite
            ? "failed"
            : "unknown"
        : job.attempts >= 8
          ? "failed"
          : "retry_wait",
      value.code ?? "delivery_error",
    );
  }
}
export async function consumeCalendar(batch: MessageBatch<unknown>, env: AuthEnv) {
  for (const message of batch.messages) {
    const body = message.body as { kind?: string; id?: string };
    if (body?.kind !== "calendar.delivery" || !body.id || !/^[A-Za-z0-9_-]+$/.test(body.id)) {
      message.ack();
      continue;
    }
    try {
      await deliverCalendar(env, body.id);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}
export function wakeCalendar(c: CalendarContext) {
  if (c.env.MAIL_QUEUE)
    c.executionCtx.waitUntil(
      recoverCalendar(c.env).catch(() => console.error("Calendar delivery recovery failed")),
    );
  if (c.env.NOTIFICATION_QUEUE)
    c.executionCtx.waitUntil(
      recoverNotifications(c.env).catch(() =>
        console.error("Calendar notification recovery failed"),
      ),
    );
}
