import { Hono } from "hono";
import { t } from "../../shared/i18n/index.ts";
import { now, uuid, type AppEnv } from "../auth/types";
import { requirePermission } from "../authorization/access";
import { body, fail, identifier, integer, nameKey, text, version } from "./input";
import {
  book,
  condition,
  first,
  folder,
  insert,
  mutate,
  owned,
  replay,
  rows,
  statement,
  update,
} from "./store";
import type { Folder } from "./types";

const dto = ({ name_key, ...value }: Folder) => value;
const routes = new Hono<AppEnv>();
routes.get("/folders", async (c) => {
  const target = await book(c, c.req.query("book_id"));
  return c.json({
    folders: (
      await rows<Folder>(
        c.env,
        "SELECT * FROM contact_folders WHERE book_id=? ORDER BY sort_order,name_key,id",
        target.id,
      )
    ).map(dto),
  });
});
routes.post("/folders", requirePermission("contacts.folders.manage"), async (c) => {
  const data = await body(c, ["book_id", "parent_id", "name", "sort_order"]),
    operation = "folders.create";
  const previous = await replay<Record<string, unknown>>(
    c,
    "contacts.folders.manage",
    operation,
    data,
  );
  if (previous) return c.json(previous.result, 201);
  const target = await book(c, data.book_id),
    parent = data.parent_id == null ? null : await folder(c, target.id, data.parent_id),
    stamp = now();
  const value: Folder = {
    id: uuid(),
    book_id: target.id,
    parent_id: parent?.id ?? null,
    name: text(data.name, "name"),
    name_key: "",
    sort_order: data.sort_order === undefined ? 0 : integer(data.sort_order, "sort_order"),
    version: 1,
    created_at: stamp,
    updated_at: stamp,
  };
  value.name_key = nameKey(value.name);
  const result = await mutate(c, {
    action: "contacts.folders.manage",
    operation,
    request: data,
    result: { folder: dto(value) },
    checks: [
      owned(c, target.id),
      ...(parent
        ? [
            condition(
              "EXISTS(SELECT 1 FROM contact_folders WHERE id=? AND book_id=?)",
              parent.id,
              target.id,
            ),
          ]
        : []),
    ],
    build: (proof) => [insert(c, "contact_folders", value, proof)],
  });
  return c.json(result, 201);
});
routes.patch("/folders/:id", requirePermission("contacts.folders.manage"), async (c) => {
  const id = identifier(c.req.param("id")),
    data = await body(c, ["version", "name", "parent_id", "sort_order"]),
    operation = `folders.update:${id}`;
  const previous = await replay<Record<string, unknown>>(
    c,
    "contacts.folders.manage",
    operation,
    data,
  );
  if (previous) return c.json(previous.result);
  const target = await book(c),
    old = await folder(c, target.id, id),
    expected = version(c, data);
  const parentId =
    data.parent_id === undefined
      ? old.parent_id
      : data.parent_id === null
        ? null
        : identifier(data.parent_id, "parent_id");
  if (parentId) await folder(c, target.id, parentId);
  const value = {
    ...old,
    name: data.name === undefined ? old.name : text(data.name, "name"),
    parent_id: parentId,
    sort_order:
      data.sort_order === undefined ? old.sort_order : integer(data.sort_order, "sort_order"),
    version: expected + 1,
    updated_at: now(),
  };
  value.name_key = nameKey(value.name);
  return c.json(
    await mutate(c, {
      action: "contacts.folders.manage",
      operation,
      request: data,
      result: { folder: dto(value) },
      checks: [
        owned(c, target.id),
        condition(
          "EXISTS(SELECT 1 FROM contact_folders WHERE id=? AND book_id=? AND version=?)",
          id,
          target.id,
          expected,
        ),
      ],
      build: (proof) => [update(c, "contact_folders", value, "id=?", [id], proof)],
    }),
  );
});
routes.delete("/folders/:id", requirePermission("contacts.folders.manage"), async (c) => {
  const id = identifier(c.req.param("id")),
    expected = version(c),
    request = { version: expected },
    operation = `folders.delete:${id}`;
  const previous = await replay(c, "contacts.folders.manage", operation, request);
  if (previous) return c.body(null, 204);
  const target = await book(c);
  await folder(c, target.id, id);
  const empty = condition(
    "NOT EXISTS(SELECT 1 FROM contact_folders WHERE parent_id=?) AND NOT EXISTS(SELECT 1 FROM contacts WHERE folder_id=?)",
    id,
    id,
  );
  if (!(await first(c.env, `SELECT 1 WHERE ${empty.sql}`, ...empty.args)))
    fail(409, "FOLDER_NOT_EMPTY", t("contacts.folderNotEmpty"));
  await mutate(c, {
    action: "contacts.folders.manage",
    operation,
    request,
    result: { deleted: true },
    checks: [
      owned(c, target.id),
      empty,
      condition("EXISTS(SELECT 1 FROM contact_folders WHERE id=? AND version=?)", id, expected),
    ],
    build: (proof) => [statement(c.env, `DELETE FROM contact_folders WHERE id=? AND ${proof}`, id)],
  });
  return c.body(null, 204);
});
export default routes;
