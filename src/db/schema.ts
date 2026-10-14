import { sql } from "drizzle-orm";
import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// Wrangler migrations remain the DDL source, including STRICT tables and MFA triggers.
const timestamp = (name: string) => integer(name).notNull().default(sql`(unixepoch())`);

export const users = sqliteTable("users", {
  id: text().primaryKey().notNull(),
  email_address: text().notNull(),
  display_name: text(),
  profile_image_key: text(),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
  password_hash: text(),
  password_changed_at: integer(),
  last_login_at: integer(),
  disabled_at: integer(),
  password_reset_required: integer().notNull().default(0),
  deleted_at: integer(),
  auth_version: integer().notNull().default(1),
  role_assignment_version: integer().notNull().default(1),
}, (table) => [uniqueIndex("users_active_email_address_unique")
  .on(sql`${table.email_address} COLLATE NOCASE`).where(sql`${table.deleted_at} IS NULL`)]);

export const userProfileFields = sqliteTable("user_profile_fields", {
  id: text().primaryKey().notNull(),
  key: text().notNull().unique(),
  label: text().notNull(),
  value_type: text({ enum: ["text", "number", "boolean", "date", "url", "select", "multiselect"] }).notNull(),
  visibility: text({ enum: ["private", "organization", "admin"] }).notNull().default("private"),
  editable_by: text({ enum: ["admin", "user"] }).notNull().default("admin"),
  required: integer().notNull().default(0),
  options_json: text(),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
  deleted_at: integer(),
});
export const userProfiles = sqliteTable("user_profiles", {
  user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  field_id: text().notNull().references(() => userProfileFields.id, { onDelete: "cascade" }),
  value: text().notNull(),
  updated_at: timestamp("updated_at"),
}, (table) => [primaryKey({ columns: [table.user_id, table.field_id] }), index("user_profiles_field_id_index").on(table.field_id)]);

export const userMfaMethods = sqliteTable("user_mfa_methods", {
  id: text().primaryKey().notNull(),
  user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text().notNull(),
  name: text(),
  created_at: timestamp("created_at"),
  verified_at: integer(),
  last_used_at: integer(),
  revoked_at: integer(),
  setup_expires_at: integer().default(sql`(unixepoch() + 600)`),
}, (table) => [
  index("user_mfa_methods_user_id_type_index").on(table.user_id, table.type),
  index("user_mfa_methods_pending_expiration_index").on(table.setup_expires_at)
    .where(sql`${table.verified_at} IS NULL AND ${table.revoked_at} IS NULL`),
]);
export const userMfaTotp = sqliteTable("user_mfa_totp", {
  method_id: text().primaryKey().notNull().references(() => userMfaMethods.id, { onDelete: "cascade" }),
  secret_ciphertext: blob({ mode: "buffer" }).notNull(),
  secret_nonce: blob({ mode: "buffer" }).notNull(),
  key_version: integer().notNull(),
  algorithm: text({ enum: ["SHA1", "SHA256", "SHA512"] }).notNull().default("SHA1"),
  digits: integer().notNull().default(6),
  period_seconds: integer().notNull().default(30),
  last_accepted_step: integer(),
}, (table) => [uniqueIndex("user_mfa_totp_key_version_secret_nonce_unique").on(table.key_version, table.secret_nonce)]);
export const userMfaRecoveryCodes = sqliteTable("user_mfa_recovery_codes", {
  id: text().primaryKey().notNull(),
  user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  code_hash: text().notNull(),
  created_at: timestamp("created_at"),
  used_at: integer(),
  revoked_at: integer(),
}, (table) => [uniqueIndex("user_mfa_recovery_codes_user_id_code_hash_unique").on(table.user_id, table.code_hash)]);

export const userSessions = sqliteTable("user_sessions", {
  id: text().primaryKey().notNull(),
  user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  auth_version: integer().notNull(),
  created_at: integer().notNull(),
  password_authenticated_at: integer().notNull(),
  mfa_authenticated_at: integer(),
  last_used_at: integer().notNull(),
  last_operation_id: text(),
  expires_at: integer().notNull(),
  revoked_at: integer(),
  user_agent: text(),
}, (table) => [index("user_sessions_user_id_index").on(table.user_id, table.revoked_at, table.expires_at),
  index("user_sessions_expiration_index").on(table.expires_at)]);
