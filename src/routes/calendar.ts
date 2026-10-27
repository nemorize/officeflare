import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../auth/types";
import { requireAccess } from "../auth/store";
import { requirePermission, requestPermissions } from "../authorization/access";
import calendarRoutes, {
  calendarDto,
  ensurePrimary,
  preferences,
  subscriptions,
} from "../calendar/calendars";
import { Temporal } from "@js-temporal/polyfill";
import { viewRange } from "../calendar/view-range";
import { calendarStartView, validCalendarView } from "../calendar/view-preferences";
import { listEvents } from "../calendar/events";
import eventRoutes from "../calendar/events";
import importRoutes from "../calendar/imports";
import feedRoutes from "../calendar/feeds";
import personalRoutes from "../calendar/personal";
import { active, calendars, rows } from "../calendar/access";
import { pageLimit, fail } from "../calendar/input";
import { cursor, readCursor } from "../calendar/cursor";
import sharingRoutes, { adminSettings } from "../calendar/sharing";
import linkRoutes, { linkSessions } from "../calendar/links";
import { publicRoutes } from "../calendar/public";
import attendeeRoutes, { ownInvitations } from "../calendar/attendees";
import {
  registrationRoutes,
  publicRegistrations,
} from "../calendar/registrations";
import availabilityRoutes from "../calendar/availability";
import attachmentRoutes from "../calendar/attachments";
import proposalRoutes, {
  ownProposalRoutes,
  publicProposalRoutes,
} from "../calendar/proposals";
import { publishingRoutes } from "../calendar/publishing";
const capabilities = {
  phase: 2,
  calendars: true,
  subscriptions: true,
  preferences: true,
  labels: true,
  events: true,
  all_day: true,
  recurrence: true,
  recurrence_overrides: true,
  recurring_edit_scopes: ["single", "following", "all"],
  following_rdate_requires_explicit_recurrence: true,
  following_before_dtstart: false,
  recurrence_frequencies: ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"],
  max_recurrence_count: 1000,
  max_query_days: 366,
  max_page_size: 500,
  max_occurrences: 5000,
  max_collaboration_recipients: 100,
  max_attachments: 20,
  max_public_candidates: 200,
  max_public_occurrences: 500,
  supported_years: [1970, 2100],
  working_hours: true,
  sharing: true,
  external_sharing: true,
  attendees: true,
  external_attendees: true,
  notification_delivery: true,
  email_delivery: true,
  ics: true,
  ics_import: true,
  ics_subscriptions: true,
  external_calendar_sync_direction: "read_only",
  external_calendar_refresh_seconds: 3600,
  max_import_bytes: 1048576,
  max_import_entries: 200,
  reminders: false,
  free_busy: true,
  availability: true,
  drive_attachments: true,
  time_proposals: true,
  guest_event_editing: false,
  guest_invitation_forwarding: false,
  resources: false,
  appointments: false,
  tasks: false,
  sync_sessions: false,
  integrations: false,
};
const calendar = new Hono<AppEnv>();
calendar.route("/", publicRoutes);
calendar.route("/", linkSessions);
calendar.route("/", publicRegistrations);
calendar.route("/", publishingRoutes);
calendar.route("/", publicProposalRoutes);
calendar.use("/inbox-invitations", requireAccess);
calendar.use("/inbox-invitations/*", requireAccess);
calendar.route("/", ownInvitations);
calendar.route("/", ownProposalRoutes);
calendar.use(
  "/admin/*",
  requireAccess,
  requirePermission("admin.calendar.settings.read"),
);
calendar.route("/", adminSettings);
calendar.use("*", requireAccess, requirePermission("calendar.access"));
calendar.use("*", async (c, next) => { c.set("initializeCalendar", () => ensurePrimary(c)); await next(); });
calendar.get("/capabilities", async (c) =>
  c.json({
    ...capabilities,
    permissions: (
      await requestPermissions(c)
    ).filter((key) => key.startsWith("calendar.")),
  }),
);
calendar.get("/bootstrap", async (c) => {
  await ensurePrimary(c);
  const [list, prefs] = await Promise.all([calendars(c), preferences(c)]),
    primary = list.find((cal) => cal.is_primary)!;
  const [labels, subs] = await Promise.all([rows(
      c.env,
      "SELECT * FROM calendar_labels WHERE calendar_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL ORDER BY sort_order,id",
      JSON.stringify(
        list
          .filter((cal) =>
            ["writer", "manager", "data_owner"].includes(cal.effective_role),
          )
          .map((cal) => cal.id),
      ),
    ), subscriptions(c, list)]);
  let initial_events;
  if (c.req.query("include_events") === "true") {
    let date = Temporal.Now.plainDateISO(prefs.time_zone).toString();
    try { const requested = c.req.query("date"); if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) { const parsed = Temporal.PlainDate.from(requested); if (parsed.year >= 1970 && parsed.year <= 2100) date = parsed.toString(); } } catch { /* Match the UI fallback for invalid dates. */ }
    const requestedView = c.req.query("view"), search = c.req.query("q") ?? "";
    const view = calendarStartView(requestedView, prefs, validCalendarView(c.req.query("cached_view")));
    const range = viewRange(date, search ? "agenda" : view, prefs.week_start);
    const selected = list.filter(cal => subs.some(sub => sub.calendar_id === cal.id && sub.selected && !sub.hidden));
    const query = new URLSearchParams({ time_min: Temporal.PlainDate.from(range.start).toZonedDateTime(prefs.time_zone).toInstant().toString(), time_max: Temporal.PlainDate.from(range.end).toZonedDateTime(prefs.time_zone).toInstant().toString(), expand_recurring: "true", calendar_ids: selected.map(cal => cal.id).join(","), ...(search ? { q: search } : {}) });
    const key = query.toString(); query.set("limit", "500");
    try {
      initial_events = { query: key, ...(selected.length ? await listEvents(c, query, list) : { events: [], next_cursor: null }) };
    } catch (error) {
      // Event query limits must not hide the calendar catalog or preferences.
      if (!(error instanceof HTTPException) || error.status >= 500) throw error;
      initial_events = { query: key, events: [], next_cursor: null, error: { status: error.status, message: error.message } };
    }
  }
  return c.json({
    initial_events,
    primary_calendar_id: primary.id,
    calendars: list.map(calendarDto),
    subscriptions: subs,
    preferences: prefs,
    labels,
    capabilities,
  });
});
calendar.get("/people", requirePermission("calendar.sharing.internal"), async (c) => {
  const query = (c.req.query("q") ?? "").trim().toLowerCase();
  if (query.length < 2) return c.json({ people: [] });
  if (query.length > 255) fail(400, "INVALID_INPUT", "Search is too long");
  return c.json({ people: await rows(c.env,
    `SELECT u.id,u.display_name,u.email_address FROM users u WHERE ${active("u")} AND instr(lower(COALESCE(u.display_name,'')||' '||u.email_address),?)>0 ORDER BY u.display_name,u.email_address,u.id LIMIT 20`, query) });
});
calendar.get("/changes", async (c) => {
  const user = c.get("identity").user,
    available = await calendars(c, true),
    scope = JSON.stringify([
      "changes",
      user.auth_version,
      user.role_assignment_version,
      available.map((cal) => [cal.id, cal.effective_role, cal.version]).sort(),
    ]),
    token = c.req.query("cursor"),
    after = token ? Number(await readCursor(c.env, user.id, scope, token)) : 0,
    limit = pageLimit(c);
  if (!Number.isSafeInteger(after) || after < 0)
    fail(400, "INVALID_CURSOR", "Invalid change cursor");
  const values = await rows<{
      seq: number;
      calendar_id: string | null;
      resource_type: string;
      resource_id: string;
      occurrence_key: string | null;
      operation: string;
      version: number;
    }>(
      c.env,
      `SELECT seq,calendar_id,resource_type,resource_id,occurrence_key,operation,version FROM calendar_changes WHERE seq>? AND (audience_user_id=? OR (audience_user_id IS NULL AND calendar_id IN (SELECT value FROM json_each(?)))) ORDER BY seq LIMIT ?`,
      after,
      user.id,
      JSON.stringify(available.map((cal) => cal.id)),
      limit + 1,
    ),
    page = values.slice(0, limit);
  return c.json({
    changes: page.map(({ seq, ...value }) => value),
    has_more: values.length > limit,
    cursor: await cursor(c.env, user.id, scope, page.at(-1)?.seq ?? after),
  });
});
calendar.route("/", calendarRoutes);
calendar.route("/", eventRoutes);
calendar.route("/", importRoutes);
calendar.route("/", feedRoutes);
calendar.route("/", personalRoutes);
calendar.route("/", sharingRoutes);
calendar.route("/", linkRoutes);
calendar.route("/", attendeeRoutes);
calendar.route("/", registrationRoutes);
calendar.route("/", availabilityRoutes);
calendar.route("/", attachmentRoutes);
calendar.route("/", proposalRoutes);
export default calendar;
