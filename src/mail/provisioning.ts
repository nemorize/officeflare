import { and, eq, exists, ne, notExists, sql, type SQL } from "drizzle-orm";
import type { AuthContext } from "../auth/types";
import { now, uuid } from "../auth/types";
import { conflict, invalid } from "../auth/input";
import { insertWhen } from "../db/conditional-insert";
import { mailAddresses, mailDomains, mailMailboxes, rolePermissions, userRoles } from "../db/schema";
import { all, first } from "./control";
import { hash, localPart } from "./input";
import { mailbox } from "./mailbox";
import type { Address, Mailbox } from "./types";

export async function mailOptions(c: AuthContext) {
  return { domains: await c.get("db").select({ id: mailDomains.id, name: mailDomains.name, is_default: mailDomains.is_default,
    inbound_enabled: mailDomains.inbound_enabled, outbound_enabled: mailDomains.outbound_enabled }).from(mailDomains).orderBy(mailDomains.name) };
}
export function mailRoleCondition(c: AuthContext, userId: string) {
  const db = c.get("db");
  return exists(db.select({ id: userRoles.user_id }).from(userRoles).innerJoin(rolePermissions, eq(rolePermissions.role_id, userRoles.role_id))
    .where(and(eq(userRoles.user_id, userId), eq(rolePermissions.permission_key, "mail.access"))));
}
export async function hasMailRole(c: AuthContext, userId: string) {
  return !!await c.get("db").select({ id: userRoles.user_id }).from(userRoles).where(and(eq(userRoles.user_id, userId), mailRoleCondition(c, userId))).limit(1).get();
}
export async function personalMail(env: Env, userId: string) {
  const box = await first<Mailbox>(env, "SELECT * FROM mail_mailboxes WHERE owner_user_id=? AND kind='personal' AND status<>'deleted' ORDER BY created_at,id LIMIT 1", userId);
  return { mailbox: box, addresses: box ? await all<Address & { email_address: string }>(env,
    "SELECT a.*,a.local_part||'@'||d.name email_address FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id WHERE a.mailbox_id=? ORDER BY a.is_primary DESC,a.created_at,a.id", box.id) : [] };
}
export async function personalMailDirectory(env: Env, userIds: string[]) {
  if (!userIds.length) return new Map<string, { mailbox: Mailbox | null; email_address: string | null; mail_enabled: boolean }>();
  const rows = await all<Mailbox & { email_address: string | null; mail_enabled: number; user_id: string; created_at: number; updated_at: number }>(env,
    "SELECT b.*,a.local_part||'@'||d.name email_address,EXISTS(SELECT 1 FROM user_roles r JOIN role_permissions p ON p.role_id=r.role_id WHERE r.user_id=u.id AND p.permission_key='mail.access') mail_enabled,u.id user_id " +
    "FROM users u LEFT JOIN mail_mailboxes b ON b.id=(SELECT id FROM mail_mailboxes WHERE owner_user_id=u.id AND kind='personal' AND status<>'deleted' ORDER BY created_at,id LIMIT 1) " +
    "LEFT JOIN mail_addresses a ON a.id=(SELECT id FROM mail_addresses WHERE mailbox_id=b.id ORDER BY is_primary DESC,created_at,id LIMIT 1) LEFT JOIN mail_domains d ON d.id=a.domain_id WHERE u.id IN(SELECT value FROM json_each(?))", JSON.stringify(userIds));
  return new Map(rows.map((row) => [row.user_id,
    { mailbox: row.id ? { id: row.id, name: row.name, kind: row.kind, status: row.status, owner_user_id: row.owner_user_id, created_at: row.created_at, updated_at: row.updated_at } : null, email_address: row.email_address, mail_enabled: !!row.mail_enabled }]));
}
export async function personalMailPlan(c: AuthContext, owner: { id: string; email_address: string; display_name: string | null }, input?: unknown) {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["domain_id", "local_part"].includes(key)))) invalid("Invalid mail address settings");
  const data = (input ?? {}) as { domain_id?: unknown; local_part?: unknown }, db = c.get("db"), { domains } = await mailOptions(c), existing = await personalMail(c.env, owner.id);
  const selected = "domain_id" in data ? domains.find((domain) => domain.id === data.domain_id) : domains.find((domain) => domain.name === owner.email_address.split("@")[1]) ?? domains.find((domain) => domain.is_default === 1);
  if (data.domain_id != null && !selected) invalid("Mail domain is unavailable");
  const digest = await hash("personal-mailbox:" + owner.id), id = existing.mailbox?.id ?? `${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;
  const box = { id, owner_user_id: owner.id, kind: "personal" as const, name: (owner.display_name || owner.email_address).slice(0, 100), status: "provisioning" as const };
  const local = selected ? localPart(data.local_part ?? owner.email_address.split("@")[0]) : null;
  const address = selected && local ? { id: uuid(), domain_id: selected.id, mailbox_id: id, local_part: local, is_primary: 1, receive_enabled: 1, send_enabled: 1 } : null;
  if (address && await db.select({ id: mailAddresses.id }).from(mailAddresses).where(and(eq(mailAddresses.domain_id, address.domain_id), eq(mailAddresses.local_part, local!), ne(mailAddresses.mailbox_id, id))).get()) conflict("This mail address is already assigned. Choose another address.");
  const guard = address ? and(exists(db.select({ id: mailDomains.id }).from(mailDomains).where(eq(mailDomains.id, address.domain_id))),
    notExists(db.select({ id: mailAddresses.id }).from(mailAddresses).where(and(eq(mailAddresses.domain_id, address.domain_id), eq(mailAddresses.local_part, local!), ne(mailAddresses.mailbox_id, id)))))! : sql`1`;
  return { box, address, existing, guard };
}
export function personalMailStatements(c: AuthContext, plan: Awaited<ReturnType<typeof personalMailPlan>>, won: SQL) {
  const db = c.get("db"), statements = [insertWhen(db, mailMailboxes, plan.box, won).onConflictDoNothing()];
  if (plan.address) {
    const address = plan.address;
    return [...statements,
      db.update(mailAddresses).set({ is_primary: 0 }).where(and(eq(mailAddresses.mailbox_id, plan.box.id), won)),
      insertWhen(db, mailAddresses, address, won).onConflictDoUpdate({ target: [mailAddresses.domain_id, mailAddresses.local_part], set: { is_primary: 1 }, setWhere: and(eq(mailAddresses.mailbox_id, plan.box.id), won) }),
    ];
  }
  return statements;
}
export async function finishMailboxProvisioning(env: Env, id: string) {
  const box = await first<Mailbox>(env, "SELECT * FROM mail_mailboxes WHERE id=? AND status='provisioning'", id);
  if (!box) return;
  await mailbox(env, id).initialize(id);
  await env.DB.prepare("UPDATE mail_mailboxes SET status='active',updated_at=? WHERE id=? AND status='provisioning' AND (kind='shared' OR EXISTS(SELECT 1 FROM users WHERE id=owner_user_id AND deleted_at IS NULL))").bind(now(), id).run();
}
export async function tryFinishMailbox(env: Env, id: string) {
  try { await finishMailboxProvisioning(env, id); }
  catch (error) { console.error("Mailbox provisioning will be retried", id, error instanceof Error ? error.message : "unknown"); }
}
export async function recoverMailboxProvisioning(env: Env) {
  for (const box of await all<Mailbox>(env, "SELECT * FROM mail_mailboxes WHERE status='provisioning' ORDER BY updated_at,id LIMIT 20")) {
    await tryFinishMailbox(env, box.id);
    await env.DB.prepare("UPDATE mail_mailboxes SET updated_at=? WHERE id=? AND status='provisioning'").bind(now(), box.id).run();
  }
}
