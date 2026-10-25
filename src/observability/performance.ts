import type { AuthContext } from "../auth/types";

/** Request-local timings only: never record SQL, bindings, paths or user content. */
export class RequestPerformance {
  private started = performance.now();
  private phases = new Map<string, number>();
  queries = 0;
  databaseCalls = 0;
  metadataQueries = 0;
  private counts = new Map<string, number>();
  count(name: string, value = 1) { this.counts.set(name, (this.counts.get(name) ?? 0) + value); }
  sqlMs = 0;
  rowsRead = 0;
  rowsWritten = 0;
  async measure<T>(name: string, task: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await task(); }
    finally { this.phases.set(name, (this.phases.get(name) ?? 0) + performance.now() - start); }
  }
  database(result: unknown) {
    for (const value of Array.isArray(result) ? result : [result]) {
      const meta = (value as { meta?: D1Meta } | null)?.meta;
      if (!meta) continue;
      this.metadataQueries++;
      this.sqlMs += meta.timings?.sql_duration_ms ?? meta.duration ?? 0;
      this.rowsRead += meta.rows_read ?? 0;
      this.rowsWritten += meta.rows_written ?? 0;
    }
  }
  header() {
    return [...this.phases, ["total", performance.now() - this.started], ["d1_sql", this.sqlMs]]
      .map(([name, duration]) => `${name};dur=${Number(duration).toFixed(1)}`)
      .concat([...this.counts].map(([name, value]) => `${name};desc="${value}"`)).concat(`d1_calls;desc="${this.databaseCalls}"`, `d1_metadata_queries;desc="${this.metadataQueries}"`, `d1_queries;desc="${this.queries}"`, `d1_rows_read;desc="${this.rowsRead}"`, `d1_rows_written;desc="${this.rowsWritten}"`).join(", ");
  }
}
export const measured = <T>(c: Pick<AuthContext, "get">, name: string, task: () => Promise<T>) =>
  c.get("performance")?.measure(name, task) ?? task();

export function observedObjects<T extends DurableObjectNamespace>(namespace: T, trace: RequestPerformance): T {
  return new Proxy(namespace, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "get" || key === "getByName") return (...args: unknown[]) => {
        const stub = (value as (...args: unknown[]) => DurableObjectStub).apply(target, args);
        return new Proxy(stub, { get(current, method) {
          const invoke = Reflect.get(current, method);
          if (typeof invoke !== "function") return invoke;
          return (...params: unknown[]) => {
            trace.count("do_calls");
            return trace.measure("do", async () => Reflect.apply(invoke, current, params));
          };
        } });
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
