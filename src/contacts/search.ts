import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { email, identifier, invalid, limit, nameKey, text } from "./input";
import { book, cursor, folder, readCursor, rows } from "./store";
import type { Bind, Contact } from "./types";

const prefix = (value: string) => value.replace(/[\\%_]/g, "\\$&") + "%";
const summary = `p.id,p.book_id,p.folder_id,p.display_name,p.organization,p.department,p.job_title,p.version,p.created_at,p.updated_at,p.trashed_at,
  (SELECT e.email_address FROM contact_emails e WHERE e.contact_id=p.id ORDER BY e.is_primary DESC,e.sort_order,e.id LIMIT 1) primary_email,
  (SELECT t.phone_number FROM contact_phones t WHERE t.contact_id=p.id ORDER BY t.is_primary DESC,t.sort_order,t.id LIMIT 1) primary_phone`;
const routes = new Hono<AppEnv>();
routes.get("/", async (c) => {
  const target = await book(c, c.req.query("book_id")),
    pageSize = limit(c.req.query("limit")),
    query = nameKey(text(c.req.query("q") ?? "", "q", 255, true)),
    folderId = c.req.query("folder_id"),
    trash = c.req.query("trashed");
  if (trash !== undefined && !["true", "false"].includes(trash)) invalid("trashed");
  const where = ["p.book_id=?", `p.trashed_at IS ${trash === "true" ? "NOT " : ""}NULL`],
    args: Bind[] = [target.id];
  if (folderId !== undefined) {
    if (folderId === "root") where.push("p.folder_id IS NULL");
    else {
      await folder(c, target.id, identifier(folderId));
      where.push("p.folder_id=?");
      args.push(folderId);
    }
  }
  if (query) {
    const phone = query.replace(/[\s().-]/g, "");
    where.push(`(p.display_name_key LIKE ? ESCAPE '\\' OR p.organization_key LIKE ? ESCAPE '\\'
      OR EXISTS(SELECT 1 FROM contact_emails e WHERE e.contact_id=p.id AND e.email_key LIKE ? ESCAPE '\\')
      ${/^\+?\d+$/.test(phone) ? "OR EXISTS(SELECT 1 FROM contact_phones t WHERE t.contact_id=p.id AND t.phone_key LIKE ? ESCAPE '\\')" : ""})`);
    args.push(prefix(query), prefix(query), prefix(query));
    if (/^\+?\d+$/.test(phone)) args.push(prefix(phone));
  }
  const scope = JSON.stringify([target.id, query, folderId ?? null, trash === "true"]),
    token = c.req.query("cursor");
  if (token) {
    const [name, id] = await readCursor(c, scope, token);
    where.push("(p.display_name_key,p.id)>(?,?)");
    args.push(name, id);
  }
  const values = await rows<
      Contact & { primary_email: string | null; primary_phone: string | null }
    >(
      c.env,
      `SELECT ${summary},p.display_name_key FROM contacts p WHERE ${where.join(" AND ")} ORDER BY p.display_name_key,p.id LIMIT ?`,
      ...args,
      pageSize + 1,
    ),
    page = values.slice(0, pageSize),
    last = page.at(-1);
  return c.json({
    contacts: page.map(({ display_name_key, ...value }) => value),
    next_cursor:
      values.length > pageSize && last
        ? await cursor(c, scope, [last.display_name_key, last.id])
        : null,
  });
});
routes.get("/lookup", async (c) => {
  const target = await book(c, c.req.query("book_id")),
    key = email(c.req.query("email_address")).toLowerCase();
  return c.json({
    contacts: await rows(
      c.env,
      `SELECT ${summary} FROM contacts p WHERE p.book_id=? AND p.trashed_at IS NULL AND EXISTS(SELECT 1 FROM contact_emails e WHERE e.contact_id=p.id AND e.email_key=?) ORDER BY p.display_name_key,p.id LIMIT 100`,
      target.id,
      key,
    ),
  });
});
routes.get("/suggestions", async (c) => {
  const query = nameKey(text(c.req.query("q") ?? "", "q", 255, true)),
    pageSize = limit(c.req.query("limit"), 10, 20);
  const target = await book(c, c.req.query("book_id"));
  if (!query) return c.json({ suggestions: [] });
  const values = await rows(
    c.env,
    `WITH candidates AS (
    SELECT p.id contact_id,e.id email_id,p.display_name,e.email_address,e.email_key,e.label,e.is_primary,p.display_name_key,
      CASE WHEN e.email_key=? THEN 0 ELSE 1 END match_rank,
      ROW_NUMBER() OVER (PARTITION BY e.email_key ORDER BY e.is_primary DESC,p.display_name_key,p.id,e.id) duplicate_rank
    FROM contact_emails e JOIN contacts p ON p.id=e.contact_id
    WHERE e.book_id=? AND p.trashed_at IS NULL AND (p.display_name_key LIKE ? ESCAPE '\\' OR p.organization_key LIKE ? ESCAPE '\\' OR e.email_key LIKE ? ESCAPE '\\')
  ) SELECT contact_id,email_id,display_name,email_address,label FROM candidates WHERE duplicate_rank=1
    ORDER BY match_rank,is_primary DESC,display_name_key,contact_id,email_id LIMIT ?`,
    query,
    target.id,
    prefix(query),
    prefix(query),
    prefix(query),
    pageSize,
  );
  return c.json({ suggestions: values });
});
export default routes;
