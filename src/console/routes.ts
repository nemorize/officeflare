import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { t } from "../../shared/i18n/index.ts";
import { serviceDefaults } from "../../shared/console-settings";
import { body, invalid } from "../auth/input";
import { accessClaim, requireAccess } from "../auth/store";
import { now, uuid, type AppEnv } from "../auth/types";
import { can, permissionCondition, requirePermission } from "../authorization/access";
import type { Permission } from "../authorization/permissions";
import { accessWon } from "../db/auth-conditions";
import { insertWhen } from "../db/conditional-insert";
import { consoleAudit, consoleSettings } from "../db/schema";
import { serviceSettings, validSettingsService, validateSetting } from "./settings";

export const workspaceConfiguration = new Hono<AppEnv>();
workspaceConfiguration.get("/", requireAccess, async (c) =>
  c.json((await serviceSettings(c.env, "general")).values),
);

const routes = new Hono<AppEnv>();
routes.use("*", requireAccess, requirePermission("console.access"));
function denied(): never {
  throw new HTTPException(403, { message: t("authorizationAccess.permissionDenied") });
}
function missing(): never {
  throw new HTTPException(404, { message: t("routesApi.notFound") });
}
routes.get("/:service/settings", async (c) => {
  const service = c.req.param("service");
  if (!validSettingsService(service)) return missing();
  const permission =
    service === "general"
      ? "admin.workspace.settings.read"
      : service === "contacts"
        ? "admin.contacts.settings.read"
        : "admin.wiki.settings.read";
  if (!(await can(c, permission))) denied();
  return c.json({ settings: await serviceSettings(c.env, service) });
});
routes.patch("/:service/settings", async (c) => {
  const service = c.req.param("service");
  if (!validSettingsService(service)) return missing();
  const permission =
    service === "general"
      ? "admin.workspace.settings.manage"
      : service === "contacts"
        ? "admin.contacts.settings.manage"
        : "admin.wiki.settings.manage";
  if (!(await can(c, permission))) denied();
  const data = await body(c, ["version", ...Object.keys(serviceDefaults[service])]);
  if (!Number.isSafeInteger(data.version) || Number(data.version) < 1) invalid();
  const current = await serviceSettings(c.env, service);
  if (current.version !== data.version)
    throw new HTTPException(412, { message: t("consoleAdmin.settingsChanged") });
  const values = { ...current.values };
  const changed: string[] = [];
  for (const [key, input] of Object.entries(data)) {
    if (key === "version") continue;
    const value = validateSetting(service, key, input);
    if (value !== values[key]) {
      values[key] = value;
      changed.push(key);
    }
  }
  if (!changed.length) return c.json({ settings: current });
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    operation = uuid(),
    stamp = now();
  const [claim, updated] = await db.batch([
    accessClaim(c, operation, permissionCondition(db, user.id, permission)),
    db
      .update(consoleSettings)
      .set({
        values_json: JSON.stringify(values),
        version: current.version + 1,
        updated_at: stamp,
        updated_by: user.id,
        operation_id: operation,
      })
      .where(
        and(
          eq(consoleSettings.service, service),
          eq(consoleSettings.version, current.version),
          accessWon(db, session.id, operation),
        ),
      )
      .returning(),
    insertWhen(
      db,
      consoleAudit,
      {
        id: operation,
        service,
        actor_user_id: user.id,
        action: "settings.updated",
        changed_keys_json: JSON.stringify(changed),
        created_at: stamp,
      },
      sql`EXISTS(SELECT 1 FROM console_settings WHERE service=${service} AND operation_id=${operation})`,
    ),
  ]);
  if (claim.meta.changes !== 1) denied();
  if (!updated.length) throw new HTTPException(412, { message: t("consoleAdmin.settingsChanged") });
  return c.json({ settings: { values, version: current.version + 1, updated_at: stamp } });
});

const accountRecords = `SELECT u.id,COALESCE(u.display_name,u.email_address) name,u.email_address owner,
  CASE WHEN u.disabled_at IS NULL THEN 'active' ELSE 'disabled' END status,
  (SELECT COUNT(*) FROM contacts x JOIN contact_books b ON b.id=x.book_id WHERE b.owner_user_id=u.id) contacts_count,
  (SELECT COUNT(*) FROM contacts x JOIN contact_books b ON b.id=x.book_id WHERE b.owner_user_id=u.id AND x.trashed_at IS NOT NULL) trashed_count,
  (SELECT COUNT(*) FROM contact_folders x JOIN contact_books b ON b.id=x.book_id WHERE b.owner_user_id=u.id) folders_count,
  (SELECT COUNT(*) FROM contact_field_definitions x JOIN contact_books b ON b.id=x.book_id WHERE b.owner_user_id=u.id) fields_count,u.created_at
  FROM users u WHERE u.deleted_at IS NULL`;
