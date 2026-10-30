import { t } from "../../shared/i18n/index.ts";
import type { RequestPerformance } from "../observability/performance";

/** Share one primary-first session across ORM and raw SQL within this request. */
export function requestDatabase(binding: D1Database, trace: RequestPerformance): D1Database {
  const raw = binding.withSession("first-primary");
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (["all", "first", "run", "raw"].includes(String(key)))
          return (...args: unknown[]) =>
            trace.measure("d1", async () => {
              trace.queries++;
              trace.databaseCalls++;
              // all() retains query metadata; first() normally discards it.
              if (key === "first") {
                const result = await target.all<Record<string, unknown>>();
                trace.database(result);
                const row = result.results[0] ?? null;
                if (args[0] !== undefined && row) {
                  if (!(String(args[0]) in row))
                    throw new Error(t("dbRequest.d1ColumnNotfoundColumnNotFound"));
                  return row[String(args[0])];
                }
                return row;
              }
              const result = await (
                target[key as "all"] as (...args: unknown[]) => Promise<unknown>
              )(...args);
              trace.database(result);
              return result;
            });
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const session = new Proxy(raw, {
    get(target, key) {
      if (key === "prepare") return (query: string) => wrap(target.prepare(query));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          trace.measure("d1", async () => {
            trace.queries += statements.length;
            trace.databaseCalls++;
            const result = await target.batch(
              statements.map((statement) => originals.get(statement) ?? statement),
            );
            trace.database(result);
            return result;
          });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(binding, {
    get(target, key) {
      if (key === "withSession") return () => session;
      if (key === "prepare") return session.prepare.bind(session);
      if (key === "batch") return session.batch.bind(session);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
