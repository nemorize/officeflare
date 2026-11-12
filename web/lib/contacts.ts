import { api } from "./api";
export type * from "./contact-model";

export interface ContactSuggestion {
  contact_id: string;
  email_id: string;
  display_name: string;
  email_address: string;
  label: string;
}
export const contactSuggestions = (query: string, signal: AbortSignal) =>
  api<{ suggestions: ContactSuggestion[] }>(
    `/api/contacts/suggestions?q=${encodeURIComponent(query)}`,
    { signal },
  );
