import { t } from "../../shared/i18n/index.ts";

export interface ContactFolder {
  id: string;
  book_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  version: number;
}
export interface ContactSummary {
  id: string;
  book_id: string;
  folder_id: string | null;
  display_name: string;
  organization: string;
  department: string;
  job_title: string;
  primary_email: string | null;
  primary_phone: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
}
export interface ContactValue {
  id?: string;
  draft_key?: string;
  label: string;
  is_primary: boolean;
  sort_order: number;
}
export interface ContactEmail extends ContactValue {
  email_address: string;
}
export interface ContactPhone extends ContactValue {
  phone_number: string;
  extension: string;
}
export interface ContactAddress extends ContactValue {
  country_code: string;
  region: string;
  city: string;
  postal_code: string;
  street_address: string;
  extended_address: string;
  formatted_address: string;
}
export interface ContactLink extends ContactValue {
  url: string;
}
export interface ContactRecord extends Omit<ContactSummary, "primary_email" | "primary_phone"> {
  given_name: string;
  family_name: string;
  nickname: string;
  birthday: string | null;
  notes: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactAddress[];
  links: ContactLink[];
  custom_fields: { field_id: string; value: unknown }[];
}
export type ContactFieldType =
  "text" | "number" | "boolean" | "date" | "url" | "select" | "multiselect";
export interface ContactFieldDefinition {
  id: string;
  book_id: string;
  key: string;
  label: string;
  value_type: ContactFieldType;
  options: string[];
  sort_order: number;
  version: number;
  archived_at: number | null;
}
export interface ContactPage {
  contacts: ContactSummary[];
  next_cursor: string | null;
}
export type ContactDraft = Omit<
  ContactRecord,
  | "id"
  | "book_id"
  | "version"
  | "created_at"
  | "updated_at"
  | "trashed_at"
  | "custom_fields"
  | "birthday"
