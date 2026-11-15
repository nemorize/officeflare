import { t, type StaticMessageKey } from "../../shared/i18n/index.ts";
import type { ConsoleService } from "../../shared/console-settings";
export interface AdminField {
  key: string;
  label: StaticMessageKey;
  kind: "checkbox" | "number" | "text" | "url" | "select";
  hint?: StaticMessageKey;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}
export interface AdminColumn {
  key: string;
  label: StaticMessageKey;
  kind?: "date" | "status";
}
export interface AdminTab {
  page: string;
  label: StaticMessageKey;
  description: StaticMessageKey;
  permissions: string[];
  fields?: AdminField[];
  records?: { permission: string; columns: AdminColumn[] };
}
const name: AdminColumn = { key: "name", label: "common.name" },
  owner: AdminColumn = { key: "owner", label: "consoleSettings.owner" },
  status: AdminColumn = { key: "status", label: "common.status", kind: "status" },
  created: AdminColumn = { key: "created_at", label: "consoleSettings.time", kind: "date" };
const column = (key: string, label: StaticMessageKey, kind?: AdminColumn["kind"]): AdminColumn => ({
  key,
  label,
  kind,
});
const field = (
  key: string,
  label: StaticMessageKey,
  kind: AdminField["kind"] = "checkbox",
  extras: Partial<AdminField> = {},
): AdminField => ({ key, label, kind, ...extras });
const accounts = "admin.contacts.accounts.read",
  contacts = "admin.contacts.settings.read",
  wiki = "admin.wiki.settings.read",
  content = "admin.wiki.content.read",
  calendar = "admin.calendar.settings.read",
  records = "admin.calendar.records.read",
  general = "admin.workspace.settings.read";
const overview = (permission: string): AdminTab => ({
  page: "overview",
  label: "consoleSettings.overview",
  description: "consoleAdmin.overviewHint",
  permissions: [permission],
});
const activity = (permission: string): AdminTab => ({
  page: "activity",
  label: "consoleSettings.audit",
  description: "consoleAdmin.activityHint",
  permissions: [permission],
  records: { permission, columns: [created, name, owner, status] },
});
const accountColumns = [
  name,
  owner,
  column("contacts_count", "consoleAdmin.contactsCount"),
  column("folders_count", "consoleAdmin.foldersCount"),
  column("fields_count", "consoleAdmin.fieldsCount"),
  status,
];
const limit = (key: string, label: StaticMessageKey) =>
  field(key, label, "number", { min: 0, max: 1000000, hint: "consoleAdmin.limitHint" });
