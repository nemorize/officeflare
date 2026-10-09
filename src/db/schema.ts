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
    can_send_as: integer().notNull().default(0),
    can_send_on_behalf: integer().notNull().default(0),
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
      enum: ["read", "write", "send_as", "send_on_behalf"],
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
