import worker from "../dist/index.js";
import { recoverDrive } from "../src/drive/jobs";

// Test-only fault injection at the storage/transaction boundaries.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/recover") {
      await recoverDrive(env); return Response.json({ recovered: true });
    }
    let injected = false;
    const beforeBatch = request.headers.get("x-test-before-batch");
    const afterStorage = request.headers.get("x-test-after-storage");
    const failBatch = request.headers.get("x-test-fail-batch");
    const transferFault = request.headers.get("x-test-before-transfer");
    const transferChunk = Number(request.headers.get("x-test-transfer-chunk") ?? 1);
    let transferChunks = 0;
    const sql = new WeakMap<object, string>();
    const prepared = (value: D1PreparedStatement, query: string): D1PreparedStatement => {
      const wrapped = new Proxy(value, { get(target, key) {
        if (key === "bind") return (...args: unknown[]) => prepared(target.bind(...args), query);
        const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
      } });
      sql.set(wrapped, query); return wrapped;
    };
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (query: string) => prepared(target.prepare(query), query);
      if (property === "withSession") return (...args: Parameters<D1Database["withSession"]>) => {
        const session = target.withSession(...args);
        return new Proxy(session, { get(targetSession, key) {
          if (key === "prepare") return (query: string) => prepared(targetSession.prepare(query), query);
          if (key === "batch") return async (statements: D1PreparedStatement[]) => {
            const queries = statements.map(value => sql.get(value) ?? "").join(" ");
            if (!injected && beforeBatch && (queries.includes("WITH snapshot") || queries.includes("INSERT INTO drive_admin_activity"))) { injected = true; await env.DB.prepare(beforeBatch).run(); }
            if (queries.includes("UPDATE drive_items SET owner_user_id") && ++transferChunks === transferChunk && transferFault) await env.DB.prepare(transferFault).run();
            if (failBatch && queries.includes(failBatch)) return targetSession.batch([...statements, targetSession.prepare("INSERT INTO deliberately_missing_table VALUES(1)")]);
            return targetSession.batch(statements);
          };
          const value = Reflect.get(targetSession, key); return typeof value === "function" ? value.bind(targetSession) : value;
        } });
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const bucket = new Proxy(env.DRIVE_BUCKET, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "put" || property === "get") return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        if (!injected && afterStorage) { injected = true; await env.DB.prepare(afterStorage).run(); }
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, DB: db, DRIVE_BUCKET: bucket }, ctx);
  },
};
