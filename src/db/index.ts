import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Database = DrizzleD1Database<typeof schema>;
export function createDatabase(binding: D1Database): Database {
  // The D1 driver only uses prepare()/batch(); its current types omit D1DatabaseSession.
  // Keep the primary-first session on every ORM query, including its atomic batches.
  return drizzle(binding.withSession("first-primary") as unknown as D1Database, { schema });
}
