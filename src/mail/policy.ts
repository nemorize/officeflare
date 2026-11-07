import { t } from "../../shared/i18n/index.ts";
import { fail } from "./types";

export interface MailWorkspaceSettings {
  default_retention_days: number | null;
  max_send_bytes: number | null;
  external_forwarding_enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
}
export async function workspaceMailPolicy(env: Env): Promise<MailWorkspaceSettings> {
  return (await env.DB.withSession("first-primary")
    .prepare("SELECT * FROM mail_workspace_settings WHERE id=1")
    .first<MailWorkspaceSettings>())!;
}
export const mailSendLimit = (domain: number | null, workspace: number | null) =>
  domain === null ? workspace : workspace === null ? domain : Math.min(domain, workspace);

export async function forwardingAllowed(env: Env, destination: string) {
  if ((await workspaceMailPolicy(env)).external_forwarding_enabled) return true;
  return !!(await env.DB.withSession("first-primary")
    .prepare("SELECT id FROM mail_domains WHERE name=?")
    .bind(destination.split("@").at(-1)!.toLowerCase())
    .first());
}
export async function requireForwardingAllowed(env: Env, destination: string) {
  if (!(await forwardingAllowed(env, destination)))
    fail(403, t("mailAdmin.externalForwardingBlocked"));
}
