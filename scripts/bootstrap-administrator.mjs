import { randomBytes, randomUUID } from "node:crypto";
import { eq, exists, notExists, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { installationState, users, userRoles } from "../src/db/schema.ts";
import { insertWhen } from "../src/db/conditional-insert.ts";
import { hashPassword } from "../src/auth/password.ts";
import { ADMINISTRATOR_ROLE_ID } from "../src/authorization/permissions.ts";
import { runWrangler } from "./wrangler.mjs";

export const ADMINISTRATOR_EMAIL = "admin@officeflare.invalid";

export function installationQueries(userId, passwordHash) {
  const db = drizzle(async () => { throw new Error("Query compilation only"); });
  const initialized = db.select({ id: installationState.id }).from(installationState);
  const existingUsers = db.select({ id: users.id }).from(users);
  const owned = exists(db.select({ id: installationState.id }).from(installationState)
    .where(eq(installationState.bootstrap_user_id, userId)));
  // Adopt an existing installation without changing any accounts or granting privileges.
  const claim = insertWhen(db, installationState, {
    id: 1, bootstrap_user_id: sql`CASE WHEN ${exists(existingUsers)} THEN NULL ELSE ${userId} END`,
  }, notExists(initialized)).onConflictDoNothing().returning({ bootstrap_user_id: installationState.bootstrap_user_id });
  const account = insertWhen(db, users, {
    id: userId, email_address: ADMINISTRATOR_EMAIL, display_name: "Administrator",
    password_hash: passwordHash, password_changed_at: sql`unixepoch()`, password_reset_required: 1,
  }, owned);
  const assignment = insertWhen(db, userRoles, {
    user_id: userId, role_id: ADMINISTRATOR_ROLE_ID,
  }, owned).returning({ user_id: userRoles.user_id });
  const dialect = new SQLiteAsyncDialect();
  // One CLI query request becomes one atomic D1 batch. Never send BEGIN/COMMIT.
  // Wrangler has no binding flag; Drizzle handles literal escaping.
  return [claim, account, assignment].map((query) => dialect.sqlToQuery(query.getSQL().inlineParams()).sql);
}

export async function bootstrapAdministrator({ flags = [], local = false, wrangler = runWrangler, log = console.log } = {}) {
  const userId = randomUUID(), password = randomBytes(24).toString("base64url");
  const queries = installationQueries(userId, await hashPassword(password));
  let result;
  try {
    const stdout = await wrangler(["d1", "execute", "DB", local ? "--local" : "--remote", "--json", "--command",
      queries.join(";\n") + ";", ...flags], { capture: true });
    result = JSON.parse(stdout);
    if (!Array.isArray(result) || result.length !== queries.length || result.some((entry) => entry.success !== true)) {
      throw new Error("Invalid bootstrap response");
    }
  } catch {
    // Child-process errors can contain command arguments, including the password hash.
    throw new Error("Administrator initialization failed; Worker deployment stopped. Check D1 access and migrations before retrying.");
  }
  const created = result.at(-1).results?.some((row) => row.user_id === userId) === true;
  if (!created) {
    const adopted = result[0].results?.some((row) => row.bootstrap_user_id === null) === true;
    log(adopted ? "Existing users detected; automatic administrator creation skipped." :
      "Installation already initialized; administrator credentials unchanged.");
    return { created: false };
  }
  // Only the winning, committed batch may reveal its initial password.
  log(`Initial administrator created.\nEmail: ${ADMINISTRATOR_EMAIL}\nTemporary password: ${password}\nA password change is required at first login. Save this password; it will not be printed again.`);
  return { created: true, userId };
}
