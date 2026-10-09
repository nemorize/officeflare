import { DurableObject } from "cloudflare:workers";
import schema from "./mailbox.sql";
import removeContacts from "./mailbox-v2.sql";
import { migrate } from "./migrations";
import { authorize } from "./control";
import { hash } from "./input";
import {
  epoch,
  fail,
  id,
  row,
  rows,
  type MailActor,
  type Partition,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type WorkTask,
} from "./types";
import type { MailPartitionDO } from "./partition";

export const mailbox = (env: Env, mailboxId: string) =>
  env.MAILBOX.getByName(mailboxId) as DurableObjectStub<MailboxDO>;
export const partition = (env: Env, partitionId: string) =>
  env.MAIL_PARTITION.getByName(
    partitionId,
  ) as DurableObjectStub<MailPartitionDO>;
const systems = [
  "inbox",
  "sent",
  "drafts",
  "archive",
  "spam",
  "trash",
] as const;
export class MailboxDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, [schema, removeContacts]);
    });
  }
  async initialize(mailboxId: string) {
    const existing = row<{ mailbox_id: string }>(
      this.sql,
      "SELECT mailbox_id FROM mailbox_settings WHERE id=1",
    );
    if (existing && existing.mailbox_id !== mailboxId)
      fail(409, "Mailbox identity mismatch");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT OR IGNORE INTO mailbox_settings(id,mailbox_id) VALUES(1,?)",
        mailboxId,
      );
      for (const system of systems)
        this.sql.exec(
          "INSERT OR IGNORE INTO folders(id,name,system_key) VALUES(?,?,?)",
          system,
          system,
          system,
        );
    });
    await this.allocate("initialize:" + mailboxId, 0);
    await this.resetAlarm();
  }
  private identity() {
    return (
      row<{ mailbox_id: string }>(
        this.sql,
        "SELECT mailbox_id FROM mailbox_settings WHERE id=1",
      )?.mailbox_id ?? fail(409, "Mailbox is not initialized")
    );
  }
  async allocate(
    operationId: string,
    reservedBytes = 64 * 1024 * 1024,
  ): Promise<string> {
    // Serialize the entire rollover protocol, including child initialization. No child calls back into this object.
    return this.ctx.blockConcurrencyWhile(async () => {
      const previous = row<{ partition_id: string }>(
        this.sql,
        "SELECT partition_id FROM allocations WHERE operation_id=?",
        operationId,
      );
      if (previous) return previous.partition_id;
      let active = row<Partition>(
        this.sql,
        "SELECT * FROM partitions WHERE status='active'",
      );
      if (active) {
        const size = await partition(this.env, active.id).size();
        this.sql.exec(
          "UPDATE partitions SET database_bytes=? WHERE id=?",
          size,
          active.id,
        );
        const configured = Number(this.env.MAIL_PARTITION_TARGET_BYTES);
        const target =
          Number.isSafeInteger(configured) &&
          configured > 0 &&
          configured < 9000000000
            ? configured
            : 6000000000;
        const reserved = row<{ n: number }>(
          this.sql,
          "SELECT coalesce(sum(reserved_bytes),0) n FROM allocations WHERE partition_id=? AND expires_at>?",
          active.id,
          epoch(),
        )!.n;
        if (size + reserved + reservedBytes >= target) active = null;
      }
      if (!active) {
        let next = row<Partition>(
          this.sql,
          "SELECT * FROM partitions WHERE status='preparing' ORDER BY ordinal LIMIT 1",
        );
        if (!next) {
          const ordinal = row<{ n: number }>(
            this.sql,
            "SELECT coalesce(max(ordinal),0)+1 n FROM partitions",
          )!.n;
          next = {
            id: id(),
            ordinal,
            status: "preparing",
            database_bytes: 0,
            created_at: epoch(),
          };
          this.sql.exec(
            "INSERT INTO partitions(id,ordinal,status,created_at) VALUES(?,?,'preparing',?)",
            next.id,
            next.ordinal,
            next.created_at,
          );
        }
        await partition(this.env, next.id).initialize(this.identity(), next.id);
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            "UPDATE partitions SET status='closed' WHERE status='active'",
          );
          this.sql.exec(
            "UPDATE partitions SET status='active' WHERE id=?",
            next!.id,
          );
        });
        active = next;
      }
      this.sql.exec(
        "INSERT INTO allocations VALUES(?,?,?,?)",
        operationId,
        active.id,
        epoch() + 7 * 86400,
        reservedBytes,
      );
      return active.id;
    });
  }
  completeAllocation(operationId: string) {
    this.sql.exec(
      "UPDATE allocations SET reserved_bytes=0 WHERE operation_id=?",
      operationId,
    );
  }
  registerRequest(
    operationId: string,
    requestHash: string,
    resourceId: string,
  ) {
    const previous = row<{ request_hash: string; resource_id: string }>(
      this.sql,
      "SELECT * FROM request_keys WHERE operation_id=?",
      operationId,
    );
    if (previous) {
      if (previous.request_hash !== requestHash)
        fail(409, "Idempotency key reused with different request");
      return previous.resource_id;
    }
    this.sql.exec(
      "INSERT INTO request_keys VALUES(?,?,?,?)",
      operationId,
      requestHash,
      resourceId,
      epoch() + 7 * 86400,
    );
    return resourceId;
  }
  async storeDraft(
    partitionId: string,
    input: import("./types").MessageInput,
    operationId: string,
    requestHash: string,
  ) {
    return this.ctx.blockConcurrencyWhile(async () =>
      partition(this.env, partitionId).createDraft(
        input,
        operationId,
        requestHash,
      ),
    );
  }
  async storeMessage(
    partitionId: string,
    input: import("./types").MessageInput,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.hasFolder(input.folder_id))
        fail(409, "Folder no longer exists");
      return partition(this.env, partitionId).insert(input);
    });
  }
  async changeMessage(
    partitionId: string,
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
  ): Promise<import("./types").MessageRow> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (changes.folder_id && !this.hasFolder(changes.folder_id))
        fail(404, "Folder not found");
      return partition(this.env, partitionId).patch(
        messageId,
        actorId,
        version,
        changes,
      );
    });
  }
  partitions() {
    return rows<Partition>(
      this.sql,
      "SELECT * FROM partitions WHERE status<>'preparing' ORDER BY ordinal",
    );
  }
  folders() {
    return rows<{
      id: string;
      name: string;
      system_key: string | null;
      version: number;
    }>(this.sql, "SELECT * FROM folders ORDER BY system_key IS NULL,name");
  }
  hasFolder(folderId: string) {
    return !!row(this.sql, "SELECT id FROM folders WHERE id=?", folderId);
  }
  putFolder(folderId: string, name: string, version?: number) {
    const existing = row<{ system_key: string | null; version: number }>(
      this.sql,
      "SELECT * FROM folders WHERE id=?",
      folderId,
    );
    if (existing?.system_key) fail(409, "System folders cannot be renamed");
    if (existing && existing.version !== version)
      fail(409, "Folder version changed");
    if (
      row(
        this.sql,
        "SELECT id FROM folders WHERE lower(name)=lower(?) AND id<>?",
        name,
        folderId,
      )
    )
      fail(409, "Folder name is already used");
    if (existing)
      this.sql.exec(
        "UPDATE folders SET name=?,version=version+1 WHERE id=?",
        name,
        folderId,
      );
    else
      this.sql.exec("INSERT INTO folders(id,name) VALUES(?,?)", folderId, name);
    return row(this.sql, "SELECT * FROM folders WHERE id=?", folderId);
  }
  async deleteFolder(folderId: string, version: number) {
    return this.ctx.blockConcurrencyWhile(async () =>
      this.removeFolder(folderId, version),
    );
  }
  private async removeFolder(folderId: string, version: number) {
    const existing = row<{ system_key: string | null; version: number }>(
      this.sql,
      "SELECT * FROM folders WHERE id=?",
      folderId,
    );
    if (!existing) fail(404, "Folder not found");
    if (existing.system_key || existing.version !== version)
      fail(409, "Folder cannot be deleted or version changed");
    for (const entry of this.partitions())
      if (await partition(this.env, entry.id).folderCount(folderId))
        fail(409, "Folder is not empty");
    // Recheck after child calls; keep folder routing changes serialized with new writes via the caller.
    this.sql.exec(
      "DELETE FROM folders WHERE id=? AND version=?",
      folderId,
      version,
    );
  }
  settings() {
    return row<Record<string, string | number | null>>(
      this.sql,
      "SELECT * FROM mailbox_settings WHERE id=1",
    )!;
  }
  updateSettings(data: Record<string, string | number | null>) {
    const allowed = [
      "signature",
      "retention_days",
      "auto_reply_enabled",
      "auto_reply_subject",
      "auto_reply_text",
    ];
    const keys = Object.keys(data);
    if (keys.some((key) => !allowed.includes(key)) || !keys.length)
      fail(400, "Invalid settings");
    this.sql.exec(
      "UPDATE mailbox_settings SET " +
        keys.map((key) => key + "=?").join(",") +
        " WHERE id=1",
      ...keys.map((key) => data[key]!),
    );
    return this.settings();
  }
  blockedSenders() {
    return rows<{ email_address: string }>(
      this.sql,
      "SELECT * FROM blocked_senders ORDER BY email_address LIMIT 1000",
    );
  }
  blockSender(address: string, blocked: boolean) {
    if (blocked)
      this.sql.exec("INSERT OR IGNORE INTO blocked_senders VALUES(?)", address);
    else
      this.sql.exec(
        "DELETE FROM blocked_senders WHERE email_address=?",
        address,
      );
  }
  templates() {
    return rows(this.sql, "SELECT * FROM templates ORDER BY name LIMIT 1000");
  }
  putTemplate(value: {
    id: string;
    name: string;
    subject: string;
    text_body: string;
  }) {
    this.sql.exec(
      "INSERT INTO templates VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,subject=excluded.subject,text_body=excluded.text_body",
      value.id,
      value.name,
      value.subject,
      value.text_body,
    );
    return row(this.sql, "SELECT * FROM templates WHERE id=?", value.id);
  }
  deleteTemplate(templateId: string) {
    this.sql.exec("DELETE FROM templates WHERE id=?", templateId);
  }
  rules() {
    return rows<Rule>(
      this.sql,
      "SELECT * FROM rules ORDER BY priority DESC,id LIMIT 100",
    );
  }
  putRule(value: Rule) {
    const existing = row<Rule>(
      this.sql,
      "SELECT * FROM rules WHERE id=?",
      value.id,
    );
    if (existing && value.version !== existing.version)
      fail(409, "Rule version changed");
    if (!existing && this.rules().length >= 100)
      fail(409, "Rule limit reached");
    this.sql.exec(
      "INSERT INTO rules VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,priority=excluded.priority,enabled=excluded.enabled,conditions_json=excluded.conditions_json,actions_json=excluded.actions_json,version=rules.version+1",
      value.id,
      value.name,
      value.priority,
      value.enabled,
      value.conditions_json,
      value.actions_json,
    );
    return row<Rule>(this.sql, "SELECT * FROM rules WHERE id=?", value.id)!;
  }
  deleteRule(ruleId: string) {
    this.sql.exec("DELETE FROM rules WHERE id=?", ruleId);
  }
  evaluate(input: { from: string; to: string; subject: string; body: string }) {
    const result = {
      folder_id: "inbox",
      is_spam: false,
      is_read: false,
      is_starred: false,
      matched_rules: [] as string[],
    };
    if (
      row(
        this.sql,
        "SELECT email_address FROM blocked_senders WHERE email_address=?",
        input.from,
      )
    ) {
      result.folder_id = "spam";
      result.is_spam = true;
    }
    for (const rule of this.rules()) {
      if (!rule.enabled) continue;
      const conditions = JSON.parse(rule.conditions_json) as RuleCondition[];
      if (
        !conditions.every((condition) => {
          const source = input[condition.field].toLowerCase(),
            value = condition.value.toLowerCase();
          return condition.operator === "contains"
            ? source.includes(value)
            : condition.operator === "equals"
              ? source === value
              : condition.operator === "prefix"
                ? source.startsWith(value)
                : source.endsWith(value);
        })
      )
        continue;
      result.matched_rules.push(rule.id);
      for (const action of JSON.parse(rule.actions_json) as RuleAction[]) {
        if (
          action.type === "move" &&
          action.folder_id &&
          this.hasFolder(action.folder_id)
        )
          result.folder_id = action.folder_id;
        if (action.type === "spam") {
          result.folder_id = "spam";
          result.is_spam = true;
        }
        if (action.type === "read") result.is_read = true;
        if (action.type === "star") result.is_starred = true;
      }
    }
    return result;
  }
  claimAutoReply(sender: string) {
    const previous = row<{ replied_at: number }>(
      this.sql,
      "SELECT replied_at FROM auto_reply_receipts WHERE sender=?",
      sender,
    );
    if (previous && previous.replied_at > epoch() - 86400) return false;
    this.sql.exec(
      "INSERT INTO auto_reply_receipts VALUES(?,?) ON CONFLICT(sender) DO UPDATE SET replied_at=excluded.replied_at",
      sender,
      epoch(),
    );
    return true;
  }
  async schedule(task: {
    id: string;
    partition_id: string;
    kind: string;
    reference_id: string;
    due_at: number;
  }) {
    this.sql.exec(
      "INSERT INTO scheduled_tasks(id,partition_id,kind,reference_id,due_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET due_at=excluded.due_at,dispatched_at=NULL",
      task.id,
      task.partition_id,
      task.kind,
      task.reference_id,
      task.due_at,
    );
    await this.resetAlarm();
  }
  private async resetAlarm() {
    const next = row<{ due_at: number | null }>(
      this.sql,
      "SELECT min(due_at) due_at FROM scheduled_tasks WHERE dispatched_at IS NULL",
    )?.due_at;
    const dataPending = !!row(
      this.sql,
      "SELECT id FROM data_jobs WHERE status IN ('queued','processing') LIMIT 1",
    );
    await this.ctx.storage.setAlarm(
      Math.max(
        Date.now() + 1000,
        Math.min(
          (next ?? epoch() + 3600) * 1000,
          Date.now() + (dataPending ? 300000 : 3600000),
        ),
      ),
    );
  }
  async alarm() {
    const mailboxId = this.identity();
    for (const task of rows<{
      id: string;
      partition_id: string;
      kind: WorkTask["kind"];
      reference_id: string;
    }>(
      this.sql,
      "SELECT * FROM scheduled_tasks WHERE dispatched_at IS NULL AND due_at<=? LIMIT 100",
      epoch(),
    )) {
      await this.env.MAIL_QUEUE.send({
        kind: task.kind,
        mailbox_id: mailboxId,
        partition_id: task.partition_id,
        reference_id: task.reference_id,
      } satisfies WorkTask);
      this.sql.exec(
        "UPDATE scheduled_tasks SET dispatched_at=? WHERE id=?",
        epoch(),
        task.id,
      );
    }
    for (const job of rows<{ id: string }>(
      this.sql,
      "SELECT id FROM data_jobs WHERE status='queued' OR (status='processing' AND updated_at<?) LIMIT 50",
      epoch() - 300,
    ))
      await this.env.MAIL_QUEUE.send({
        kind: "data_job",
        mailbox_id: mailboxId,
        reference_id: job.id,
      });
    for (const entry of this.partitions())
      await partition(this.env, entry.id).maintenance(
        Number(this.settings().retention_days) || null,
      );
    this.sql.exec("DELETE FROM allocations WHERE expires_at<?", epoch());
    this.sql.exec("DELETE FROM request_keys WHERE expires_at<?", epoch());
    this.sql.exec(
      "DELETE FROM recent_provider_messages WHERE expires_at<?",
      epoch(),
    );
    this.sql.exec("DELETE FROM websocket_tickets WHERE expires_at<?", epoch());
    this.sql.exec(
      "DELETE FROM auto_reply_receipts WHERE replied_at<?",
      epoch() - 86400,
    );
    this.sql.exec(
      "DELETE FROM scheduled_tasks WHERE dispatched_at<?",
      epoch() - 7 * 86400,
    );
    this.sql.exec(
      "DELETE FROM events WHERE created_at<? OR sequence<(SELECT coalesce(max(sequence),0)-1000 FROM events)",
      epoch() - 7 * 86400,
    );
    this.sql.exec(
      "DELETE FROM audit_events WHERE created_at<? OR sequence<(SELECT coalesce(max(sequence),0)-10000 FROM audit_events)",
      epoch() - 30 * 86400,
    );
    await this.resetAlarm();
  }
  rememberProvider(
    provider: string,
    connectionId: string,
    providerMessageId: string,
    partitionId: string,
    submissionId: string,
  ) {
    this.sql.exec(
      "INSERT OR REPLACE INTO recent_provider_messages VALUES(?,?,?,?,?,?)",
      provider,
      connectionId,
      providerMessageId,
      partitionId,
      submissionId,
      epoch() + 30 * 86400,
    );
  }
  providerMessage(
    provider: string,
    connectionId: string,
    providerMessageId: string,
  ) {
    return row<{ partition_id: string; submission_id: string }>(
      this.sql,
      "SELECT partition_id,submission_id FROM recent_provider_messages WHERE provider=? AND connection_id=? AND provider_message_id=?",
      provider,
      connectionId,
      providerMessageId,
    );
  }
  async createDataJob(value: {
    id: string;
    actor_json: string;
    kind: string;
    source_r2_key: string | null;
    output_prefix: string;
    cursor_json?: string;
  }) {
    this.sql.exec(
      "INSERT INTO data_jobs(id,actor_json,kind,status,source_r2_key,output_prefix,cursor_json,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?)",
      value.id,
      value.actor_json,
      value.kind,
      value.source_r2_key,
      value.output_prefix,
      value.cursor_json ?? "{}",
      epoch(),
      epoch(),
    );
    await this.resetAlarm();
  }
  dataJob(jobId: string) {
    return (
      row<{
        id: string;
        actor_json: string;
        kind: string;
        status: string;
        source_r2_key: string | null;
        output_prefix: string;
        progress: number;
        cursor_json: string;
        error_code: string | null;
      }>(this.sql, "SELECT * FROM data_jobs WHERE id=?", jobId) ??
      fail(404, "Job not found")
    );
  }
  claimDataJob(jobId: string) {
    const job = this.dataJob(jobId);
    if (
      ["completed", "failed"].includes(job.status) ||
      (job.status === "processing" &&
        row<{ updated_at: number }>(
          this.sql,
          "SELECT updated_at FROM data_jobs WHERE id=?",
          jobId,
        )!.updated_at >
          epoch() - 300)
    )
      return null;
    this.sql.exec(
      "UPDATE data_jobs SET status='processing',error_code=NULL,updated_at=? WHERE id=?",
      epoch(),
      jobId,
    );
    return job;
  }
  advanceDataJob(
    jobId: string,
    progress: number,
    cursor: string,
    completed: boolean,
  ) {
    this.sql.exec(
      "UPDATE data_jobs SET status=?,progress=?,cursor_json=?,updated_at=? WHERE id=?",
      completed ? "completed" : "queued",
      progress,
      cursor,
      epoch(),
      jobId,
    );
  }
  retryDataJob(jobId: string, actor: MailActor) {
    if (this.dataJob(jobId).status !== "failed")
      fail(409, "Only failed jobs may be retried");
    this.sql.exec(
      "UPDATE data_jobs SET status='queued',actor_json=?,error_code=NULL,updated_at=? WHERE id=?",
      JSON.stringify(actor),
      epoch(),
      jobId,
    );
  }
  dataJobs(actorId: string) {
    return rows(
      this.sql,
      "SELECT id,kind,status,progress,error_code,created_at,updated_at FROM data_jobs WHERE json_extract(actor_json,'$.user_id')=? ORDER BY created_at DESC LIMIT 100",
      actorId,
    );
  }
  failDataJob(jobId: string, error: string) {
    this.sql.exec(
      "UPDATE data_jobs SET status='failed',error_code=?,updated_at=? WHERE id=?",
      error.slice(0, 200),
      epoch(),
      jobId,
    );
  }
  audit(actorId: string, operation: string, path: string) {
    this.sql.exec(
      "INSERT INTO audit_events(actor_id,operation,resource_path,created_at) VALUES(?,?,?,?)",
      actorId,
      operation,
      path,
      epoch(),
    );
  }
  auditLog(before: number) {
    return rows(
      this.sql,
      "SELECT * FROM audit_events WHERE sequence<? ORDER BY sequence DESC LIMIT 100",
      before,
    );
  }
  async ticket(actor: MailActor) {
    const token = id() + id();
    this.sql.exec(
      "INSERT INTO websocket_tickets VALUES(?,?,?)",
      await hash(token),
      JSON.stringify(actor),
      epoch() + 60,
    );
    return token;
  }
  async fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 400 });
    return this.openEvents(
      new URL(request.url).searchParams.get("ticket") ?? "",
    );
  }
  private async openEvents(token: string) {
    const hashed = await hash(token);
    const ticket = row<{ actor_json: string }>(
      this.sql,
      "DELETE FROM websocket_tickets WHERE token_hash=? AND expires_at>? RETURNING actor_json",
      hashed,
      epoch(),
    );
    if (!ticket) return new Response("Invalid event ticket", { status: 401 });
    const actor = JSON.parse(ticket.actor_json) as MailActor;
    await authorize(this.env, actor, this.identity(), "read");
    const sockets = new WebSocketPair();
    this.ctx.acceptWebSocket(sockets[1]);
    sockets[1].serializeAttachment(actor);
    return new Response(null, { status: 101, webSocket: sockets[0] });
  }
  async emit(message: {
    message_id: string;
    operation: string;
    private_user_id?: string | null;
  }) {
    const payload = {
      mailbox_id: this.identity(),
      message_id: message.message_id,
      operation: message.operation,
    };
    const event = row<{ sequence: number }>(
      this.sql,
      "INSERT INTO events(payload_json,private_user_id,created_at) VALUES(?,?,?) RETURNING sequence",
      JSON.stringify(payload),
      message.private_user_id ?? null,
      epoch(),
    )!;
    for (const socket of this.ctx.getWebSockets()) {
      const actor = socket.deserializeAttachment() as MailActor;
      if (message.private_user_id && message.private_user_id !== actor.user_id)
        continue;
      try {
        await authorize(this.env, actor, this.identity(), "read");
        socket.send(JSON.stringify({ ...payload, sequence: event.sequence }));
      } catch {
        socket.close(1008, "Access revoked");
      }
    }
  }
  async webSocketMessage(socket: WebSocket) {
    try {
      await authorize(
        this.env,
        socket.deserializeAttachment() as MailActor,
        this.identity(),
        "read",
      );
      socket.send('{"type":"pong"}');
    } catch {
      socket.close(1008, "Access revoked");
    }
  }
}
