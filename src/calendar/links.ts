import { Hono } from "hono";
import { now, uuid, type AppEnv } from "../auth/types";
import { digest, random } from "../auth/crypto";
import { hashPassword, verifyPassword } from "../auth/password";
import type { CalendarContext, Calendar, Event, Bind } from "./types";
import type { ShareLink, LinkSession } from "./collaboration-types";
import {
  active,
  calendarAccess,
  calendarCondition,
  condition,
  combine,
  first,
  permission,
  requireCalendar,
  requireEvent,
  rows,
} from "./access";
import { body, choice, expectedVersion, fail, flag, identifier, integer, text } from "./input";
import { insert, mutate, update } from "./mutations";
import { settings } from "./sharing";
import { occurrence } from "./attendance-store";
import { interval, queryRange } from "./time";
export const sharedFields = [
  "title",
  "description_html",
  "location",
  "organizer",
  "attachments",
] as const;
function fields(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > sharedFields.length ||
    value.some((item) => !sharedFields.includes(item))
  )
    fail(400, "INVALID_INPUT", "Invalid shared fields");
  return [...new Set(value)] as string[];
}
export function linkDto(link: ShareLink) {
  const { token_hash, password_hash, ...rest } = link;
  return {
    ...rest,
    shared_fields: JSON.parse(link.shared_fields_json),
    shared_fields_json: undefined,
    allow_ics: !!link.allow_ics,
    password_protected: !!password_hash,
  };
}
export function inLinkRange(
  link: Pick<ShareLink, "time_min" | "time_max">,
  event: Event,
  cal: Calendar,
) {
  const value = interval(event, cal.time_zone);
  return (
    (link.time_min === null || value.max > link.time_min) &&
    (link.time_max === null || value.min < link.time_max)
  );
}
export function assertLinkOccurrence(link: ShareLink, event: Event, cal: Calendar) {
  if (!inLinkRange(link, event, cal))
    fail(404, "OCCURRENCE_NOT_SHARED", "This occurrence is outside the shared date range");
}
export async function limitPublic(c: CalendarContext, bucket: string, max: number, seconds = 3600) {
  const window = Math.floor(now() / seconds) * seconds,
    hash = await digest(bucket),
    result = await c.env.DB.withSession("first-primary")
      .prepare(
        "INSERT INTO calendar_public_limits(bucket,window_start,attempts) VALUES(?,?,1) ON CONFLICT(bucket,window_start) DO UPDATE SET attempts=attempts+1 RETURNING attempts",
      )
      .bind(hash, window)
      .first<{ attempts: number }>();
  if (result!.attempts > max) fail(429, "RATE_LIMITED", "Too many requests. Try again later");
}
export function publicHeaders(c: CalendarContext) {
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET") {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin)
      fail(403, "INVALID_ORIGIN", "Invalid request origin");
  }
}
export function linkCondition(link: ShareLink) {
  const access = calendarAccess(link.created_by, "cal", 5),
    allowed = permission(link.created_by, "calendar.sharing.external");
  return condition(
    `EXISTS(SELECT 1 FROM calendar_share_links l JOIN calendars cal ON cal.id=l.calendar_id JOIN users creator ON creator.id=l.created_by JOIN calendar_workspace_settings cfg ON cfg.id='workspace' WHERE l.id=? AND l.access_version=? AND l.revoked_at IS NULL AND l.expires_at>unixepoch() AND cfg.external_sharing_enabled=1 AND ${active("creator")} AND ${access.sql} AND ${allowed.sql} AND (l.event_id IS NULL OR EXISTS(SELECT 1 FROM calendar_events e WHERE e.id=l.event_id AND e.organizer_calendar_id=l.calendar_id AND e.trashed_at IS NULL AND e.status<>'cancelled')))`,
    link.id,
    link.access_version,
    ...access.args,
    ...allowed.args,
  );
}
export async function publicLink(c: CalendarContext) {
  const token = text(c.req.param("token"), "token", 100);
  if (!/^ofcl_[A-Za-z0-9_-]{43}$/.test(token)) fail(404, "LINK_NOT_FOUND", "Share link not found");
  const link = await first<ShareLink>(
    c.env,
    "SELECT * FROM calendar_share_links WHERE token_hash=?",
    await digest(token),
  );
  if (!link) fail(404, "LINK_NOT_FOUND", "Share link not found");
  const auth = linkCondition(link);
  if (!(await first(c.env, `SELECT 1 WHERE ${auth.sql}`, ...auth.args)))
    fail(404, "LINK_NOT_FOUND", "Share link not found");
  const cal = (await first<Calendar>(
    c.env,
    "SELECT * FROM calendars WHERE id=?",
    link.calendar_id,
  ))!;
  const event = link.event_id
    ? (await first<Event>(c.env, "SELECT * FROM calendar_events WHERE id=?", link.event_id))!
    : null;
  if (event && link.occurrence_key)
    assertLinkOccurrence(link, await occurrence(c, event, link.occurrence_key), cal);
  return { link, cal, event, auth };
}
export async function linkSession(c: CalendarContext, link: ShareLink, required = false) {
  const token = c.req.header("X-Calendar-Link-Session");
  if (!token) {
    if (required || link.password_hash)
      fail(403, "LINK_SESSION_REQUIRED", "A valid link session is required");
    return null;
  }
  if (!/^ofcs_[A-Za-z0-9_-]{43}$/.test(token))
    fail(403, "LINK_SESSION_REQUIRED", "A valid link session is required");
  const value = await first<LinkSession>(
    c.env,
    "SELECT * FROM calendar_link_sessions WHERE token_hash=? AND share_link_id=? AND link_access_version=? AND expires_at>unixepoch() AND revoked_at IS NULL",
    await digest(token),
    link.id,
    link.access_version,
  );
  if (!value) fail(403, "LINK_SESSION_REQUIRED", "A valid link session is required");
  return value;
}
export const sessionCondition = (session: LinkSession) =>
  condition(
    "EXISTS(SELECT 1 FROM calendar_link_sessions WHERE id=? AND link_access_version=? AND revoked_at IS NULL AND expires_at>unixepoch())",
    session.id,
    session.link_access_version,
  );
