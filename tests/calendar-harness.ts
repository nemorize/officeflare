import worker from "../dist/index.js";
// Test-only races at the claim boundary. Production routes never accept these headers.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
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
