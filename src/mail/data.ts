import { putStream } from "./objects";
import { authorize } from "./control";
import { mailbox, partition } from "./mailbox";
import { inlineContentIds, imageAssetKey } from "./editor";
import { mboxMessage, unquoteMboxMessage } from "./mbox";
import { hash, text } from "./input";
import { ingest, readBody, flushOutbox } from "./service";
import {
  epoch,
  fail,
  id,
  messageId,
  type Attachment,
  type MessageInput,
  type InboundTask,
  type MailActor,
  type MessageRow,
  type Rule,
} from "./types";

export async function startImport(
  env: Env,
  actor: MailActor,
  mailboxId: string,
  raw: ReadableStream<Uint8Array>,
  format: string,
) {
  await authorize(env, actor, mailboxId, "read");
  await authorize(env, actor, mailboxId, "write");
  if (!["eml", "mbox"].includes(format)) fail(400, "Unsupported import format");
  const jobId = id(),
    source = "imports/" + mailboxId + "/" + jobId + "/" + format;
  await putStream(env.MAIL_BUCKET, source, raw, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  await mailbox(env, mailboxId).createDataJob({
    id: jobId,
    actor_json: JSON.stringify(actor),
    kind: "import_" + format,
    source_r2_key: source,
    output_prefix: "data-jobs/" + mailboxId + "/" + jobId + "/",
  });
  await env.MAIL_QUEUE.send({
    kind: "data_job",
    mailbox_id: mailboxId,
    reference_id: jobId,
  });
  return jobId;
}
export async function startExport(
  env: Env,
  actor: MailActor,
  mailboxId: string,
  backup: boolean | "reindex",
) {
  await authorize(env, actor, mailboxId, "read");
  const jobId = id(),
    entries = await mailbox(env, mailboxId).partitions();
  await mailbox(env, mailboxId).createDataJob({
    id: jobId,
    actor_json: JSON.stringify(actor),
    kind: backup === "reindex" ? "reindex" : backup ? "backup" : "export",
    source_r2_key: null,
    output_prefix: "data-jobs/" + mailboxId + "/" + jobId + "/",
    cursor_json: JSON.stringify({
      partitions: entries.map((p) => p.id),
      partition_index: 0,
      before: null,
      cutoff: epoch(),
    }),
  });
  await env.MAIL_QUEUE.send({
    kind: "data_job",
    mailbox_id: mailboxId,
    reference_id: jobId,
  });
  return jobId;
}
export async function processDataJob(env: Env, mailboxId: string, jobId: string) {
  const coordinator = mailbox(env, mailboxId),
    job = await coordinator.claimDataJob(jobId);
  if (!job) return;
  const actor = JSON.parse(job.actor_json) as MailActor;
  try {
    await authorize(env, actor, mailboxId, job.kind.startsWith("import") ? "write" : "read");
    await authorize(env, actor, mailboxId, "read");
    if (job.kind === "reindex") await authorize(env, actor, mailboxId, "write");
    if (job.kind === "restore") {
      await restorePage(env, mailboxId, job, actor);
      return;
    }
    if (job.kind.startsWith("import")) {
      const source = await env.MAIL_BUCKET.get(job.source_r2_key!);
      if (!source) fail(503, "Import source unavailable");
      const raw = new Uint8Array(await source.arrayBuffer());
      const messages = job.kind === "import_eml" ? [raw] : splitMbox(raw);
      if (!messages.length) fail(400, "No messages in import");
      for (
        let index = job.progress;
        index < Math.min(messages.length, job.progress + 10);
        index++
      ) {
        // Stable ingestion IDs recover retries after a message committed but job progress did not.
        const digest = await hash(jobId + ":" + index),
          ingestId = [
            digest.slice(0, 8),
            digest.slice(8, 12),
            digest.slice(12, 16),
            digest.slice(16, 20),
            digest.slice(20, 32),
          ].join("-");
        const rawKey = "originals/" + mailboxId + "/" + ingestId + ".eml";
        await env.MAIL_BUCKET.put(rawKey, messages[index]!, {
          httpMetadata: { contentType: "message/rfc822" },
        });
        const task: InboundTask = {
          kind: "inbound",
          id: ingestId,
          mailbox_id: mailboxId,
          provider: null,
          connection_id: null,
          raw_r2_key: rawKey,
          envelope_from: "",
          envelope_to: "",
          received_at: epoch(),
          source: "import",
        };
        await ingest(env, task);
        await coordinator.advanceDataJob(
          jobId,
          index + 1,
          job.cursor_json,
          index + 1 === messages.length,
        );
      }
      if ((await coordinator.dataJob(jobId)).status !== "completed")
        await env.MAIL_QUEUE.send({
          kind: "data_job",
          mailbox_id: mailboxId,
          reference_id: jobId,
        });
      return;
    }
    const cursor = JSON.parse(job.cursor_json) as {
      partitions: string[];
      partition_index: number;
      before: { received_at: number; id: string } | null;
      cutoff: number;
    };
    if (cursor.partition_index >= cursor.partitions.length) {
      if (job.kind === "backup")
        await backupManifest(env, mailboxId, job.output_prefix, job.progress);
      await coordinator.advanceDataJob(jobId, job.progress, job.cursor_json, true);
      return;
    }
    const partitionId = cursor.partitions[cursor.partition_index]!,
      store = partition(env, partitionId);
    const page = await store.query({
      actor_id: actor.user_id,
      limit: 10,
      include_snoozed: true,
      before: cursor.before ?? { received_at: cursor.cutoff + 1, id: "" },
    });
    for (const [ordinal, message] of page.entries()) {
      const details = await store.get(message.id, actor.user_id),
        body = await readBody(env, details.body_r2_key);
      const number = job.progress + ordinal,
        prefix = job.output_prefix + String(number).padStart(12, "0");
      if (job.kind === "reindex") {
        await store.rebuildIndex(message.id, body.text || body.html.replace(/<[^>]*>/g, " "));
      } else if (job.kind === "backup") {
        // Copy all referenced objects into the backup namespace so later deletion does not invalidate it.
        const bodyKey = prefix + ".body.json";
        await env.MAIL_BUCKET.put(bodyKey, JSON.stringify(body));
        const files = [];
        for (const file of details.attachments) {
          const source = await env.MAIL_BUCKET.get(file.r2_key);
          if (!source) fail(503, "Backup attachment unavailable");
          const key = prefix + "." + file.id + ".attachment";
          await env.MAIL_BUCKET.put(key, source.body, {
            httpMetadata: source.httpMetadata,
          });
          files.push({ ...file, r2_key: key });
        }
        let original: string | null = null;
        if (details.raw_r2_key) {
          const source = await env.MAIL_BUCKET.get(details.raw_r2_key);
          if (!source) fail(503, "Backup original unavailable");
          original = prefix + ".eml";
          await env.MAIL_BUCKET.put(original, source.body);
        }
        await env.MAIL_BUCKET.put(
          prefix + ".message.json",
          JSON.stringify({
            ...details,
            body_r2_key: bodyKey,
            raw_r2_key: original,
            attachments: files,
          }),
        );
      } else {
        let raw: Uint8Array;
        if (details.raw_r2_key) {
          const object = await env.MAIL_BUCKET.get(details.raw_r2_key);
          if (!object) fail(503, "Export original unavailable");
          raw = new Uint8Array(await object.arrayBuffer());
        } else raw = new TextEncoder().encode(await renderMime(env, details, body));
        await env.MAIL_BUCKET.put(
          prefix + ".mbox",
          mboxMessage(raw, details.from_address, details.received_at),
        );
      }
    }
    const last = page.at(-1);
    if (page.length < 10) {
      cursor.partition_index++;
      cursor.before = null;
    } else cursor.before = { received_at: last!.received_at, id: last!.id };
    const completed = cursor.partition_index >= cursor.partitions.length;
    if (completed && job.kind === "backup")
      await backupManifest(env, mailboxId, job.output_prefix, job.progress + page.length);
    await coordinator.advanceDataJob(
      jobId,
      job.progress + page.length,
      JSON.stringify(cursor),
      completed,
    );
    if (!completed)
      await env.MAIL_QUEUE.send({
        kind: "data_job",
        mailbox_id: mailboxId,
        reference_id: jobId,
      });
  } catch (error) {
    await coordinator.failDataJob(
      jobId,
      error instanceof Error ? error.message : "Import/export failed",
    );
    throw error;
  }
}
export async function renderMime(
  env: Env,
  message: MessageRow & {
    recipients: { kind: string; email_address: string }[];
    attachments: {
      filename: string;
      content_type: string;
      r2_key: string;
      content_id?: string | null;
      disposition?: string;
    }[];
  },
  body: { text: string; html: string },
) {
  const boundary = "officeflare-" + id(),
    encode = (value: string) => "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(value))) + "?=";
  const header = (value: string) => value.replace(/[\r\n]/g, " ");
  const base64 = (value: string) =>
    btoa(unescape(encodeURIComponent(value))).replace(/.{76}/g, "$&\r\n");
  const alternative = boundary + "-alternative";
  const lines = [
    "From: " + header(message.from_address),
    ...(message.reply_to_address ? ["Reply-To: " + header(message.reply_to_address)] : []),
    "To: " +
      message.recipients
        .filter((r) => r.kind === "to")
        .map((r) => header(r.email_address))
        .join(", "),
    "Cc: " +
      message.recipients
        .filter((r) => r.kind === "cc")
        .map((r) => header(r.email_address))
        .join(", "),
    "Bcc: " +
      message.recipients
        .filter((r) => r.kind === "bcc")
        .map((r) => header(r.email_address))
        .join(", "),
    "Subject: " + encode(message.subject),
    ...(message.rfc_message_id ? ["Message-ID: <" + header(message.rfc_message_id) + ">"] : []),
    "Date: " + new Date(message.received_at * 1000).toUTCString(),
    "MIME-Version: 1.0",
    "X-Officeflare-Export: reconstructed",
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    "",
    "--" + boundary,
    'Content-Type: multipart/alternative; boundary="' + alternative + '"',
    "",
    "--" + alternative,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64(body.text),
    ...(body.html
      ? [
          "--" + alternative,
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          base64(body.html),
        ]
      : []),
    "--" + alternative + "--",
    "",
  ];
  for (const file of message.attachments) {
    const object = await env.MAIL_BUCKET.get(file.r2_key);
    if (!object) fail(503, "Export attachment unavailable");
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = "";
    for (let n = 0; n < bytes.length; n += 8192)
      binary += String.fromCharCode(...bytes.subarray(n, n + 8192));
    lines.push(
      "--" + boundary,
      "Content-Type: " + header(file.content_type),
      "Content-Disposition: " +
        (file.disposition === "inline" ? "inline" : "attachment") +
        '; filename="' +
        header(file.filename).replaceAll('"', "'") +
        '"',
      ...(file.content_id ? ["Content-ID: <" + header(file.content_id) + ">"] : []),
      "Content-Transfer-Encoding: base64",
      "",
      btoa(binary).replace(/.{76}/g, "$&\r\n"),
    );
  }
  lines.push("--" + boundary + "--", "");
  return lines.join("\r\n");
}
export async function exportStream(env: Env, prefix: string) {
  let cursor: string | undefined,
    started = false,
    keys: string[] = [],
    index = 0,
    reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (reader) {
            const chunk = await reader.read();
            if (!chunk.done) {
              controller.enqueue(chunk.value);
              return;
            }
            reader = null;
          }
          if (index < keys.length) {
            const object = await env.MAIL_BUCKET.get(keys[index++]!);
            if (!object) throw new Error("Export piece unavailable");
            reader = object.body.getReader();
            continue;
          }
          if (started && !cursor) {
            controller.close();
            return;
          }
          const page = await env.MAIL_BUCKET.list({
            prefix,
            cursor,
            limit: 1000,
          });
          started = true;
          keys = page.objects.filter((o) => o.key.endsWith(".mbox")).map((o) => o.key);
          index = 0;
          cursor = page.truncated ? page.cursor : undefined;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await reader?.cancel();
    },
  });
}
export async function startRestore(
  env: Env,
  actor: MailActor,
  sourceMailbox: string,
  backupId: string,
  targetMailbox: string,
  restoreSettings: boolean,
) {
  await authorize(env, actor, sourceMailbox, "read");
  await authorize(env, actor, targetMailbox, "read");
  await authorize(env, actor, targetMailbox, "write");
  if (restoreSettings) await authorize(env, actor, targetMailbox, "manage");
  const source = await mailbox(env, sourceMailbox).dataJob(backupId);
  if (
    source.kind !== "backup" ||
    source.status !== "completed" ||
    JSON.parse(source.actor_json).user_id !== actor.user_id
  )
    fail(403, "Backup is unavailable");
  const jobId = id();
  await mailbox(env, targetMailbox).createDataJob({
    id: jobId,
    actor_json: JSON.stringify(actor),
    kind: "restore",
    source_r2_key: source.output_prefix,
    output_prefix: "data-jobs/" + targetMailbox + "/" + jobId + "/",
    cursor_json: JSON.stringify({
      restore_settings: restoreSettings,
      source_mailbox_id: sourceMailbox,
      source_job_id: backupId,
    }),
  });
  await env.MAIL_QUEUE.send({
    kind: "data_job",
    mailbox_id: targetMailbox,
    reference_id: jobId,
  });
  return jobId;
}
async function restorePage(
  env: Env,
  mailboxId: string,
  job: Awaited<ReturnType<ReturnType<typeof mailbox>["dataJob"]>>,
  actor: MailActor,
) {
  const coordinator = mailbox(env, mailboxId),
    cursor = JSON.parse(job.cursor_json) as {
      cursor?: string;
      restore_settings: boolean;
      initialized?: boolean;
      source_mailbox_id: string;
      source_job_id: string;
      folder_map?: Record<string, string>;
    };
  await authorize(env, actor, cursor.source_mailbox_id, "read");
  await authorize(env, actor, mailboxId, "write");
  if (cursor.restore_settings) await authorize(env, actor, mailboxId, "manage");
  const manifestObject = await env.MAIL_BUCKET.get(job.source_r2_key! + "manifest.json");
  if (!manifestObject) fail(503, "Backup manifest unavailable");
  const manifest = await manifestObject.json<{
    format: string;
    folders: { id: string; name: string; system_key: string | null }[];
    settings: Record<string, string | number | null>;
    rules: Rule[];
    blocked_senders: { email_address: string }[];
    signature_images?: { id: string; key: string }[];
  }>();
  if (manifest.format !== "officeflare-mail-v1") fail(400, "Unsupported backup format");
  if (!cursor.initialized) {
    cursor.folder_map = {};
    const currentFolders = await coordinator.folders();
    for (const folder of manifest.folders) {
      const existing = currentFolders.find(
        (value) => value.id === folder.id || value.name.toLowerCase() === folder.name.toLowerCase(),
      );
      cursor.folder_map[folder.id] = existing?.id ?? folder.id;
      if (!folder.system_key && !existing) await coordinator.putFolder(folder.id, folder.name);
    }
    if (cursor.restore_settings) {
      const { signature, retention_days, auto_reply_enabled, auto_reply_subject, auto_reply_text } =
        manifest.settings;
      for (const image of manifest.signature_images ?? []) {
        if (!/^[a-f0-9-]{36}$/.test(image.id) || image.key !== `signature-${image.id}.image`)
          fail(400, "Invalid signature image in backup");
        const object = await env.MAIL_BUCKET.get(job.source_r2_key! + image.key);
        if (!object) fail(503, "Backup signature image unavailable");
        await env.MAIL_BUCKET.put(imageAssetKey(mailboxId, image.id), object.body, {
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
        });
      }
      await coordinator.updateSettings({
        signature: signature!,
        signature_html: manifest.settings.signature_html ?? "",
        retention_days: retention_days!,
        auto_reply_enabled: auto_reply_enabled!,
        auto_reply_subject: auto_reply_subject!,
        auto_reply_text: auto_reply_text!,
      });
    }
    if (cursor.restore_settings) {
      for (const value of manifest.blocked_senders)
        await coordinator.blockSender(value.email_address, true);
      const current = await coordinator.rules();
      for (const value of manifest.rules)
        await coordinator.putRule({
          ...value,
          actions_json: JSON.stringify(
            (
              JSON.parse(value.actions_json) as {
                type: string;
                folder_id?: string;
              }[]
            ).map((action) => ({
              ...action,
              ...(action.folder_id
                ? {
                    folder_id: cursor.folder_map?.[action.folder_id] ?? action.folder_id,
                  }
                : {}),
            })),
          ),
          version: current.find((rule) => rule.id === value.id)?.version ?? 1,
        });
    }
    cursor.initialized = true;
  }
  const page = await env.MAIL_BUCKET.list({
    prefix: job.source_r2_key!,
    cursor: cursor.cursor,
    limit: 50,
  });
  let count = 0;
  for (const entry of page.objects.filter((o) => o.key.endsWith(".message.json"))) {
    const object = await env.MAIL_BUCKET.get(entry.key);
    if (!object) fail(503, "Backup message unavailable");
    const source = await object.json<
      MessageRow & {
        attachments: Attachment[];
        references: string[];
        recipients: { kind: string; email_address: string }[];
        draft: { state: string } | null;
      }
    >();
    const operation = "restore:" + job.id + ":" + source.id,
      partitionId = await coordinator.allocate(operation),
      digest = await hash(operation),
      messageUuid = [
        digest.slice(0, 8),
        digest.slice(8, 12),
        digest.slice(12, 16),
        digest.slice(16, 20),
        digest.slice(20, 32),
      ].join("-"),
      targetId = partitionId + "." + messageUuid;
    const body = await readBody(env, source.body_r2_key),
      bodyKey = "bodies/" + mailboxId + "/" + targetId + "/restore.json";
    await env.MAIL_BUCKET.put(bodyKey, JSON.stringify(body));
    const files: Attachment[] = [];
    for (const file of source.attachments) {
      const digest = await hash(targetId + ":" + file.id),
        fileId = [
          digest.slice(0, 8),
          digest.slice(8, 12),
          digest.slice(12, 16),
          digest.slice(16, 20),
          digest.slice(20, 32),
        ].join("-");
      const object = await env.MAIL_BUCKET.get(file.r2_key);
      if (!object) fail(503, "Backup attachment unavailable");
      const target = "attachments/" + mailboxId + "/" + targetId + "/" + fileId;
      await env.MAIL_BUCKET.put(target, object.body, {
        httpMetadata: object.httpMetadata,
      });
      files.push({ ...file, id: fileId, r2_key: target });
    }
    let original: string | null = null;
    if (source.raw_r2_key) {
      const object = await env.MAIL_BUCKET.get(source.raw_r2_key);
      if (!object) fail(503, "Backup original unavailable");
      original = "originals/" + mailboxId + "/" + targetId + ".eml";
      await env.MAIL_BUCKET.put(original, object.body);
    }
    const recipient = (kind: string) =>
      source.recipients.filter((r) => r.kind === kind).map((r) => r.email_address);
    const input: MessageInput = {
      id: targetId,
      ingest_id: operation,
      thread_id: source.thread_id,
      direction: source.direction as "inbound" | "outbound",
      folder_id: source.draft
        ? "drafts"
        : (cursor.folder_map?.[source.folder_id] ?? source.folder_id),
      source: "restore",
      subject: source.subject,
      from_address: source.from_address,
      reply_to_address: source.reply_to_address,
      to: recipient("to"),
      cc: recipient("cc"),
      bcc: recipient("bcc"),
      received_at: source.received_at,
      provider: source.provider,
      connection_id: source.connection_id,
      provider_message_id: source.provider_message_id,
      rfc_message_id: source.rfc_message_id,
      references: source.references,
      raw_r2_key: original,
      body_r2_key: bodyKey,
      snippet: source.snippet,
      search_text: body.text || body.html.replace(/<[^>]*>/g, " "),
      attachments: files,
      draft_owner_id: source.draft ? actor.user_id : null,
      is_spam: !!source.is_spam,
      snoozed_until: source.snoozed_until,
    };
    await coordinator.storeMessage(partitionId, input);
    await partition(env, partitionId).applyInboundFlags(
      targetId,
      !!source.is_read,
      !!source.is_starred,
    );
    await coordinator.completeAllocation(operation);
    await flushOutbox(env, mailboxId, partitionId);
    count++;
  }
  cursor.cursor = page.truncated ? page.cursor : undefined;
  await coordinator.advanceDataJob(
    job.id,
    job.progress + count,
    JSON.stringify(cursor),
    !page.truncated,
  );
  if (page.truncated)
    await env.MAIL_QUEUE.send({
      kind: "data_job",
      mailbox_id: mailboxId,
      reference_id: job.id,
    });
}

