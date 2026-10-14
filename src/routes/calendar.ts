import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { requireAccess } from "../auth/store";
import { requirePermission, permissionsFor } from "../authorization/access";
import calendarRoutes, {
  calendarDto,
  ensurePrimary,
  preferences,
  subscriptions,
} from "../calendar/calendars";
import eventRoutes from "../calendar/events";
import personalRoutes from "../calendar/personal";
import { calendars, rows } from "../calendar/access";
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
calendar.use("*", async (c, next) => {
  await ensurePrimary(c);
  await next();
});
calendar.get("/capabilities", async (c) =>
  c.json({
    ...capabilities,
    permissions: (
      await permissionsFor(c.get("db"), c.get("identity").user.id)
    ).filter((key) => key.startsWith("calendar.")),
  }),
);
calendar.get("/bootstrap", async (c) => {
  const list = await calendars(c),
    primary = list.find((cal) => cal.is_primary)!,
    labels = await rows(
      c.env,
      "SELECT * FROM calendar_labels WHERE calendar_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL ORDER BY sort_order,id",
      JSON.stringify(
        list
          .filter((cal) =>
            ["writer", "manager", "data_owner"].includes(cal.effective_role),
          )
          .map((cal) => cal.id),
      ),
    );
  return c.json({
    primary_calendar_id: primary.id,
    calendars: list.map(calendarDto),
    subscriptions: await subscriptions(c),
    preferences: await preferences(c),
    labels,
    capabilities,
  });
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
calendar.route("/", personalRoutes);
calendar.route("/", sharingRoutes);
calendar.route("/", linkRoutes);
calendar.route("/", attendeeRoutes);
calendar.route("/", registrationRoutes);
calendar.route("/", availabilityRoutes);
calendar.route("/", attachmentRoutes);
calendar.route("/", proposalRoutes);
export default calendar;
