import { incomingRoute } from "./routing";
import { sendingLimits, validateMessageSize } from "./limits";
import { putStream } from "./objects";
import { queueWebhooks } from "./jobs";
import { attachEditorImages, composedBody, editorBody, inlineContentIds, textHtml } from "./editor";
import PostalMime, { type Address as MimeAddress } from "postal-mime";
import { all, authorize, first, resolveRecipient, sender } from "./control";
import {
  cleanHtml,
  composeState,
  integer,
  flag,
  email,
  hash,
  htmlText,
  recipients,
  replyToAddress,
  rfcId,
  text,
} from "./input";
import { mailbox, partition } from "./mailbox";
import {
  epoch,
  fail,
  id,
  locator,
  messageId,
  type Attachment,
  type InboundTask,
  type MailActor,
  type MailBody,
  type MessageInput,
  type MessageQuery,
  type MessageRow,
  type SubmissionSnapshot,
} from "./types";

export const bodyKey = (
  mailboxId: string,
  messageId: string,
  revision: string,
) => "bodies/" + mailboxId + "/" + messageId + "/" + revision + ".json";
export async function readBody(env: Env, key: string): Promise<MailBody> {
  const object = await env.MAIL_BUCKET.get(key);
  if (!object) fail(503, "Mail body is unavailable");
  const body = await object.json<MailBody>();
  if (body.compose_state) {
    // Old saved drafts may contain a mode; it no longer participates in sending.
    const { send_mode: _mode, ...state } = body.compose_state as MailBody["compose_state"] & { send_mode?: string };
    body.compose_state = state;
  }
  return body;
}
async function stableUuid(value: string) {
  const digest = await hash(value);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}
