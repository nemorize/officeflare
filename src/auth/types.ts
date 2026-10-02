import type { Context } from "hono";

export type AuthEnv = Env & {
  AUTH_SIGNING_KEYS: string;
  MFA_ENCRYPTION_KEYS: string;
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
};
export interface User {
  id: string;
  email_address: string;
  display_name: string | null;
  profile_image_key: string | null;
  password_hash: string | null;
  password_changed_at: number | null;
  password_reset_required: number;
  auth_version: number;
  disabled_at: number | null;
  deleted_at: number | null;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface Session {
  id: string;
  user_id: string;
  auth_version: number;
  password_authenticated_at: number;
  mfa_authenticated_at: number | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number;
  user_agent: string | null;
}
export interface Challenge {
  id: string;
  user_id: string;
  session_id: string | null;
  purpose: "login" | "login_mfa" | "password_reset" | "reauth_mfa" | "reauth";
  auth_version: number;
  password_authenticated_at: number;
  mfa_authenticated_at: number | null;
  expires_at: number;
  attempts: number;
  used_at: number | null;
  used_by: string | null;
}
export interface Identity { user: User; session: Session }
export type AppEnv = {
  Bindings: AuthEnv;
  Variables: { db: D1DatabaseSession; identity: Identity };
};
export type AuthContext = Context<AppEnv>;
export const now = () => Math.floor(Date.now() / 1000);
export const uuid = () => crypto.randomUUID();
export const ACCESS_TTL = 900;
export const SESSION_TTL = 30 * 86400;
export const CHALLENGE_TTL = 300;
