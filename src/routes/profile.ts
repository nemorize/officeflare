import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { body, conflict, invalid, unauthorized } from "../auth/input";
import { accessClaim, accessWon, publicUser, requireAccess } from "../auth/store";
import { now, uuid, type AppEnv } from "../auth/types";

interface Field {
  id: string; key: string; label: string; value_type: string; visibility: string; editable_by: string;
  required: number; options_json: string | null; updated_at: number;
}
const profile = new Hono<AppEnv>();
profile.use("/profile", requireAccess);
profile.use("/profile-fields", requireAccess);
async function fields(c: Parameters<typeof requireAccess>[0]) {
  const result = await c.get("db").prepare(`SELECT id, key, label, value_type, visibility, editable_by, required, options_json, updated_at
    FROM user_profile_fields WHERE deleted_at IS NULL AND visibility <> 'admin' ORDER BY key`).all<Field>();
  return result.results;
}
profile.get("/profile-fields", async (c) => c.json({ fields: (await fields(c)).map((field) => ({
  id: field.id, key: field.key, label: JSON.parse(field.label), value_type: field.value_type,
  visibility: field.visibility, editable_by: field.editable_by, required: !!field.required,
  options: field.options_json === null ? null : JSON.parse(field.options_json),
})) }));
profile.get("/profile", async (c) => {
  const { user } = c.get("identity");
  const values = await c.get("db").prepare(`SELECT f.key, p.value FROM user_profiles p JOIN user_profile_fields f ON f.id = p.field_id
    WHERE p.user_id = ? AND f.deleted_at IS NULL AND f.visibility <> 'admin' ORDER BY f.key`).bind(user.id).all<{ key: string; value: string }>();
  return c.json({ display_name: user.display_name, profile_image_key: user.profile_image_key,
    fields: Object.fromEntries(values.results.map((value) => [value.key, JSON.parse(value.value)])) });
});

function validate(field: Field, value: unknown) {
  if (value === null) { if (field.required) invalid(`Required field: ${field.key}`); return; }
  switch (field.value_type) {
    case "text": if (typeof value !== "string" || value.length > 4096 || (field.required && !value.trim())) invalid(`Invalid field: ${field.key}`); break;
    case "number": if (typeof value !== "number" || !Number.isFinite(value)) invalid(`Invalid field: ${field.key}`); break;
    case "boolean": if (typeof value !== "boolean") invalid(`Invalid field: ${field.key}`); break;
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`Invalid field: ${field.key}`);
      const date = new Date(`${value}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(`Invalid field: ${field.key}`);
      break;
    }
    case "url": {
      if (typeof value !== "string" || value.length > 2048) invalid(`Invalid field: ${field.key}`);
      try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid(`Invalid field: ${field.key}`); }
      catch { invalid(`Invalid field: ${field.key}`); }
      break;
    }
    case "select": case "multiselect": {
      const options = JSON.parse(field.options_json!) as { value: string }[];
      const values = field.value_type === "select" ? [value] : value;
      if (!Array.isArray(values) || values.length > 100 || (field.required && !values.length) ||
          new Set(values).size !== values.length || values.some((item) => typeof item !== "string" || !options.some((option) => option.value === item))) invalid(`Invalid field: ${field.key}`);
      break;
    }
    default: invalid(`Unsupported field: ${field.key}`);
  }
}
profile.patch("/profile", async (c) => {
  const data = await body(c, ["display_name", "fields"]), { user, session } = c.get("identity");
  if ("display_name" in data && data.display_name !== null &&
      (typeof data.display_name !== "string" || !data.display_name.trim() || [...data.display_name].length > 200)) invalid("Invalid display_name");
  if (data.fields !== undefined && (!data.fields || typeof data.fields !== "object" || Array.isArray(data.fields))) invalid("Invalid fields");
  const supplied = (data.fields ?? {}) as Record<string, unknown>;
  if (!Object.keys(data).length || Object.keys(supplied).length > 50) invalid();
  const definitions = await fields(c), changes: { field: Field; value: unknown }[] = [];
  for (const [key, value] of Object.entries(supplied)) {
    const field = definitions.find((definition) => definition.key === key);
    if (!field) invalid(`Unknown profile field: ${key}`);
    if (field.editable_by !== "user") throw new HTTPException(403, { message: "Field cannot be edited" });
    validate(field, value); changes.push({ field, value });
  }
  const current = await c.get("db").prepare("SELECT field_id, value FROM user_profiles WHERE user_id = ?").bind(user.id).all<{ field_id: string; value: string }>();
  for (const field of definitions.filter((field) => field.required && field.editable_by === "user")) {
    const change = changes.find((change) => change.field.id === field.id);
    const existing = current.results.find((value) => value.field_id === field.id);
    if (!change && !existing) invalid(`Required field: ${field.key}`);
    if (!change && existing) validate(field, JSON.parse(existing.value));
  }
  const operation = uuid(), timestamp = now();
  // Recheck every visible definition, including required fields, in the write transaction.
  const snapshot = JSON.stringify(definitions);
  const checks = `NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN user_profile_fields f ON f.id = json_extract(j.value, '$.id')
    WHERE f.id IS NULL OR f.deleted_at IS NOT NULL OR f.key <> json_extract(j.value, '$.key')
    OR f.updated_at <> json_extract(j.value, '$.updated_at') OR f.value_type <> json_extract(j.value, '$.value_type')
    OR f.label <> json_extract(j.value, '$.label') OR f.options_json IS NOT json_extract(j.value, '$.options_json')
    OR f.required <> json_extract(j.value, '$.required') OR f.editable_by <> json_extract(j.value, '$.editable_by')
    OR f.visibility <> json_extract(j.value, '$.visibility'))
    AND (SELECT COUNT(*) FROM user_profile_fields WHERE deleted_at IS NULL AND visibility <> 'admin') = ?`;
  const result = await c.get("db").batch([
    accessClaim(c, operation, checks, [snapshot, definitions.length]),
    c.get("db").prepare(`UPDATE users SET display_name = CASE WHEN ? THEN ? ELSE display_name END, updated_at = ?
      WHERE id = ? AND ${accessWon}`).bind("display_name" in data ? 1 : 0, data.display_name as string | null ?? null, timestamp, user.id, session.id, operation),
    ...changes.map(({ field, value }) => value === null
      ? c.get("db").prepare(`DELETE FROM user_profiles WHERE user_id = ? AND field_id = ? AND ${accessWon}`).bind(user.id, field.id, session.id, operation)
      : c.get("db").prepare(`INSERT INTO user_profiles(user_id, field_id, value, updated_at)
        SELECT ?, ?, ?, ? WHERE ${accessWon} ON CONFLICT(user_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(user.id, field.id, JSON.stringify(value), timestamp, session.id, operation)),
  ]);
  if (result[0]!.meta.changes !== 1) conflict("Account or profile policy changed; reload and retry");
  const updated = await c.get("db").prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<typeof user>();
  if (!updated) unauthorized();
  return c.json({ user: publicUser(updated) });
});
export default profile;