export const serviceTabs: Record<ConsoleService, AdminTab[]> = {
  general: [
    {
      page: "workspace",
      label: "consoleAdmin.workspace",
      description: "consoleAdmin.workspaceHint",
      permissions: [general],
      fields: [
        field("workspace_name", "consoleAdmin.workspaceName", "text"),
        field("support_url", "consoleAdmin.supportUrl", "url", {
          hint: "consoleAdmin.supportHint",
        }),
      ],
    },
    {
      page: "regional",
      label: "consoleAdmin.regional",
      description: "consoleAdmin.regionalHint",
      permissions: [general],
      fields: [
        field("default_language", "consoleAdmin.defaultLanguage", "select", {
          options: [
            { value: "system", label: t("consoleAdmin.systemLanguage") },
            { value: "ko", label: "한국어" },
            { value: "en", label: "English" },
            { value: "ja", label: "日本語" },
          ],
        }),
        field("default_time_zone", "consoleAdmin.timeZone", "text", {
          hint: "consoleAdmin.timeZoneHint",
        }),
        field("default_regional_format", "consoleAdmin.regionalFormat", "select", {
          options: [
            { value: "en", label: "English" },
            { value: "ko-KR", label: "한국 (ko-KR)" },
            { value: "en-US", label: "United States (en-US)" },
            { value: "ja-JP", label: "日本 (ja-JP)" },
          ],
        }),
      ],
    },
    {
      page: "notifications",
      label: "consoleAdmin.notifications",
      description: "push.adminDescription",
      permissions: ["admin.notifications.settings.read"],
    },
  ],
  calendar: [
    overview(records),
    {
      page: "calendars",
      label: "consoleAdmin.calendars",
      description: "consoleAdmin.calendarRecordsHint",
      permissions: [records],
      records: {
        permission: records,
        columns: [
          name,
          owner,
          column("kind", "consoleAdmin.type", "status"),
          column("time_zone", "consoleAdmin.timeZone"),
          column("events_count", "consoleAdmin.eventsCount"),
          status,
        ],
      },
    },
    {
      page: "sharing",
      label: "consoleAdmin.sharing",
      description: "consoleAdmin.calendarSharingHint",
      permissions: [calendar, records],
      fields: [
        field("internal_sharing_enabled", "consoleCalendar.internalSharing"),
        field("external_sharing_enabled", "consoleCalendar.externalSharing"),
        field("public_link_password_required", "consoleCalendar.passwordRequired"),
        field("public_link_max_days", "consoleCalendar.maxLinkDays", "number", {
          min: 1,
          max: 365,
        }),
      ],
      records: {
        permission: records,
        columns: [
          name,
          owner,
          column("mode", "consoleAdmin.type", "status"),
          status,
          column("expires_at", "consoleAdmin.expires", "date"),
        ],
      },
    },
    {
      page: "invitations",
      label: "consoleAdmin.invitations",
      description: "consoleAdmin.invitationsHint",
      permissions: [calendar, records],
      fields: [
        field("system_address_id", "consoleCalendar.senderAddress", "select", {
          hint: "consoleCalendar.senderHint",
        }),
      ],
      records: {
        permission: records,
        columns: [
          name,
          owner,
          column("channel", "consoleAdmin.channel", "status"),
          status,
          created,
        ],
      },
    },
    {
      page: "integrations",
      label: "consoleAdmin.integrations",
      description: "consoleAdmin.integrationsHint",
      permissions: [calendar, records],
      fields: [
        field("imports_enabled", "consoleAdmin.allowImports"),
        field("subscriptions_enabled", "consoleAdmin.allowSubscriptions"),
      ],
      records: {
        permission: records,
        columns: [
          name,
          owner,
          column("source_host", "consoleAdmin.source"),
          column("events_count", "consoleAdmin.eventsCount"),
          status,
          column("last_success_at", "consoleAdmin.lastSync", "date"),
        ],
      },
    },
    activity(records),
  ],
  contacts: [
    overview(accounts),
    {
      page: "accounts",
      label: "consoleAdmin.accounts",
      description: "consoleAdmin.contactsPrivacy",
      permissions: [accounts],
      records: { permission: accounts, columns: accountColumns },
    },
    {
      page: "contacts",
      label: "consoleAdmin.contactEntries",
      description: "consoleAdmin.contactEntriesHint",
      permissions: [contacts, accounts],
      fields: [
        field("entries_enabled", "consoleAdmin.allowContacts"),
        limit("max_contacts", "consoleAdmin.maxContacts"),
      ],
      records: {
        permission: accounts,
        columns: [
          name,
          owner,
          column("contacts_count", "consoleAdmin.contactsCount"),
          column("trashed_count", "consoleAdmin.trashedCount"),
        ],
      },
    },
    {
      page: "folders",
      label: "consoleAdmin.folders",
      description: "consoleAdmin.foldersHint",
      permissions: [contacts, accounts],
      fields: [
        field("folders_enabled", "consoleAdmin.allowFolders"),
        limit("max_folders", "consoleAdmin.maxFolders"),
      ],
      records: {
        permission: accounts,
        columns: [name, owner, column("folders_count", "consoleAdmin.foldersCount")],
      },
    },
    {
      page: "fields",
      label: "consoleAdmin.fields",
      description: "consoleAdmin.fieldsHint",
      permissions: [contacts, accounts],
      fields: [
        field("fields_enabled", "consoleAdmin.allowFields"),
        limit("max_fields", "consoleAdmin.maxFields"),
      ],
      records: {
        permission: accounts,
        columns: [name, owner, column("fields_count", "consoleAdmin.fieldsCount")],
      },
    },
    activity("admin.contacts.audit.read"),
  ],
  wiki: [
    overview(content),
    {
      page: "spaces",
      label: "consoleAdmin.spaces",
      description: "consoleAdmin.wikiPrivacy",
      permissions: [content],
      records: {
        permission: content,
        columns: [
          name,
          owner,
          column("pages_count", "consoleAdmin.pagesCount"),
          column("members_count", "consoleAdmin.membersCount"),
          status,
        ],
      },
    },
    {
      page: "pages",
      label: "consoleAdmin.pages",
      description: "consoleAdmin.wikiPagesHint",
      permissions: [content],
      records: {
        permission: content,
        columns: [
          name,
          column("space_name", "consoleAdmin.space"),
          owner,
          status,
          column("updated_at", "consoleAdmin.updated", "date"),
        ],
      },
    },
    {
      page: "sharing",
      label: "consoleAdmin.sharing",
      description: "consoleAdmin.wikiSharingHint",
      permissions: [wiki, content],
      fields: [field("sharing_enabled", "consoleAdmin.allowWikiSharing")],
      records: {
        permission: content,
        columns: [name, owner, column("role", "consoleAdmin.access", "status"), status, created],
      },
    },
    {
      page: "settings",
      label: "consoleSettings.policies",
      description: "consoleAdmin.wikiPolicyHint",
      permissions: [wiki],
      fields: [
        field("spaces_enabled", "consoleAdmin.allowSpaces"),
        field("pages_enabled", "consoleAdmin.allowPages"),
        field("comments_enabled", "consoleAdmin.allowComments"),
      ],
    },
    activity("admin.wiki.audit.read"),
  ],
};
export const servicePermissions = (service: ConsoleService) => [
  ...new Set(serviceTabs[service].flatMap((tab) => tab.permissions)),
];
export const serviceTitle = (service: ConsoleService) =>
  service === "general"
    ? t("consoleAdmin.general")
    : service === "calendar"
      ? t("libWorkspaceNavigation.calendar")
      : service === "contacts"
        ? t("contacts.title")
        : t("wiki.title");
export const settingsReadPermission = (service: ConsoleService) =>
  service === "general"
    ? "admin.workspace.settings.read"
    : service === "calendar"
      ? "admin.calendar.settings.read"
      : service === "contacts"
        ? "admin.contacts.settings.read"
        : "admin.wiki.settings.read";
export const settingsWritePermission = (service: ConsoleService) =>
  settingsReadPermission(service).replace(/\.read$/, ".manage");
export const metricLabels: Record<string, StaticMessageKey> = {
  accounts: "consoleAdmin.accounts",
  contacts: "consoleAdmin.contactsCount",
  trashed: "consoleAdmin.trashedCount",
  folders: "consoleAdmin.foldersCount",
  fields: "consoleAdmin.fieldsCount",
  spaces: "consoleAdmin.spaces",
  pages: "consoleAdmin.pagesCount",
  members: "consoleAdmin.membersCount",
  calendars: "consoleAdmin.calendars",
  events: "consoleAdmin.eventsCount",
  subscriptions: "consoleAdmin.subscriptions",
  links: "consoleAdmin.publicLinks",
  queued: "consoleAdmin.queued",
  failed: "consoleAdmin.failed",
};
