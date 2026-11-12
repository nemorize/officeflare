import type { AuthContext, AuthEnv } from "../auth/types";
import type { contactBooks, contactFolders, contacts, contactFieldDefinitions } from "../db/schema";

export type ContactContext = AuthContext;
export type ContactEnv = AuthEnv;
export type Book = typeof contactBooks.$inferSelect;
export type Folder = typeof contactFolders.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type FieldDefinition = typeof contactFieldDefinitions.$inferSelect;
export type Bind = string | number | null;
export interface Condition {
  sql: string;
  args: Bind[];
}
export const detailTables = {
  emails: "contact_emails",
  phones: "contact_phones",
  addresses: "contact_addresses",
  links: "contact_links",
} as const;
export type DetailKind = keyof typeof detailTables;
export type DetailRow = Record<string, Bind> & {
  id: string;
  contact_id: string;
  is_primary: number;
  sort_order: number;
};
export interface CustomValue {
  field_id: string;
  value: unknown;
}
export interface ContactDetail extends Contact {
  emails: DetailRow[];
  phones: DetailRow[];
  addresses: DetailRow[];
  links: DetailRow[];
  custom_fields: CustomValue[];
}
