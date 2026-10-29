import { eq, sql, type AnyColumn, type SQLWrapper } from "drizzle-orm";

export const increment = (column: AnyColumn) => sql<number>`${column} + 1`;
export const coalesce = (column: AnyColumn, value: number) =>
  sql<number>`coalesce(${column}, ${value})`;
// SQLite's previous-statement count gates dependent writes inside one D1 batch.
export const changedOnce = () => eq(sql<number>`changes()`, 1);
export const jsonExtract = (value: SQLWrapper, path: string) =>
  sql`json_extract(${value}, ${path})`;
export const isNot = (left: SQLWrapper, right: SQLWrapper) => sql`${left} IS NOT ${right}`;