const configurationAudit = (service: string) =>
  `SELECT a.id,a.action name,COALESCE(u.display_name,u.email_address) owner,CASE WHEN a.action='settings.updated' THEN 'configuration' ELSE 'content' END status,a.created_at FROM console_audit a JOIN users u ON u.id=a.actor_user_id WHERE a.service='${service}'`;
const catalogs: Record<string, { permission: Permission; query: string }> = {
  "contacts/accounts": { permission: "admin.contacts.accounts.read", query: accountRecords },
  "contacts/contacts": { permission: "admin.contacts.accounts.read", query: accountRecords },
  "contacts/folders": { permission: "admin.contacts.accounts.read", query: accountRecords },
  "contacts/fields": { permission: "admin.contacts.accounts.read", query: accountRecords },
  "contacts/activity": {
    permission: "admin.contacts.audit.read",
    query: configurationAudit("contacts"),
  },
  "wiki/spaces": {
    permission: "admin.wiki.content.read",
    query: `SELECT s.id,s.name,COALESCE(u.display_name,u.email_address) owner,CASE WHEN s.archived_at IS NULL THEN 'active' ELSE 'archived' END status,(SELECT COUNT(*) FROM wiki_pages p WHERE p.space_id=s.id AND p.purged_at IS NULL) pages_count,(SELECT COUNT(*) FROM wiki_space_members m WHERE m.space_id=s.id) members_count,s.created_at FROM wiki_spaces s JOIN users u ON u.id=s.owner_user_id WHERE s.kind='team'`,
  },
  "wiki/pages": {
    permission: "admin.wiki.content.read",
    query: `SELECT p.id,p.title name,s.name space_name,COALESCE(u.display_name,u.email_address) owner,CASE WHEN p.trashed_at IS NULL THEN 'active' ELSE 'trashed' END status,p.updated_at,p.created_at FROM wiki_pages p JOIN wiki_spaces s ON s.id=p.space_id JOIN users u ON u.id=p.created_by WHERE s.kind='team' AND p.purged_at IS NULL`,
  },
  "wiki/sharing": {
    permission: "admin.wiki.content.read",
    query: `SELECT s.id||':'||m.user_id id,s.name,COALESCE(u.display_name,u.email_address) owner,m.role,'space' status,m.created_at FROM wiki_space_members m JOIN wiki_spaces s ON s.id=m.space_id JOIN users u ON u.id=m.user_id WHERE s.kind='team' UNION ALL SELECT p.id||':'||g.user_id,p.title,COALESCE(u.display_name,u.email_address),g.role,'page',g.created_at FROM wiki_page_grants g JOIN wiki_pages p ON p.id=g.page_id JOIN wiki_spaces s ON s.id=p.space_id JOIN users u ON u.id=g.user_id WHERE s.kind='team' AND p.purged_at IS NULL`,
  },
  "wiki/activity": {
    permission: "admin.wiki.audit.read",
    query: `${configurationAudit("wiki")} UNION ALL SELECT a.id,a.action,COALESCE(u.display_name,u.email_address),'content',a.created_at FROM wiki_activity a JOIN wiki_spaces s ON s.id=a.space_id LEFT JOIN users u ON u.id=a.actor_user_id WHERE s.kind='team'`,
  },
  "calendar/calendars": {
    permission: "admin.calendar.records.read",
    query: `SELECT cal.id,cal.name,COALESCE(u.display_name,u.email_address) owner,cal.kind,cal.status,cal.time_zone,(SELECT COUNT(*) FROM calendar_events e WHERE e.organizer_calendar_id=cal.id AND e.status!='cancelled') events_count,cal.created_at FROM calendars cal JOIN users u ON u.id=cal.data_owner_user_id WHERE cal.trashed_at IS NULL`,
  },
  "calendar/sharing": {
    permission: "admin.calendar.records.read",
    query: `SELECT l.id,cal.name,COALESCE(u.display_name,u.email_address) owner,l.mode,CASE WHEN l.revoked_at IS NOT NULL THEN 'revoked' WHEN l.expires_at<=unixepoch() THEN 'expired' ELSE 'active' END status,l.expires_at,l.created_at FROM calendar_share_links l JOIN calendars cal ON cal.id=l.calendar_id JOIN users u ON u.id=l.created_by`,
  },
  "calendar/invitations": {
    permission: "admin.calendar.records.read",
    query: `SELECT id,action name,COALESCE(recipient_email,recipient_user_id,'') owner,channel,status,created_at FROM calendar_invitation_deliveries`,
  },
  "calendar/integrations": {
    permission: "admin.calendar.records.read",
    query: `SELECT cal.id,cal.name,COALESCE(u.display_name,u.email_address) owner,f.source_host,CASE WHEN f.enabled=0 THEN 'paused' WHEN f.error_code IS NOT NULL THEN 'error' ELSE 'active' END status,f.event_count events_count,f.last_success_at,cal.created_at FROM calendar_feeds f JOIN calendars cal ON cal.id=f.calendar_id JOIN users u ON u.id=cal.data_owner_user_id`,
  },
  "calendar/activity": {
    permission: "admin.calendar.records.read",
    query: `SELECT a.id,a.action name,COALESCE(u.display_name,u.email_address,'') owner,'calendar' status,a.created_at FROM calendar_activity a LEFT JOIN users u ON u.id=a.actor_user_id`,
  },
};
const summaries: Record<string, { permission: Permission; query: string }> = {
  contacts: {
    permission: "admin.contacts.accounts.read",
    query:
      "SELECT (SELECT COUNT(*) FROM contact_books) accounts,(SELECT COUNT(*) FROM contacts WHERE trashed_at IS NULL) contacts,(SELECT COUNT(*) FROM contacts WHERE trashed_at IS NOT NULL) trashed,(SELECT COUNT(*) FROM contact_folders) folders,(SELECT COUNT(*) FROM contact_field_definitions WHERE archived_at IS NULL) fields",
  },
  wiki: {
    permission: "admin.wiki.content.read",
    query:
      "SELECT (SELECT COUNT(*) FROM wiki_spaces WHERE kind='team' AND archived_at IS NULL) spaces,(SELECT COUNT(*) FROM wiki_pages p JOIN wiki_spaces s ON s.id=p.space_id WHERE s.kind='team' AND p.trashed_at IS NULL AND p.purged_at IS NULL) pages,(SELECT COUNT(*) FROM wiki_pages p JOIN wiki_spaces s ON s.id=p.space_id WHERE s.kind='team' AND p.trashed_at IS NOT NULL AND p.purged_at IS NULL) trashed,(SELECT COUNT(*) FROM wiki_space_members m JOIN wiki_spaces s ON s.id=m.space_id WHERE s.kind='team') members",
  },
  calendar: {
    permission: "admin.calendar.records.read",
    query:
      "SELECT (SELECT COUNT(*) FROM calendars WHERE trashed_at IS NULL) calendars,(SELECT COUNT(*) FROM calendar_events WHERE status!='cancelled') events,(SELECT COUNT(*) FROM calendar_feeds WHERE enabled=1) subscriptions,(SELECT COUNT(*) FROM calendar_share_links WHERE revoked_at IS NULL AND expires_at>unixepoch()) links,(SELECT COUNT(*) FROM calendar_invitation_deliveries WHERE status IN ('queued','retry_wait')) queued,(SELECT COUNT(*) FROM calendar_invitation_deliveries WHERE status IN ('unknown','failed')) failed",
  },
};
routes.get("/:service/:page", async (c) => {
  const service = c.req.param("service"),
    page = c.req.param("page");
  if (page === "overview") {
    const config = summaries[service];
    if (!config) return missing();
    if (!(await can(c, config.permission))) denied();
    return c.json({
      summary: await c.env.DB.withSession("first-primary")
        .prepare(config.query)
        .first<Record<string, number>>(),
    });
  }
  const config = catalogs[`${service}/${page}`];
  if (!config) return missing();
  if (!(await can(c, config.permission))) denied();
  const offset = Number(c.req.query("cursor") ?? 0),
    query = (c.req.query("q") ?? "").trim().toLowerCase();
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || query.length > 200)
    invalid();
  const result = await c.env.DB.withSession("first-primary")
    .prepare(
      `SELECT * FROM (${config.query}) records WHERE instr(lower(COALESCE(name,'')||' '||COALESCE(owner,'')),?)>0 ORDER BY created_at DESC,id LIMIT 51 OFFSET ?`,
    )
    .bind(query, offset)
    .all();
  return c.json({
    items: result.results.slice(0, 50),
    next_cursor: result.results.length > 50 ? String(offset + 50) : null,
  });
});
export default routes;
