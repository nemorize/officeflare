export interface PushWebConfig {
  apiKey: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
}
export interface PushConfiguration {
  available: boolean;
  firebase?: PushWebConfig;
  vapid_key?: string;
}
export interface PushSettings {
  configured: boolean;
  web_push_enabled: boolean;
  version: number;
}
export const pushTarget = (path: unknown) =>
  typeof path === "string" &&
  (path === "/notifications" ||
    path === "/profile/sessions" ||
    path === "/mail" ||
    /^\/calendar\/invitations\/[A-Za-z0-9_-]+$/.test(path))
    ? path
    : "/notifications";
