import type { Context } from "hono";
import type { AuthContext } from "../auth/types";
import { createMiddleware } from "hono/factory";
import { requireAccess } from "../auth/store";
import { can } from "../authorization/access";
import { permissionClosure, type Permission } from "../authorization/permissions";
import {
  epoch,
  fail,
  type MailActor,
  type MailAppEnv,
  type MailAction,
  type Mailbox,
  type Domain,
  type Connection,
} from "./types";
import { hash } from "./input";

export const control = (env: Env) => env.DB.withSession("first-primary");
export async function first<T>(
  env: Env,
  sql: string,
  ...args: (string | number | null)[]
) {
  return control(env)
    .prepare(sql)
    .bind(...args)
    .first<T>();
}
export async function all<T>(
  env: Env,
  sql: string,
  ...args: (string | number | null)[]
) {
  return (
    await control(env)
      .prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}
export const activeAccountSql =
  "u.deleted_at IS NULL AND u.disabled_at IS NULL AND u.password_hash IS NOT NULL AND u.password_reset_required=0";
export const mailAccessSql = "EXISTS(SELECT 1 FROM user_roles access_roles JOIN role_permissions access_permissions ON access_permissions.role_id=access_roles.role_id WHERE access_roles.user_id=u.id AND access_permissions.permission_key='mail.access')";
function administrativeRequest(c: Context<MailAppEnv>) {
  const path = c.req.path.replace(/^\/api\/mail/, ""), method = c.req.method;
  return /^\/(provider-connections|domains|addresses)(\/|$)/.test(path) ||
    path === "/mailboxes" && (method === "POST" || c.req.query("all") === "true") ||
    /^\/mailboxes\/[^/]+$/.test(path) && method === "PATCH";
}
export const authenticateMail = createMiddleware<MailAppEnv>(
  async (c, next) => {
    const token = /^Bearer (.+)$/i.exec(
      c.req.header("authorization") ?? "",
    )?.[1];
    if (token?.startsWith("ofm_")) {
      const actor = await first<MailActor>(
        c.env,
        "SELECT u.id user_id,u.auth_version,k.id api_key_id FROM mail_api_keys k JOIN users u ON u.id=k.user_id WHERE k.token_hash=? AND k.revoked_at IS NULL AND k.expires_at>? AND k.auth_version=u.auth_version AND " +
          activeAccountSql + " AND " + mailAccessSql,
        await hash(token),
        epoch(),
      );
      if (!actor) fail(401, "Invalid mail API key");
      c.set("mail_actor", actor);
      await next();
    } else {
      await requireAccess(c as unknown as AuthContext, async () => {
        const { user } = c.get("identity");
        c.set("mail_actor", {
          user_id: user.id,
          auth_version: user.auth_version,
          api_key_id: null,
        });
        // Console administration is separate from using mailbox contents.
        if (!administrativeRequest(c) && !await can(c as unknown as AuthContext, "mail.access")) fail(403, "Mail access is not enabled for this account");
        await next();
      });
    }
  },
);
export async function administrator(
  c: Context<MailAppEnv>,
  permission: Permission,
) {
  if (
    c.get("mail_actor").api_key_id ||
    !(await can(c as unknown as AuthContext, permission))
  )
    fail(403, "Permission denied");
}
const columns = {
  read: "can_read",
  write: "can_write",
  send_as: "can_send_as",
  send_on_behalf: "can_send_on_behalf",
  manage: "can_manage",
} as const;
export async function authorize(
  env: Env,
  actor: MailActor,
  mailboxId: string,
  action: MailAction,
): Promise<Mailbox> {
  const mailbox = await first<Mailbox>(
    env,
    "SELECT b.* FROM mail_mailboxes b JOIN users u ON u.id=? LEFT JOIN mail_mailbox_members m ON m.mailbox_id=b.id AND m.user_id=u.id " +
      "WHERE b.id=? AND b.status='active' AND u.auth_version=? AND " +
      activeAccountSql +
      " AND " + mailAccessSql +
      " AND (b.owner_user_id=u.id OR m." +
      columns[action] +
      "=1)" +
      (actor.api_key_id
        ? " AND EXISTS(SELECT 1 FROM mail_api_keys k JOIN mail_api_key_scopes s ON s.key_id=k.id WHERE k.id=? AND k.user_id=u.id AND k.revoked_at IS NULL AND k.expires_at>? AND k.auth_version=u.auth_version AND s.mailbox_id=b.id AND s.action=?)"
        : ""),
    actor.user_id,
    mailboxId,
    actor.auth_version,
    ...(actor.api_key_id ? [actor.api_key_id, epoch(), action] : []),
  );
  if (!mailbox) fail(403, "Mailbox access denied");
  return mailbox;
}
export async function connection(env: Env, connectionId: string) {
  const result = await first<Connection>(
    env,
    "SELECT * FROM mail_provider_connections WHERE id=? AND enabled=1",
    connectionId,
  );
  if (!result) fail(409, "Provider connection is disabled or missing");
  if (result.provider !== "cloudflare")
    fail(422, "Unsupported provider: " + result.provider);
  return result;
}
export async function resolveRecipient(env: Env, destination: string) {
  const at = destination.lastIndexOf("@"),
    local = destination.slice(0, at).toLowerCase(),
    name = destination.slice(at + 1).toLowerCase();
  const domain = await first<Domain>(
    env,
    "SELECT * FROM mail_domains WHERE name=? AND inbound_enabled=1",
    name,
  );
  if (!domain?.inbound_connection_id) return null;
  const provider = await connection(env, domain.inbound_connection_id);
  const exact = await first<{ mailbox_id: string }>(
    env,
    "SELECT a.mailbox_id FROM mail_addresses a JOIN mail_mailboxes b ON b.id=a.mailbox_id WHERE a.domain_id=? AND a.receive_enabled=1 AND b.status='active' AND a.local_part=?",
    domain.id,
    local,
  );
  const plus =
    !exact && domain.plus_addressing && local.includes("+")
      ? await first<{ mailbox_id: string }>(
          env,
          "SELECT a.mailbox_id FROM mail_addresses a JOIN mail_mailboxes b ON b.id=a.mailbox_id WHERE a.domain_id=? AND a.receive_enabled=1 AND b.status='active' AND a.local_part=?",
          domain.id,
          local.split("+")[0]!,
        )
      : null;
  const mailboxId =
    exact?.mailbox_id ?? plus?.mailbox_id ?? domain.catch_all_mailbox_id;
  if (
    !mailboxId ||
    !(await first(
      env,
      "SELECT id FROM mail_mailboxes WHERE id=? AND status='active'",
      mailboxId,
    ))
  )
    return null;
  return {
    mailbox_id: mailboxId,
    provider: provider.provider,
    connection_id: provider.id,
  };
}
export async function sender(
  env: Env,
  actor: MailActor,
  mailboxId: string,
  addressId: string,
  mode: "send_as" | "send_on_behalf",
) {
  await authorize(env, actor, mailboxId, mode);
  const result = await first<{ email_address: string; connection_id: string }>(
    env,
    "SELECT a.local_part||'@'||d.name email_address,d.outbound_connection_id connection_id FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id WHERE a.id=? AND a.mailbox_id=? AND a.send_enabled=1 AND d.outbound_enabled=1",
    addressId,
    mailboxId,
  );
  if (!result?.connection_id)
    fail(409, "Sending address or domain is disabled");
  return { ...result, ...(await connection(env, result.connection_id)) };
}

// Keep D1 permission checks in the same statement as D1 mutations. DO/R2 work uses
// revalidation and durable operation records because there is no cross-store transaction.
export function administrativeControl(
  c: Context<MailAppEnv>,
  permission: Permission,
) {
  const actor = c.get("mail_actor");
  if (actor.api_key_id) fail(403, "Session authentication required");
  const condition = "EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.auth_version=? AND " + activeAccountSql +
    " AND NOT EXISTS(SELECT 1 FROM json_each(?) required_permission WHERE NOT EXISTS(SELECT 1 FROM user_roles r JOIN role_permissions p ON p.role_id=r.role_id WHERE r.user_id=u.id AND p.permission_key=required_permission.value)))";
  return guardedControl(c.env, condition, [
    actor.user_id,
    actor.auth_version,
    JSON.stringify(permissionClosure([permission])),
  ]);
}
export function resourceControl(
  c: Context<MailAppEnv>,
  mailboxId: string,
  action: MailAction,
) {
  const actor = c.get("mail_actor");
  if (actor.api_key_id) fail(403, "Session authentication required");
  const condition =
    "EXISTS(SELECT 1 FROM mail_mailboxes b JOIN users u ON u.id=? LEFT JOIN mail_mailbox_members m ON m.mailbox_id=b.id AND m.user_id=u.id WHERE b.id=? AND b.status='active' AND u.auth_version=? AND " +
    activeAccountSql +
    " AND " + mailAccessSql +
    " AND (b.owner_user_id=u.id OR m." +
    columns[action] +
    "=1))";
  return guardedControl(c.env, condition, [
    actor.user_id,
    mailboxId,
    actor.auth_version,
  ]);
}
function guardedControl(
  env: Env,
  condition: string,
  guardBindings: (string | number)[],
) {
  const session = control(env);
  return {
    prepare(query: string) {
      const values = /\bVALUES\s*\(([^)]*)\)(.*)$/s.exec(query);
      const guarded = values
        ? query.slice(0, values.index) +
          "SELECT " +
          values[1] +
          " WHERE " +
          condition +
          values[2]
        : query + " AND " + condition;
      return {
        bind(...bindings: unknown[]) {
          return session.prepare(guarded).bind(...bindings, ...guardBindings);
        },
      };
    },
    batch(statements: D1PreparedStatement[]) {
      return session.batch(statements);
    },
  };
}