const routes = new Hono<AppEnv>();
const paths = [
  "/calendars/:calendarId/share-links",
  "/calendars/:calendarId/events/:eventId/share-links",
];
for (const path of paths) {
  routes.get(path, async (c) => {
    const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
      id = c.req.param("eventId");
    if (id) await requireEvent(c, cal, identifier(id), true);
    return c.json({
      links: (
        await rows<ShareLink>(
          c.env,
          `SELECT * FROM calendar_share_links WHERE calendar_id=? AND event_id ${id ? "=?" : "IS NULL"} ORDER BY created_at DESC,id`,
          cal.id,
          ...(id ? [id] : []),
        )
      ).map(linkDto),
    });
  });
  routes.post(path, async (c) => {
    const data = await body(c, [
        "mode",
        "occurrence_key",
        "shared_fields",
        "allow_ics",
        "expires_at",
        "password",
        "time_min",
        "time_max",
      ]),
      cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
      event = c.req.param("eventId")
        ? await requireEvent(c, cal, identifier(c.req.param("eventId")), true)
        : null,
      config = await settings(c);
    if (!config.external_sharing_enabled)
      fail(403, "SHARING_DISABLED", "External sharing is disabled");
    const mode = choice(data.mode ?? "view", "mode", ["view", "join"]);
    if (!event && mode === "join") fail(400, "INVALID_LINK", "Calendar links support viewing only");
    const key =
      data.occurrence_key === undefined ? null : text(data.occurrence_key, "occurrence_key", 64);
    if (key && !event) fail(400, "INVALID_SCOPE", "A calendar link has no occurrence scope");
    if (key) await occurrence(c, event!, key);
    const max = now() + config.public_link_max_days * 86400,
      expires =
        data.expires_at === undefined
          ? max
          : integer(data.expires_at, "expires_at", now() + 1, max),
      password = data.password == null ? null : text(data.password, "password", 128);
    if (password && password.length < 8)
      fail(400, "INVALID_PASSWORD", "Link passwords need at least 8 characters");
    if (config.public_link_password_required && !password)
      fail(403, "PASSWORD_REQUIRED", "Workspace policy requires link passwords");
    const range =
        data.time_min === undefined && data.time_max === undefined
          ? null
          : queryRange(data.time_min, data.time_max),
      token = `ofcl_${random()}`,
      id = uuid(),
      value: ShareLink = {
        id,
        calendar_id: cal.id,
        event_id: event?.id ?? null,
        target_type: event ? "event" : "calendar",
        occurrence_key: key,
        mode,
        token_hash: await digest(token),
        password_hash: password ? await hashPassword(password) : null,
        shared_fields_json: JSON.stringify(fields(data.shared_fields ?? ["title"])),
        allow_ics: data.allow_ics === undefined ? 0 : flag(data.allow_ics, "allow_ics"),
        time_min: range?.min ?? null,
        time_max: range?.max ?? null,
        access_version: 1,
        version: 1,
        created_by: c.get("identity").user.id,
        expires_at: expires,
        revoked_at: null,
        created_at: now(),
      };
    if (event && (key || event.recurrence_json === "[]"))
      assertLinkOccurrence(value, key ? await occurrence(c, event, key) : event, cal);
    const result = await mutate(c, {
      action: "calendar.sharing.external",
      operation: `link.create:${cal.id}:${event?.id ?? ""}`,
      idempotent: true,
      secretResult: true,
      request: data,
      result: {
        link: {
          ...linkDto(value),
          token,
          url: new URL(`/api/calendar/public/share-links/${token}`, c.req.url).href,
        },
      },
      calendar: cal.id,
      event: event?.id,
      checks: [
        calendarCondition(c, cal, 5),
        ...(event ? [eventAvailableCondition(event)] : []),
        condition(
          "EXISTS(SELECT 1 FROM calendar_workspace_settings WHERE id='workspace' AND version=? AND external_sharing_enabled=1)",
          config.version,
        ),
      ],
      build: (proof) => [
        insert(c, "calendar_share_links", value as unknown as Record<string, Bind>, proof),
      ],
    });
    return c.json(result, 201);
  });
}
const eventAvailableCondition = (event: Event) =>
  condition(
    "EXISTS(SELECT 1 FROM calendar_events WHERE id=? AND version=? AND trashed_at IS NULL AND status<>'cancelled')",
    event.id,
    event.version,
  );