export const userRefreshTokens = sqliteTable("user_refresh_tokens", {
  id: text().primaryKey().notNull(),
  session_id: text().notNull().references(() => userSessions.id, { onDelete: "cascade" }),
  token_hash: text().notNull().unique(),
  parent_id: text().references((): AnySQLiteColumn => userRefreshTokens.id),
  created_at: integer().notNull(),
  expires_at: integer().notNull(),
  used_at: integer(),
  used_by: text().unique(),
  revoked_at: integer(),
}, (table) => [index("user_refresh_tokens_session_id_index").on(table.session_id),
  index("user_refresh_tokens_parent_id_index").on(table.parent_id)]);
export const userAuthChallenges = sqliteTable("user_auth_challenges", {
  id: text().primaryKey().notNull(),
  user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  session_id: text().references(() => userSessions.id, { onDelete: "cascade" }),
  token_hash: text().notNull().unique(),
  purpose: text({ enum: ["login", "login_mfa", "password_reset", "reauth_mfa", "reauth"] }).notNull(),
  auth_version: integer().notNull(),
  password_authenticated_at: integer().notNull(),
  mfa_authenticated_at: integer(),
  created_at: integer().notNull(),
  expires_at: integer().notNull(),
  attempts: integer().notNull().default(0),
  used_at: integer(),
  used_by: text().unique(),
}, (table) => [index("user_auth_challenges_user_id_index").on(table.user_id, table.expires_at),
  index("user_auth_challenges_expiration_index").on(table.expires_at)]);
export const authRateLimits = sqliteTable("auth_rate_limits", {
  bucket: text().primaryKey().notNull(),
  attempts: integer().notNull(),
  expires_at: integer().notNull(),
}, (table) => [index("auth_rate_limits_expiration_index").on(table.expires_at)]);

export const roles = sqliteTable("roles", {
  id: text().primaryKey().notNull(),
  key: text().notNull().unique(),
  label: text().notNull(),
  description: text(),
  is_system: integer().notNull().default(0),
  is_default: integer().notNull().default(0),
  version: integer().notNull().default(1),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
});
export const rolePermissions = sqliteTable("role_permissions", {
  role_id: text().notNull().references(() => roles.id, { onDelete: "cascade" }),
  permission_key: text().notNull(),
}, (table) => [primaryKey({ columns: [table.role_id, table.permission_key] })]);
export const userRoles = sqliteTable("user_roles", {
  user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  role_id: text().notNull().references(() => roles.id, { onDelete: "cascade" }),
  assigned_by: text().references(() => users.id, { onDelete: "set null" }),
  assigned_at: timestamp("assigned_at"),
}, (table) => [primaryKey({ columns: [table.user_id, table.role_id] }), index("user_roles_role_id_index").on(table.role_id)]);

// bootstrap_user_id is an audit snapshot, not a cascading foreign key.
export const installationState = sqliteTable("installation_state", {
  id: integer().primaryKey().notNull(),
  initialized_at: timestamp("initialized_at"),
  bootstrap_user_id: text(),
});


// migrations/0009_create_mail_control.sql is the DDL source. Mail contents live in DO SQL.

