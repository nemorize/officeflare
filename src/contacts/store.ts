import { t } from "../../shared/i18n/index.ts";
import { now, uuid } from "../auth/types";
import { digest } from "../auth/crypto";
import { permissionClosure, type Permission } from "../authorization/permissions";
import { fail, identifier, text } from "./input";
import {
  detailTables,
  type Bind,
  type Book,
  type Condition,
  type Contact,
  type ContactContext,
  type ContactDetail,
  type ContactEnv,
  type DetailRow,
  type Folder,
} from "./types";

export const statement = (env: ContactEnv, sql: string, ...args: Bind[]) =>
  env.DB.withSession("first-primary")
    .prepare(sql)
    .bind(...args);
export const first = <T>(env: ContactEnv, sql: string, ...args: Bind[]) =>
  statement(env, sql, ...args).first<T>();
export const rows = async <T>(env: ContactEnv, sql: string, ...args: Bind[]) =>
  (await statement(env, sql, ...args).all<T>()).results;
export const condition = (sql: string, ...args: Bind[]): Condition => ({ sql, args });
const combine = (...checks: Condition[]): Condition => ({
  sql: checks.map((check) => `(${check.sql})`).join(" AND ") || "1",
  args: checks.flatMap((check) => check.args),
});

export function identity(c: ContactContext, action: Permission = "contacts.access"): Condition {
  const { user, session } = c.get("identity");
  return condition(
    `EXISTS(SELECT 1 FROM user_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND u.id=? AND s.auth_version=? AND s.auth_version=u.auth_version
    AND s.revoked_at IS NULL AND s.expires_at>? AND u.disabled_at IS NULL AND u.deleted_at IS NULL
    AND u.password_hash IS NOT NULL AND u.password_reset_required=0
    AND (s.mfa_authenticated_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM user_mfa_methods m WHERE m.user_id=u.id AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL)))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) required WHERE NOT EXISTS(
      SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=? AND rp.permission_key=required.value))`,
    session.id,
    user.id,
    user.auth_version,
    now(),
    JSON.stringify(permissionClosure([action])),
    user.id,
  );
}
export function owned(c: ContactContext, book: string) {
  return condition(
    "EXISTS(SELECT 1 FROM contact_books WHERE id=? AND owner_user_id=?)",
    book,
    c.get("identity").user.id,
  );
}
export async function book(c: ContactContext, requested?: unknown): Promise<Book> {
  const user = c.get("identity").user.id;
  let value = await first<Book>(c.env, "SELECT * FROM contact_books WHERE owner_user_id=?", user);
  if (!value) {
    const auth = identity(c);
    await statement(
      c.env,
      `INSERT INTO contact_books(id,owner_user_id) SELECT ?,? WHERE ${auth.sql} ON CONFLICT(owner_user_id) DO NOTHING`,
      uuid(),
      user,
      ...auth.args,
    ).run();
    value = await first<Book>(c.env, "SELECT * FROM contact_books WHERE owner_user_id=?", user);
  }
  if (!value) fail(403, "PERMISSION_DENIED", t("contacts.denied"));
  if (requested !== undefined && identifier(requested, "book_id") !== value.id)
    fail(404, "BOOK_NOT_FOUND", t("contacts.notFound"));
  return value;
}
export async function folder(c: ContactContext, bookId: string, id: unknown): Promise<Folder> {
  const value = await first<Folder>(
    c.env,
    "SELECT * FROM contact_folders WHERE id=? AND book_id=?",
    identifier(id),
    bookId,
  );
  if (!value) fail(404, "FOLDER_NOT_FOUND", t("contacts.notFound"));
  return value;
}
export async function contact(c: ContactContext, id: unknown, trash = false): Promise<Contact> {
  const value = await first<Contact>(
    c.env,
    `SELECT p.* FROM contacts p JOIN contact_books b ON b.id=p.book_id WHERE p.id=? AND b.owner_user_id=? AND p.trashed_at IS ${trash ? "NOT " : ""}NULL`,
    identifier(id),
    c.get("identity").user.id,
  );
  if (!value) fail(404, "CONTACT_NOT_FOUND", t("contacts.notFound"));
  return value;
}
export async function detail(c: ContactContext, value: Contact): Promise<ContactDetail> {
  // Read the aggregate in one transaction so its version and child rows agree.
  const [parent, emails, phones, addresses, links, custom] = await c.env.DB.withSession(
    "first-primary",
  ).batch([
    statement(
      c.env,
      `SELECT * FROM contacts WHERE id=? AND book_id=? AND trashed_at IS ${value.trashed_at === null ? "" : "NOT "}NULL`,
      value.id,
      value.book_id,
    ),
    ...Object.values(detailTables).map((table) =>
      statement(
        c.env,
        `SELECT * FROM ${table} WHERE contact_id=? ORDER BY sort_order,id`,
        value.id,
      ),
    ),
    statement(
      c.env,
      "SELECT field_id,value_json FROM contact_field_values WHERE contact_id=? ORDER BY field_id",
      value.id,
    ),
  ]);
  if (!parent!.results[0]) fail(404, "CONTACT_NOT_FOUND", t("contacts.notFound"));
  return {
    ...(parent!.results[0] as unknown as Contact),
    emails: emails!.results as DetailRow[],
    phones: phones!.results as DetailRow[],
    addresses: addresses!.results as DetailRow[],
    links: links!.results as DetailRow[],
    custom_fields: (custom!.results as { field_id: string; value_json: string }[]).map((row) => ({
      field_id: row.field_id,
      value: JSON.parse(row.value_json) as unknown,
    })),
  };
}
export function dto(value: ContactDetail) {
  const { display_name_key, organization_key, ...result } = value;
  return {
    ...result,
    ...Object.fromEntries(
      Object.keys(detailTables).map((kind) => [
        kind,
        value[kind as keyof typeof detailTables].map((row) => {
          const { contact_id, book_id, email_key, phone_key, ...item } = row;
          return { ...item, is_primary: !!row.is_primary };
        }),
      ]),
    ),
  };
}
export function insert(
  c: ContactContext,
  table: string,
  values: Record<string, Bind>,
  proof: string,
) {
  const entries = Object.entries(values);
  return statement(
    c.env,
    `INSERT INTO ${table}(${entries.map(([key]) => key).join(",")}) SELECT ${entries.map(() => "?").join(",")} WHERE ${proof}`,
    ...entries.map(([, value]) => value),
  );
}
export function insertRows(
  c: ContactContext,
  table: string,
  values: Record<string, Bind>[],
  proof: string,
) {
  const columns = Object.keys(values[0]!);
  return statement(
    c.env,
    `INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.map((column) => `json_extract(value,'$.${column}')`).join(",")} FROM json_each(?) WHERE ${proof}`,
    JSON.stringify(values),
  );
}
export function update(
  c: ContactContext,
  table: string,
  values: Record<string, Bind>,
  where: string,
  args: Bind[],
  proof: string,
) {
  const entries = Object.entries(values);
  return statement(
    c.env,
    `UPDATE ${table} SET ${entries.map(([key]) => key + "=?").join(",")} WHERE ${where} AND ${proof}`,
    ...entries.map(([, value]) => value),
    ...args,
  );
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function idempotencyKey(c: ContactContext) {
  const key = c.req.header("Idempotency-Key");
  return key === undefined ? null : text(key, "Idempotency-Key", 128);
}
export async function replay<T>(
  c: ContactContext,
  action: Permission,
  operation: string,
  request: unknown,
): Promise<{ result: T } | null> {
  const key = idempotencyKey(c);
  if (!key) return null;
  const auth = identity(c, action);
  if (!(await first(c.env, `SELECT 1 WHERE ${auth.sql}`, ...auth.args)))
    fail(403, "PERMISSION_DENIED", t("contacts.denied"));
  const old = await first<{ request_hash: string; result_json: string }>(
    c.env,
    "SELECT request_hash,result_json FROM contact_operations WHERE actor_user_id=? AND operation=? AND idempotency_key=?",
    c.get("identity").user.id,
    operation,
    key,
  );
  if (!old) return null;
  if (old.request_hash !== (await digest(stable(request))))
    fail(409, "IDEMPOTENCY_CONFLICT", t("contacts.idempotencyConflict"));
  return { result: JSON.parse(old.result_json) as T };
}
export async function mutate<T>(
  c: ContactContext,
  input: {
    action: Permission;
    operation: string;
    request: unknown;
    result: T;
    checks: Condition[];
    build: (proof: string) => D1PreparedStatement[];
  },
): Promise<T> {
  const old = await replay<T>(c, input.action, input.operation, input.request);
  if (old) return old.result;
  const id = uuid(),
    auth = identity(c, input.action),
    key = idempotencyKey(c);
  const checks = combine(
    auth,
    ...input.checks,
    ...(key
      ? [
          condition(
            "NOT EXISTS(SELECT 1 FROM contact_operations WHERE actor_user_id=? AND operation=? AND idempotency_key=?)",
            c.get("identity").user.id,
            input.operation,
            key,
          ),
        ]
      : []),
  );
  const proof = `EXISTS(SELECT 1 FROM contact_operations WHERE id='${id}')`;
  try {
    const result = await c.env.DB.withSession("first-primary").batch([
      statement(
        c.env,
        `INSERT INTO contact_operations(id,actor_user_id,operation,idempotency_key,request_hash,result_json,expires_at) SELECT ?,?,?,?,?,?,? WHERE ${checks.sql}`,
        id,
        c.get("identity").user.id,
        input.operation,
        key,
        await digest(stable(input.request)),
        JSON.stringify(input.result),
        now() + 86400,
        ...checks.args,
      ),
      ...input.build(proof),
    ]);
    if (result[0]!.meta.changes !== 1) {
      if (!(await first(c.env, `SELECT 1 WHERE ${auth.sql}`, ...auth.args)))
        fail(403, "PERMISSION_DENIED", t("contacts.denied"));
      const raced = await replay<T>(c, input.action, input.operation, input.request);
      if (raced) return raced.result;
      fail(412, "VERSION_CONFLICT", t("contacts.changed"));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed|FOREIGN KEY constraint failed|Contact folder cycle/.test(
        error.message,
      )
    )
      fail(409, "CONTACT_CONSTRAINT", t("contacts.constraint"));
    throw error;
  }
  return input.result;
}

const encoder = new TextEncoder();
const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
const cursorKey = (c: ContactContext) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(`officeflare:contacts:cursor:${c.env.AUTH_SIGNING_KEYS}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
export async function cursor(c: ContactContext, scope: string, position: [string, string]) {
  const payload = encode(
    encoder.encode(JSON.stringify([c.get("identity").user.id, scope, position, now() + 86400])),
  );
  return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await cursorKey(c), encoder.encode(payload))))}`;
}
export async function readCursor(
  c: ContactContext,
  scope: string,
  token: string,
): Promise<[string, string]> {
  try {
    if (token.length > 8192) throw new Error();
    const [payload, signature, extra] = token.split(".");
    if (
      !payload ||
      !signature ||
      extra ||
      !(await crypto.subtle.verify(
        "HMAC",
        await cursorKey(c),
        decode(signature),
        encoder.encode(payload),
      ))
    )
      throw new Error();
    const value: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== c.get("identity").user.id ||
      value[1] !== scope ||
      typeof value[3] !== "number" ||
      value[3] <= now() ||
      !Array.isArray(value[2]) ||
      value[2].length !== 2 ||
      value[2].some((item: unknown) => typeof item !== "string")
    )
      throw new Error();
    return value[2] as [string, string];
  } catch {
    fail(400, "INVALID_CURSOR", t("contacts.invalidCursor"));
  }
}
