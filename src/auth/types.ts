import type { Context } from "hono";
import type { Database } from "../db";
import type { users, userSessions, userAuthChallenges } from "../db/schema";

export type AuthEnv = Env & {
  AUTH_SIGNING_KEYS: string;
  MFA_ENCRYPTION_KEYS: string;
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
};
export type User = typeof users.$inferSelect;
export type Session = typeof userSessions.$inferSelect;
export type Challenge = typeof userAuthChallenges.$inferSelect;
export interface Identity { user: User; session: Session }
export type AppEnv = {
  Bindings: AuthEnv;
  Variables: { db: Database; identity: Identity };
};
export type AuthContext = Context<AppEnv>;
export const now = () => Math.floor(Date.now() / 1000);
export const uuid = () => crypto.randomUUID();
export const ACCESS_TTL = 900;
export const SESSION_TTL = 30 * 86400;
export const CHALLENGE_TTL = 300;
