import { processDataJob } from "./data";
import { hash } from "./input";
import { all, authorize, first, sender } from "./control";
import { mailbox, partition } from "./mailbox";
import { provider } from "./providers";
import { flushOutbox, ingest } from "./service";
import { unseal } from "./secrets";
import {
  epoch,
  fail,
  locator,
  type DeliveryTask,
  type MailTask,
  type SubmissionSnapshot,
} from "./types";
export async function sendSubmission(
  env: Env,
  mailboxId: string,
  partitionId: string,
  submissionId: string,
) {
  const store = partition(env, partitionId),
    receiptKey = "accepted/" + mailboxId + "/" + submissionId + ".json";
  const accepted = await env.MAIL_BUCKET.get(receiptKey);
  if (accepted) {
    const value = await accepted.json<{ provider_message_id: string }>();
    const job = await store.submission(submissionId);
    await rememberDelivery(
      env,
      job.provider,
      job.connection_id,
      value.provider_message_id,
      mailboxId,
      partitionId,
      submissionId,
    );
    await store.complete(submissionId, value.provider_message_id);
    await mailbox(env, mailboxId).rememberProvider(
      job.provider,
      job.connection_id,
      value.provider_message_id,
      partitionId,
      submissionId,
    );
    await flushOutbox(env, mailboxId, partitionId);
    return;
  }
  const job = await store.claim(submissionId);
  if (!job) return;
  let snapshot: SubmissionSnapshot;
  try {
    const selected = await sender(
      env,
      {
        user_id: job.actor_id,
        auth_version: job.actor_auth_version,
        api_key_id: job.api_key_id,
      },
      mailboxId,
      job.address_id,
      job.send_mode,
    );
    if (
      selected.provider !== job.provider ||
      selected.connection_id !== job.connection_id
    )
      fail(409, "Sending provider connection changed");
    const object = await env.MAIL_BUCKET.get(job.snapshot_r2_key);
    if (!object) fail(409, "Submission snapshot is unavailable");
    snapshot = await object.json<SubmissionSnapshot>();
    if (snapshot.from !== selected.email_address)
      fail(409, "Sending address changed");
  } catch {
    await store.failure(
      submissionId,
      "failed",
      "authorization_or_configuration_changed",
    );
    await flushOutbox(env, mailboxId, partitionId);
    return;
  }
  let result: { provider_message_id: string };
  try {
    result = await provider(job.provider).send(env, snapshot);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "acceptance_unknown";
    const retryable = [
      "E_RATE_LIMIT_EXCEEDED",
      "E_DAILY_LIMIT_EXCEEDED",
    ].includes(code);
    const known = [
      "LOCAL_ATTACHMENT_MISSING",
      "E_VALIDATION_ERROR",
      "E_FIELD_MISSING",
      "E_TOO_MANY_RECIPIENTS",
      "E_TOO_MANY_ATTACHMENTS",
      "E_SENDER_NOT_VERIFIED",
      "E_RECIPIENT_NOT_ALLOWED",
      "E_RECIPIENT_SUPPRESSED",
      "E_SENDER_DOMAIN_NOT_AVAILABLE",
      "E_CONTENT_TOO_LARGE",
      "E_RATE_LIMIT_EXCEEDED",
      "E_DAILY_LIMIT_EXCEEDED",
      "E_HEADER_NOT_ALLOWED",
      "E_HEADER_USE_API_FIELD",
      "E_HEADER_VALUE_INVALID",
      "E_HEADER_VALUE_TOO_LONG",
      "E_HEADER_NAME_INVALID",
      "E_HEADERS_TOO_LARGE",
      "E_HEADERS_TOO_MANY",
    ].includes(code);
    const retryAt =
      epoch() + Math.min(86400, 60 * 2 ** Math.min(job.attempt_count, 10));
    await store.failure(
      submissionId,
      retryable && job.attempt_count < 5
        ? "retry_wait"
        : known
          ? "failed"
          : "unknown",
      code,
      retryAt,
    );
    if (retryable && job.attempt_count < 5)
      await mailbox(env, mailboxId).schedule({
        id: submissionId,
        partition_id: partitionId,
        kind: "send",
        reference_id: submissionId,
        due_at: retryAt,
      });
    await flushOutbox(env, mailboxId, partitionId);
    return;
  }
  // After provider acceptance, all retries reconcile this receipt; they never send again.
  await env.MAIL_BUCKET.put(receiptKey, JSON.stringify(result), {
    httpMetadata: { contentType: "application/json" },
  });
  await rememberDelivery(
    env,
    job.provider,
    job.connection_id,
    result.provider_message_id,
    mailboxId,
    partitionId,
    submissionId,
  );
  await store.complete(submissionId, result.provider_message_id);
  await mailbox(env, mailboxId).rememberProvider(
    job.provider,
    job.connection_id,
    result.provider_message_id,
    partitionId,
    submissionId,
  );
  await flushOutbox(env, mailboxId, partitionId);
}
async function delivery(env: Env, event: DeliveryTask) {
  const receipt = await env.MAIL_BUCKET.get(
    "delivery-index/" +
      event.provider +
      "/" +
      (await hash(event.provider_message_id)) +
      ".json",
  );
  if (receipt) {
    const target = await receipt.json<{
      mailbox_id: string;
      partition_id: string;
      submission_id: string;
      connection_id: string;
    }>();
    const store = partition(env, target.partition_id);
    // A deleted message no longer needs delivery updates. Keep historical routing
    // independent of address reassignment and disabled provider connections.
    if (!(await store.findSubmission(target.submission_id))) return;
    await store.delivery(target.submission_id, {
      ...event,
      connection_id: event.connection_id || target.connection_id,
    });
    await flushOutbox(env, target.mailbox_id, target.partition_id);
    return;
  }
  const targets = await all<{ mailbox_id: string }>(
    env,
    "SELECT a.mailbox_id FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id WHERE lower(a.local_part||'@'||d.name)=lower(?)",
    event.sender,
  );
  for (const target of targets) {
    const coordinator = mailbox(env, target.mailbox_id);
    for (const entry of (await coordinator.partitions()).reverse()) {
      const submissionId = await partition(env, entry.id).providerSubmission(
        event.provider,
        event.connection_id,
        event.provider_message_id,
      );
      if (!submissionId) continue;
      const job = await partition(env, entry.id).submission(submissionId);
      await partition(env, entry.id).delivery(submissionId, {
        ...event,
        connection_id: job.connection_id,
      });
      await flushOutbox(env, target.mailbox_id, entry.id);
      return;
    }
  }
  // Delivery can arrive before the provider ID has been committed.
  fail(503, "Delivery correlation is pending");
}
async function rememberDelivery(
  env: Env,
  provider: string,
  connectionId: string,
  providerMessageId: string,
  mailboxId: string,
  partitionId: string,
  submissionId: string,
) {
  await env.MAIL_BUCKET.put(
    "delivery-index/" +
      provider +
      "/" +
      (await hash(providerMessageId)) +
      ".json",
    JSON.stringify({
      mailbox_id: mailboxId,
      partition_id: partitionId,
      submission_id: submissionId,
      connection_id: connectionId,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
}
export function normalizeTask(value: unknown): MailTask {
  if (!value || typeof value !== "object") fail(400, "Invalid mail task");
  const event = value as Record<string, unknown>;
  if (typeof event.kind === "string") return value as MailTask;
  if (
    typeof event.type === "string" &&
    event.type.startsWith("cf.email.sending.message.")
  ) {
    const payload = event.payload as Record<string, unknown>,
      metadata = event.metadata as Record<string, unknown>;
    if (
      !payload ||
      !metadata ||
      typeof payload.eventId !== "string" ||
      typeof payload.messageId !== "string" ||
      typeof payload.sender !== "string" ||
      typeof payload.recipient !== "string"
    )
      fail(400, "Invalid Cloudflare delivery event");
    const status = event.type.split(".").at(-1)!;
    if (
      ![
        "delivered",
        "deferred",
        "bounced",
        "failed",
        "rejected",
        "complained",
      ].includes(status)
    )
      fail(400, "Unsupported delivery event");
    const timestamp = Date.parse(String(metadata.eventTimestamp));
    if (!Number.isFinite(timestamp)) fail(400, "Invalid event timestamp");
    return {
      kind: "delivery",
      provider: "cloudflare",
      connection_id: "",
      provider_event_id: payload.eventId,
      provider_message_id: payload.messageId,
      sender: payload.sender,
      recipient: payload.recipient,
      status,
      event_at: Math.floor(timestamp / 1000),
    };
  }
  fail(400, "Unsupported mail task");
}
export async function processTask(env: Env, value: unknown) {
  const task = normalizeTask(value);
  switch (task.kind) {
    case "data_job":
      await processDataJob(env, task.mailbox_id, task.reference_id);
      break;
    case "inbound":
      await ingest(env, task);
      break;
    case "send":
      await sendSubmission(
        env,
        task.mailbox_id,
        task.partition_id,
        task.reference_id,
      );
      break;
    case "snooze": {
      const store = partition(env, task.partition_id),
        message = await store.internalMessage(task.reference_id);
      if (message?.snoozed_until && message.snoozed_until <= epoch())
        await mailbox(env, task.mailbox_id).changeMessage(
          task.partition_id,
          message.id,
          message.draft_owner_id ?? "",
          message.version,
          { snoozed_until: null },
        );
      await flushOutbox(env, task.mailbox_id, task.partition_id);
      break;
    }
    case "outbox":
      await flushOutbox(env, task.mailbox_id, task.partition_id);
      break;
    case "delivery":
      await delivery(env, task);
      break;
    case "webhook":
      await deliverWebhook(
        env,
        task.mailbox_id,
        task.partition_id,
        task.reference_id,
      );
      break;
    default:
      fail(400, "Unsupported mail task");
  }
}
export async function consume(batch: MessageBatch, env: Env) {
  for (const message of batch.messages) {
    try {
      await processTask(env, message.body);
      message.ack();
    } catch (error) {
      console.error(
        "Mail task retry",
        message.id,
        error instanceof Error ? error.message : "unknown",
      );
      message.retry({ delaySeconds: 60 });
    }
  }
}
export async function recover(env: Env) {
  await cleanUploads(env);
  let cursor: string | undefined;
  // Process a bounded page each run, rotate the listing cursor durably to avoid starving later keys.
  const cursorObject = await env.MAIL_BUCKET.get(
    "maintenance/pending-cursor.json",
  );
  if (cursorObject)
    cursor = (await cursorObject.json<{ cursor?: string }>()).cursor;
  const page = await env.MAIL_BUCKET.list({
    prefix: "pending/",
    limit: 100,
    cursor,
  });
  for (const object of page.objects) {
    const pending = await env.MAIL_BUCKET.get(object.key);
    if (pending) await env.MAIL_QUEUE.send(await pending.json());
  }
  await env.MAIL_BUCKET.put(
    "maintenance/pending-cursor.json",
    JSON.stringify({ cursor: page.truncated ? page.cursor : undefined }),
  );
}
export async function queueWebhooks(
  env: Env,
  mailboxId: string,
  eventId: string,
  payload: {
    message_id: string;
    operation: string;
    private_user_id?: string | null;
  },
) {
  if (payload.private_user_id) return;
  const partitionId = locator(payload.message_id),
    store = partition(env, partitionId);
  for (const hook of await all<{ id: string; owner_user_id: string }>(
    env,
    "SELECT id,owner_user_id FROM mail_webhooks WHERE mailbox_id=? AND enabled=1",
    mailboxId,
  )) {
    const deliveryId = await store.registerWebhook(
      hook.id,
      eventId,
      JSON.stringify({
        id: eventId,
        mailbox_id: mailboxId,
        message_id: payload.message_id,
        operation: payload.operation,
      }),
    );
    await mailbox(env, mailboxId).schedule({
      id: deliveryId,
      kind: "webhook",
      partition_id: partitionId,
      reference_id: deliveryId,
      due_at: epoch(),
    });
  }
}
async function deliverWebhook(
  env: Env,
  mailboxId: string,
  partitionId: string,
  deliveryId: string,
) {
  const store = partition(env, partitionId),
    job = await store.webhookDelivery(deliveryId);
  if (
    !job ||
    job.status === "delivered" ||
    job.status === "failed" ||
    job.attempt_count >= 5
  )
    return;
  const hook = await first<{
    owner_user_id: string;
    url: string;
    secret_ciphertext: string;
    secret_nonce: string;
  }>(
    env,
    "SELECT * FROM mail_webhooks WHERE id=? AND mailbox_id=? AND enabled=1",
    job.webhook_id,
    mailboxId,
  );
  if (!hook) {
    await store.webhookResult(deliveryId, false, true);
    return;
  }
  try {
    const user = await first<{ auth_version: number }>(
      env,
      "SELECT auth_version FROM users WHERE id=?",
      hook.owner_user_id,
    );
    await authorize(
      env,
      {
        user_id: hook.owner_user_id,
        auth_version: user!.auth_version,
        api_key_id: null,
      },
      mailboxId,
      "read",
    );
    const timestamp = String(epoch()),
      secret = await unseal(env, hook.secret_ciphertext, hook.secret_nonce);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = [
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(timestamp + "." + job.payload_json),
        ),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const response = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Officeflare-Timestamp": timestamp,
        "X-Officeflare-Signature": signature,
      },
      body: job.payload_json,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    const succeeded = response.ok;
    await store.webhookResult(deliveryId, succeeded, job.attempt_count >= 4);
    if (!succeeded && job.attempt_count < 4)
      await mailbox(env, mailboxId).schedule({
        id: deliveryId,
        kind: "webhook",
        partition_id: partitionId,
        reference_id: deliveryId,
        due_at: epoch() + 60 * 2 ** job.attempt_count,
      });
  } catch {
    await store.webhookResult(deliveryId, false, job.attempt_count >= 4);
    if (job.attempt_count < 4)
      await mailbox(env, mailboxId).schedule({
        id: deliveryId,
        kind: "webhook",
        partition_id: partitionId,
        reference_id: deliveryId,
        due_at: epoch() + 60 * 2 ** job.attempt_count,
      });
  }
}

export async function cleanUploads(env: Env) {
  const previous = await env.MAIL_BUCKET.get("maintenance/uploads-cursor.json");
  const cursor = previous
    ? (await previous.json<{ cursor?: string }>()).cursor
    : undefined;
  const page = await env.MAIL_BUCKET.list({
    prefix: "uploads/",
    limit: 100,
    cursor,
    include: ["customMetadata"],
  });
  for (const object of page.objects)
    if (Number(object.customMetadata?.expires_at ?? 0) < epoch())
      await env.MAIL_BUCKET.delete(object.key);
  await env.MAIL_BUCKET.put(
    "maintenance/uploads-cursor.json",
    JSON.stringify({ cursor: page.truncated ? page.cursor : undefined }),
  );
}