export const mailProviderConnections = sqliteTable(
  "mail_provider_connections",
  {
    id: text().primaryKey().notNull(),
    provider: text().notNull(),
    name: text().notNull(),
    enabled: integer().notNull().default(1),
    version: integer().notNull().default(1),
    created_at: timestamp("created_at"),
    updated_at: timestamp("updated_at"),
  },
);
export const mailDomains = sqliteTable("mail_domains", {
  is_default: integer().notNull().default(0),
  id: text().primaryKey().notNull(),
  name: text().notNull().unique(),
  inbound_connection_id: text().references(() => mailProviderConnections.id),
  outbound_connection_id: text().references(() => mailProviderConnections.id),
  inbound_enabled: integer().notNull().default(0),
  outbound_enabled: integer().notNull().default(0),
  max_send_bytes: integer(),
  plus_addressing: integer().notNull().default(1),
  catch_all_mailbox_id: text().references(
    (): AnySQLiteColumn => mailMailboxes.id,
  ),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
}, (table) => [uniqueIndex("mail_domains_default_unique").on(table.is_default).where(sql`${table.is_default}=1`)]);
export const mailRoutingRules = sqliteTable(
  "mail_routing_rules",
  {
    id: text().primaryKey().notNull(),
    domain_id: text()
      .notNull()
      .references(() => mailDomains.id, { onDelete: "cascade" }),
    name: text().notNull(),
    priority: integer().notNull().default(0),
    enabled: integer().notNull().default(1),
    conditions_json: text().notNull(),
    action: text({ enum: ["store", "forward", "reject"] }).notNull(),
    forward_to: text(),
    reject_reason: text(),
    version: integer().notNull().default(1),
  },
  (table) => [
    index("mail_routing_rules_domain_index").on(
      table.domain_id,
      table.enabled,
      table.priority,
    ),
  ],
);
export const mailMailboxes = sqliteTable(
  "mail_mailboxes",
  {
    id: text().primaryKey().notNull(),
    owner_user_id: text()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    kind: text({ enum: ["personal", "shared"] })
      .notNull()
      .default("personal"),
    status: text({ enum: ["provisioning", "active", "disabled", "deleted"] })
      .notNull()
      .default("provisioning"),
    created_at: timestamp("created_at"),
    updated_at: timestamp("updated_at"),
  },
  (table) => [
    index("mail_mailboxes_owner_index").on(table.owner_user_id, table.status),
  ],
);
export const mailMailboxMembers = sqliteTable(
  "mail_mailbox_members",
  {
    mailbox_id: text()
      .notNull()
      .references(() => mailMailboxes.id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    can_read: integer().notNull().default(0),
    can_write: integer().notNull().default(0),
    can_send: integer().notNull().default(0),
    can_manage: integer().notNull().default(0),
    updated_at: timestamp("updated_at"),
  },
  (table) => [
    primaryKey({ columns: [table.mailbox_id, table.user_id] }),
    index("mail_members_user_index").on(table.user_id, table.mailbox_id),
  ],
);
export const mailAddresses = sqliteTable(
  "mail_addresses",
  {
    id: text().primaryKey().notNull(),
    domain_id: text()
      .notNull()
      .references(() => mailDomains.id),
    mailbox_id: text()
      .notNull()
      .references(() => mailMailboxes.id),
    local_part: text().notNull(),
    is_primary: integer().notNull().default(0),
    receive_enabled: integer().notNull().default(1),
    send_enabled: integer().notNull().default(1),
    created_at: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("mail_addresses_domain_local_unique").on(
      table.domain_id,
      sql`${table.local_part} COLLATE NOCASE`,
    ),
    index("mail_addresses_mailbox_index").on(table.mailbox_id),
    uniqueIndex("mail_addresses_primary_unique")
      .on(table.mailbox_id)
      .where(sql`${table.is_primary}=1`),
  ],
);
export const mailApiKeys = sqliteTable("mail_api_keys", {
  id: text().primaryKey().notNull(),
  user_id: text()
    .notNull()
    .references(() => users.id),
  name: text().notNull(),
  token_hash: text().notNull().unique(),
  auth_version: integer().notNull(),
  expires_at: integer().notNull(),
  revoked_at: integer(),
  created_at: timestamp("created_at"),
});
export const mailApiKeyScopes = sqliteTable(
  "mail_api_key_scopes",
  {
    key_id: text()
      .notNull()
      .references(() => mailApiKeys.id, { onDelete: "cascade" }),
    mailbox_id: text()
      .notNull()
      .references(() => mailMailboxes.id, { onDelete: "cascade" }),
    action: text({
      enum: ["read", "write", "send"],
    }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key_id, table.mailbox_id, table.action] }),
  ],
);
export const mailWebhooks = sqliteTable(
  "mail_webhooks",
  {
    id: text().primaryKey().notNull(),
    mailbox_id: text()
      .notNull()
      .references(() => mailMailboxes.id),
    owner_user_id: text()
      .notNull()
      .references(() => users.id),
    url: text().notNull(),
    secret_hash: text().notNull(),
    secret_ciphertext: text().notNull(),
    secret_nonce: text().notNull(),
    enabled: integer().notNull().default(1),
    created_at: timestamp("created_at"),
  },
  (table) => [index("mail_webhooks_mailbox_index").on(table.mailbox_id)],
);
export const mailControlOperations = sqliteTable(
  "mail_control_operations",
  {
    id: text().primaryKey().notNull(),
    actor_id: text()
      .notNull()
      .references(() => users.id),
    operation: text().notNull(),
    resource_id: text().notNull(),
    request_hash: text().notNull(),
    status: text({ enum: ["pending", "completed", "failed"] })
      .notNull()
      .default("pending"),
    created_at: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("mail_control_operations_actor_operation_unique").on(
      table.actor_id,
      table.operation,
      table.id,
    ),
  ],
);

