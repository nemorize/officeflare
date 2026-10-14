import worker from "../dist/index.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { deliverCalendar, recoverCalendar } from "../src/calendar/jobs";
import type { AuthEnv } from "../src/auth/types";
export class FakeEmail extends WorkerEntrypoint<Env> {
  async send(message: unknown) {
    const id = `<${crypto.randomUUID()}@calendar.test>`;
    await this.env.MAIL_BUCKET.put(
      `test-sent/${id}.json`,
      JSON.stringify(message),
    );
    if (
      (await (await this.env.MAIL_BUCKET.get("test-mode"))?.text()) ===
      "unknown"
    )
      throw new Error("Connection lost after provider acceptance");
    return { messageId: id };
  }
}
// Test-only races at the claim boundary. Production routes never accept these headers.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/test-calendar/flush") {
      const data = (await request.json()) as {
        ids?: string[];
        after_snapshot?: string;
      };
      const jobs =
        data.ids ??
        (
          await env.DB.prepare(
            "SELECT id FROM calendar_invitation_deliveries WHERE status IN('queued','retry_wait')",
          ).all<{ id: string }>()
        ).results.map((value) => value.id);
      let injected = false;
      const deliveryEnv = data.after_snapshot
        ? {
            ...env,
            MAIL_BUCKET: new Proxy(env.MAIL_BUCKET, {
              get(target, key) {
                if (key === "put")
                  return async (...args: Parameters<R2Bucket["put"]>) => {
                    const result = await target.put(...args);
                    if (
                      !injected &&
                      args[0].startsWith("calendar/snapshots/")
                    ) {
                      injected = true;
                      await env.DB.prepare(data.after_snapshot!).run();
                    }
                    return result;
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          }
        : env;
      await Promise.all(
        jobs.map((id) => deliverCalendar(deliveryEnv as AuthEnv, id)),
      );
      return Response.json({ processed: jobs.length });
    }
    if (new URL(request.url).pathname === "/test-calendar/recover") {
      await recoverCalendar(env as AuthEnv);
      return Response.json({ recovered: true });
    }
    let injected = false;
    const queries = new WeakMap<object, string>();
    const wrap = (
      value: D1PreparedStatement,
      query: string,
    ): D1PreparedStatement => {
      const result = new Proxy(value, {
        get(target, key) {
          if (key === "bind")
            return (...args: unknown[]) => wrap(target.bind(...args), query);
          const item = Reflect.get(target, key);
          return typeof item === "function" ? item.bind(target) : item;
        },
      });
      queries.set(result, query);
      return result;
    };
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "withSession")
          return (...args: Parameters<D1Database["withSession"]>) => {
            const session = target.withSession(...args);
            return new Proxy(session, {
              get(current, key) {
                if (key === "prepare")
                  return (query: string) => wrap(current.prepare(query), query);
                if (key === "batch")
                  return async (statements: D1PreparedStatement[]) => {
                    if (
                      !injected &&
                      statements.some((value) =>
                        (queries.get(value) ?? "").includes(
                          "INSERT INTO calendar_operations",
                        ),
                      )
                    ) {
                      injected = true;
                      const before = request.headers.get("x-test-before-batch");
                      if (before) await env.DB.prepare(before).run();
                      if (request.headers.has("x-test-fail-batch"))
                        return current.batch([
                          ...statements,
                          current.prepare(
                            "INSERT INTO missing_calendar_test_table VALUES(1)",
                          ),
                        ]);
                    }
                    return current.batch(statements);
                  };
                const item = Reflect.get(current, key);
                return typeof item === "function" ? item.bind(current) : item;
              },
            });
          };
        const item = Reflect.get(target, key);
        return typeof item === "function" ? item.bind(target) : item;
      },
    });
    return worker.fetch(request, { ...env, DB: db }, ctx);
  },
};
