import { partition, mailbox } from "./mailbox";
import { epoch } from "./types";

export interface MailFlowRecord {
  id: string;
  direction: string;
  provider: string | null;
  status: string;
  error_code: string | null;
  attempt_count: number;
  scheduled_at: number | null;
  created_at: number;
  updated_at: number;
  revision: number;
}
export async function publishMailFlow(
  env: Env,
  mailboxId: string | null,
  records: MailFlowRecord[],
) {
  for (let start = 0; start < records.length; start += 50)
    await env.DB.batch(
      records.slice(start, start + 50).map((record) =>
        env.DB.prepare(
          `INSERT INTO mail_admin_flow(id,mailbox_id,direction,provider,status,error_code,attempt_count,scheduled_at,created_at,updated_at,revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,error_code=excluded.error_code,attempt_count=excluded.attempt_count,scheduled_at=excluded.scheduled_at,updated_at=excluded.updated_at,revision=excluded.revision WHERE excluded.revision>=mail_admin_flow.revision`,
        ).bind(
          record.id,
          mailboxId,
          record.direction,
          record.provider,
          record.status,
          record.error_code,
          record.attempt_count,
          record.scheduled_at,
          record.created_at,
          record.updated_at,
          record.revision,
        ),
      ),
    );
}
export async function recordInboundFlow(
  env: Env,
  id: string,
  mailboxId: string | null,
  provider: string | null,
  status: string,
  errorCode: string | null = null,
) {
  await publishMailFlow(env, mailboxId, [
    {
      id: `inbound:${id}`,
      direction: "inbound",
      provider,
      status,
      error_code: errorCode,
      attempt_count: 0,
      scheduled_at: null,
      created_at: epoch(),
      updated_at: epoch(),
      revision: 0,
    },
  ]);
}
export async function refreshMailStorage(env: Env, mailboxId: string) {
  const entries = await mailbox(env, mailboxId).partitions();
  const summary = { message_count: 0, database_bytes: 0, attachment_bytes: 0 };
  for (let start = 0; start < entries.length; start += 4) {
    const records = await Promise.all(
      entries.slice(start, start + 4).map((entry) => partition(env, entry.id).adminStats()),
    );
    for (const record of records) {
      summary.message_count += record.message_count;
      summary.database_bytes += record.database_bytes;
      summary.attachment_bytes += record.attachment_bytes;
    }
  }
  const updatedAt = epoch();
  await env.DB.prepare(
    `INSERT INTO mail_admin_storage(mailbox_id,message_count,database_bytes,attachment_bytes,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(mailbox_id) DO UPDATE SET message_count=excluded.message_count,database_bytes=excluded.database_bytes,attachment_bytes=excluded.attachment_bytes,updated_at=excluded.updated_at WHERE excluded.updated_at>=mail_admin_storage.updated_at`,
  )
    .bind(
      mailboxId,
      summary.message_count,
      summary.database_bytes,
      summary.attachment_bytes,
      updatedAt,
    )
    .run();
  return { ...summary, updated_at: updatedAt };
}