export const userMailPreferences = sqliteTable("user_mail_preferences", { user_id: text().primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }), preferences_json: text().notNull(), updated_at: timestamp("updated_at") });

export const notificationEvents = sqliteTable("notification_events", {
  id: text().primaryKey().notNull(), source_key: text().notNull().unique(), type: text().notNull(),
  title: text().notNull(), body: text().notNull(), target_path: text(), created_at: timestamp("created_at"),
});
export const notificationInbox = sqliteTable("notification_inbox", {
  seq: integer().primaryKey({ autoIncrement: true }), id: text().notNull().unique(),
  user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  event_id: text().notNull().references(() => notificationEvents.id), read_at: integer(), archived_at: integer(),
  snoozed_until: integer(), deleted_at: integer(), version: integer().notNull().default(1),
  created_at: timestamp("created_at"), updated_at: timestamp("updated_at"),
}, (table) => [uniqueIndex("notification_inbox_user_event").on(table.user_id, table.event_id)]);
export const notificationRecipients = sqliteTable("notification_recipients", {
  event_id: text().notNull().references(() => notificationEvents.id),
  user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  decision: text({ enum: ["deliver", "suppressed"] }).notNull(), created_at: timestamp("created_at"),
}, (table) => [primaryKey({ columns: [table.event_id, table.user_id] })]);
export const notificationPreferences = sqliteTable("notification_preferences", {
  user_id: text().primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  enabled: integer().notNull().default(1), rules_json: text().notNull().default("{}"),
  version: integer().notNull().default(1), updated_at: timestamp("updated_at"),
});
export const notificationChanges = sqliteTable("notification_changes", {
  seq: integer().primaryKey({ autoIncrement: true }), user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  notification_id: text(), kind: text().notNull(), created_at: timestamp("created_at"),
});
export const notificationWsTickets = sqliteTable("notification_ws_tickets", {
  token_hash: text().primaryKey().notNull(), user_id: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  session_id: text().notNull().references(() => userSessions.id, { onDelete: "cascade" }),
  auth_version: integer().notNull(), expires_at: integer().notNull(),
});