> & {
  birthday: string;
  custom_fields: Record<string, unknown>;
};
export const contactFieldTypes: ContactFieldType[] = [
  "text",
  "number",
  "boolean",
  "date",
  "url",
  "select",
  "multiselect",
];
export function contactLocation(path: string) {
  return {
    trash: path === "/contacts/trash",
    folder: path.match(/^\/contacts\/folders\/([A-Za-z0-9_-]+)$/)?.[1] ?? null,
    unfiled: path === "/contacts/unfiled",
  };
}
export function folderOptions(folders: ContactFolder[], exclude?: string) {
  const blocked = new Set<string>(exclude ? [exclude] : []);
  for (let count = 0; count < folders.length; count++) {
    let changed = false;
    for (const folder of folders)
      if (folder.parent_id && blocked.has(folder.parent_id) && !blocked.has(folder.id)) {
        blocked.add(folder.id);
        changed = true;
      }
    if (!changed) break;
  }
  const result: { value: string; label: string }[] = [{ value: "root", label: t("contacts.root") }],
    visited = new Set<string>();
  const walk = (parent: string | null, prefix: string) => {
    for (const folder of folders.filter((item) => item.parent_id === parent)) {
      if (visited.has(folder.id) || blocked.has(folder.id)) continue;
      visited.add(folder.id);
      const label = prefix ? `${prefix} / ${folder.name}` : folder.name;
      result.push({ value: folder.id, label });
      walk(folder.id, label);
    }
  };
  walk(null, "");
  return result;
}
export function contactDraft(contact?: ContactRecord, folder: string | null = null): ContactDraft {
  return {
    display_name: contact?.display_name ?? "",
    given_name: contact?.given_name ?? "",
    family_name: contact?.family_name ?? "",
    nickname: contact?.nickname ?? "",
    organization: contact?.organization ?? "",
    department: contact?.department ?? "",
    job_title: contact?.job_title ?? "",
    birthday: contact?.birthday ?? "",
    notes: contact?.notes ?? "",
    folder_id: contact ? contact.folder_id : folder,
    emails: contact?.emails.map((item) => ({ ...item })) ?? [
      { email_address: "", label: "", is_primary: true, sort_order: 0 },
    ],
    phones: contact?.phones.map((item) => ({ ...item })) ?? [],
    addresses: contact?.addresses.map((item) => ({ ...item })) ?? [],
    links: contact?.links.map((item) => ({ ...item })) ?? [],
    custom_fields: Object.fromEntries(
      contact?.custom_fields.map((item) => [item.field_id, item.value]) ?? [],
    ),
  };
}
function ordered<T extends ContactValue>(values: T[]) {
  const chosen = values.findIndex((item) => item.is_primary);
  return values.map((item, index) => ({
    ...item,
    is_primary: index === (chosen < 0 ? 0 : chosen),
    sort_order: index,
  }));
}
export function contactPayload(draft: ContactDraft, definitions: ContactFieldDefinition[]) {
  const custom_fields = Object.entries(draft.custom_fields).flatMap(([field_id, original]) => {
    const definition = definitions.find((item) => item.id === field_id);
    let value = original;
    if (value === undefined) return [];
    if (definition && !definition.archived_at) {
      if (value === "" && ["number", "date", "url", "select"].includes(definition.value_type))
        return [];
      if (definition.value_type === "number") {
        value = Number(value);
        if (!Number.isFinite(value))
          throw new Error(t("contacts.invalid", { field: definition.label }));
      }
    }
    return [{ field_id, value }];
  });
  const payload = {
    display_name: draft.display_name.trim(),
    given_name: draft.given_name.trim(),
    family_name: draft.family_name.trim(),
    nickname: draft.nickname.trim(),
    organization: draft.organization.trim(),
    department: draft.department.trim(),
    job_title: draft.job_title.trim(),
    birthday: draft.birthday || null,
    notes: draft.notes,
    folder_id: draft.folder_id,
    emails: ordered(
      draft.emails
        .filter((item) => item.email_address.trim())
        .map(({ id, email_address, label, is_primary }) => ({
          ...(id ? { id } : {}),
          email_address: email_address.trim(),
          label,
          is_primary,
          sort_order: 0,
        })),
    ),
    phones: ordered(
      draft.phones
        .filter((item) => item.phone_number.trim() || item.extension.trim())
        .map(({ id, phone_number, extension, label, is_primary }) => ({
          ...(id ? { id } : {}),
          phone_number: phone_number.trim(),
          extension: extension.trim(),
          label,
          is_primary,
          sort_order: 0,
        })),
    ),
    addresses: ordered(
      draft.addresses
        .filter((item) =>
          [
            item.street_address,
            item.extended_address,
            item.formatted_address,
            item.city,
            item.region,
            item.country_code,
            item.postal_code,
          ].some((value) => value.trim()),
        )
        .map(
          ({
            id,
            label,
            is_primary,
            street_address,
            extended_address,
            formatted_address,
            city,
            region,
            country_code,
            postal_code,
          }) => ({
            ...(id ? { id } : {}),
            label,
            is_primary,
            street_address,
            extended_address,
            formatted_address,
            city,
            region,
            country_code,
            postal_code,
            sort_order: 0,
          }),
        ),
    ),
    links: ordered(
      draft.links
        .filter((item) => item.url.trim())
        .map(({ id, url, label, is_primary }) => ({
          ...(id ? { id } : {}),
          url: url.trim(),
          label,
          is_primary,
          sort_order: 0,
        })),
    ),
    custom_fields,
  };
  if (
    !payload.display_name &&
    !payload.given_name &&
    !payload.family_name &&
    !payload.organization &&
    !payload.emails.length &&
    !payload.phones.length
  )
    throw new Error(t("contacts.identityRequired"));
  return payload;
}
export function contactInitials(name: string) {
  const words = name.trim().split(/\s+/);
  return (
    words.length > 1
      ? (words[0]?.[0] ?? "") + (words.at(-1)?.[0] ?? "")
      : [...name].slice(0, 2).join("")
  ).toUpperCase();
}