export async function getMessage(
  env: Env,
  actor: MailActor,
  mailboxId: string,
  resourceId: string,
) {
  await authorize(env, actor, mailboxId, "read");
  await belongs(env, mailboxId, locator(resourceId));
  const message = await partition(env, locator(resourceId)).get(
    resourceId,
    actor.user_id,
  );
  const content = await readBody(env, message.body_r2_key);
  const cid: Record<string, string> = {};
  for (const attachment of message.attachments)
    if (attachment.content_id)
      cid[attachment.content_id] =
        "/api/mail/mailboxes/" +
        mailboxId +
        "/messages/" +
        resourceId +
        "/attachments/" +
        attachment.id;
  const { body_r2_key: _body, raw_r2_key: _raw, ...result } = message;
  return {
    ...result,
    body_revision: message.body_r2_key.split("/").at(-1),
    attachments: message.attachments.map(({ r2_key: _key, ...file }) => file),
    body: { text: content.text, html: cleanHtml(content.html, cid), ...(message.draft ? {
      ...(content.compose_state ? { compose_state: content.compose_state } : {}),
      ...(content.editor_body ? { editor_body: { text: content.editor_body.text, html: cleanHtml(content.editor_body.html, cid) } } : {}),
      ...(content.quoted_body ? { quoted_body: { text: content.quoted_body.text, html: cleanHtml(content.quoted_body.html, cid) }, include_quoted_body: content.include_quoted_body ?? true } : {}),
    } : {}) },
  };
}
export async function belongs(
  env: Env,
  mailboxId: string,
  partitionId: string,
) {
  if (
    !(await mailbox(env, mailboxId).partitions()).some(
      (p) => p.id === partitionId,
    )
  )
    fail(404, "Mail resource not found");
}
export async function queryMessages(
  env: Env,
  actor: MailActor,
  mailboxId: string,
  query: Omit<MessageQuery, "actor_id">,
  selected?: string[],
) {
  await authorize(env, actor, mailboxId, "read");
  const entries = await mailbox(env, mailboxId).partitions();
  const targets = selected
    ? entries.filter((p) => selected.includes(p.id))
    : entries;
  if (selected && targets.length !== selected.length)
    fail(400, "Invalid cursor partitions");
  const result: MessageRow[] = [];
  // Bound outgoing concurrency; failures abort instead of silently presenting incomplete search results.
  for (let start = 0; start < targets.length; start += 4) {
    const pages = await Promise.all(
      targets
        .slice(start, start + 4)
        .map((p) =>
          partition(env, p.id).query({ ...query, actor_id: actor.user_id }),
        ),
    );
    result.push(...pages.flat());
  }
  result.sort(
    (a, b) => b.received_at - a.received_at || b.id.localeCompare(a.id),
  );
  return {
    messages: result.slice(0, query.limit),
    partitions: targets.map((p) => p.id),
  };
}
export async function createDraft(
  env: Env,
  actor: MailActor,
  mailboxId: string,
  data: Record<string, unknown>,
  key: string,
  quotedBody?: MailBody["quoted_body"],
) {
  await authorize(env, actor, mailboxId, "read");
  await authorize(env, actor, mailboxId, "write");
  const subject = text(data.subject ?? "", "subject", 998, true),
    content: MailBody = composedBody(editorBody(data.editor_body ?? { text: data.text ?? "", html: data.html ?? "" }), quotedBody);
  if (data.compose_state !== undefined) content.compose_state = composeState(data.compose_state);
  const to = recipients(data.to, "to"),
    cc = recipients(data.cc, "cc"),
    bcc = recipients(data.bcc, "bcc"),
    replyTo = replyToAddress(data.reply_to);
  if (to.length + cc.length + bcc.length > 50) fail(400, "Too many recipients");
  const operation = actor.user_id + ":draft:" + key;
  const partitionId = await mailbox(env, mailboxId).allocate(operation);
  const resourceId = partitionId + "." + (await stableUuid(operation)),
    requestHash = await hash(
      JSON.stringify({
        subject,
        content,
        to,
        cc,
        bcc,
        ...(data.reply_to !== undefined ? { reply_to: replyTo } : {}),
        ...(content.compose_state ? { compose_state: content.compose_state } : {}),
        attachments: data.attachment_ids ?? [],
        reply_to_message_id: data.reply_to_message_id ?? null,
        include_signature: data.include_signature ?? true,
      }),
    );
  const existing = await partition(env, partitionId).receipt(operation);
  if (existing) {
    if (existing.request_hash !== requestHash)
      fail(409, "Idempotency key reused with different request");
    return getMessage(env, actor, mailboxId, existing.resource_id);
  }
  const includeSignature =
    data.include_signature === undefined
      ? true
      : !!flag(data.include_signature, "include_signature");
  const settings = includeSignature ? await mailbox(env, mailboxId).settings() : null;
  if (settings?.signature || settings?.signature_html) {
    const editable = content.editor_body ?? { text: content.text, html: content.html };
    const signature = String(settings.signature), signatureHtml = String(settings.signature_html ?? "");
    Object.assign(content, composedBody({ text: editable.text + "\n\n" + signature, html: editable.html || signatureHtml ? (editable.html || textHtml(editable.text)) + (signatureHtml || textHtml(signature)) : "" }, quotedBody));
  }
  let files: Attachment[] = [];
  const createdKeys: string[] = [];
  let committed = false;
  try {
  if (
    data.attachment_ids !== undefined &&
    (!Array.isArray(data.attachment_ids) || data.attachment_ids.length > 32)
  )
    fail(400, "Invalid attachment_ids");
  for (const uploadId of (data.attachment_ids ?? []) as unknown[]) {
    const upload = await env.MAIL_BUCKET.get(
      "uploads/" +
        mailboxId +
        "/" +
        actor.user_id +
        "/" +
        text(uploadId, "attachment_id", 36),
    );
    if (!upload || Number(upload.customMetadata?.expires_at ?? 0) < epoch())
      fail(400, "Upload is missing or expired");
    const fileId = id(),
      r2Key = "attachments/" + mailboxId + "/" + resourceId + "/" + fileId;
    createdKeys.push(r2Key);
    await env.MAIL_BUCKET.put(r2Key, upload.body, {
      httpMetadata: upload.httpMetadata,
    });
    files.push({
      id: fileId,
      filename: upload.customMetadata?.filename ?? "attachment",
      content_type:
        upload.httpMetadata?.contentType ?? "application/octet-stream",
      size_bytes: upload.size,
      content_id: upload.customMetadata?.content_id ?? null,
      r2_key: r2Key,
      disposition: upload.customMetadata?.content_id ? "inline" : "attachment",
    });
  }
  let threadId = id(),
    references: string[] = [];
  if (data.reply_to_message_id) {
    const originalId = text(
      data.reply_to_message_id,
      "reply_to_message_id",
      73,
    );
    await belongs(env, mailboxId, locator(originalId));
    const original = await partition(env, locator(originalId)).get(
      originalId,
      actor.user_id,
    );
    threadId = original.thread_id;
    references = [
      ...original.references,
      ...(original.rfc_message_id ? [original.rfc_message_id] : []),
    ].slice(-100);
  }
  content.html = cleanHtml(content.html, {}, true);
  files = await attachEditorImages(env, mailboxId, resourceId, content.html, files, createdKeys);
  const keyBody = bodyKey(mailboxId, resourceId, requestHash);
  createdKeys.push(keyBody);
  await env.MAIL_BUCKET.put(keyBody, JSON.stringify(content), {
    httpMetadata: { contentType: "application/json" },
  });
  const input: MessageInput = {
    id: resourceId,
    thread_id: threadId,
    direction: "outbound",
    folder_id: "drafts",
    subject,
    from_address: "",
    reply_to_address: replyTo,
    to,
    cc,
    bcc,
    received_at: epoch(),
    provider: null,
    connection_id: null,
    provider_message_id: null,
    rfc_message_id: null,
    references,
    raw_r2_key: null,
    body_r2_key: keyBody,
    snippet: (content.text || htmlText(content.html)).slice(0, 200),
    search_text: content.text || htmlText(content.html),
    attachments: files,
    draft_owner_id: actor.user_id,
  };
  await mailbox(env, mailboxId).storeDraft(
    partitionId,
    input,
    operation,
    requestHash,
  );
  committed = true;
  await mailbox(env, mailboxId).completeAllocation(operation);
  await flushOutbox(env, mailboxId, partitionId);
  return getMessage(env, actor, mailboxId, resourceId);
  } catch (error) {
    if (!committed) await Promise.allSettled(createdKeys.map((key) => env.MAIL_BUCKET.delete(key)));
    throw error;
  }
}
export async function submitDraft(
  env: Env,
  actor: MailActor,
  mailboxId: string,
  resourceId: string,
  data: Record<string, unknown>,
  key: string,
) {
  await authorize(env, actor, mailboxId, "read");
  await belongs(env, mailboxId, locator(resourceId));
  const addressId = text(data.address_id, "address_id", 36),
    address = await sender(env, actor, mailboxId, addressId);
  if (
    (data.provider !== undefined && data.provider !== address.provider) ||
    (data.connection_id !== undefined &&
      data.connection_id !== address.connection_id)
  )
    fail(409, "Provider or connection does not match sending domain");
  const version = Number(data.version);
  if (!Number.isSafeInteger(version) || version < 1)
    fail(400, "Invalid version");
  const scheduledAt =
    data.scheduled_at === undefined ? epoch() + integer(data.undo_window ?? 0, "undo_window", 0, 30) : Number(data.scheduled_at);
  if (
    !Number.isSafeInteger(scheduledAt) ||
    scheduledAt < epoch() - 60 ||
    scheduledAt > epoch() + 366 * 86400
  )
    fail(400, "Invalid scheduled_at");
  const requestHash = await hash(
    JSON.stringify({
      resourceId,
      addressId,
      version,
      scheduled_at: data.scheduled_at ?? null,
      ...(data.undo_window !== undefined ? { undo_window: integer(data.undo_window, "undo_window", 0, 30) } : {}),
      provider: address.provider,
      connection_id: address.connection_id,
    }),
  );
  const submissionId =
    locator(resourceId) +
    "." +
    (await stableUuid(actor.user_id + ":submit:" + key));
  await mailbox(env, mailboxId).registerRequest(
    actor.user_id + ":submit:" + key,
    requestHash,
    submissionId,
  );
  const store = partition(env, locator(resourceId)),
    existing = await store.findSubmission(submissionId);
  if (existing) {
    if (existing.request_hash !== requestHash)
      fail(409, "Idempotency key reused with different request");
    return existing;
  }
  const message = await store.get(resourceId, actor.user_id),
    content = await readBody(env, message.body_r2_key);
  if (
    !message.draft ||
    message.draft.version !== version ||
    message.draft.state !== "editable"
  )
    fail(409, "Draft is not editable or version changed");
  const select = (kind: string) =>
    message.recipients
      .filter((r) => r.kind === kind)
      .map((r) => r.email_address);
  const to = select("to"),
    cc = select("cc"),
    bcc = select("bcc");
  if (!to.length && !cc.length && !bcc.length)
    fail(400, "At least one recipient is required");
  const referencedImages = inlineContentIds(content.html), attachments = message.attachments.filter((file) => file.disposition !== "inline" || !!file.content_id && referencedImages.has(file.content_id));
  const headers: Record<string, string> = {};
  if (message.references.length) {
    headers["In-Reply-To"] = "<" + message.references.at(-1) + ">";
    headers.References = message.references
      .slice(-20)
      .map((r) => "<" + r + ">")
      .join(" ");
  }
  const snapshot: SubmissionSnapshot = {
    from: address.email_address,
    ...(message.reply_to_address ? { reply_to: message.reply_to_address } : {}),
    to,
    cc,
    bcc,
    subject: message.subject,
    ...content,
    headers,
    attachments,
  };
  if (data.auto_reply) {
    snapshot.headers["Auto-Submitted"] = "auto-replied";
    snapshot.headers["X-Officeflare-Autoreply"] = "1";
  }
  validateMessageSize(snapshot, sendingLimits(address.provider, address.max_send_bytes).max_send_bytes);
  const snapshotKey =
    "submissions/" +
    mailboxId +
    "/" +
    submissionId +
    "/" +
    requestHash +
    ".json";
  await env.MAIL_BUCKET.put(snapshotKey, JSON.stringify(snapshot), {
    httpMetadata: { contentType: "application/json" },
  });
  const submission = await store.submit(
    {
      id: submissionId,
      message_id: resourceId,
      actor_id: actor.user_id,
      actor_auth_version: actor.auth_version,
      api_key_id: actor.api_key_id,
      address_id: addressId,
      provider: address.provider,
      connection_id: address.connection_id,
      request_hash: requestHash,
      draft_version: version,
      snapshot_r2_key: snapshotKey,
      status: scheduledAt > epoch() ? "scheduled" : "queued",
      scheduled_at: scheduledAt,
    },
    address.email_address,
  );
  await mailbox(env, mailboxId).schedule({
    id: submissionId,
    partition_id: locator(resourceId),
    kind: "send",
    reference_id: submissionId,
    due_at: scheduledAt,
  });
  await flushOutbox(env, mailboxId, locator(resourceId));
  return submission;
}
const flatten = (addresses?: MimeAddress[]): string[] =>
  (addresses ?? [])
    .flatMap((a) =>
      a.group ? a.group.map((m) => m.address) : a.address ? [a.address] : [],
    )
    .slice(0, 1000);