export const driveAccounts = sqliteTable("drive_accounts", {
  user_id: text().primaryKey().notNull().references(() => users.id), quota_bytes: integer().notNull(),
  used_bytes: integer().notNull().default(0), reserved_bytes: integer().notNull().default(0), created_at: timestamp("created_at"),
  quota_override_bytes: integer(), status: text({ enum: ["active", "read_only", "suspended"] }).notNull().default("active"),
  version: integer().notNull().default(1), updated_at: timestamp("updated_at"),
});
// Operational defaults live in D1; migration 0017 seeds the singleton settings row.
export const driveSettings = sqliteTable("drive_settings", {
  id: integer().primaryKey(), default_quota_bytes: integer().notNull(), max_file_bytes: integer().notNull(),
  internal_sharing_enabled: integer().notNull(), public_sharing_enabled: integer().notNull(),
  public_link_password_required: integer().notNull(), public_link_max_days: integer().notNull(),
  trash_retention_days: integer().notNull(), version: integer().notNull().default(1), updated_at: timestamp("updated_at"),
  updated_by: text().references(() => users.id),
});
export const driveItems = sqliteTable("drive_items", {
  id: text().primaryKey().notNull(), owner_user_id: text().notNull().references(() => users.id),
  parent_id: text().references((): AnySQLiteColumn => driveItems.id), kind: text({ enum: ["file", "folder"] }).notNull(),
  name: text().notNull(), description: text().notNull().default(""), current_version_id: text(),
  version: integer().notNull().default(1), created_by: text().notNull().references(() => users.id),
  created_at: timestamp("created_at"), updated_at: timestamp("updated_at"), trashed_at: integer(), purged_at: integer(),
}, table => [index("drive_items_parent").on(table.parent_id, table.updated_at, table.id), index("drive_items_owner").on(table.owner_user_id, table.updated_at, table.id)]);
export const driveVersions = sqliteTable("drive_versions", {
  id: text().primaryKey().notNull(), item_id: text().notNull().references(() => driveItems.id), blob_key: text().notNull(),
  size: integer().notNull(), content_type: text().notNull(), etag: text().notNull(), sha256: text(),
  created_by: text().notNull().references(() => users.id), created_at: timestamp("created_at"),
}, table => [index("drive_versions_item").on(table.item_id, table.created_at, table.id), index("drive_versions_blob").on(table.blob_key)]);
export const drivePermissions = sqliteTable("drive_permissions", {
  item_id: text().notNull().references(() => driveItems.id), user_id: text().notNull().references(() => users.id),
  role: text({ enum: ["viewer", "commenter", "editor"] }).notNull(), expires_at: integer(),
  created_by: text().notNull().references(() => users.id), created_at: timestamp("created_at"),
}, table => [primaryKey({ columns: [table.item_id, table.user_id] }), index("drive_permissions_user").on(table.user_id, table.item_id)]);
export const driveLinks = sqliteTable("drive_links", {
  id: text().primaryKey().notNull(), item_id: text().notNull().references(() => driveItems.id), token_hash: text().notNull().unique(),
  password_hash: text(), allow_download: integer().notNull().default(1), expires_at: integer(), revoked_at: integer(),
  created_by: text().notNull().references(() => users.id), created_at: timestamp("created_at"),
});
export const driveUploads = sqliteTable("drive_uploads", {
  id: text().primaryKey().notNull(), owner_user_id: text().notNull().references(() => driveAccounts.user_id), created_by: text().notNull().references(() => users.id),
  item_id: text().notNull(), parent_id: text().references(() => driveItems.id), name: text().notNull(), base_version: integer().notNull(),
  size: integer().notNull(), content_type: text().notNull(), sha256: text(), mode: text({ enum: ["single", "multipart"] }).notNull(),
  blob_key: text().notNull().unique(), multipart_id: text(), status: text().notNull(), lease_token: text(), lease_until: integer().notNull().default(0),
  expires_at: integer().notNull(), created_at: timestamp("created_at"), completed_at: integer(),
});
export const driveUploadParts = sqliteTable("drive_upload_parts", {
  upload_id: text().notNull().references(() => driveUploads.id, { onDelete: "cascade" }), part_number: integer().notNull(), size: integer().notNull(), etag: text().notNull(),
}, table => [primaryKey({ columns: [table.upload_id, table.part_number] })]);
export const driveActivity = sqliteTable("drive_activity", {
  seq: integer().primaryKey({ autoIncrement: true }), operation_id: text().notNull().unique(), item_id: text().notNull().references(() => driveItems.id),
  owner_user_id: text().notNull().references(() => users.id), actor_user_id: text().references(() => users.id), link_id: text().references(() => driveLinks.id),
  action: text().notNull(), details_json: text().notNull(), created_at: timestamp("created_at"),
});
export const driveOperations = sqliteTable("drive_operations", { id: text().primaryKey().notNull(), actor_user_id: text().notNull().references(() => users.id), created_at: timestamp("created_at") });
export const driveAdminActivity = sqliteTable("drive_admin_activity", {
  seq: integer().primaryKey({ autoIncrement: true }), operation_id: text().notNull().unique(),
  actor_user_id: text().notNull().references(() => users.id), action: text().notNull(),
  target_type: text().notNull(), target_id: text(), details_json: text().notNull(), created_at: timestamp("created_at"),
}, table => [index("drive_admin_activity_time").on(table.created_at, table.seq)]);
export const driveAdminJobs = sqliteTable("drive_admin_jobs", {
  id: text().primaryKey().notNull(), source_user_id: text().notNull().references(() => users.id),
  target_user_id: text().notNull().references(() => users.id), root_item_id: text().references(() => driveItems.id), root_trashed_at: integer(),
  actor_user_id: text().notNull().references(() => users.id), reason: text().notNull(),
  status: text({ enum: ["queued", "running", "failed", "completed", "cancelled"] }).notNull(),
  total_items: integer().notNull(), processed_items: integer().notNull().default(0), reserved_bytes: integer().notNull(),
  error: text(), version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"),
}, table => [index("drive_admin_jobs_status").on(table.status, table.created_at), index("drive_admin_jobs_source").on(table.source_user_id, table.status), index("drive_admin_jobs_target").on(table.target_user_id, table.status)]);
export const driveAdminJobItems = sqliteTable("drive_admin_job_items", {
  job_id: text().notNull().references(() => driveAdminJobs.id), item_id: text().notNull().references(() => driveItems.id),
  parent_id: text(), item_version: integer().notNull(), size: integer().notNull(), processed: integer().notNull().default(0),
}, table => [primaryKey({ columns: [table.job_id, table.item_id] }), index("drive_admin_job_items_item").on(table.item_id, table.processed)]);
export const driveChanges = sqliteTable("drive_changes", {
  seq: integer().primaryKey({ autoIncrement: true }), user_id: text().notNull().references(() => users.id), item_id: text().notNull().references(() => driveItems.id), kind: text().notNull(), created_at: timestamp("created_at"),
});
export const driveStars = sqliteTable("drive_stars", { user_id: text().notNull().references(() => users.id), item_id: text().notNull().references(() => driveItems.id), created_at: timestamp("created_at") }, table => [primaryKey({ columns: [table.user_id, table.item_id] })]);
export const driveRecents = sqliteTable("drive_recents", { user_id: text().notNull().references(() => users.id), item_id: text().notNull().references(() => driveItems.id), viewed_at: timestamp("viewed_at") }, table => [primaryKey({ columns: [table.user_id, table.item_id] })]);
export const driveComments = sqliteTable("drive_comments", {
  id: text().primaryKey().notNull(), item_id: text().notNull().references(() => driveItems.id), parent_id: text().references((): AnySQLiteColumn => driveComments.id), author_user_id: text().notNull().references(() => users.id),
  body: text().notNull(), resolved: integer().notNull().default(0), version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"), deleted_at: integer(),
});
export const driveAccessRequests = sqliteTable("drive_access_requests", {
  id: text().primaryKey().notNull(), item_id: text().notNull().references(() => driveItems.id), user_id: text().notNull().references(() => users.id), role: text().notNull(), message: text().notNull().default(""), status: text().notNull().default("pending"), created_at: timestamp("created_at"), decided_at: integer(),
});
export const driveGarbage = sqliteTable("drive_garbage", { blob_key: text().primaryKey().notNull(), not_before: timestamp("not_before"), lease_until: integer().notNull().default(0) });

