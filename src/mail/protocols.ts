import { t } from "../../shared/i18n/index.ts";
import { renderMime } from "./data";
import { mailboxSendingLimits } from "./limits";
import { providers } from "./providers";
import { putStream } from "./objects";
import { Hono } from "hono";
import PostalMime from "postal-mime";
import { all, authorize } from "./control";
import { email, hash, integer, jsonBody, recipients, strictId, text } from "./input";
import { mailbox, partition } from "./mailbox";
import { belongs, createDraft, getMessage, queryMessages, readBody, submitDraft } from "./service";
import { epoch, fail, id, locator, type MailActor, type MailAppEnv, type Mailbox } from "./types";
const core = "urn:ietf:params:jmap:core",
  mailCapability = "urn:ietf:params:jmap:mail",
  submissionCapability = "urn:ietf:params:jmap:submission";
async function accounts(env: Env, actor: MailActor) {
  const candidates = await all<Mailbox>(
      env,
      "SELECT DISTINCT b.* FROM mail_mailboxes b LEFT JOIN mail_mailbox_members m ON m.mailbox_id=b.id AND m.user_id=? WHERE b.status='active' AND (b.owner_user_id=? OR m.can_read=1)",
      actor.user_id,
      actor.user_id,
    ),
    result: Mailbox[] = [];
  for (const candidate of candidates) {
    try {
      await authorize(env, actor, candidate.id, "read");
      result.push(candidate);
    } catch {
      /* Scopes can intentionally narrow the user's accounts. */
    }
  }
  return result;
}
async function state(env: Env, mailboxId: string) {
  const parts = await mailbox(env, mailboxId).partitions(),
    value = [];
  for (const part of parts) value.push([part.id, await partition(env, part.id).state()]);
  return hash(
    JSON.stringify({
      partitions: value,
      folders: await mailbox(env, mailboxId).folders(),
    }),
  );
}
export const jmap = new Hono<MailAppEnv>();
jmap.get("/session", async (c) => {
  const owner = c.get("mail_actor"),
    available = await accounts(c.env, owner),
    origin = new URL(c.req.url).origin;
  const readOnly: Record<string, boolean> = {};
  const limits = Object.fromEntries(
    await Promise.all(
      available.map(
        async (entry) => [entry.id, await mailboxSendingLimits(c.env, entry.id)] as const,
      ),
    ),
  );
  for (const entry of available) {
    try {
      await authorize(c.env, owner, entry.id, "write");
      readOnly[entry.id] = false;
    } catch {
      readOnly[entry.id] = true;
    }
  }
  return c.json({
    capabilities: {
      [core]: {
        maxSizeUpload: Math.max(
          0,
          ...available.map(
            (entry) => limits[entry.id]!.max_send_bytes || limits[entry.id]!.max_upload_bytes,
          ),
        ),
        maxConcurrentUpload: 4,
        maxSizeRequest: 5 * 1024 * 1024,
        maxConcurrentRequests: 4,
        maxCallsInRequest: 32,
        maxObjectsInGet: 100,
        maxObjectsInSet: 100,
        collationAlgorithms: ["i;unicode-casemap"],
      },
      [mailCapability]: {},
      [submissionCapability]: {},
    },
    accounts: Object.fromEntries(
      available.map((entry) => [
        entry.id,
        {
          name: entry.name,
          isPersonal: entry.kind === "personal",
          isReadOnly: readOnly[entry.id],
          accountCapabilities: {
            [mailCapability]: {
              maxMailboxesPerEmail: 1,
              maxMailboxDepth: 1,
              maxSizeMailboxName: 100,
              maxSizeAttachmentsPerEmail: limits[entry.id]!.max_upload_bytes,
              emailQuerySortOptions: ["receivedAt"],
              mayCreateTopLevelMailbox: true,
            },
            [submissionCapability]: {
              maxDelayedSend: 366 * 86400,
              submissionExtensions: {},
            },
          },
        },
      ]),
    ),
    primaryAccounts: {
      [mailCapability]: available[0]?.id,
      [submissionCapability]: available[0]?.id,
    },
    username: owner.user_id,
    apiUrl: origin + "/api/mail/jmap",
    downloadUrl: origin + "/api/mail/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    uploadUrl: origin + "/api/mail/jmap/upload/{accountId}",
    eventSourceUrl: origin + "/api/mail/jmap/events",
    state: owner.auth_version.toString(),
  });
});
jmap.post("/upload/:account", async (c) => {
  const account = c.req.param("account"),
    actor = c.get("mail_actor");
  await authorize(c.env, actor, account, "write");
  if (!c.req.raw.body) fail(400, t("mailProtocols.missingUpload"));
  const limits = await mailboxSendingLimits(c.env, account),
    maximum = limits.max_send_bytes || limits.max_upload_bytes;
  const uploadId = id();
  const object = await putStream(
    c.env.MAIL_BUCKET,
    "uploads/" + account + "/" + actor.user_id + "/" + uploadId,
    c.req.raw.body,
    {
      customMetadata: {
        filename: "message.eml",
        expires_at: String(epoch() + 86400),
      },
      httpMetadata: {
        contentType: c.req.header("content-type") ?? "application/octet-stream",
      },
    },
    undefined,
    maximum,
  );
  if (!object || object.size > maximum) {
    await c.env.MAIL_BUCKET.delete("uploads/" + account + "/" + actor.user_id + "/" + uploadId);
    fail(413, t("mailProtocols.uploadExceedsBytes", { maximum: maximum }));
  }
  return c.json(
    {
      accountId: account,
      blobId: "upload:" + uploadId,
      type: object.httpMetadata?.contentType,
      size: object.size,
    },
    201,
  );
});
jmap.get("/download/:account/:blob/:name", async (c) => {
  const account = c.req.param("account"),
    actor = c.get("mail_actor");
  await authorize(c.env, actor, account, "read");
  const blob = c.req.param("blob");
  let object: R2ObjectBody | null;
  if (blob.startsWith("upload:")) {
    object = await c.env.MAIL_BUCKET.get(
      "uploads/" + account + "/" + actor.user_id + "/" + strictId(blob.slice(7)),
    );
    if (object && Number(object.customMetadata?.expires_at ?? 0) <= epoch()) object = null;
  } else {
    const [messageId, attachmentId] = blob.split(":");
    await belongs(c.env, account, locator(messageId!));
    const message = await partition(c.env, locator(messageId!)).get(messageId!, actor.user_id);
    if (attachmentId) {
      const file = message.attachments.find((file) => file.id === attachmentId);
      if (!file) fail(404, t("mailProtocols.blobNotFound"));
      object = await c.env.MAIL_BUCKET.get(file.r2_key);
    } else if (message.raw_r2_key) object = await c.env.MAIL_BUCKET.get(message.raw_r2_key);
    else
      return new Response(
        await renderMime(c.env, message, await readBody(c.env, message.body_r2_key)),
        {
          headers: {
            "Content-Type": "message/rfc822",
            "Content-Disposition": "attachment",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
  }
  if (!object) fail(404, t("mailProtocols.blobNotFound"));
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
});
jmap.post("/", async (c) => {
  const data = await jsonBody(c.req.raw, ["using", "methodCalls", "createdIds"]);
  if (
    !Array.isArray(data.using) ||
    data.using.some((cap) => ![core, mailCapability, submissionCapability].includes(cap)) ||
    !Array.isArray(data.methodCalls) ||
    data.methodCalls.length > 32
  )
    fail(400, t("mailProtocols.invalidJmapRequest"));
  const responses: [string, Record<string, unknown>, string][] = [],
    createdIds: Record<string, string> = {};
  for (const call of data.methodCalls) {
    if (
      !Array.isArray(call) ||
      call.length !== 3 ||
      typeof call[0] !== "string" ||
      !call[1] ||
      typeof call[1] !== "object" ||
      typeof call[2] !== "string"
    )
      fail(400, t("mailProtocols.invalidJmapMethodCall"));
    const [name, original, tag] = call as [string, Record<string, unknown>, string],
      args = { ...original };
    try {
      for (const [key, value] of Object.entries(args))
        if (key.startsWith("#")) {
          const reference = value as {
              resultOf: string;
              name: string;
              path: string;
            },
            result = responses.find((r) => r[2] === reference.resultOf && r[0] === reference.name);
          if (!result || reference.path !== "/ids")
            fail(400, t("mailProtocols.invalidJmapResultReference"));
          args[key.slice(1)] = result[1].ids;
          delete args[key];
        }
      const result = await jmapMethod(c.env, c.get("mail_actor"), name, args, createdIds);
      responses.push([name, result, tag]);
    } catch (error) {
      const match = /MAIL:(\d{3}):([^\n]+)/.exec(error instanceof Error ? error.message : "");
      const type =
        match?.[2] === "Unknown JMAP method"
          ? "unknownMethod"
          : name.endsWith("/changes")
            ? "cannotCalculateChanges"
            : match?.[1] === "403"
              ? "forbidden"
              : match?.[1] === "404"
                ? "notFound"
                : match?.[1] === "409"
                  ? "stateMismatch"
                  : "invalidArguments";
      responses.push([
        "error",
        { type, description: match?.[2] ?? t("mailProtocols.unsupportedMethodOrArguments") },
        tag,
      ]);
    }
  }
  return c.json({
    methodResponses: responses,
    createdIds,
    sessionState: c.get("mail_actor").auth_version.toString(),
  });
});
async function jmapMethod(
  env: Env,
  actor: MailActor,
  name: string,
  args: Record<string, unknown>,
  createdIds: Record<string, string>,
): Promise<Record<string, unknown>> {
  if (name === "Core/echo") return args;
  if (
    ![
      "Mailbox/get",
      "Mailbox/query",
      "Mailbox/set",
      "Email/query",
      "Email/get",
      "Email/set",
      "Email/import",
      "Thread/get",
      "Identity/get",
      "SearchSnippet/get",
      "EmailSubmission/set",
    ].includes(name) &&
    !name.endsWith("/changes")
  )
    fail(400, t("mailProtocols.unknownJmapMethod"));
  if (name.endsWith("/changes")) fail(400, t("mailProtocols.changeHistoryIsNotAvailable"));
  const account = text(args.accountId, "accountId", 36);
  await authorize(env, actor, account, "read");
  const currentState = await state(env, account);
  if (args.ifInState !== undefined && args.ifInState !== currentState)
    fail(409, t("mailProtocols.stateChanged"));
  const ids = args.ids === undefined || args.ids === null ? null : args.ids;
  if (
    ids !== null &&
    (!Array.isArray(ids) || ids.length > 100 || ids.some((value) => typeof value !== "string"))
  )
    fail(400, t("mailProtocols.invalidIds"));
  if (name === "Mailbox/get") {
    const folders = await mailbox(env, account).folders(),
      counts: Record<string, { total: number; unread: number }> = {};
    for (const entry of await mailbox(env, account).partitions())
      for (const value of await partition(env, entry.id).folderCounts(actor.user_id)) {
        const count = (counts[value.folder_id] ??= { total: 0, unread: 0 });
        count.total += value.total;
        count.unread += value.unread;
      }
    return {
      accountId: account,
      state: currentState,
      list: folders
        .filter((f) => !ids || (ids as string[]).includes(f.id))
        .map((f) => ({
          id: f.id,
          name: f.name,
          parentId: null,
          role:
            f.system_key === "archive"
              ? "archive"
              : f.system_key === "spam"
                ? "junk"
                : f.system_key,
          sortOrder: 0,
          totalEmails: counts[f.id]?.total ?? 0,
          unreadEmails: counts[f.id]?.unread ?? 0,
          isSubscribed: true,
        })),
      notFound: ids
        ? (ids as string[]).filter((value) => !folders.some((f) => f.id === value))
        : [],
    };
  }
  if (name === "Email/query" || name === "Mailbox/query") {
    if (name === "Mailbox/query") {
      const folders = await mailbox(env, account).folders();
      return {
        accountId: account,
        queryState: currentState,
        canCalculateChanges: false,
        position: 0,
        ids: folders.map((f) => f.id),
        total: folders.length,
      };
    }
    const filter = (args.filter ?? {}) as Record<string, unknown>;
    if (
      !filter ||
      typeof filter !== "object" ||
      Array.isArray(filter) ||
      Object.keys(filter).some(
        (field) =>
          !["text", "from", "to", "subject", "hasAttachment", "hasKeyword", "inMailbox"].includes(
            field,
          ),
      )
    )
      fail(400, t("mailProtocols.unsupportedFilter"));
    if (
      filter.hasKeyword !== undefined &&
      !["$seen", "$flagged"].includes(String(filter.hasKeyword))
    )
      fail(400, t("mailProtocols.unsupportedKeywordFilter"));
    if (
      args.sort !== undefined &&
      (!Array.isArray(args.sort) ||
        args.sort.length !== 1 ||
        (args.sort[0] as { property?: string }).property !== "receivedAt" ||
        (args.sort[0] as { isAscending?: boolean }).isAscending !== false)
    )
      fail(400, t("mailProtocols.onlyDescendingReceivedatSortingIsSupported"));
    const terms: string[] = [];
    for (const [field, prefix] of [
      ["text", ""],
      ["from", "from:"],
      ["to", "to:"],
      ["subject", "subject:"],
    ] as const)
      if (filter[field])
        terms.push(prefix + '"' + text(filter[field], field, 256).replaceAll('"', "") + '"');
    if (filter.hasAttachment !== undefined) {
      if (typeof filter.hasAttachment !== "boolean")
        fail(400, t("mailProtocols.invalidHasattachment"));
      terms.push((filter.hasAttachment ? "" : "-") + "has:attachment");
    }
    if (filter.hasKeyword === "$seen") terms.push("is:read");
    if (filter.hasKeyword === "$flagged") terms.push("is:starred");
    const limit = integer(args.limit ?? 50, "limit", 1, 100),
      position = integer(args.position ?? 0, "position", 0, 1000);
    const page = await queryMessages(env, actor, account, {
      limit: position + limit + 1,
      search: terms.join(" "),
      folder_id: filter.inMailbox ? text(filter.inMailbox, "inMailbox", 100) : undefined,
      include_snoozed: true,
    });
    return {
      accountId: account,
      queryState: currentState,
      canCalculateChanges: false,
      position,
      ids: page.messages.slice(position, position + limit).map((m) => m.id),
    };
  }
  if (name === "Email/get") {
    const requested = ids as string[] | null,
      selected =
        requested ??
        (
          await queryMessages(env, actor, account, {
            limit: 100,
            include_snoozed: true,
          })
        ).messages.map((m) => m.id),
      list = [],
      notFound = [];
    for (const emailId of selected) {
      try {
        const message = await getMessage(env, actor, account, emailId);
        list.push({
          id: message.id,
          blobId: message.id,
          threadId: message.thread_id,
          mailboxIds: { [message.folder_id]: true },
          keywords: {
            ...(message.is_read ? { $seen: true } : {}),
            ...(message.is_starred ? { $flagged: true } : {}),
            ...(message.draft ? { $draft: true } : {}),
          },
          size: message.body.text.length + message.body.html.length,
          receivedAt: new Date(message.received_at * 1000).toISOString(),
          messageId: message.rfc_message_id ? [message.rfc_message_id] : [],
          from: [{ email: message.from_address, name: "" }],
          to: message.recipients
            .filter((r) => r.kind === "to")
            .map((r) => ({ email: r.email_address, name: "" })),
          cc: message.recipients
            .filter((r) => r.kind === "cc")
            .map((r) => ({ email: r.email_address, name: "" })),
          bcc: message.recipients
            .filter((r) => r.kind === "bcc")
            .map((r) => ({ email: r.email_address, name: "" })),
          subject: message.subject,
          preview: message.snippet,
          hasAttachment: !!message.has_attachments,
          textBody: [{ partId: "text", type: "text/plain" }],
          htmlBody: [{ partId: "html", type: "text/html" }],
          bodyValues: {
            text: {
              value: message.body.text,
              isEncodingProblem: false,
              isTruncated: false,
            },
            html: {
              value: message.body.html,
              isEncodingProblem: false,
              isTruncated: false,
            },
          },
          attachments: message.attachments.map((f) => ({
            blobId: message.id + ":" + f.id,
            name: f.filename,
            type: f.content_type,
            size: f.size_bytes,
            cid: f.content_id,
            disposition: f.disposition,
          })),
          provider: message.provider,
          connectionId: message.connection_id,
        });
      } catch {
        notFound.push(emailId);
      }
    }
    return { accountId: account, state: currentState, list, notFound };
  }
  if (name === "Thread/get") {
    if (!ids) fail(400, t("mailProtocols.threadIdsRequired"));
    const list = [],
      notFound = [];
    for (const threadId of ids as string[]) {
      const messages = (
        await queryMessages(env, actor, account, {
          limit: 1000,
          thread_id: threadId,
          include_snoozed: true,
        })
      ).messages;
      if (messages.length) list.push({ id: threadId, emailIds: messages.map((m) => m.id) });
      else notFound.push(threadId);
    }
    return { accountId: account, state: currentState, list, notFound };
  }
  if (name === "Identity/get") {
    let canSend = false;
    try {
      await authorize(env, actor, account, "send");
      canSend = true;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("MAIL:403:")) throw error;
    }
    const addresses = canSend
      ? await all<{ id: string; email: string; provider: string }>(
          env,
          "SELECT a.id,a.local_part||'@'||d.name email,p.provider FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id JOIN mail_provider_connections p ON p.id=d.outbound_connection_id WHERE a.mailbox_id=? AND a.send_enabled=1 AND d.outbound_enabled=1 AND p.enabled=1",
          account,
        )
      : [];
    return {
      accountId: account,
      state: currentState,
      list: addresses
        .filter(
          (a) =>
            providers.some((entry) => entry.id === a.provider && entry.capabilities.send) &&
            (!ids || (ids as string[]).includes(a.id)),
        )
        .map(({ provider: _provider, ...a }) => ({
          ...a,
          name: "",
          replyTo: null,
          bcc: null,
          textSignature: "",
          htmlSignature: "",
          mayDelete: false,
        })),
      notFound: ids
        ? (ids as string[]).filter((value) => !addresses.some((a) => a.id === value))
        : [],
    };
  }
  if (name === "SearchSnippet/get") {
    const selected = args.emailIds;
    if (!Array.isArray(selected) || selected.length > 100)
      fail(400, t("mailProtocols.invalidEmailids"));
    const list = [];
    for (const emailId of selected) {
      const message = await getMessage(env, actor, account, text(emailId, "emailId", 73));
      list.push({
        emailId,
        subject: message.subject,
        preview: message.snippet,
      });
    }
    return { accountId: account, list, notFound: [] };
  }
  if (
    name === "Email/set" ||
    name === "EmailSubmission/set" ||
    name === "Email/import" ||
    name === "Mailbox/set"
  ) {
    const created: Record<string, unknown> = {},
      updated: Record<string, null> = {},
      destroyed: string[] = [],
      notCreated: Record<string, unknown> = {},
      notUpdated: Record<string, unknown> = {},
      notDestroyed: Record<string, unknown> = {};
    const create = (name === "Email/import" ? args.emails : args.create) ?? {};
    if (
      !create ||
      typeof create !== "object" ||
      Array.isArray(create) ||
      Object.keys(create).length > 100
    )
      fail(400, t("mailProtocols.invalidCreate"));
    for (const [creationId, raw] of Object.entries(
      create as Record<string, Record<string, unknown>>,
    )) {
      try {
        if (name === "Mailbox/set") {
          await authorize(env, actor, account, "write");
          const folder = await mailbox(env, account).putFolder(id(), text(raw.name, "name", 100));
          created[creationId] = folder;
          createdIds[creationId] = String(folder!.id);
          continue;
        }
        if (name === "EmailSubmission/set") {
          const emailId = text(raw.emailId, "emailId", 74),
            resolved = emailId.startsWith("#") ? createdIds[emailId.slice(1)]! : emailId;
          if (!resolved) fail(400, t("mailProtocols.unknownCreationId"));
          const message = await partition(env, locator(resolved)).get(resolved, actor.user_id);
          const job = await submitDraft(
            env,
            actor,
            account,
            resolved,
            {
              address_id: raw.identityId,
              version: message.draft?.version,
              scheduled_at: raw.sendAt
                ? Math.floor(Date.parse(String(raw.sendAt)) / 1000)
                : undefined,
            },
            id(),
          );
          created[creationId] = {
            id: job.id,
            emailId: resolved,
            identityId: raw.identityId,
            undoStatus: job.status === "scheduled" ? "pending" : "final",
          };
          createdIds[creationId] = job.id;
          continue;
        }
        let draftData: Record<string, unknown>;
        if (name === "Email/import") {
          const blobId = text(raw.blobId, "blobId", 100);
          if (!blobId.startsWith("upload:"))
            fail(400, t("mailProtocols.importRequiresAnUploadedMimeBlob"));
          const object = await env.MAIL_BUCKET.get(
            "uploads/" + account + "/" + actor.user_id + "/" + blobId.slice(7),
          );
          if (!object) fail(404, t("mailProtocols.blobNotFound"));
          const parsed = await PostalMime.parse(await object.arrayBuffer()),
            uploads = [];
          for (const file of parsed.attachments) {
            const uploadId = id();
            await env.MAIL_BUCKET.put(
              "uploads/" + account + "/" + actor.user_id + "/" + uploadId,
              file.content,
              {
                httpMetadata: { contentType: file.mimeType },
                customMetadata: {
                  filename: file.filename ?? "attachment",
                  expires_at: String(epoch() + 86400),
                },
              },
            );
            uploads.push(uploadId);
          }
          const flat = (value: typeof parsed.to) =>
            (value ?? []).flatMap((a) =>
              a.group ? a.group.map((m) => m.address) : a.address ? [a.address] : [],
            );
          draftData = {
            subject: parsed.subject ?? "",
            text: parsed.text ?? "",
            html: parsed.html ?? "",
            to: flat(parsed.to),
            cc: flat(parsed.cc),
            bcc: flat(parsed.bcc),
            attachment_ids: uploads,
          };
        } else {
          const addresses = (value: unknown) =>
            Array.isArray(value) ? value.map((a) => email((a as { email: unknown }).email)) : [];
          const values = (raw.bodyValues ?? {}) as Record<string, { value?: unknown }>;
          draftData = {
            subject: raw.subject ?? "",
            to: addresses(raw.to),
            cc: addresses(raw.cc),
            bcc: addresses(raw.bcc),
            text: values.text?.value ?? "",
            html: values.html?.value ?? "",
          };
        }
        const message = await createDraft(env, actor, account, draftData, id());
        created[creationId] = {
          id: message.id,
          blobId: message.id,
          threadId: message.thread_id,
        };
        createdIds[creationId] = message.id;
      } catch (error) {
        notCreated[creationId] = {
          type: "invalidProperties",
          description: error instanceof Error ? error.message : t("mailProtocols.creationFailed"),
        };
      }
    }
    const update = args.update ?? {};
    if (
      typeof update !== "object" ||
      !update ||
      Array.isArray(update) ||
      Object.keys(update).length > 100
    )
      fail(400, t("mailProtocols.invalidUpdate"));
    for (const [resourceId, value] of Object.entries(
      update as Record<string, Record<string, unknown>>,
    )) {
      try {
        await authorize(env, actor, account, "write");
        if (name === "Mailbox/set") {
          const folder = (await mailbox(env, account).folders()).find((f) => f.id === resourceId);
          if (!folder) fail(404, t("mailProtocols.folderNotFound"));
          await mailbox(env, account).putFolder(
            resourceId,
            text(value.name, "name", 100),
            folder.version,
          );
        } else if (name === "Email/set") {
          await belongs(env, account, locator(resourceId));
          const message = await partition(env, locator(resourceId)).get(resourceId, actor.user_id),
            keywords = (value.keywords ?? {}) as Record<string, unknown>,
            folders = value.mailboxIds ? Object.keys(value.mailboxIds as object) : [];
          await mailbox(env, account).changeMessage(
            locator(resourceId),
            resourceId,
            actor.user_id,
            message.version,
            {
              ...(folders.length ? { folder_id: folders[0] } : {}),
              is_read: Number(value["keywords/$seen"] ?? keywords["$seen"] ?? !!message.is_read),
              is_starred: Number(
                value["keywords/$flagged"] ?? keywords["$flagged"] ?? !!message.is_starred,
              ),
            },
          );
        } else fail(400, t("mailProtocols.updateIsUnsupported"));
        updated[resourceId] = null;
      } catch {
        notUpdated[resourceId] = { type: "invalidProperties" };
      }
    }
    const destroy = args.destroy ?? [];
    if (!Array.isArray(destroy) || destroy.length > 100)
      fail(400, t("mailProtocols.invalidDestroy"));
    for (const resourceId of destroy) {
      try {
        await authorize(env, actor, account, "write");
        if (name === "Mailbox/set") {
          const folder = (await mailbox(env, account).folders()).find((f) => f.id === resourceId);
          if (!folder) fail(404, t("mailProtocols.folderNotFound"));
          await mailbox(env, account).deleteFolder(String(resourceId), folder.version);
        } else if (name === "Email/set") {
          await belongs(env, account, locator(String(resourceId)));
          const message = await partition(env, locator(String(resourceId))).get(
            String(resourceId),
            actor.user_id,
          );
          await partition(env, locator(String(resourceId))).purge(
            String(resourceId),
            actor.user_id,
            !!message.draft,
          );
        } else fail(400, t("mailProtocols.destroyIsUnsupportedForThisMethod"));
        destroyed.push(String(resourceId));
      } catch {
        notDestroyed[String(resourceId)] = { type: "forbidden" };
      }
    }
    return {
      accountId: account,
      oldState: currentState,
      newState: await state(env, account),
      created,
      updated,
      destroyed,
      notCreated,
      notUpdated,
      notDestroyed,
    };
  }
  fail(400, t("mailProtocols.unsupportedJmapMethod"));
}
const toolSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const field = { type: "string" };
const tools = [
  {
    name: "list_mailboxes",
    get description() {
      return t("mailProtocols.listMailboxesAvailableToThisCredential");
    },
    inputSchema: toolSchema({}, []),
  },
  {
    name: "search_messages",
    get description() {
      return t("mailProtocols.searchAMailbox");
    },
    inputSchema: toolSchema({ mailbox_id: field, query: field }, ["mailbox_id", "query"]),
  },
  {
    name: "get_message",
    get description() {
      return t("mailProtocols.readAnAuthorizedMessage");
    },
    inputSchema: toolSchema({ mailbox_id: field, message_id: field }, ["mailbox_id", "message_id"]),
  },
  {
    name: "create_draft",
    get description() {
      return t("mailProtocols.createAPrivateDraftForReview");
    },
    inputSchema: toolSchema(
      {
        mailbox_id: field,
        subject: field,
        text: field,
        to: { type: "array", items: field },
      },
      ["mailbox_id", "subject", "text", "to"],
    ),
  },
  {
    name: "request_send",
    get description() {
      return t("mailProtocols.requestHumanReviewOfTheCurrentDraftDoesNot");
    },
    inputSchema: toolSchema({ mailbox_id: field, draft_id: field }, ["mailbox_id", "draft_id"]),
  },
];
export async function mcp(c: import("hono").Context<MailAppEnv>) {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin)
    fail(403, t("mailProtocols.invalidMcpOrigin"));
  const version = c.req.header("mcp-protocol-version");
  if (version && !["2025-03-26", "2025-06-18", "2025-11-25"].includes(version))
    fail(400, t("mailProtocols.unsupportedMcpProtocolVersion"));
  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
    fail(406, t("mailProtocols.mcpRequiresJsonAndEventStreamAcceptance"));
  const request = await jsonBody(c.req.raw, ["jsonrpc", "id", "method", "params"]);
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string")
    fail(400, t("mailProtocols.invalidJsonRpcRequest"));
  if (!("id" in request)) return c.body(null, 202);
  let result: unknown;
  if (request.method === "initialize")
    result = {
      protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(
        String((request.params as { protocolVersion?: string })?.protocolVersion),
      )
        ? (request.params as { protocolVersion: string }).protocolVersion
        : "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "officeflare-mail", version: "0.1.0" },
    };
  else if (request.method === "ping") result = {};
  else if (request.method === "tools/list") result = { tools };
  else if (request.method === "tools/call") {
    const params = request.params as {
        name?: string;
        arguments?: Record<string, unknown>;
      },
      args = params?.arguments ?? {},
      actor = c.get("mail_actor");
    try {
      let value: unknown;
      switch (params?.name) {
        case "list_mailboxes":
          value = { mailboxes: await accounts(c.env, actor) };
          break;
        case "search_messages":
          value = await queryMessages(c.env, actor, text(args.mailbox_id, "mailbox_id", 36), {
            limit: 50,
            search: text(args.query, "query", 1000),
          });
          break;
        case "get_message":
          value = await getMessage(
            c.env,
            actor,
            text(args.mailbox_id, "mailbox_id", 36),
            text(args.message_id, "message_id", 73),
          );
          break;
        case "create_draft":
          value = await createDraft(
            c.env,
            actor,
            text(args.mailbox_id, "mailbox_id", 36),
            { subject: args.subject, text: args.text, to: args.to },
            id(),
          );
          break;
        case "request_send": {
          const account = text(args.mailbox_id, "mailbox_id", 36),
            draftId = text(args.draft_id, "draft_id", 73);
          const message = await getMessage(c.env, actor, account, draftId);
          if (!message.draft) fail(409, t("mailProtocols.messageIsNotADraft"));
          value = {
            requires_human_approval: true,
            draft_id: message.id,
            version: message.draft.version,
            subject: message.subject,
            recipients: message.recipients,
            review_endpoint:
              "/api/mail/mailboxes/" + account + "/drafts/" + message.id + "/submissions",
          };
          break;
        }
        default:
          fail(400, t("mailProtocols.unknownTool"));
      }
      result = {
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError: false,
      };
    } catch (error) {
      result = {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : t("mailProtocols.toolFailed"),
          },
        ],
        isError: true,
      };
    }
  } else
    return c.json({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: t("mailProtocols.methodNotFound") },
    });
  return c.json({ jsonrpc: "2.0", id: request.id, result });
}
