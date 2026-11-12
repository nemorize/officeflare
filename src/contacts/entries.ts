import { Hono } from "hono";
import { t } from "../../shared/i18n/index.ts";
import { now, uuid, type AppEnv } from "../auth/types";
import { requirePermission } from "../authorization/access";
import {
  array,
  body,
  date,
  details,
  fields,
  fieldValue,
  identifier,
  invalid,
  nameKey,
  object,
  text,
  version,
} from "./input";
import {
  book,
  condition,
  contact,
  detail,
  dto,
  folder,
  insert,
  mutate,
  owned,
  replay,
  rows,
  statement,
  insertRows,
  update,
} from "./store";
import {
  detailTables,
  type Condition,
  type Contact,
  type ContactContext,
  type ContactDetail,
  type FieldDefinition,
} from "./types";

const strings = [
  "display_name",
  "given_name",
  "family_name",
  "nickname",
  "organization",
  "department",
  "job_title",
  "notes",
] as const;
const allowed = [
  "folder_id",
  "birthday",
  ...strings,
  ...Object.keys(detailTables),
  "custom_fields",
];
async function prepare(c: ContactContext, data: Record<string, unknown>, old?: ContactDetail) {
  const target = await book(c, data.book_id),
    stamp = now(),
    id = old?.id ?? uuid();
  const value: ContactDetail = old
    ? { ...old }
    : {
        id,
        book_id: target.id,
        folder_id: null,
        display_name: "",
        display_name_key: "",
        given_name: "",
        family_name: "",
        nickname: "",
        organization: "",
        organization_key: "",
        department: "",
        job_title: "",
        birthday: null,
        notes: "",
        version: 1,
        created_at: stamp,
        updated_at: stamp,
        trashed_at: null,
        emails: [],
        phones: [],
        addresses: [],
        links: [],
        custom_fields: [],
      };
  for (const key of strings)
    if (data[key] !== undefined)
      value[key] = text(data[key], key, key === "notes" ? 10000 : 255, true);
  if (data.birthday !== undefined)
    value.birthday = data.birthday === null ? null : date(data.birthday);
  if (data.folder_id !== undefined)
    value.folder_id = data.folder_id === null ? null : identifier(data.folder_id, "folder_id");
  const checks: Condition[] = [owned(c, target.id)];
  if (value.folder_id) {
    await folder(c, target.id, value.folder_id);
    checks.push(
      condition(
        "EXISTS(SELECT 1 FROM contact_folders WHERE id=? AND book_id=?)",
        value.folder_id,
        target.id,
      ),
    );
  }
  for (const kind of Object.keys(detailTables) as (keyof typeof detailTables)[])
    if (data[kind] !== undefined) value[kind] = details(data[kind], kind, id, old?.[kind]);
  if (!value.display_name)
    value.display_name =
      [value.given_name, value.family_name].filter(Boolean).join(" ") ||
      String(value.emails[0]?.email_address ?? value.phones[0]?.phone_number ?? value.organization);
  if (!value.display_name || value.display_name.length > 255) invalid("display_name");
  value.display_name_key = nameKey(value.display_name);
  value.organization_key = nameKey(value.organization);
  value.updated_at = stamp;
  if (data.custom_fields !== undefined) {
    const definitions = await rows<FieldDefinition>(
        c.env,
        "SELECT * FROM contact_field_definitions WHERE book_id=?",
        target.id,
      ),
      seen = new Set<string>();
    value.custom_fields = array(data.custom_fields, "custom_fields").map((entry) => {
      const input = object(entry);
      fields(input, ["field_id", "value"]);
      const fieldId = identifier(input.field_id, "field_id"),
        definition = definitions.find((item) => item.id === fieldId);
      if (!definition || seen.has(fieldId)) invalid("field_id");
      seen.add(fieldId);
      const parsed = fieldValue(input.value, definition);
      if (
        definition.archived_at !== null &&
        !old?.custom_fields.some(
          (item) =>
            item.field_id === fieldId && JSON.stringify(item.value) === JSON.stringify(parsed),
        )
      )
        invalid("field_id");
      return { field_id: fieldId, value: parsed };
    });
    value.custom_fields.sort((a, b) => a.field_id.localeCompare(b.field_id));
    // One JSON bind keeps fifty custom fields below D1's parameter limit.
    const snapshot = value.custom_fields.map((item) => {
      const definition = definitions.find((entry) => entry.id === item.field_id)!;
      return { id: definition.id, version: definition.version };
    });
    checks.push(
      condition(
        "NOT EXISTS(SELECT 1 FROM json_each(?) snapshot LEFT JOIN contact_field_definitions f ON f.id=json_extract(snapshot.value,'$.id') AND f.book_id=? WHERE f.id IS NULL OR f.version<>json_extract(snapshot.value,'$.version'))",
        JSON.stringify(snapshot),
        target.id,
      ),
    );
  }
  return { value, checks };
}
function core(value: ContactDetail): Contact {
  const { emails, phones, addresses, links, custom_fields, ...result } = value;
  return result;
}
function children(
  c: ContactContext,
  data: Record<string, unknown>,
  value: ContactDetail,
  proof: string,
  creating = false,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [kind, table] of Object.entries(detailTables) as [
    keyof typeof detailTables,
    string,
  ][]) {
    if (!creating && data[kind] === undefined) continue;
    if (!creating)
      statements.push(
        statement(c.env, `DELETE FROM ${table} WHERE contact_id=? AND ${proof}`, value.id),
      );
    const items = value[kind].map((row) => ({
      ...row,
      ...(kind === "emails" ? { book_id: value.book_id } : {}),
    }));
    if (items.length) statements.push(insertRows(c, table, items, proof));
  }
  if (creating || data.custom_fields !== undefined) {
    if (!creating)
      statements.push(
        statement(
          c.env,
          `DELETE FROM contact_field_values WHERE contact_id=? AND ${proof}`,
          value.id,
        ),
      );
    const items = value.custom_fields.map((row) => ({
      book_id: value.book_id,
      contact_id: value.id,
      field_id: row.field_id,
      value_json: JSON.stringify(row.value),
    }));
    if (items.length) statements.push(insertRows(c, "contact_field_values", items, proof));
  }
  return statements;
}
const routes = new Hono<AppEnv>();
routes.post("/", requirePermission("contacts.entries.create"), async (c) => {
  const data = await body(c, ["book_id", ...allowed]),
    operation = "contacts.create";
  const previous = await replay<Record<string, unknown>>(
    c,
    "contacts.entries.create",
    operation,
    data,
  );
  if (previous) return c.json(previous.result, 201);
  const { value, checks } = await prepare(c, data);
  const result = await mutate(c, {
    action: "contacts.entries.create",
    operation,
    request: data,
    result: { contact: dto(value) },
    checks,
    build: (proof) => [
      insert(c, "contacts", core(value), proof),
      ...children(c, data, value, proof, true),
    ],
  });
  c.header("ETag", `"v${result.contact.version}"`);
  return c.json(result, 201);
});
routes.get("/:id", async (c) => {
  const trash = c.req.query("trashed");
  if (trash !== undefined && !["true", "false"].includes(trash)) invalid("trashed");
  const value = await detail(c, await contact(c, c.req.param("id"), trash === "true"));
  c.header("ETag", `"v${value.version}"`);
  return c.json({ contact: dto(value) });
});
routes.patch("/:id", requirePermission("contacts.entries.update"), async (c) => {
  const id = identifier(c.req.param("id")),
    data = await body(c, ["version", ...allowed]),
    operation = `contacts.update:${id}`;
  const previous = await replay<Record<string, unknown>>(
    c,
    "contacts.entries.update",
    operation,
    data,
  );
  if (previous) return c.json(previous.result);
  const old = await detail(c, await contact(c, id)),
    expected = version(c, data),
    { value, checks } = await prepare(c, data, old);
  value.version = expected + 1;
  const result = await mutate(c, {
    action: "contacts.entries.update",
    operation,
    request: data,
    result: { contact: dto(value) },
    checks: [
      ...checks,
      condition(
        "EXISTS(SELECT 1 FROM contacts WHERE id=? AND version=? AND trashed_at IS NULL)",
        id,
        expected,
      ),
    ],
    build: (proof) => [
      update(c, "contacts", core(value), "id=?", [id], proof),
      ...children(c, data, value, proof),
    ],
  });
  c.header("ETag", `"v${result.contact.version}"`);
  return c.json(result);
});
routes.delete("/:id", requirePermission("contacts.entries.delete"), async (c) => {
  const id = identifier(c.req.param("id")),
    expected = version(c),
    request = { version: expected },
    operation = `contacts.trash:${id}`;
  const previous = await replay(c, "contacts.entries.delete", operation, request);
  if (previous) return c.body(null, 204);
  const old = await contact(c, id),
    stamp = now();
  await mutate(c, {
    action: "contacts.entries.delete",
    operation,
    request,
    result: { trashed: true },
    checks: [
      owned(c, old.book_id),
      condition(
        "EXISTS(SELECT 1 FROM contacts WHERE id=? AND version=? AND trashed_at IS NULL)",
        id,
        expected,
      ),
    ],
    build: (proof) => [
      update(
        c,
        "contacts",
        { trashed_at: stamp, updated_at: stamp, version: expected + 1 },
        "id=?",
        [id],
        proof,
      ),
    ],
  });
  return c.body(null, 204);
});
routes.post("/:id/restore", requirePermission("contacts.entries.update"), async (c) => {
  const id = identifier(c.req.param("id")),
    data = await body(c, ["version", "folder_id"]),
    operation = `contacts.restore:${id}`;
  const previous = await replay<Record<string, unknown>>(
    c,
    "contacts.entries.update",
    operation,
    data,
  );
  if (previous) return c.json(previous.result);
  const old = await detail(c, await contact(c, id, true)),
    expected = version(c, data),
    folderId =
      data.folder_id === undefined
        ? old.folder_id
        : data.folder_id === null
          ? null
          : identifier(data.folder_id, "folder_id");
  if (folderId) await folder(c, old.book_id, folderId);
  const value = {
    ...old,
    folder_id: folderId,
    trashed_at: null,
    updated_at: now(),
    version: expected + 1,
  };
  return c.json(
    await mutate(c, {
      action: "contacts.entries.update",
      operation,
      request: data,
      result: { contact: dto(value) },
      checks: [
        owned(c, old.book_id),
        condition(
          "EXISTS(SELECT 1 FROM contacts WHERE id=? AND version=? AND trashed_at IS NOT NULL)",
          id,
          expected,
        ),
      ],
      build: (proof) => [update(c, "contacts", core(value), "id=?", [id], proof)],
    }),
  );
});
routes.delete("/:id/permanent", requirePermission("contacts.entries.delete"), async (c) => {
  const id = identifier(c.req.param("id")),
    expected = version(c),
    request = { version: expected },
    operation = `contacts.purge:${id}`;
  const previous = await replay(c, "contacts.entries.delete", operation, request);
  if (previous) return c.body(null, 204);
  const old = await contact(c, id, true);
  await mutate(c, {
    action: "contacts.entries.delete",
    operation,
    request,
    result: { deleted: true },
    checks: [
      owned(c, old.book_id),
      condition(
        "EXISTS(SELECT 1 FROM contacts WHERE id=? AND version=? AND trashed_at IS NOT NULL)",
        id,
        expected,
      ),
    ],
    build: (proof) => [statement(c.env, `DELETE FROM contacts WHERE id=? AND ${proof}`, id)],
  });
  return c.body(null, 204);
});
export default routes;