// migrations/0019_calendar_core.sql is the DDL source for STRICT, time-union checks,
// and the calendar-scoped label foreign key. Calendar mutations use atomic D1 claims.
export const calendars = sqliteTable("calendars", {
  id: text().primaryKey().notNull(), data_owner_user_id: text().notNull().references(() => users.id),
  kind: text({ enum: ["personal", "shared", "resource", "system", "external"] }).notNull(), name: text().notNull(),
  description: text().notNull().default(""), location: text().notNull().default(""), time_zone: text().notNull().default("UTC"),
  default_visibility: text().notNull().default("private"), status: text().notNull().default("active"),
  version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"), trashed_at: integer(),
}, table => [index("calendars_owner").on(table.data_owner_user_id, table.trashed_at, table.status)]);
export const calendarPrimaryCalendars = sqliteTable("calendar_primary_calendars", {
  user_id: text().primaryKey().notNull().references(() => users.id), calendar_id: text().notNull().unique().references(() => calendars.id),
});
export const calendarAcl = sqliteTable("calendar_acl", {
  id: text().primaryKey().notNull(), calendar_id: text().notNull().references(() => calendars.id), scope_type: text().notNull(), scope_key: text().notNull(), role: text().notNull(),
  expires_at: integer(), granted_by: text().references(() => users.id), version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"),
}, table => [uniqueIndex("calendar_acl_scope").on(table.calendar_id, table.scope_type, table.scope_key), index("calendar_acl_subject").on(table.scope_type, table.scope_key, table.expires_at)]);
export const calendarSubscriptions = sqliteTable("calendar_subscriptions", {
  user_id: text().notNull().references(() => users.id), calendar_id: text().notNull().references(() => calendars.id), name_override: text(), color: text(),
  selected: integer().notNull().default(1), hidden: integer().notNull().default(0), sort_order: integer().notNull().default(0),
  default_reminders_json: text().notNull().default("[]"), notification_policy_json: text().notNull().default("{}"), version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"),
}, table => [primaryKey({ columns: [table.user_id, table.calendar_id] }), index("calendar_subscriptions_user").on(table.user_id, table.selected, table.sort_order)]);
export const calendarPreferences = sqliteTable("calendar_preferences", {
  user_id: text().primaryKey().notNull().references(() => users.id), time_zone: text().notNull().default("UTC"), secondary_time_zone: text(), locale: text().notNull().default("en"),
  week_start: integer().notNull().default(1), default_view: text().notNull().default("week"), default_duration_minutes: integer().notNull().default(30),
  invitation_policy: text().notNull().default("all"), display_options_json: text().notNull().default("{}"), default_reminders_json: text().notNull().default("[]"),
  version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"),
});
export const calendarLabels = sqliteTable("calendar_labels", {
  id: text().primaryKey().notNull(), calendar_id: text().notNull().references(() => calendars.id), name: text().notNull(), color: text().notNull(), sort_order: integer().notNull().default(0),
  version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"), deleted_at: integer(),
}, table => [uniqueIndex("calendar_labels_calendar_id").on(table.calendar_id, table.id)]);
export const calendarEvents = sqliteTable("calendar_events", {
  id: text().primaryKey().notNull(), organizer_calendar_id: text().notNull().references(() => calendars.id), organizer_user_id: text().references(() => users.id),
  organizer_email: text().notNull(), creator_user_id: text().references(() => users.id), authority: text().notNull().default("native"), i_cal_uid: text().notNull(), sequence: integer().notNull().default(0),
  event_type: text().notNull().default("default"), status: text().notNull().default("confirmed"), title: text().notNull().default(""), description_html: text().notNull().default(""), location_json: text().notNull().default("{}"),
  time_kind: text({ enum: ["timed", "all_day"] }).notNull(), start_at: integer(), end_at: integer(), start_date: text(), end_date: text(), start_local: text(), end_local: text(), start_time_zone: text(), end_time_zone: text(),
  recurrence_json: text().notNull().default("[]"), recurrence_until_at: integer(), visibility: text().notNull().default("default"), transparency: text().notNull().default("busy"),
  guest_permissions_json: text().notNull().default("{}"), type_properties_json: text().notNull().default("{}"), shared_properties_json: text().notNull().default("{}"), source_json: text().notNull().default("{}"),
  version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"), trashed_at: integer(),
}, table => [uniqueIndex("calendar_events_uid").on(table.organizer_calendar_id, table.i_cal_uid),
  index("calendar_events_timed").on(table.organizer_calendar_id, table.start_at, table.end_at).where(sql`${table.trashed_at} IS NULL`),
  index("calendar_events_dates").on(table.organizer_calendar_id, table.start_date, table.end_date).where(sql`${table.trashed_at} IS NULL`),
  index("calendar_events_recurring").on(table.organizer_calendar_id, table.recurrence_until_at).where(sql`${table.recurrence_json}<>'[]' AND ${table.trashed_at} IS NULL`)]);
