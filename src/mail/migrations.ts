import { t } from "../../shared/i18n/index.ts";
import { fail, row } from "./types";

// DO migrations run lazily on activation and atomically with their version marker.
// Append a versioned SQL migration here when changing a deployed schema.
export function migrate(storage: DurableObjectStorage, migrations: readonly string[]) {
  const sql = storage.sql;
  sql.exec("PRAGMA foreign_keys=ON");
  sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY) STRICT");
  const current = row<{ version: number }>(
    sql,
    "SELECT coalesce(max(version),0) version FROM schema_version",
  )!.version;
  if (current > migrations.length)
    fail(503, t("mailMigrations.mailDatabaseRequiresANewerWorkerVersion"));
  for (let version = current + 1; version <= migrations.length; version++) {
    storage.transactionSync(() => {
      for (const statement of migrations[version - 1]!.split(
        migrations[version - 1]!.includes("-- statement-breakpoint")
          ? "-- statement-breakpoint"
          : ";",
      ).filter((s) => s.trim()))
        sql.exec(statement);
      sql.exec("INSERT INTO schema_version VALUES(?)", version);
    });
  }
}
