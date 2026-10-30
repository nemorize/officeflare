import { t } from "../../shared/i18n/index.ts";
import { inboxExcludedFolders } from "./ui-query";
import { DurableObject } from "cloudflare:workers";
import schema from "./partition.sql";
import unifiedSend from "./partition-v2.sql";
import uiCommands from "./partition-v3.sql";
import readModels from "./partition-v4.sql";
import { rebuildReadModels, rebuildDirtyThreads } from "./read-models";
import { migrate } from "./migrations";
import { compileSearch } from "./search";
import {
  epoch,
  fail,
  id,
  row,
  rows,
  type Attachment,
  type MessageInput,
  type MessageQuery,
  type MessageRow,
  type ThreadRow,
  type Submission,
  type DeliveryTask,
  publicSubmission,
} from "./types";

export class MailPartitionDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, [schema, unifiedSend, uiCommands, readModels]);
    });
  }
  initialize(mailboxId: string, partitionId: string) {
    const existing = row<{ mailbox_id: string; partition_id: string }>(
      this.sql,
      "SELECT * FROM partition_identity WHERE id=1",
    );
    if (existing && (existing.mailbox_id !== mailboxId || existing.partition_id !== partitionId))
      fail(409, t("mailPartition.partitionIdentityMismatch"));
    this.sql.exec("INSERT OR IGNORE INTO partition_identity VALUES(1,?,?)", mailboxId, partitionId);
  }
  state() {
    return row<{ n: number }>(
      this.sql,
      "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='change_log'),0) n",
    )!.n;
  }
  size() {
    return this.sql.databaseSize;
  }
  internalMessage(messageId: string) {
    return row<MessageRow>(this.sql, "SELECT * FROM messages WHERE id=?", messageId);
  }
  folderCounts(actorId: string) {
    return rows<{
      folder_id: string;
      total: number;
      unread: number;
      threads: number;
      unread_threads: number;
    }>(
      this.sql,
      "SELECT folder_id,count(*) total,sum(1-is_read) unread,count(DISTINCT thread_id) threads,count(DISTINCT CASE WHEN is_read=0 THEN thread_id END) unread_threads FROM messages WHERE draft_owner_id IS NULL OR draft_owner_id=? GROUP BY folder_id",
      actorId,
    );
  }
  folderCount(folderId: string) {
    return row<{ n: number }>(
      this.sql,
      "SELECT count(*) n FROM messages WHERE folder_id=?",
      folderId,
    )!.n;
  }
  private change(
    messageId: string,
    operation: string,
    privateUser: string | null = null,
    threadId?: string,
  ) {
    const current = row<{ thread_id: string; version: number }>(
      this.sql,
      "SELECT thread_id,version FROM messages WHERE id=?",
      messageId,
    );
    this.sql.exec(
      "INSERT INTO change_log(message_id,operation,created_at) VALUES(?,?,?)",
      messageId,
      operation,
      epoch(),
    );
    const identity = row<{ mailbox_id: string; partition_id: string }>(
      this.sql,
      "SELECT * FROM partition_identity WHERE id=1",
    )!;
    this.sql.exec(
      "INSERT INTO outbox VALUES(?,?,?, ?,NULL)",
      id(),
      "event",
      JSON.stringify({
        ...identity,
        message_id: messageId,
        thread_id: threadId ?? current?.thread_id,
        version: current?.version,
        operation,
        private_user_id: privateUser,
      }),
      epoch(),
    );
  }
  private removeIndex(messageId: string) {
    for (const document of rows<{
      id: number;
      subject: string;
      from_address: string;
      to_addresses: string;
      body: string;
    }>(this.sql, "SELECT * FROM search_documents WHERE message_id=?", messageId)) {
      this.sql.exec(
        "INSERT INTO messages_fts(messages_fts,rowid,subject,from_address,to_addresses,body) VALUES('delete',?,?,?,?,?)",
        document.id,
        document.subject,
        document.from_address,
        document.to_addresses,
        document.body,
      );
    }
    this.sql.exec("DELETE FROM search_documents WHERE message_id=?", messageId);
  }
  private index(messageId: string, subject: string, from: string, to: string[], body: string) {
    this.removeIndex(messageId);
    // Overlap exceeds the supported query length, including phrases spanning a chunk boundary.
    const chunks: string[] = [];
    for (let start = 0; start < body.length; start += 64000)
      chunks.push(body.slice(Math.max(0, start - 512), start + 64000));
    if (!chunks.length) chunks.push("");
    for (const chunk of chunks) {
      const document = row<{ id: number }>(
        this.sql,
        "INSERT INTO search_documents(message_id,subject,from_address,to_addresses,body) VALUES(?,?,?,?,?) RETURNING id",
        messageId,
        subject,
        from,
        to.join(" "),
        chunk,
      )!;
      this.sql.exec(
        "INSERT INTO messages_fts(rowid,subject,from_address,to_addresses,body) VALUES(?,?,?,?,?)",
        document.id,
        subject,
        from,
        to.join(" "),
        chunk,
      );
    }
  }
  insert(input: MessageInput) {
    const existing = input.ingest_id
      ? row<{ id: string }>(this.sql, "SELECT id FROM messages WHERE ingest_id=?", input.ingest_id)
      : row<{ id: string }>(this.sql, "SELECT id FROM messages WHERE id=?", input.id);
    if (existing) return existing.id;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO messages(id,thread_id,direction,folder_id,subject,from_address,received_at,provider,connection_id,provider_message_id,rfc_message_id,raw_r2_key,body_r2_key,snippet,has_attachments,draft_owner_id,ingest_id,is_spam,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        input.id,
        input.thread_id,
        input.direction,
        input.folder_id,
        input.subject,
        input.from_address,
        input.received_at,
        input.provider,
        input.connection_id,
        input.provider_message_id,
        input.rfc_message_id,
        input.raw_r2_key,
        input.body_r2_key,
        input.snippet,
        Number(input.attachments.length > 0),
        input.draft_owner_id,
        input.ingest_id ?? null,
        Number(input.is_spam ?? false),
        epoch(),
        epoch(),
      );
      this.sql.exec(
        "UPDATE messages SET source=?,trashed_at=?,reply_to_address=?,snoozed_until=? WHERE id=?",
        input.source ?? "email",
        ["trash", "spam"].includes(input.folder_id) ? epoch() : null,
        input.reply_to_address ?? null,
        Number.isSafeInteger(input.snoozed_until) && input.snoozed_until! > epoch()
          ? input.snoozed_until!
          : null,
        input.id,
      );
      for (const kind of ["to", "cc", "bcc"] as const)
        input[kind].forEach((address, ordinal) =>
          this.sql.exec(
            "INSERT INTO message_recipients VALUES(?,?,?,?)",
            input.id,
            kind,
            ordinal,
            address,
          ),
        );
      for (const reference of new Set(input.references))
        this.sql.exec("INSERT INTO message_references VALUES(?,?)", input.id, reference);
      for (const file of input.attachments)
        this.sql.exec(
          "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)",
          file.id,
          input.id,
          file.filename,
          file.content_type,
          file.size_bytes,
          file.content_id,
          file.r2_key,
          file.disposition,
        );
      if (input.draft_owner_id) {
        this.sql.exec(
          "INSERT INTO drafts(message_id,created_by) VALUES(?,?)",
          input.id,
          input.draft_owner_id,
        );
        this.sql.exec(
          "INSERT INTO draft_revisions VALUES(?,1,?,?)",
          input.id,
          input.body_r2_key,
          epoch(),
        );
      }
      this.index(
        input.id,
        input.subject,
        input.from_address,
        [...input.to, ...input.cc],
        input.search_text,
      );
      this.change(input.id, "created", input.draft_owner_id);
    });
    return input.id;
  }
  receipt(operationId: string) {
    return row<{ request_hash: string; resource_id: string }>(
      this.sql,
      "SELECT request_hash,resource_id FROM processing_receipts WHERE id=?",
      operationId,
    );
  }
  createDraft(input: MessageInput, operationId: string, requestHash: string) {
    const existing = this.receipt(operationId);
    if (existing) {
      if (existing.request_hash !== requestHash)
        fail(409, t("mailPartition.idempotencyKeyReusedWithDifferentRequest"));
      return existing.resource_id;
    }
    this.ctx.storage.transactionSync(() => {
      this.insert(input);
      this.sql.exec(
        "INSERT INTO processing_receipts VALUES(?,?,?,?)",
        operationId,
        requestHash,
        input.id,
        epoch(),
      );
    });
    return input.id;
  }
  applyInboundFlags(messageId: string, read: boolean, star: boolean) {
    this.sql.exec(
      "UPDATE messages SET is_read=?,is_starred=? WHERE id=?",
      Number(read),
      Number(star),
      messageId,
    );
  }
  get(messageId: string, actorId: string) {
    const message = row<MessageRow>(
      this.sql,
      "SELECT * FROM messages WHERE id=? AND (draft_owner_id IS NULL OR draft_owner_id=?)",
      messageId,
      actorId,
    );
    if (!message) fail(404, t("mailPartition.messageNotFound"));
    return {
      ...message,
      recipients: rows<{ kind: string; email_address: string }>(
        this.sql,
        "SELECT kind,email_address FROM message_recipients WHERE message_id=? ORDER BY kind,ordinal",
        messageId,
      ),
      attachments: rows<Attachment>(
        this.sql,
        "SELECT id,filename,content_type,size_bytes,content_id,r2_key,disposition FROM attachments WHERE message_id=?",
        messageId,
      ),
      references: rows<{ rfc_message_id: string }>(
        this.sql,
        "SELECT rfc_message_id FROM message_references WHERE message_id=?",
        messageId,
      ).map((r) => r.rfc_message_id),
      draft: row<{ version: number; state: string }>(
        this.sql,
        "SELECT version,state FROM drafts WHERE message_id=?",
        messageId,
      ),
      submissions: rows<Submission>(
        this.sql,
        "SELECT * FROM submissions WHERE message_id=? ORDER BY created_at DESC LIMIT 20",
        messageId,
      ).map(publicSubmission),
    };
  }
  headers(ids: string[], actorId: string): MessageRow[] {
    return rows<MessageRow>(
      this.sql,
      "SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND (draft_owner_id IS NULL OR draft_owner_id=?)",
      JSON.stringify(ids),
      actorId,
    );
  }
  private queryPlan(query: MessageQuery) {
    const filters = ["(m.draft_owner_id IS NULL OR m.draft_owner_id=?)"],
      bindings: (string | number)[] = [query.actor_id];
    if (!query.include_snoozed && !query.snoozed_only) {
      filters.push("(m.snoozed_until IS NULL OR m.snoozed_until<=?)");
      bindings.push(epoch());
    }
    if (query.snoozed_only) {
      filters.push("m.snoozed_until>?");
      bindings.push(epoch());
    }
    if (query.before) {
      filters.push("(m.received_at<? OR (m.received_at=? AND m.id<?))");
      bindings.push(query.before.received_at, query.before.received_at, query.before.id);
    }
    if (query.folder_id) {
      filters.push("m.folder_id=?");
      bindings.push(query.folder_id);
    }
    if (query.thread_id) {
      filters.push("m.thread_id=?");
      bindings.push(query.thread_id);
    }
    if (query.search) {
      const plan = compileSearch(query.search);
      filters.push(...plan.filters);
      bindings.push(...plan.bindings);
      for (const term of plan.terms) {
        filters.push(
          (term.startsWith("-") ? "NOT " : "") +
            "EXISTS(SELECT 1 FROM search_documents d JOIN messages_fts f ON f.rowid=d.id WHERE d.message_id=m.id AND messages_fts MATCH ?)",
        );
        bindings.push(term.startsWith("-") ? term.slice(1) : term);
      }
    }
    if (query.view === "inbox") {
      filters.push("m.folder_id NOT IN (" + inboxExcludedFolders.map(() => "?").join(",") + ")");
      bindings.push(...inboxExcludedFolders);
    }
    if (query.view === "all") filters.push("m.folder_id NOT IN ('trash','spam','drafts')");
    if (query.exclude_drafts) filters.push("m.draft_owner_id IS NULL");
    if (query.editable_drafts)
      filters.push("EXISTS(SELECT 1 FROM drafts d WHERE d.message_id=m.id AND d.state='editable')");
    if (query.view === "scheduled")
      filters.push(
        "EXISTS(SELECT 1 FROM submissions s WHERE s.message_id=m.id AND s.status IN ('scheduled','queued','retry_wait'))",
      );
    if (query.view === "outbox")
      filters.push(
        "EXISTS(SELECT 1 FROM submissions s WHERE s.message_id=m.id AND s.status IN ('scheduled','queued','processing','retry_wait','unknown'))",
      );
    return { filters, bindings };
  }
  query(query: MessageQuery) {
    const { filters, bindings } = this.queryPlan(query);
    if (query.thread_ids) {
      filters.push("m.thread_id IN (SELECT value FROM json_each(?))");
      bindings.push(JSON.stringify(query.thread_ids));
    }
    const submission =
      query.view === "scheduled" || query.view === "outbox"
        ? ",(SELECT status FROM submissions WHERE message_id=m.id AND status IN ('scheduled','queued','processing','retry_wait','unknown') ORDER BY created_at DESC,id DESC LIMIT 1) submission_status,(SELECT min(scheduled_at) FROM submissions WHERE message_id=m.id AND status IN ('scheduled','queued','retry_wait')) scheduled_at"
        : "";
    return rows<MessageRow & { recipient_summary: string }>(
      this.sql,
      "SELECT m.*,(SELECT state FROM drafts WHERE message_id=m.id) draft_state,(SELECT group_concat(email_address, ', ') FROM message_recipients WHERE message_id=m.id AND kind='to') recipient_summary" +
        submission +
        " FROM messages m WHERE " +
        filters.join(" AND ") +
        " ORDER BY m.received_at DESC,m.id DESC LIMIT ?",
      ...bindings,
      query.limit,
    );
  }
  rebuildSummaries() {
    this.ctx.storage.transactionSync(() => rebuildReadModels(this.sql));
  }
  private summaryThreads(query: MessageQuery, ids?: string[]): ThreadRow[] {
    const filters = ["1"],
      args: (string | number)[] = [];
    if (query.folder_id) {
      filters.push("t.folder_id=?");
      args.push(query.folder_id);
    }
    if (!query.include_snoozed && !query.snoozed_only) {
      filters.push("t.snoozed_until<=?");
      args.push(epoch());
    }
    if (query.snoozed_only) {
      filters.push("t.snoozed_until>?");
      args.push(epoch());
    }
    if (query.thread_id) {
      filters.push("t.thread_id=?");
      args.push(query.thread_id);
    }
    for (const selected of [query.thread_ids, ids])
      if (selected) {
        filters.push("t.thread_id IN (SELECT value FROM json_each(?))");
        args.push(JSON.stringify(selected));
      }
    if (query.view === "inbox") {
      filters.push("t.folder_id NOT IN (" + inboxExcludedFolders.map(() => "?").join(",") + ")");
      args.push(...inboxExcludedFolders);
    }
    if (query.view === "all") filters.push("t.folder_id NOT IN ('trash','spam','drafts')");
    const before =
      !ids && query.before
        ? " AND (r.received_at<? OR (r.received_at=? AND r.representative_id<?))"
        : "";
    return rows<ThreadRow>(
      this.sql,
      "WITH matched AS (SELECT t.* FROM thread_summaries t WHERE " +
        filters.join(" AND ") +
        "), ranked AS (SELECT *,row_number() OVER(PARTITION BY thread_id ORDER BY received_at DESC,representative_id DESC) rn FROM matched), totals AS (SELECT thread_id,sum(message_count) message_count,sum(unread_count) unread_count,sum(starred_count) starred_count,max(has_attachments) thread_attachments,group_concat(participants) participants FROM matched GROUP BY thread_id) SELECT m.*,totals.message_count,totals.unread_count,totals.starred_count,totals.thread_attachments,totals.participants,(SELECT group_concat(email_address, ', ') FROM message_recipients WHERE message_id=m.id AND kind='to') recipient_summary FROM ranked r JOIN totals USING(thread_id) JOIN messages m ON m.id=r.representative_id WHERE r.rn=1" +
        before +
        " ORDER BY r.received_at DESC,r.representative_id DESC" +
        (ids ? "" : " LIMIT ?"),
      ...args,
      ...(!ids && query.before
        ? [query.before.received_at, query.before.received_at, query.before.id]
        : []),
      ...(!ids ? [query.limit] : []),
    ).map(({ thread_attachments, ...entry }: ThreadRow & { thread_attachments?: number }) => ({
      ...entry,
      has_attachments: thread_attachments ?? entry.has_attachments,
      participants: [...new Set((entry.participants ?? "").split(",").filter(Boolean))].join(","),
    }));
  }
  threadPage(query: MessageQuery, ids?: string[]): ThreadRow[] {
    if (
      query.exclude_drafts &&
      !query.search &&
      !query.editable_drafts &&
      !["scheduled", "outbox"].includes(query.view ?? "")
    )
      return this.summaryThreads(query, ids);
    const { filters, bindings } = this.queryPlan({ ...query, before: undefined });
    if (query.thread_ids) {
      filters.push("m.thread_id IN (SELECT value FROM json_each(?))");
      bindings.push(JSON.stringify(query.thread_ids));
    }
    if (ids) {
      filters.push("m.thread_id IN (SELECT value FROM json_each(?))");
      bindings.push(JSON.stringify(ids));
    }
    const before = !ids && query.before ? " AND (received_at<? OR (received_at=? AND id<?))" : "";
    return rows<ThreadRow>(
      this.sql,
      "WITH matched AS (SELECT m.* FROM messages m WHERE " +
        filters.join(" AND ") +
        "), ranked AS (SELECT *,row_number() OVER(PARTITION BY thread_id ORDER BY received_at DESC,id DESC) rn FROM matched), totals AS (SELECT thread_id,count(*) message_count,sum(1-is_read) unread_count,sum(is_starred) starred_count,max(has_attachments) thread_attachments,group_concat(DISTINCT nullif(from_address,'')) participants FROM matched GROUP BY thread_id) SELECT r.*,t.message_count,t.unread_count,t.starred_count,t.thread_attachments,t.participants,(SELECT group_concat(email_address, ', ') FROM message_recipients WHERE message_id=r.id AND kind='to') recipient_summary FROM ranked r JOIN totals t USING(thread_id) WHERE rn=1" +
        before +
        " ORDER BY received_at DESC,id DESC" +
        (ids ? "" : " LIMIT ?"),
      ...bindings,
      ...(!ids && query.before
        ? [query.before.received_at, query.before.received_at, query.before.id]
        : []),
      ...(!ids ? [query.limit] : []),
    ).map(
      ({
        rn: _rank,
        thread_attachments,
        ...entry
      }: ThreadRow & { rn?: number; thread_attachments?: number }) => ({
        ...entry,
        has_attachments: thread_attachments ?? entry.has_attachments,
      }),
    );
  }
  summary(actorId: string) {
    const folders = rows<{ folder_id: string; total: number; unread: number }>(
      this.sql,
      "SELECT folder_id,sum(total) total,sum(unread) unread FROM mailbox_counts WHERE (owner_id='' OR owner_id=?) AND snoozed_until<=? GROUP BY folder_id",
      actorId,
      epoch(),
    );
    const counts = row<{ starred: number; snoozed: number; scheduled: number; outbox: number }>(
      this.sql,
      "SELECT coalesce(sum(is_starred*total),0) starred,coalesce(sum(CASE WHEN snoozed_until>? THEN total ELSE 0 END),0) snoozed,(SELECT count(DISTINCT s.message_id) FROM submissions s JOIN messages d ON d.id=s.message_id WHERE s.status IN ('scheduled','queued','retry_wait') AND (d.draft_owner_id IS NULL OR d.draft_owner_id=?)) scheduled,(SELECT count(DISTINCT s.message_id) FROM submissions s JOIN messages d ON d.id=s.message_id WHERE s.status IN ('scheduled','queued','processing','retry_wait','unknown') AND (d.draft_owner_id IS NULL OR d.draft_owner_id=?)) outbox FROM mailbox_counts WHERE owner_id='' OR owner_id=?",
      epoch(),
      actorId,
      actorId,
      actorId,
    )!;
    const drafts = row<{ n: number }>(
      this.sql,
      "SELECT count(*) n FROM drafts d JOIN messages m ON m.id=d.message_id WHERE d.state='editable' AND m.draft_owner_id=?",
      actorId,
    )!.n;
    return {
      folders: folders.map((folder) =>
        folder.folder_id === "drafts" ? { ...folder, total: drafts, unread: 0 } : folder,
      ),
      ...counts,
    };
  }
  findThread(references: string[]) {
    for (const reference of references.slice(-100).reverse()) {
      const found = row<{ thread_id: string }>(
        this.sql,
        "SELECT thread_id FROM messages WHERE rfc_message_id=? ORDER BY received_at DESC LIMIT 1",
        reference,
      );
      if (found) return found.thread_id;
    }
    return null;
  }
  patch(
    messageId: string,
    actorId: string,
    version: number,
    changes: {
      folder_id?: string;
      is_read?: number;
      is_starred?: number;
      is_spam?: number;
      snoozed_until?: number | null;
    },
  ) {
    if (changes.folder_id === "spam" && changes.is_spam === undefined) changes.is_spam = 1;
    if (["inbox", "archive"].includes(changes.folder_id ?? "") && changes.is_spam === undefined)
      changes.is_spam = 0;
    const message = this.get(messageId, actorId);
    if (message.version !== version) fail(409, t("mailPartition.messageVersionChanged"));
    if (message.draft && changes.folder_id && changes.folder_id !== "drafts")
      fail(409, t("mailPartition.draftsMustBeSubmittedOrDiscarded"));
    const keys = Object.keys(changes) as (keyof typeof changes)[];
    if (!keys.length) fail(400, t("mailPartition.noChangesSupplied"));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE messages SET " +
          keys.map((key) => key + "=?").join(",") +
          ",trashed_at=?,version=version+1,updated_at=? WHERE id=?",
        ...keys.map((key) => changes[key]!),
        changes.folder_id && ["trash", "spam"].includes(changes.folder_id)
          ? (message.trashed_at ?? epoch())
          : changes.folder_id
            ? null
            : message.trashed_at,
        epoch(),
        messageId,
      );
      this.change(messageId, "updated", message.draft_owner_id);
    });
    return this.get(messageId, actorId);
  }
  /** Each item commits its receipt and outbox record with the CAS update. */
  patchMany(
    actorId: string,
    operation: string,
    requestHash: string,
    items: { id: string; version: number; changes: Parameters<MailPartitionDO["patch"]>[3] }[],
  ) {
    this.sql.exec("DELETE FROM ui_command_receipts WHERE expires_at<?", epoch());
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE read_model_state SET defer_threads=1 WHERE id=1");
      const results = items.map((item) => {
        const operationId = actorId + ":" + operation + ":" + item.id;
        const previous = row<{ request_hash: string; result_json: string }>(
          this.sql,
          "SELECT * FROM ui_command_receipts WHERE operation_id=?",
          operationId,
        );
        if (previous) {
          if (previous.request_hash !== requestHash)
            fail(409, t("mailPartition.idempotencyKeyReusedWithDifferentRequest"));
          return JSON.parse(previous.result_json) as {
            id: string;
            success: true;
            before: MessageRow;
            message: MessageRow;
          };
        }
        let threadId: string | undefined;
        try {
          return this.ctx.storage.transactionSync(() => {
            const before = this.get(item.id, actorId);
            threadId = before.thread_id;
            const message = this.patch(item.id, actorId, item.version, { ...item.changes });
            const result = { id: item.id, success: true as const, before, message };
            this.sql.exec(
              "INSERT INTO ui_command_receipts VALUES(?,?,?,?)",
              operationId,
              requestHash,
              JSON.stringify(result),
              epoch() + 86400,
            );
            return result;
          });
        } catch (error) {
          return {
            id: item.id,
            thread_id: threadId,
            success: false as const,
            error:
              error instanceof Error
                ? error.message.replace(/^MAIL:\d{3}:/, "")
                : t("mailPartition.operationFailed"),
          };
        }
      });
      rebuildDirtyThreads(this.sql);
      this.sql.exec("UPDATE read_model_state SET defer_threads=0 WHERE id=1");
      return results;
    });
  }
  editDraft(
    messageId: string,
    actorId: string,
    version: number,
    input: {
      subject: string;
      to: string[];
      cc: string[];
      bcc: string[];
      reply_to_address?: string | null;
      body_r2_key: string;
      snippet: string;
      search_text: string;
      attachments?: Attachment[];
    },
  ) {
    const message = this.get(messageId, actorId);
    if (!message.draft || message.draft.state !== "editable")
      fail(409, t("mailPartition.draftIsNotEditable"));
    if (message.draft.version !== version) fail(409, t("mailPartition.draftVersionChanged"));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE messages SET subject=?,body_r2_key=?,snippet=?,reply_to_address=?,version=version+1,updated_at=? WHERE id=?",
        input.subject,
        input.body_r2_key,
        input.snippet,
        input.reply_to_address === undefined ? message.reply_to_address : input.reply_to_address,
        epoch(),
        messageId,
      );
      this.sql.exec("UPDATE drafts SET version=version+1 WHERE message_id=?", messageId);
      this.sql.exec(
        "INSERT INTO draft_revisions VALUES(?,?,?,?)",
        messageId,
        version + 1,
        input.body_r2_key,
        epoch(),
      );
      this.sql.exec("DELETE FROM message_recipients WHERE message_id=?", messageId);
      for (const kind of ["to", "cc", "bcc"] as const)
        input[kind].forEach((address, ordinal) =>
          this.sql.exec(
            "INSERT INTO message_recipients VALUES(?,?,?,?)",
            messageId,
            kind,
            ordinal,
            address,
          ),
        );
      if (input.attachments) {
        for (const removed of message.attachments.filter(
          (file) => !input.attachments!.some((keep) => keep.id === file.id),
        )) {
          this.sql.exec(
            "INSERT OR IGNORE INTO garbage VALUES(?,?)",
            removed.r2_key,
            epoch() + 86400,
          );
        }
        this.sql.exec("DELETE FROM attachments WHERE message_id=?", messageId);
        for (const file of input.attachments)
          this.sql.exec(
            "INSERT INTO attachments(id,message_id,filename,content_type,size_bytes,content_id,r2_key,disposition) VALUES(?,?,?,?,?,?,?,?)",
            file.id,
            messageId,
            file.filename,
            file.content_type,
            file.size_bytes,
            file.content_id,
            file.r2_key,
            file.disposition,
          );
        this.sql.exec(
          "UPDATE messages SET has_attachments=? WHERE id=?",
          Number(input.attachments.length > 0),
          messageId,
        );
      }
      this.index(
        messageId,
        input.subject,
        message.from_address,
        [...input.to, ...input.cc],
        input.search_text,
      );
      this.change(messageId, "updated", actorId);
    });
    return this.get(messageId, actorId);
  }
  submit(
    value: Omit<Submission, "provider_message_id" | "lease_until" | "attempt_count" | "error_code">,
    fromAddress: string,
  ) {
    const existing = row<Submission>(this.sql, "SELECT * FROM submissions WHERE id=?", value.id);
    if (existing) {
      if (existing.request_hash !== value.request_hash)
        fail(409, t("mailPartition.idempotencyKeyReusedWithDifferentRequest"));
      return existing;
    }
    const message = this.get(value.message_id, value.actor_id);
    if (
      !message.draft ||
      message.draft.state !== "editable" ||
      message.draft.version !== value.draft_version
    )
      fail(409, t("mailPartition.draftVersionChangedOrSubmitted"));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO submissions(id,message_id,actor_id,actor_auth_version,api_key_id,address_id,provider,connection_id,request_hash,draft_version,snapshot_r2_key,status,scheduled_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        value.id,
        value.message_id,
        value.actor_id,
        value.actor_auth_version,
        value.api_key_id,
        value.address_id,
        value.provider,
        value.connection_id,
        value.request_hash,
        value.draft_version,
        value.snapshot_r2_key,
        value.status,
        value.scheduled_at,
        epoch(),
        epoch(),
      );
      const snapshotRecipients = rows<{ email_address: string }>(
        this.sql,
        "SELECT DISTINCT email_address FROM message_recipients WHERE message_id=?",
        value.message_id,
      );
      for (const recipient of snapshotRecipients)
        this.sql.exec(
          "INSERT INTO submission_recipients(submission_id,email_address) VALUES(?,?)",
          value.id,
          recipient.email_address,
        );
      this.sql.exec("UPDATE drafts SET state='submitted' WHERE message_id=?", value.message_id);
      this.sql.exec("UPDATE messages SET from_address=? WHERE id=?", fromAddress, value.message_id);
      for (const document of rows<{
        id: number;
        subject: string;
        from_address: string;
        to_addresses: string;
        body: string;
      }>(this.sql, "SELECT * FROM search_documents WHERE message_id=?", value.message_id)) {
        this.sql.exec(
          "INSERT INTO messages_fts(messages_fts,rowid,subject,from_address,to_addresses,body) VALUES('delete',?,?,?,?,?)",
          document.id,
          document.subject,
          document.from_address,
          document.to_addresses,
          document.body,
        );
        this.sql.exec(
          "UPDATE search_documents SET from_address=? WHERE id=?",
          fromAddress,
          document.id,
        );
        this.sql.exec(
          "INSERT INTO messages_fts(rowid,subject,from_address,to_addresses,body) VALUES(?,?,?,?,?)",
          document.id,
          document.subject,
          fromAddress,
          document.to_addresses,
          document.body,
        );
      }
      this.change(value.message_id, "submitted", value.actor_id);
    });
    return this.submission(value.id);
  }
  findSubmission(submissionId: string) {
    return row<Submission>(this.sql, "SELECT * FROM submissions WHERE id=?", submissionId);
  }
  submission(submissionId: string) {
    return (
      row<Submission>(this.sql, "SELECT * FROM submissions WHERE id=?", submissionId) ??
      fail(404, t("mailPartition.submissionNotFound"))
    );
  }
  submissionView(submissionId: string, actorId: string) {
    const value = this.submission(submissionId);
    if (value.actor_id !== actorId) this.get(value.message_id, actorId);
    const {
      actor_auth_version: _auth,
      api_key_id: _key,
      request_hash: _hash,
      snapshot_r2_key: _snapshot,
      ...publicValue
    } = value;
    return {
      ...publicValue,
      recipients: rows(
        this.sql,
        "SELECT email_address,status,event_at FROM submission_recipients WHERE submission_id=?",
        submissionId,
      ),
    };
  }
  claim(submissionId: string) {
    const job = this.submission(submissionId);
    if (job.status === "processing" && (job.lease_until ?? 0) <= epoch()) {
      this.sql.exec(
        "UPDATE submissions SET status='unknown',error_code='acceptance_unknown',updated_at=? WHERE id=?",
        epoch(),
        submissionId,
      );
      return null;
    }
    if (!["scheduled", "queued", "retry_wait"].includes(job.status) || job.scheduled_at > epoch())
      return null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE submissions SET status='processing',attempt_count=attempt_count+1,lease_until=?,updated_at=? WHERE id=?",
        epoch() + 300,
        epoch(),
        submissionId,
      );
      this.sql.exec(
        "INSERT INTO submission_attempts(id,submission_id,provider,connection_id,started_at) VALUES(?,?,?,?,?)",
        id(),
        submissionId,
        job.provider,
        job.connection_id,
        epoch(),
      );
    });
    return this.submission(submissionId);
  }
  complete(submissionId: string, providerMessageId: string) {
    const job = this.submission(submissionId);
    if (job.status === "accepted") return true;
    // A user may cancel an uncertain send and reopen its draft. A late receipt
    // must not turn that canceled submission back into a sent message.
    if (job.status === "canceled") return false;
    if (!["processing", "unknown"].includes(job.status))
      fail(409, t("mailPartition.submissionIsNotProcessing"));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE submissions SET status='accepted',provider_message_id=?,lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?",
        providerMessageId,
        epoch(),
        submissionId,
      );
      this.sql.exec(
        "UPDATE submission_attempts SET provider_message_id=?,finished_at=? WHERE submission_id=? AND finished_at IS NULL",
        providerMessageId,
        epoch(),
        submissionId,
      );
      this.sql.exec(
        "UPDATE messages SET folder_id='sent',draft_owner_id=NULL,provider=?,connection_id=?,provider_message_id=?,version=version+1,updated_at=? WHERE id=?",
        job.provider,
        job.connection_id,
        providerMessageId,
        epoch(),
        job.message_id,
      );
      if (providerMessageId.includes("@"))
        this.sql.exec(
          "UPDATE messages SET rfc_message_id=? WHERE id=?",
          providerMessageId.replace(/^<|>$/g, ""),
          job.message_id,
        );
      this.sql.exec("DELETE FROM drafts WHERE message_id=?", job.message_id);
      this.change(job.message_id, "accepted");
    });
    return true;
  }
  failure(
    submissionId: string,
    status: "failed" | "retry_wait" | "unknown",
    code: string,
    retryAt = 0,
  ) {
    const job = this.submission(submissionId);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE submissions SET status=?,error_code=?,scheduled_at=?,lease_until=NULL,updated_at=? WHERE id=?",
        status,
        code.slice(0, 200),
        retryAt || job.scheduled_at,
        epoch(),
        submissionId,
      );
      this.sql.exec(
        "UPDATE submission_attempts SET error_code=?,finished_at=? WHERE submission_id=? AND finished_at IS NULL",
        code.slice(0, 200),
        epoch(),
        submissionId,
      );
      if (status === "failed")
        this.sql.exec("UPDATE drafts SET state='editable' WHERE message_id=?", job.message_id);
      this.change(job.message_id, status, job.actor_id);
    });
  }
  cancel(submissionId: string, actorId: string) {
    this.submissionView(submissionId, actorId);
    const job = this.submission(submissionId);
    if (!["scheduled", "queued", "retry_wait", "unknown"].includes(job.status))
      fail(409, t("mailPartition.submissionCannotBeCanceledAfterProcessingStarts"));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE submissions SET status='canceled',updated_at=? WHERE id=?",
        epoch(),
        submissionId,
      );
      this.sql.exec("UPDATE drafts SET state='editable' WHERE message_id=?", job.message_id);
      this.change(job.message_id, "canceled", job.actor_id);
    });
    return this.submission(submissionId);
  }
  retry(submissionId: string, actorId: string) {
    this.submissionView(submissionId, actorId);
    const job = this.submission(submissionId),
      message = this.get(job.message_id, actorId);
    if (job.status !== "failed")
      fail(409, t("mailPartition.onlyKnownFailedSubmissionsMayBeRetried"));
    if (message.draft?.version !== job.draft_version || message.draft.state !== "editable")
      fail(409, t("mailPartition.draftChangedCreateANewSubmission"));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE submissions SET status='queued',scheduled_at=?,error_code=NULL,updated_at=? WHERE id=?",
        epoch(),
        epoch(),
        submissionId,
      );
      this.sql.exec("UPDATE drafts SET state='submitted' WHERE message_id=?", job.message_id);
    });
    return this.submission(submissionId);
  }
  providerSubmission(provider: string, connectionId: string, providerMessageId: string) {
    return (
      row<{ id: string }>(
        this.sql,
        "SELECT id FROM submissions WHERE provider=? AND (connection_id=? OR ?='') AND provider_message_id=?",
        provider,
        connectionId,
        connectionId,
        providerMessageId,
      )?.id ?? null
    );
  }
  delivery(submissionId: string, event: DeliveryTask) {
    const job = this.submission(submissionId);
    if (
      job.provider !== event.provider ||
      job.connection_id !== event.connection_id ||
      job.provider_message_id !== event.provider_message_id
    )
      fail(409, t("mailPartition.deliveryEventDoesNotMatchSubmission"));
    if (
      row(
        this.sql,
        "SELECT provider_event_id FROM provider_events WHERE provider=? AND connection_id=? AND provider_event_id=?",
        event.provider,
        event.connection_id,
        event.provider_event_id,
      )
    )
      return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO provider_events VALUES(?,?,?,?,?,?)",
        event.provider,
        event.provider_event_id,
        event.connection_id,
        event.provider_message_id,
        submissionId,
        epoch(),
      );
      // A late temporary event must not replace a terminal outcome.
      this.sql.exec(
        "UPDATE submission_recipients SET status=?,event_at=? WHERE submission_id=? AND email_address=? AND event_at<=? AND (status IN ('pending','deferred') OR ?='complained')",
        event.status,
        event.event_at,
        submissionId,
        event.recipient,
        event.event_at,
        event.status,
      );
      this.change(job.message_id, "delivery");
    });
  }
  private erase(messageId: string) {
    const message = row<MessageRow>(this.sql, "SELECT * FROM messages WHERE id=?", messageId);
    if (!message) return;
    if (
      row(
        this.sql,
        "SELECT id FROM submissions WHERE message_id=? AND status IN ('scheduled','queued','processing','retry_wait','unknown')",
        messageId,
      )
    )
      fail(409, t("mailPartition.messageHasAnActiveOrUncertainSubmission"));
    this.removeIndex(messageId);
    const keys = [
      message.body_r2_key,
      message.raw_r2_key,
      ...rows<{ r2_key: string }>(
        this.sql,
        "SELECT r2_key FROM attachments WHERE message_id=?",
        messageId,
      ).map((f) => f.r2_key),
      ...rows<{ body_r2_key: string }>(
        this.sql,
        "SELECT body_r2_key FROM draft_revisions WHERE message_id=?",
        messageId,
      ).map((f) => f.body_r2_key),
      ...rows<{ snapshot_r2_key: string }>(
        this.sql,
        "SELECT snapshot_r2_key FROM submissions WHERE message_id=?",
        messageId,
      ).map((f) => f.snapshot_r2_key),
    ];
    for (const key of keys)
      if (key) this.sql.exec("INSERT OR IGNORE INTO garbage VALUES(?,?)", key, epoch() + 86400);
    this.sql.exec("DELETE FROM submissions WHERE message_id=?", messageId);
    this.sql.exec("DELETE FROM messages WHERE id=?", messageId);
    this.change(messageId, "deleted", message.draft_owner_id, message.thread_id);
  }
  purge(messageId: string, actorId: string, draft = false) {
    const message = this.get(messageId, actorId);
    if (draft ? !message.draft : !["trash", "spam"].includes(message.folder_id))
      fail(409, t("mailPartition.permanentDeletionIsAllowedOnlyForTrashSpamOr"));
    this.ctx.storage.transactionSync(() => this.erase(messageId));
  }
  async rebuildIndex(messageId: string, text: string) {
    const message = row<MessageRow>(this.sql, "SELECT * FROM messages WHERE id=?", messageId);
    if (!message) return;
    const to = rows<{ email_address: string }>(
      this.sql,
      "SELECT email_address FROM message_recipients WHERE message_id=? AND kind<>'bcc'",
      messageId,
    ).map((r) => r.email_address);
    this.ctx.storage.transactionSync(() =>
      this.index(messageId, message.subject, message.from_address, to, text),
    );
  }
  registerWebhook(webhookId: string, eventId: string, payload: string) {
    this.sql.exec(
      "INSERT OR IGNORE INTO webhook_deliveries(id,webhook_id,event_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      id(),
      webhookId,
      eventId,
      payload,
      epoch(),
      epoch(),
    );
    return row<{ id: string }>(
      this.sql,
      "SELECT id FROM webhook_deliveries WHERE webhook_id=? AND event_id=?",
      webhookId,
      eventId,
    )!.id;
  }
  webhookDelivery(deliveryId: string) {
    return row<{
      id: string;
      webhook_id: string;
      payload_json: string;
      status: string;
      attempt_count: number;
    }>(this.sql, "SELECT * FROM webhook_deliveries WHERE id=?", deliveryId);
  }
  webhookResult(deliveryId: string, success: boolean, terminal: boolean) {
    this.sql.exec(
      "UPDATE webhook_deliveries SET status=?,attempt_count=attempt_count+1,updated_at=? WHERE id=?",
      success ? "delivered" : terminal ? "failed" : "pending",
      epoch(),
      deliveryId,
    );
  }
  webhookDeliveries() {
    return rows(
      this.sql,
      "SELECT id,webhook_id,event_id,status,attempt_count,updated_at FROM webhook_deliveries ORDER BY created_at DESC LIMIT 100",
    );
  }
  outbox() {
    return rows<{ id: string; kind: string; payload_json: string }>(
      this.sql,
      "SELECT id,kind,payload_json FROM outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 50",
    );
  }
  markDispatched(outboxId: string) {
    this.sql.exec("UPDATE outbox SET dispatched_at=? WHERE id=?", epoch(), outboxId);
  }
  markDispatchedMany(ids: string[]) {
    this.sql.exec(
      "UPDATE outbox SET dispatched_at=? WHERE id IN (SELECT value FROM json_each(?))",
      epoch(),
      JSON.stringify(ids),
    );
  }
  async maintenance(retentionDays: number | null) {
    for (const stale of rows<{ id: string }>(
      this.sql,
      "SELECT id FROM submissions WHERE status='processing' AND lease_until<? LIMIT 100",
      epoch(),
    ))
      this.failure(stale.id, "unknown", "acceptance_unknown");
    if (retentionDays) {
      for (const message of rows<{ id: string }>(
        this.sql,
        "SELECT id FROM messages WHERE folder_id IN ('trash','spam') AND trashed_at IS NOT NULL AND trashed_at<? LIMIT 100",
        epoch() - retentionDays * 86400,
      )) {
        if (
          !row(
            this.sql,
            "SELECT id FROM submissions WHERE message_id=? AND status IN ('scheduled','queued','processing','retry_wait','unknown')",
            message.id,
          )
        )
          this.ctx.storage.transactionSync(() => this.erase(message.id));
      }
    }
    for (const item of rows<{ r2_key: string }>(
      this.sql,
      "SELECT r2_key FROM garbage WHERE delete_after<=? LIMIT 50",
      epoch(),
    )) {
      await this.env.MAIL_BUCKET.delete(item.r2_key);
      this.sql.exec("DELETE FROM garbage WHERE r2_key=?", item.r2_key);
    }
    this.sql.exec("DELETE FROM outbox WHERE dispatched_at<?", epoch() - 7 * 86400);
    this.sql.exec("DELETE FROM change_log WHERE created_at<?", epoch() - 30 * 86400);
    const identity = row<{ mailbox_id: string; partition_id: string }>(
      this.sql,
      "SELECT * FROM partition_identity WHERE id=1",
    )!;
    for (const pending of rows<{ id: string }>(
      this.sql,
      "SELECT id FROM submissions WHERE status IN ('queued','scheduled','retry_wait') AND scheduled_at<=? ORDER BY scheduled_at LIMIT 50",
      epoch(),
    ))
      await this.env.MAIL_QUEUE.send({
        kind: "send",
        ...identity,
        reference_id: pending.id,
      });
    for (const uncertain of rows<{ id: string }>(
      this.sql,
      "SELECT id FROM submissions WHERE status='unknown' ORDER BY coalesce(reconciled_at,0),id LIMIT 50",
    )) {
      if (
        await this.env.MAIL_BUCKET.head(
          "accepted/" + identity.mailbox_id + "/" + uncertain.id + ".json",
        )
      )
        await this.env.MAIL_QUEUE.send({
          kind: "send",
          ...identity,
          reference_id: uncertain.id,
        });
      this.sql.exec("UPDATE submissions SET reconciled_at=? WHERE id=?", epoch(), uncertain.id);
    }
    for (const pending of rows<{ id: string }>(
      this.sql,
      "SELECT id FROM webhook_deliveries WHERE status='pending' AND updated_at<? LIMIT 50",
      epoch() - 300,
    ))
      await this.env.MAIL_QUEUE.send({
        kind: "webhook",
        ...identity,
        reference_id: pending.id,
      });
    this.sql.exec("DELETE FROM processing_receipts WHERE created_at<?", epoch() - 30 * 86400);
    this.sql.exec("DELETE FROM provider_events WHERE created_at<?", epoch() - 90 * 86400);
    this.sql.exec(
      "DELETE FROM webhook_deliveries WHERE status<>'pending' AND updated_at<?",
      epoch() - 30 * 86400,
    );
    if (this.outbox().length) {
      await this.env.MAIL_QUEUE.send({
        kind: "outbox",
        ...identity,
        reference_id: "maintenance",
      });
    }
  }
}
