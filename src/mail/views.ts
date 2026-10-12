import { authorize } from "./control";
import { mailbox, partition } from "./mailbox";
import {
  fail,
  type MailActor,
  type MessageQuery,
  type ThreadRow,
} from "./types";

const newer = (
  a: Pick<ThreadRow, "received_at" | "id">,
  b: Pick<ThreadRow, "received_at" | "id">,
) => a.received_at - b.received_at || a.id.localeCompare(b.id);
async function mapPartitions<T, R>(
  entries: T[],
  task: (entry: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < entries.length; start += 4)
    results.push(
      ...(await Promise.all(entries.slice(start, start + 4).map(task))),
    );
  return results;
}
export async function queryThreads(
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
  const base = { ...query, actor_id: actor.user_id, exclude_drafts: true };
  const frontiers = new Map<
    string,
    { received_at: number; id: string } | undefined
  >();
  const exhausted = new Set<string>(),
    candidates = new Set<string>();
  let merged: ThreadRow[] = [];
  while (exhausted.size < targets.length) {
    const tail = merged[query.limit - 1];
    const pending = targets.filter(
      (entry) =>
        !exhausted.has(entry.id) &&
        (!tail ||
          !frontiers.get(entry.id) ||
          newer(frontiers.get(entry.id)!, tail) >= 0),
    );
    if (!pending.length) break;
    const pages = await mapPartitions(pending, async (entry) => ({
      id: entry.id,
      page: await partition(env, entry.id).threadPage({
        ...base,
        before: frontiers.get(entry.id) ?? query.before,
      }),
    }));
    const added: string[] = [];
    for (const { id, page } of pages) {
      if (page.length < query.limit) exhausted.add(id);
      if (page.length) frontiers.set(id, page.at(-1));
      for (const item of page)
        if (!candidates.has(item.thread_id)) {
          candidates.add(item.thread_id);
          added.push(item.thread_id);
        }
    }
    const summaries = new Map(merged.map((entry) => [entry.thread_id, entry]));
    // A conversation can span partitions. Aggregate each candidate across every target before sorting or applying the cursor.
    for (let start = 0; start < added.length; start += 100) {
      const chunk = added.slice(start, start + 100);
      const groups = await mapPartitions(targets, (entry) =>
        partition(env, entry.id).threadPage(
          { ...base, before: undefined },
          chunk,
        ),
      );
      for (const group of groups)
        for (const entry of group) {
          const old = summaries.get(entry.thread_id);
          if (!old) summaries.set(entry.thread_id, entry);
          else
            summaries.set(entry.thread_id, {
              ...(newer(entry, old) > 0 ? entry : old),
              message_count: old.message_count + entry.message_count,
              unread_count: old.unread_count + entry.unread_count,
              starred_count: old.starred_count + entry.starred_count,
              has_attachments: Math.max(
                old.has_attachments,
                entry.has_attachments,
              ),
              participants: [
                ...new Set(
                  [old.participants, entry.participants]
                    .flatMap((text) => (text ?? "").split(","))
                    .filter(Boolean),
                ),
              ].join(", "),
            });
        }
    }
    merged = [...summaries.values()]
      .filter((entry) => !query.before || newer(entry, query.before) < 0)
      .sort((a, b) => newer(b, a));
  }
  return {
    messages: merged
      .slice(0, query.limit)
      .map((entry) => ({
        ...entry,
        is_read: Number(entry.unread_count === 0),
        is_starred: Number(entry.starred_count > 0),
      })),
    partitions: targets.map((entry) => entry.id),
  };
}
export async function mailboxSummary(
  env: Env,
  actor: MailActor,
  mailboxId: string,
) {
  await authorize(env, actor, mailboxId, "read");
  const parts = await mailbox(env, mailboxId).partitions();
  const summaries = await mapPartitions(parts, (entry) =>
    partition(env, entry.id).summary(actor.user_id),
  );
  const folders: Record<string, { total: number; unread: number }> = {};
  let starred = 0,
    snoozed = 0,
    scheduled = 0,
    outbox = 0;
  for (const summary of summaries) {
    starred += summary.starred;
    snoozed += summary.snoozed;
    scheduled += summary.scheduled;
    outbox += summary.outbox;
    for (const item of summary.folders) {
      const old = folders[item.folder_id] ?? { total: 0, unread: 0 };
      folders[item.folder_id] = {
        total: old.total + item.total,
        unread: old.unread + item.unread,
      };
    }
  }
  return { folders, starred, snoozed, scheduled, outbox };
}
