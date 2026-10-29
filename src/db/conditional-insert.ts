import { getTableColumns, Param, SQL, sql } from "drizzle-orm";
import type {
  SQLiteInsertSelectQueryBuilder,
  SQLiteInsertValue,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import type { Database } from ".";

// INSERT ... SELECT keeps a conditional creation in the same atomic D1 batch.
// Drizzle requires every column in schema order for insert-select, even nullable/default columns.
export function insertWhen<T extends SQLiteTable>(
  db: Database,
  table: T,
  values: SQLiteInsertValue<T>,
  condition: SQL,
) {
  const columns = getTableColumns(table);
  const selection: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(columns)) {
    const value = values[key as keyof typeof values];
    const selected = value === undefined ? (column.default ?? column.defaultFn?.() ?? null) : value;
    selection[key] = selected instanceof SQL ? selected : sql`${new Param(selected, column)}`;
  }
  const query = db
    .select(selection)
    .from(sql`(VALUES (1))`)
    .where(condition);
  // Object.entries preserves the schema order required by Drizzle's insert-select check.
  return db.insert(table).select(query as unknown as SQLiteInsertSelectQueryBuilder<T>);
}