async function managedLink(c: CalendarContext) {
  const link = await first<ShareLink>(
    c.env,
    "SELECT * FROM calendar_share_links WHERE id=? AND revoked_at IS NULL",
    identifier(c.req.param("linkId")),
  );
  if (!link) fail(404, "LINK_NOT_FOUND", "Share link not found");
  const cal = await requireCalendar(c, link.calendar_id, 5);
  return { link, cal };
}
routes.on(["PATCH", "DELETE"], "/share-links/:linkId", async (c) => {
  const data =
      c.req.method === "PATCH"
        ? await body(c, ["version", "password", "shared_fields", "expires_at", "allow_ics"])
        : {},
    version = expectedVersion(c, data),
    { link, cal } = await managedLink(c),
    cfg = await settings(c),
    values: Record<string, Bind> = {
      version: version + 1,
      access_version: link.access_version + 1,
    };
  if (c.req.method === "DELETE") values.revoked_at = now();
  if ("shared_fields" in data)
    values.shared_fields_json = JSON.stringify(fields(data.shared_fields));
  if ("allow_ics" in data) values.allow_ics = flag(data.allow_ics, "allow_ics");
  if ("expires_at" in data)
    values.expires_at = integer(
      data.expires_at,
      "expires_at",
      now() + 1,
      now() + cfg.public_link_max_days * 86400,
    );
  if ("password" in data) {
    const password = data.password === null ? null : text(data.password, "password", 128);
    if (password && password.length < 8)
      fail(400, "INVALID_PASSWORD", "Link passwords need at least 8 characters");
    if (cfg.public_link_password_required && !password)
      fail(403, "PASSWORD_REQUIRED", "Workspace policy requires link passwords");
    values.password_hash = password ? await hashPassword(password) : null;
  }
  await mutate(c, {
    action: "calendar.sharing.external",
    operation: "link.change",
    request: { id: link.id, version, ...data },
    result: null,
    calendar: cal.id,
    checks: [
      calendarCondition(c, cal, 5),
      condition(
        "EXISTS(SELECT 1 FROM calendar_share_links WHERE id=? AND version=? AND revoked_at IS NULL)",
        link.id,
        version,
      ),
    ],
    build: (proof) => [update(c, "calendar_share_links", values, "id=?", [link.id], proof)],
  });
  return c.req.method === "DELETE"
    ? c.body(null, 204)
    : c.json({ link: linkDto({ ...link, ...values } as ShareLink) });
});
routes.post("/share-links/:linkId/rotate", async (c) => {
  const data = await body(c, ["version"]),
    version = expectedVersion(c, data),
    { link, cal } = await managedLink(c),
    token = `ofcl_${random()}`,
    hash = await digest(token),
    result = await mutate(c, {
      action: "calendar.sharing.external",
      operation: `link.rotate:${link.id}`,
      idempotent: true,
      secretResult: true,
      request: data,
      result: {
        link: {
          id: link.id,
          version: version + 1,
          access_version: link.access_version + 1,
          token,
          url: new URL(`/api/calendar/public/share-links/${token}`, c.req.url).href,
        },
      },
      checks: [
        calendarCondition(c, cal, 5),
        condition(
          "EXISTS(SELECT 1 FROM calendar_share_links WHERE id=? AND version=? AND revoked_at IS NULL)",
          link.id,
          version,
        ),
      ],
      build: (proof) => [
        update(
          c,
          "calendar_share_links",
          {
            token_hash: hash,
            version: version + 1,
            access_version: link.access_version + 1,
          },
          "id=?",
          [link.id],
          proof,
        ),
      ],
    });
  return c.json(result);
});
export const linkSessions = new Hono<AppEnv>();
linkSessions.post("/public/share-links/:token/sessions", async (c) => {
  const data = await body(c, ["password"]),
    { link, auth } = await publicLink(c);
  await limitPublic(
    c,
    `password:${link.id}:${c.req.header("cf-connecting-ip") ?? "unknown"}`,
    10,
    600,
  );
  if (
    link.password_hash &&
    !(await verifyPassword(text(data.password, "password", 128), link.password_hash))
  )
    fail(403, "INVALID_PASSWORD", "Invalid link password");
  const id = uuid(),
    token = `ofcs_${random()}`,
    expires = now() + 1800,
    hash = await digest(token),
    result = await mutate(c, {
      operation: `link.session:${link.id}`,
      secretResult: true,
      principal: { actor_key: `anonymous:${id}`, actor_user_id: null, auth },
      request: data,
      result: { session_token: token, expires_at: expires },
      checks: [],
      build: (proof) => [
        insert(
          c,
          "calendar_link_sessions",
          {
            id,
            share_link_id: link.id,
            token_hash: hash,
            link_access_version: link.access_version,
            expires_at: expires,
          },
          proof,
        ),
      ],
    });
  return c.json(result, 201);
});
export default routes;
