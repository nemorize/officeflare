export interface CalendarWorkspaceSettings {
  system_address_id: string | null;
  internal_sharing_enabled: number;
  external_sharing_enabled: number;
  public_link_max_days: number;
  public_link_password_required: number;
  version: number;
}

export interface CalendarAdminSettings {
  settings: CalendarWorkspaceSettings;
  sending_addresses: { id: string; email_address: string }[];
}
