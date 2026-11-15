export const serviceDefaults = {
  general: {
    workspace_name: "Officeflare",
    support_url: "",
    default_language: "system",
    default_time_zone: "UTC",
    default_regional_format: "en",
  },
  contacts: {
    entries_enabled: true,
    folders_enabled: true,
    fields_enabled: true,
    max_contacts: 0,
    max_folders: 0,
    max_fields: 0,
  },
  wiki: {
    spaces_enabled: true,
    pages_enabled: true,
    comments_enabled: true,
    sharing_enabled: true,
  },
} as const;
export type SettingsService = keyof typeof serviceDefaults;
export type ConsoleService = SettingsService | "calendar";
export type SettingValue = string | boolean | number | null;
export interface ServiceSettings {
  values: Record<string, SettingValue>;
  version: number;
  updated_at: number | null;
}
