import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { now, uuid } from "../auth/types";
import { requirePermission } from "../authorization/access";
import { calendarCondition, condition, first, requireCalendar, rows } from "./access";
import { body, fail, identifier, text } from "./input";
import { change, insert, mutate, replay } from "./mutations";
import { insertEvent, makeCopy } from "./event-data";
import { MAX_IMPORT_BYTES, parseCalendarImport } from "./ical-import";

const routes = new Hono<AppEnv>();
routes.post(
  "/calendars/:calendarId/imports",
  requirePermission("calendar.events.create"),
  async (c) => {
    const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 3);
    const data = await body(c, ["content", "dry_run"]);
    if (data.dry_run !== undefined && typeof data.dry_run !== "boolean")
      fail(400, "INVALID_INPUT", t("calendarImports.dryRunMustBeABoolean"));
    const content = text(data.content, "content", MAX_IMPORT_BYTES),
      dryRun = data.dry_run === true;
    const operation = `calendar.import:${cal.id}`;
    if (!dryRun) {
      const previous = await replay(c, operation, data, "calendar.events.create");
      if (previous) return c.json(previous.result);
    }
    let parsed: ReturnType<typeof parseCalendarImport>;
    try {
      parsed = parseCalendarImport(content, cal);
    } catch (error) {
      fail(
        400,
        "INVALID_ICALENDAR",
        error instanceof Error
          ? error.message.slice(0, 512)
          : t("calendarImports.invalidIcalendarFile"),
      );
    }
    const existing = new Set(
      (
        await rows<{ i_cal_uid: string }>(
          c.env,
          "SELECT i_cal_uid FROM calendar_events WHERE organizer_calendar_id=? AND i_cal_uid IN(SELECT value FROM json_each(?))",
          cal.id,
          JSON.stringify(parsed.plans.map((plan) => plan.event.i_cal_uid)),
        )
      ).map((event) => event.i_cal_uid),
    );
    const plans = parsed.plans.filter((plan) => {
      if (!existing.has(plan.event.i_cal_uid)) return true;
      for (const entry of plan.entries) {
        entry.status = "skipped";
        entry.message = t("calendarImports.anEventWithThisUidAlreadyExistsInThis");
      }
      return false;
    });
    if (!dryRun)
      for (const plan of plans)
        for (const entry of plan.entries) {
          entry.status = "imported";
          entry.message = "Imported.";
          entry.event_id = plan.event.id;
        }
    const result = {
      dry_run: dryRun,
      calendar_id: cal.id,
      events_imported: dryRun ? 0 : plans.length,
      summary: {
        ready: parsed.entries.filter((entry) => entry.status === "ready").length,
        imported: parsed.entries.filter((entry) => entry.status === "imported").length,
        skipped: parsed.entries.filter((entry) => entry.status === "skipped").length,
        failed: parsed.entries.filter((entry) => entry.status === "error").length,
      },
      entries: parsed.entries,
    };
    if (dryRun) return c.json(result);
    const owner = await first<{ email_address: string }>(
      c.env,
      "SELECT email_address FROM users WHERE id=?",
      cal.data_owner_user_id,
    );
    for (const plan of plans) {
      plan.event.organizer_email = owner!.email_address;
      plan.event.creator_user_id = c.get("identity").user.id;
    }
    const saved = await mutate(c, {
      operation,
      action: "calendar.events.create",
      idempotent: true,
      request: data,
      result,
      calendar: cal.id,
      details: {
        events_imported: plans.length,
        skipped: result.summary.skipped,
        failed: result.summary.failed,
      },
      checks: [
        calendarCondition(c, cal, 3),
        condition(
          "NOT EXISTS(SELECT 1 FROM calendar_events WHERE organizer_calendar_id=? AND i_cal_uid IN(SELECT value FROM json_each(?)))",
          cal.id,
          JSON.stringify(plans.map((plan) => plan.event.i_cal_uid)),
        ),
      ],
      build: (proof) =>
        plans.flatMap((plan) => [
          ...insertEvent(c, plan.event, makeCopy(plan.event), proof),
          ...plan.overrides.flatMap((override) => {
            const id = uuid();
            return [
              insert(
                c,
                "calendar_event_scopes",
                { id, event_id: plan.event.id, occurrence_key: override.key },
                proof,
              ),
              insert(
                c,
                "calendar_event_overrides",
                {
                  scope_id: id,
                  cancelled: override.cancelled,
                  patch_json: JSON.stringify(override.patch),
                  effective_start_at: override.event.start_at,
                  effective_end_at: override.event.end_at,
                  effective_start_date: override.event.start_date,
                  effective_end_date: override.event.end_date,
                  version: 1,
                  created_at: now(),
                  updated_at: now(),
                },
                proof,
              ),
            ];
          }),
          change(c, proof, cal.id, "event", plan.event.id, 1),
        ]),
    });
    return c.json(saved);
  },
);
export default routes;
