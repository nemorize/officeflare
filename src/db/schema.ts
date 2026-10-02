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
