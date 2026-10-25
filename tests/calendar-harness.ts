import worker from "../dist/index.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { deliverCalendar, recoverCalendar } from "../src/calendar/jobs";
import type { AuthEnv } from "../src/auth/types";
import { syncCalendarFeed, recoverCalendarFeeds } from "../src/calendar/feed-sync";
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
    if (["/test-calendar/feed-sync", "/test-calendar/feed-recover"].includes(new URL(request.url).pathname)) {
      const data = await request.json() as { id: string; content?: string; status?: number; headers?: Record<string, string>; dns?: string; before_commit?: string; fail_batch?: boolean };
      const requests: { url: string; headers: Record<string, string> }[] = [];
      const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input); requests.push({ url, headers: Object.fromEntries(new Headers(init?.headers)) });
        if (url.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: [{ type: 1, data: data.dns ?? "93.184.216.34" }] });
        if (data.before_commit) await env.DB.prepare(data.before_commit).run();
        return new Response([204, 304].includes(data.status ?? 200) ? null : data.content ?? "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", { status: data.status ?? 200, headers: data.headers });
      };
      const feedEnv = data.fail_batch ? { ...env, DB: new Proxy(env.DB, {
        get(target, key) {
          if (key === "withSession") return (...args: Parameters<D1Database["withSession"]>) => {
            const session = target.withSession(...args);
            return new Proxy(session, { get(current, property) {
              if (property === "batch") return (statements: D1PreparedStatement[]) => current.batch([...statements, current.prepare("INSERT INTO missing_calendar_test_table VALUES(1)")]);
              const item = Reflect.get(current, property); return typeof item === "function" ? item.bind(current) : item;
            } });
          };
          const item = Reflect.get(target, key); return typeof item === "function" ? item.bind(target) : item;
        },
      }) } : env;
      if (new URL(request.url).pathname.endsWith("feed-recover")) await recoverCalendarFeeds(feedEnv as AuthEnv, fetcher);
      else await syncCalendarFeed(feedEnv as AuthEnv, data.id, fetcher);
      return Response.json({ requests });
    }
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
    const executed: string[] = [];
    const queries = new WeakMap<object, string>();
    const wrap = (
      value: D1PreparedStatement,
      query: string,
    ): D1PreparedStatement => {
      const result = new Proxy(value, {
        get(target, key) {
          if (key === "bind")
            return (...args: unknown[]) => wrap(target.bind(...args), query);
          if (key === "all" || key === "first" || key === "run")
            return (...args: unknown[]) => { executed.push(query); return (target[key] as (...args: unknown[]) => unknown)(...args); };
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
    const response = await worker.fetch(request, { ...env, DB: db }, ctx);
    if (!request.headers.has("x-test-calendar-queries")) return response;
    const measured = new Response(response.body, response);
    measured.headers.set("x-test-calendar-catalog-reads", String(executed.filter(sql => sql.startsWith("SELECT cal.*")).length));
    measured.headers.set("x-test-calendar-query-count", String(executed.length));
    return measured;
  },
};
