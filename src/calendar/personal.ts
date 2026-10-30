import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { now, uuid } from "../auth/types";
import { calendarCondition, condition, first, requireCalendar, rows } from "./access";
import type { CalendarContext, Copy } from "./types";
import {
  body,
  color,
  expectedVersion,
  fail,
  flag,
  identifier,
  integer,
  jsonObject,
  text,
} from "./input";
import { change, insert, mutate, update } from "./mutations";
import { copyDto } from "./event-data";
const routes = new Hono<AppEnv>();
routes.get("/calendars/:calendarId/labels", async (c) => {
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 4);
  return c.json({
    labels: await rows(
      c.env,
      "SELECT * FROM calendar_labels WHERE calendar_id=? AND deleted_at IS NULL ORDER BY sort_order,id",
      cal.id,
    ),
  });
});
routes.post("/calendars/:calendarId/labels", async (c) => {
  const data = await body(c, ["name", "color", "sort_order"]),
    cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
    id = uuid(),
    stamp = now(),
    value = {
      id,
      calendar_id: cal.id,
      name: text(data.name, "name", 255),
      color: color(data.color),
      sort_order: integer(data.sort_order ?? 0, "sort_order", -1000000, 1000000),
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    };
  if (!value.color) fail(400, "INVALID_INPUT", t("calendarPersonal.labelColorIsRequired"));
  const result = await mutate(c, {
    operation: `label.create:${cal.id}`,
    idempotent: true,
    request: data,
    result: { label: value },
    calendar: cal.id,
    checks: [calendarCondition(c, cal, 5)],
    build: (proof) => [
      insert(c, "calendar_labels", value, proof),
      change(c, proof, cal.id, "label", id, 1),
    ],
  });
  return c.json(result, 201);
});
routes.patch("/calendars/:calendarId/labels/:labelId", async (c) => {
  const data = await body(c, ["version", "name", "color", "sort_order"]),
    cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
    id = identifier(c.req.param("labelId")),
    version = expectedVersion(c, data),
    old = await first<Record<string, string | number | null>>(
      c.env,
      "SELECT * FROM calendar_labels WHERE id=? AND calendar_id=? AND deleted_at IS NULL",
      id,
      cal.id,
    );
  if (!old) fail(404, "LABEL_NOT_FOUND", t("calendarPersonal.labelNotFound"));
  const values: Record<string, string | number | null> = {
    version: version + 1,
    updated_at: now(),
  };
  if ("name" in data) values.name = text(data.name, "name", 255);
  if ("color" in data) {
    values.color = color(data.color);
    if (!values.color) fail(400, "INVALID_INPUT", t("calendarPersonal.labelColorIsRequired"));
  }
  if ("sort_order" in data)
    values.sort_order = integer(data.sort_order, "sort_order", -1000000, 1000000);
  await mutate(c, {
    operation: "label.update",
    request: data,
    result: null,
    calendar: cal.id,
    checks: [
      calendarCondition(c, cal, 5),
      condition(
        "EXISTS(SELECT 1 FROM calendar_labels WHERE id=? AND version=? AND deleted_at IS NULL)",
        id,
        version,
      ),
    ],
    build: (proof) => [
      update(c, "calendar_labels", values, "id=?", [id], proof),
      change(c, proof, cal.id, "label", id, version + 1),
    ],
  });
  return c.json({ label: { ...old, ...values } });
});
routes.delete("/calendars/:calendarId/labels/:labelId", async (c) => {
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
    id = identifier(c.req.param("labelId")),
    version = expectedVersion(c);
  await mutate(c, {
    operation: "label.delete",
    request: { id, version },
    result: null,
    calendar: cal.id,
    checks: [
      calendarCondition(c, cal, 5),
      condition(
        "EXISTS(SELECT 1 FROM calendar_labels WHERE id=? AND calendar_id=? AND version=? AND deleted_at IS NULL)",
        id,
        cal.id,
        version,
      ),
    ],
    build: (proof) => [
      c.env.DB.prepare(
        `INSERT INTO calendar_changes(calendar_id,audience_user_id,resource_type,resource_id,operation,version) SELECT copy.calendar_id,(SELECT data_owner_user_id FROM calendars WHERE id=copy.calendar_id),'copy',copy.id,'upsert',copy.version+1 FROM calendar_event_copies copy WHERE copy.label_id=? AND ${proof}`,
      ).bind(id),
      c.env.DB.prepare(
        `UPDATE calendar_event_copies SET label_id=NULL,version=version+1,updated_at=? WHERE label_id=? AND ${proof}`,
      ).bind(now(), id),
      update(
        c,
        "calendar_labels",
        { deleted_at: now(), version: version + 1, updated_at: now() },
        "id=?",
        [id],
        proof,
      ),
      change(c, proof, cal.id, "label", id, version + 1, "delete"),
    ],
  });
  return c.body(null, 204);
});
async function copyTarget(c: CalendarContext) {
  const id = identifier(c.req.param("copyId")),
    value = await first<Copy>(
      c.env,
      "SELECT * FROM calendar_event_copies WHERE id=? AND removed_at IS NULL",
      id,
    );
  if (!value) fail(404, "COPY_NOT_FOUND", t("calendarPersonal.eventCopyNotFound"));
  const cal = await requireCalendar(c, value.calendar_id, 6);
  return { value, cal };
}
routes.get("/copies/:copyId", async (c) => {
  const { value } = await copyTarget(c);
  c.header("ETag", `"v${value.version}"`);
  return c.json({ copy: copyDto(value) });
});
routes.patch("/copies/:copyId", async (c) => {
  const data = await body(c, ["version", "color", "label_id", "private_properties", "hidden"]),
    { value, cal } = await copyTarget(c),
    version = expectedVersion(c, data),
    values: Record<string, string | number | null> = {
      version: version + 1,
      updated_at: now(),
    };
  if ("color" in data) values.color_override = color(data.color);
  if ("label_id" in data)
    values.label_id = data.label_id === null ? null : identifier(data.label_id, "label_id");
  if ("private_properties" in data)
    values.private_properties_json = JSON.stringify(
      jsonObject(data.private_properties, "private_properties"),
    );
  if ("hidden" in data) values.hidden_at = flag(data.hidden, "hidden") ? now() : null;
  const label = values.label_id,
    check =
      typeof label === "string"
        ? condition(
            "EXISTS(SELECT 1 FROM calendar_labels WHERE id=? AND calendar_id=? AND deleted_at IS NULL)",
            label,
            cal.id,
          )
        : condition("1");
  if (!(await first(c.env, `SELECT 1 WHERE ${check.sql}`, ...check.args)))
    fail(400, "INVALID_LABEL", t("calendarPersonal.labelDoesNotBelongToThisCalendar"));
  await mutate(c, {
    operation: "copy.update",
    request: data,
    result: null,
    checks: [
      calendarCondition(c, cal, 6),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_copies WHERE id=? AND version=?)",
        value.id,
        version,
      ),
      check,
    ],
    build: (proof) => [
      update(c, "calendar_event_copies", values, "id=?", [value.id], proof),
      change(c, proof, null, "copy", value.id, version + 1, "upsert", c.get("identity").user.id),
    ],
  });
  return c.json({ copy: copyDto({ ...value, ...values } as Copy) });
});
routes.delete("/copies/:copyId", async (c) => {
  const { value, cal } = await copyTarget(c),
    version = expectedVersion(c);
  await mutate(c, {
    operation: "copy.hide",
    request: { id: value.id, version },
    result: null,
    checks: [
      calendarCondition(c, cal, 6),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_copies WHERE id=? AND version=?)",
        value.id,
        version,
      ),
    ],
    build: (proof) => [
      update(
        c,
        "calendar_event_copies",
        { hidden_at: now(), version: version + 1, updated_at: now() },
        "id=?",
        [value.id],
        proof,
      ),
      change(c, proof, null, "copy", value.id, version + 1, "upsert", c.get("identity").user.id),
    ],
  });
  return c.body(null, 204);
});
export default routes;
