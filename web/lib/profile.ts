export type ProfileValue = string | number | boolean | string[] | null;
export interface ProfileField {
  id: string; key: string; label: Record<string, string>;
  value_type: "text" | "number" | "boolean" | "date" | "url" | "select" | "multiselect";
  editable_by: "user" | "admin" | "none";
  required: boolean;
  options: { value: string; label: Record<string, string> }[] | null;
}
export const label = (translations: Record<string, string> | null | undefined, fallback: string) =>
  translations?.en || Object.values(translations ?? {}).find((value) => typeof value === "string" && value) || fallback;

export function profileChanges(definitions: ProfileField[], values: Record<string, ProfileValue>) {
  const fields: Record<string, ProfileValue> = {};
  for (const field of definitions.filter((field) => field.editable_by === "user")) {
    let value = values[field.key] ?? null;
    const title = label(field.label, field.key);
    if (value === "" || (Array.isArray(value) && value.length === 0 && !field.required)) value = null;
    if (field.required && (value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length))) {
      throw new Error(`${title} is required.`);
    }
    if (field.value_type === "number" && value !== null) {
      value = Number(value);
      if (!Number.isFinite(value)) throw new Error(`${title} must be a number.`);
    }
    fields[field.key] = value;
  }
  return fields;
}

export function validatePassword(password: string, confirmation: string) {
  const length = [...password].length;
  if (length < 15 || length > 128 || new TextEncoder().encode(password).length > 512) {
    throw new Error("Your new password must contain 15–128 characters.");
  }
  if (password !== confirmation) throw new Error("The passwords do not match.");
}

export const returnToWorkspace = (path: unknown) =>
  typeof path === "string" && ([
    "/", "/mail", "/mail/drafts", "/mail/sent", "/mail/archive", "/mail/trash", "/mail/spam", "/mail/starred", "/mail/snoozed",
    "/mail/templates", "/mail/rules", "/mail/settings", "/mail/integrations", "/mail/data", "/mail/activity",
    "/console/mail/domains", "/console/mail/mailboxes", "/console/mail/providers",
    "/calendar", "/calendar/shared", "/drive", "/drive/shared", "/drive/starred", "/drive/trash",
    "/profile", "/profile/security", "/profile/sessions",
  ].includes(path) || /^\/console(?:\/(?:users|roles)(?:\/[A-Za-z0-9_-]{1,100})?)?$/.test(path) || /^\/console\/mail\/(?:domains|mailboxes)\/[A-Za-z0-9_-]{1,100}$/.test(path) || /^\/mail\/folders\/[A-Za-z0-9_-]{1,100}$/.test(path))
    ? path : "/";