export const calendarEventScopes = sqliteTable("calendar_event_scopes", {
  id: text().primaryKey().notNull(), event_id: text().notNull().references(() => calendarEvents.id), occurrence_key: text().notNull().default(""),
}, table => [uniqueIndex("calendar_event_scopes_key").on(table.event_id, table.occurrence_key), uniqueIndex("calendar_event_scopes_event").on(table.id, table.event_id)]);
export const calendarEventOverrides = sqliteTable("calendar_event_overrides", {
  scope_id: text().primaryKey().notNull().references(() => calendarEventScopes.id, { onDelete: "cascade" }), cancelled: integer().notNull().default(0), patch_json: text().notNull().default("{}"),
  effective_start_at: integer(), effective_end_at: integer(), effective_start_date: text(), effective_end_date: text(), version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"),
}, table => [index("calendar_overrides_timed").on(table.effective_start_at, table.effective_end_at), index("calendar_overrides_dates").on(table.effective_start_date, table.effective_end_date)]);
export const calendarEventCopies = sqliteTable("calendar_event_copies", {
  id: text().primaryKey().notNull(), event_id: text().notNull().references(() => calendarEvents.id), calendar_id: text().notNull().references(() => calendars.id),
  copy_kind: text().notNull().default("organizer"), color_override: text(), label_id: text(), use_default_reminders: integer().notNull().default(1), private_properties_json: text().notNull().default("{}"), hidden_at: integer(), removed_at: integer(),
  version: integer().notNull().default(1), created_at: timestamp("created_at"), updated_at: timestamp("updated_at"),
}, table => [uniqueIndex("calendar_event_copies_event").on(table.event_id, table.calendar_id), index("calendar_copies_calendar").on(table.calendar_id, table.removed_at, table.event_id)]);
export const calendarOperations = sqliteTable("calendar_operations", {
  id: text().primaryKey().notNull(), actor_key: text().notNull(), actor_user_id: text().references(() => users.id), operation: text().notNull(), idempotency_key: text(), request_hash: text().notNull(), result_json: text().notNull(), created_at: timestamp("created_at"), expires_at: integer().notNull(),
}, table => [uniqueIndex("calendar_operations_key").on(table.actor_key, table.operation, table.idempotency_key)]);
export const calendarSeriesLinks = sqliteTable("calendar_series_links", {
  previous_event_id: text().notNull().references(() => calendarEvents.id), next_event_id: text().notNull().references(() => calendarEvents.id), split_occurrence_key: text().notNull(), operation_id: text().notNull().references(() => calendarOperations.id),
}, table => [primaryKey({ columns: [table.previous_event_id, table.next_event_id] })]);
export const calendarChanges = sqliteTable("calendar_changes", {
  seq: integer().primaryKey({ autoIncrement: true }), calendar_id: text().references(() => calendars.id), audience_user_id: text().references(() => users.id), resource_type: text().notNull(), resource_id: text().notNull(), occurrence_key: text(), operation: text().notNull(), version: integer().notNull(), created_at: timestamp("created_at"),
}, table => [index("calendar_changes_calendar").on(table.calendar_id, table.seq), index("calendar_changes_user").on(table.audience_user_id, table.seq)]);
export const calendarActivity = sqliteTable("calendar_activity", {
  id: text().primaryKey().notNull(), operation_id: text().notNull().references(() => calendarOperations.id), actor_user_id: text().references(() => users.id), calendar_id: text().references(() => calendars.id), event_id: text(), action: text().notNull(), details_json: text().notNull(), created_at: timestamp("created_at"),
}, table => [index("calendar_activity_event").on(table.event_id, table.created_at, table.id)]);
