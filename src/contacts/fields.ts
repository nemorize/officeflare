import { Hono } from "hono";
import { t } from "../../shared/i18n/index.ts";
import { now, uuid, type AppEnv } from "../auth/types";
import { requirePermission } from "../authorization/access";
import {
  array,
  body,
  fail,
  identifier,
  integer,
  invalid,
  text,
  valueTypes,
  version,
} from "./input";
import { book, condition, first, insert, mutate, owned, replay, rows, update } from "./store";
import type { ContactContext, FieldDefinition } from "./types";

export function fieldDto({ options_json, ...value }: FieldDefinition) {
  return { ...value, options: JSON.parse(options_json) as string[] };
}
async function definition(c: ContactContext, id: string) {
  const value = await first<FieldDefinition>(
    c.env,
    "SELECT f.* FROM contact_field_definitions f JOIN contact_books b ON b.id=f.book_id WHERE f.id=? AND b.owner_user_id=?",
    id,
    c.get("identity").user.id,
  );
  if (!value) fail(404, "FIELD_NOT_FOUND", t("contacts.notFound"));
  return value;
}
function values(data: Record<string, unknown>, old?: FieldDefinition) {
  const valueType = data.value_type === undefined && old ? old.value_type : data.value_type;
  if (!valueTypes.includes(valueType as FieldDefinition["value_type"])) invalid("value_type");
  const options =
    data.options === undefined
      ? old
        ? (JSON.parse(old.options_json) as string[])
        : []
      : array(data.options, "options", 100).map((entry) => text(entry, "options"));
  if (
    new Set(options).size !== options.length ||
    (["select", "multiselect"].includes(String(valueType)) ? !options.length : !!options.length)
  )
    invalid("options");
  return {
    value_type: valueType as FieldDefinition["value_type"],
    options_json: JSON.stringify(options),
    label: data.label === undefined && old ? old.label : text(data.label, "label"),
    sort_order:
      data.sort_order === undefined
        ? (old?.sort_order ?? 0)
        : integer(data.sort_order, "sort_order"),
  };
}
const routes = new Hono<AppEnv>();
routes.get("/field-definitions", async (c) => {
  const target = await book(c, c.req.query("book_id"));
  const archived = c.req.query("include_archived");
  if (archived !== undefined && !["true", "false"].includes(archived)) invalid("include_archived");
  return c.json({
    fields: (
      await rows<FieldDefinition>(
        c.env,
        `SELECT * FROM contact_field_definitions WHERE book_id=? ${archived === "true" ? "" : "AND archived_at IS NULL"} ORDER BY sort_order,label,id`,
        target.id,
      )
    ).map(fieldDto),
  });
});
routes.post("/field-definitions", requirePermission("contacts.fields.manage"), async (c) => {
  const data = await body(c, ["book_id", "key", "label", "value_type", "options", "sort_order"]),
    operation = "fields.create";
  const previous = await replay<Record<string, unknown>>(
    c,
    "contacts.fields.manage",
    operation,
    data,
  );
  if (previous) return c.json(previous.result, 201);
  const target = await book(c, data.book_id),
    key = text(data.key, "key", 64);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) invalid("key");
  const stamp = now(),
    value: FieldDefinition = {
      id: uuid(),
      book_id: target.id,
      key,
      ...values(data),
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      archived_at: null,
    };
  return c.json(
    await mutate(c, {
      action: "contacts.fields.manage",
      operation,
      request: data,
      result: { field: fieldDto(value) },
      checks: [owned(c, target.id)],
      build: (proof) => [insert(c, "contact_field_definitions", value, proof)],
    }),
    201,
  );
});
routes.patch("/field-definitions/:id", requirePermission("contacts.fields.manage"), async (c) => {
  const id = identifier(c.req.param("id")),
    data = await body(c, ["version", "label", "value_type", "options", "sort_order", "archived"]),
    operation = `fields.update:${id}`;
  const previous = await replay<Record<string, unknown>>(
    c,
    "contacts.fields.manage",
    operation,
    data,
  );
  if (previous) return c.json(previous.result);
  const old = await definition(c, id),
    expected = version(c, data),
    value = { ...old, ...values(data, old), version: expected + 1, updated_at: now() };
  if (data.archived !== undefined) {
    if (typeof data.archived !== "boolean") invalid("archived");
    value.archived_at = data.archived ? now() : null;
  }
  const changesType =
    value.value_type !== old.value_type || value.options_json !== old.options_json;
  const unused = condition("NOT EXISTS(SELECT 1 FROM contact_field_values WHERE field_id=?)", id);
  if (changesType && !(await first(c.env, `SELECT 1 WHERE ${unused.sql}`, ...unused.args)))
    fail(409, "FIELD_IN_USE", t("contacts.fieldInUse"));
  return c.json(
    await mutate(c, {
      action: "contacts.fields.manage",
      operation,
      request: data,
      result: { field: fieldDto(value) },
      checks: [
        owned(c, old.book_id),
        condition(
          "EXISTS(SELECT 1 FROM contact_field_definitions WHERE id=? AND version=?)",
          id,
          expected,
        ),
        ...(changesType ? [unused] : []),
      ],
      build: (proof) => [update(c, "contact_field_definitions", value, "id=?", [id], proof)],
    }),
  );
});
routes.delete("/field-definitions/:id", requirePermission("contacts.fields.manage"), async (c) => {
  const id = identifier(c.req.param("id")),
    expected = version(c),
    request = { version: expected },
    operation = `fields.archive:${id}`;
  const previous = await replay(c, "contacts.fields.manage", operation, request);
  if (previous) return c.body(null, 204);
  const old = await definition(c, id);
  await mutate(c, {
    action: "contacts.fields.manage",
    operation,
    request,
    result: { archived: true },
    checks: [
      owned(c, old.book_id),
      condition(
        "EXISTS(SELECT 1 FROM contact_field_definitions WHERE id=? AND version=?)",
        id,
        expected,
      ),
    ],
    build: (proof) => [
      update(
        c,
        "contact_field_definitions",
        { archived_at: now(), updated_at: now(), version: expected + 1 },
        "id=?",
        [id],
        proof,
      ),
    ],
  });
  return c.body(null, 204);
});
export default routes;