async function backupManifest(env: Env, mailboxId: string, prefix: string, count: number) {
  const coordinator = mailbox(env, mailboxId),
    settings = await coordinator.settings();
  const signatureImages: { id: string; key: string }[] = [];
  for (const cid of inlineContentIds(String(settings.signature_html ?? ""))) {
    const imageId = /^([a-f0-9-]{36})@officeflare\.image$/.exec(cid)?.[1];
    if (!imageId) continue;
    const object = await env.MAIL_BUCKET.get(imageAssetKey(mailboxId, imageId));
    if (!object) fail(503, "Signature image unavailable during backup");
    const key = `signature-${imageId}.image`;
    await env.MAIL_BUCKET.put(prefix + key, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });
    signatureImages.push({ id: imageId, key });
  }
  await env.MAIL_BUCKET.put(
    prefix + "manifest.json",
    JSON.stringify({
      format: "officeflare-mail-v1",
      scope: "accessible_messages",
      consistency: "per-message",
      created_at: epoch(),
      message_count: count,
      settings,
      signature_images: signatureImages,
      folders: await coordinator.folders(),
      rules: await coordinator.rules(),
      blocked_senders: await coordinator.blockedSenders(),
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
}
// Split mboxrd (including singly quoted mboxo lines) without transcoding MIME bytes.
function splitMbox(raw: Uint8Array): Uint8Array[] {
  const ranges: { start: number; end: number }[] = [],
    from = [70, 114, 111, 109, 32];
  let start = 0;
  for (let pos = 0; pos < raw.length; pos++) {
    if (
      (pos === 0 || raw[pos - 1] === 10) &&
      from.every((value, index) => raw[pos + index] === value)
    ) {
      if (pos > start) ranges.push({ start, end: pos });
      while (pos < raw.length && raw[pos] !== 10) pos++;
      start = pos + 1;
    }
  }
  if (start < raw.length) ranges.push({ start, end: raw.length });
  if (ranges.length > 10000) fail(413, "Import has too many messages; split the file");
  return ranges.map(({ start, end }) => unquoteMboxMessage(raw.subarray(start, end)));
}