export async function ingest(env: Env, task: InboundTask) {
  const receiptKey = "receipts/" + task.mailbox_id + "/" + task.id + ".json";
  if (await env.MAIL_BUCKET.head(receiptKey)) {
    await env.MAIL_BUCKET.delete("pending/" + task.id + ".json");
    return;
  }
  const state = await first<{ status: string }>(
    env,
    "SELECT status FROM mail_mailboxes WHERE id=?",
    task.mailbox_id,
  );
  if (state?.status !== "active")
    fail(409, "Destination mailbox is not active");
  const raw = await env.MAIL_BUCKET.get(task.raw_r2_key);
  if (!raw) fail(503, "Inbound original is unavailable");
  const parsed = await PostalMime.parse(await raw.arrayBuffer(), {
    maxNestingDepth: 32,
    maxHeadersSize: 256 * 1024,
  });
  const operation = "inbound:" + task.id,
    partitionId = await mailbox(env, task.mailbox_id).allocate(operation),
    resourceId = partitionId + "." + task.id;
  const body: MailBody = { text: parsed.text ?? "", html: parsed.html ?? "" },
    searchText = body.text || htmlText(body.html);
  const from = parsed.from?.address ?? task.envelope_from,
    subject = (parsed.subject ?? "").slice(0, 998),
    to = flatten(parsed.to),
    cc = flatten(parsed.cc);
  const decision = await mailbox(env, task.mailbox_id).evaluate({
    from,
    to: [...to, ...cc].join(" "),
    subject,
    body: searchText,
  });
  const files: Attachment[] = [];
  for (const [ordinal, file] of parsed.attachments.entries()) {
    const fileId = await stableUuid(task.id + ":attachment:" + ordinal),
      r2Key =
        "attachments/" + task.mailbox_id + "/" + resourceId + "/" + fileId;
    const value =
      typeof file.content === "string"
        ? new TextEncoder().encode(file.content)
        : file.content;
    await env.MAIL_BUCKET.put(r2Key, value, {
      httpMetadata: { contentType: file.mimeType },
    });
    files.push({
      id: fileId,
      filename: (file.filename ?? "attachment").slice(0, 255),
      content_type: file.mimeType,
      size_bytes: value.byteLength,
      content_id: rfcId(file.contentId),
      r2_key: r2Key,
      disposition: file.related ? "inline" : "attachment",
    });
  }
  const references = [
    ...(parsed.references?.match(/<[^>]+>/g) ?? []),
    ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
  ]
    .map(rfcId)
    .filter((r): r is string => !!r)
    .slice(-100);
  let threadId: string | null = null;
  for (const entry of (
    await mailbox(env, task.mailbox_id).partitions()
  ).reverse()) {
    threadId = await partition(env, entry.id).findThread(references);
    if (threadId) break;
  }
  const keyBody = bodyKey(task.mailbox_id, resourceId, "inbound");
  await env.MAIL_BUCKET.put(keyBody, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
  await mailbox(env, task.mailbox_id).storeMessage(partitionId, {
    id: resourceId,
    ingest_id: task.id,
    thread_id: threadId ?? id(),
    direction: "inbound",
    folder_id: decision.folder_id,
    source: task.source,
    subject,
    from_address: from.slice(0, 254),
    reply_to_address: flatten(parsed.replyTo)[0]?.slice(0, 254) ?? null,
    to,
    cc,
    bcc: [],
    received_at:
      task.source === "import" &&
      parsed.date &&
      Number.isFinite(Date.parse(parsed.date))
        ? Math.floor(Date.parse(parsed.date) / 1000)
        : task.received_at,
    provider: task.provider,
    connection_id: task.connection_id,
    provider_message_id: null,
    rfc_message_id: rfcId(parsed.messageId),
    references,
    raw_r2_key: task.raw_r2_key,
    body_r2_key: keyBody,
    snippet: searchText.slice(0, 200),
    search_text: searchText,
    attachments: files,
    draft_owner_id: null,
    is_spam: decision.is_spam,
  });
  await partition(env, partitionId).applyInboundFlags(
    resourceId,
    decision.is_read,
    decision.is_starred,
  );
  await env.MAIL_BUCKET.put(
    receiptKey,
    JSON.stringify({
      resource_id: resourceId,
      partition_id: partitionId,
      completed_at: epoch(),
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  await mailbox(env, task.mailbox_id).completeAllocation(operation);
  await env.MAIL_BUCKET.delete("pending/" + task.id + ".json");
  await flushOutbox(env, task.mailbox_id, partitionId);
  // Auto-replies use the same submission path and revalidate the mailbox owner's account.
  const settings = await mailbox(env, task.mailbox_id).settings();
  if (
    task.source !== "import" &&
    settings.auto_reply_enabled &&
    !decision.is_spam &&
    task.envelope_from &&
    !/mailer-daemon|postmaster|no-?reply/i.test(from) &&
    !parsed.headers.some((h) =>
      [
        "auto-submitted",
        "list-id",
        "precedence",
        "x-officeflare-autoreply",
      ].includes(h.key),
    ) &&
    (await mailbox(env, task.mailbox_id).claimAutoReply(from))
  ) {
    const owner = await first<MailActor>(
      env,
      "SELECT u.id user_id,u.auth_version,NULL api_key_id FROM mail_mailboxes b JOIN users u ON u.id=b.owner_user_id WHERE b.id=?",
      task.mailbox_id,
    );
    const address = await first<{ id: string }>(
      env,
      "SELECT id FROM mail_addresses WHERE mailbox_id=? AND send_enabled=1 ORDER BY is_primary DESC LIMIT 1",
      task.mailbox_id,
    );
    if (owner && address) {
      try {
        if (await resolveRecipient(env, from)) return;
        const draft = await createDraft(
          env,
          owner,
          task.mailbox_id,
          {
            subject: String(settings.auto_reply_subject || "Re: " + subject),
            text: String(settings.auto_reply_text),
            to: [from],
            reply_to_message_id: resourceId,
          },
          "auto:" + task.id,
        );
        await submitDraft(
          env,
          owner,
          task.mailbox_id,
          draft.id,
          { address_id: address.id, version: 1, auto_reply: true },
          "auto:" + task.id,
        );
      } catch (error) {
        console.error(
          "Auto-reply failed",
          task.id,
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
  }
}
export async function receive(message: ForwardableEmailMessage, env: Env) {
  const route = await incomingRoute(env, message);
  if (route?.action === "reject") {
    message.setReject(route.reject_reason ?? "Rejected by domain policy");
    return;
  }
  if (route?.action === "forward") {
    await message.forward(route.forward_to!);
    return;
  }
  const target = await resolveRecipient(env, message.to);
  if (!target) {
    message.setReject("Recipient is not available");
    return;
  }
  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject("Message is too large");
    return;
  }
  const task: InboundTask = {
    kind: "inbound",
    id: id(),
    ...target,
    raw_r2_key: "",
    envelope_from: message.from,
    envelope_to: message.to,
    received_at: epoch(),
  };
  task.raw_r2_key = "originals/" + task.mailbox_id + "/" + task.id + ".eml";
  await putStream(
    env.MAIL_BUCKET,
    task.raw_r2_key,
    message.raw,
    { httpMetadata: { contentType: "message/rfc822" } },
    message.rawSize,
  );
  await env.MAIL_BUCKET.put(
    "pending/" + task.id + ".json",
    JSON.stringify(task),
    { httpMetadata: { contentType: "application/json" } },
  );
  // The durable pending record recovers a queue publish failure without losing the original.
  try {
    await env.MAIL_QUEUE.send(task);
  } catch (error) {
    console.error(
      "Inbound dispatch pending",
      task.id,
      error instanceof Error ? error.message : "unknown",
    );
  }
}
export async function flushOutbox(
  env: Env,
  mailboxId: string,
  partitionId: string,
) {
  const store = partition(env, partitionId);
  for (const item of await store.outbox()) {
    const payload = JSON.parse(item.payload_json) as {
      message_id: string;
      operation: string;
      private_user_id?: string | null;
    };
    await mailbox(env, mailboxId).emit(payload);
    await dispatchWebhooks(env, mailboxId, item.id, payload);
    await store.markDispatched(item.id);
  }
}
export const dispatchWebhooks = queueWebhooks;
