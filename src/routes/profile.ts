import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { and, count, eq, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";
import { body, conflict, invalid, unauthorized } from "../auth/input";
import { accessClaim, publicUser, requireAccess } from "../auth/store";
import { accessWon } from "../db/auth-conditions";
import { isNot, jsonExtract } from "../db/expressions";
import { insertWhen } from "../db/conditional-insert";
import { users, userProfileFields, userProfiles } from "../db/schema";
import { now, uuid, type AppEnv } from "../auth/types";

type Field = Pick<
  typeof userProfileFields.$inferSelect,
  | "id"
  | "key"
  | "label"
  | "value_type"
  | "visibility"
  | "editable_by"
  | "required"
  | "options_json"
  | "updated_at"
>;
// Typed columns for the virtual JSON table used to compare a policy snapshot atomically.
const snapshotRows = sqliteTable("profile_policy_snapshot", { value: text() });
const profile = new Hono<AppEnv>();
profile.use("/profile", requireAccess);
profile.use("/profile-fields", requireAccess);
async function fields(c: Parameters<typeof requireAccess>[0]) {
  return c
    .get("db")
    .select({
      id: userProfileFields.id,
      key: userProfileFields.key,
      label: userProfileFields.label,
      value_type: userProfileFields.value_type,
      visibility: userProfileFields.visibility,
      editable_by: userProfileFields.editable_by,
      required: userProfileFields.required,
      options_json: userProfileFields.options_json,
      updated_at: userProfileFields.updated_at,
    })
    .from(userProfileFields)
    .where(and(isNull(userProfileFields.deleted_at), ne(userProfileFields.visibility, "admin")))
    .orderBy(userProfileFields.key);
}
profile.get("/profile-fields", async (c) =>
  c.json({
    fields: (await fields(c)).map((field) => ({
      id: field.id,
      key: field.key,
      label: JSON.parse(field.label),
      value_type: field.value_type,
      visibility: field.visibility,
      editable_by: field.editable_by,
      required: !!field.required,
      options: field.options_json === null ? null : JSON.parse(field.options_json),
    })),
  }),
);
profile.get("/profile", async (c) => {
  const { user } = c.get("identity");
  const values = await c
    .get("db")
    .select({ key: userProfileFields.key, value: userProfiles.value })
    .from(userProfiles)
    .innerJoin(userProfileFields, eq(userProfileFields.id, userProfiles.field_id))
    .where(
      and(
        eq(userProfiles.user_id, user.id),
        isNull(userProfileFields.deleted_at),
        ne(userProfileFields.visibility, "admin"),
      ),
    )
    .orderBy(userProfileFields.key);
  return c.json({
    display_name: user.display_name,
    profile_image_key: user.profile_image_key,
    fields: Object.fromEntries(values.map((value) => [value.key, JSON.parse(value.value)])),
  });
});

function validate(field: Field, value: unknown) {
  if (value === null) {
    if (field.required) invalid(t("routesProfile.requiredField", { key: field.key }));
    return;
  }
  switch (field.value_type) {
    case "text":
      if (typeof value !== "string" || value.length > 4096 || (field.required && !value.trim()))
        invalid(t("routesProfile.invalidField", { key: field.key }));
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        invalid(t("routesProfile.invalidField", { key: field.key }));
      break;
    case "boolean":
      if (typeof value !== "boolean") invalid(t("routesProfile.invalidField", { key: field.key }));
      break;
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        invalid(t("routesProfile.invalidField", { key: field.key }));
      const date = new Date(`${value}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
        invalid(t("routesProfile.invalidField", { key: field.key }));
      break;
    }
    case "url": {
      if (typeof value !== "string" || value.length > 2048)
        invalid(t("routesProfile.invalidField", { key: field.key }));
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          invalid(t("routesProfile.invalidField", { key: field.key }));
      } catch {
        invalid(t("routesProfile.invalidField", { key: field.key }));
      }
      break;
    }
    case "select":
    case "multiselect": {
      const options = JSON.parse(field.options_json!) as { value: string }[];
      const values = field.value_type === "select" ? [value] : value;
      if (
        !Array.isArray(values) ||
        values.length > 100 ||
        (field.required && !values.length) ||
        new Set(values).size !== values.length ||
        values.some(
          (item) => typeof item !== "string" || !options.some((option) => option.value === item),
        )
      )
        invalid(t("routesProfile.invalidField", { key: field.key }));
      break;
    }
    default:
      invalid(t("routesProfile.unsupportedField", { key: field.key }));
  }
}
profile.patch("/profile", async (c) => {
  const data = await body(c, ["display_name", "fields"]),
    { user, session } = c.get("identity");
  if (
    "display_name" in data &&
    data.display_name !== null &&
    (typeof data.display_name !== "string" ||
      !data.display_name.trim() ||
      [...data.display_name].length > 200)
  )
    invalid(t("routesProfile.invalidDisplayName"));
  if (
    data.fields !== undefined &&
    (!data.fields || typeof data.fields !== "object" || Array.isArray(data.fields))
  )
    invalid(t("routesProfile.invalidFields"));
  const supplied = (data.fields ?? {}) as Record<string, unknown>;
  if (!Object.keys(data).length || Object.keys(supplied).length > 50) invalid();
  const definitions = await fields(c),
    changes: { field: Field; value: unknown }[] = [];
  for (const [key, value] of Object.entries(supplied)) {
    const field = definitions.find((definition) => definition.key === key);
    if (!field) invalid(t("routesProfile.unknownProfileField", { key: key }));
    if (field.editable_by !== "user")
      throw new HTTPException(403, { message: t("routesProfile.fieldCannotBeEdited") });
    validate(field, value);
    changes.push({ field, value });
  }
  const db = c.get("db");
  const current = await db
    .select({ field_id: userProfiles.field_id, value: userProfiles.value })
    .from(userProfiles)
    .where(eq(userProfiles.user_id, user.id));
  for (const field of definitions.filter(
    (field) => field.required && field.editable_by === "user",
  )) {
    const change = changes.find((change) => change.field.id === field.id);
    const existing = current.find((value) => value.field_id === field.id);
    if (!change && !existing) invalid(t("routesProfile.requiredField", { key: field.key }));
    if (!change && existing) validate(field, JSON.parse(existing.value));
  }
  const operation = uuid(),
    timestamp = now();
  // Recheck every visible definition, including required fields, in the write transaction.
  const snapshot = JSON.stringify(definitions);
  const value = (key: keyof Field) => jsonExtract(snapshotRows.value, `$.${key}`);
  const mismatches = db
    .select({ id: userProfileFields.id })
    .from(sql`json_each(${snapshot}) AS ${sql.identifier("profile_policy_snapshot")}`)
    .leftJoin(userProfileFields, eq(userProfileFields.id, value("id")))
    .where(
      or(
        isNull(userProfileFields.id),
        isNotNull(userProfileFields.deleted_at),
        ne(userProfileFields.key, value("key")),
        ne(userProfileFields.updated_at, value("updated_at")),
        ne(userProfileFields.value_type, value("value_type")),
        ne(userProfileFields.label, value("label")),
        isNot(userProfileFields.options_json, value("options_json")),
        ne(userProfileFields.required, value("required")),
        ne(userProfileFields.editable_by, value("editable_by")),
        ne(userProfileFields.visibility, value("visibility")),
      ),
    );
  const checks = and(
    notExists(mismatches),
    eq(
      db
        .select({ count: count() })
        .from(userProfileFields)
        .where(
          and(isNull(userProfileFields.deleted_at), ne(userProfileFields.visibility, "admin")),
        ),
      definitions.length,
    ),
  );
  const won = accessWon(db, session.id, operation);
  const result = await db.batch([
    accessClaim(c, operation, checks),
    db
      .update(users)
      .set({
        updated_at: timestamp,
        ...("display_name" in data ? { display_name: data.display_name as string | null } : {}),
      })
      .where(and(eq(users.id, user.id), won)),
    ...changes.map(({ field, value }) =>
      value === null
        ? db
            .delete(userProfiles)
            .where(and(eq(userProfiles.user_id, user.id), eq(userProfiles.field_id, field.id), won))
        : insertWhen(
            db,
            userProfiles,
            {
              user_id: user.id,
              field_id: field.id,
              value: JSON.stringify(value),
              updated_at: timestamp,
            },
            won,
          ).onConflictDoUpdate({
            target: [userProfiles.user_id, userProfiles.field_id],
            set: { value: JSON.stringify(value), updated_at: timestamp },
          }),
    ),
  ]);
  if (result[0]!.meta.changes !== 1)
    conflict(t("routesProfile.accountOrProfilePolicyChangedReloadAndRetry"));
  const updated = await db.select().from(users).where(eq(users.id, user.id)).get();
  if (!updated) unauthorized();
  return c.json({ user: publicUser(updated) });
});
export default profile;
