import { test } from "node:test";
import assert from "node:assert/strict";
import { benchmark, percentile, timingMetrics } from "../scripts/benchmark.mjs";
test("performance comparison records warm read latency and bounded server metrics without credentials or response content", async () => {
  let calls = 0;
  const result = await benchmark({
    baseUrl: "https://example.test",
    paths: ["/api/drive/items?owner=private@example.test"],
    token: "secret",
    samples: 3,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      return new Response("private content", {
        headers: { "server-timing": 'auth;dur=1.5, d1_queries;desc="6"' },
      });
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.results[0].metrics.d1_queries.p95, 6);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.deepEqual(timingMetrics('x;dur=1.1, y;desc="3"'), { x: 1.1, y: 3 });
  await assert.rejects(
    benchmark({
      baseUrl: "https://example.test",
      paths: ["https://other.test/api/drive"],
      token: "secret",
      samples: 1,
    }),
    /same-origin/,
  );
});

const { build } = await import("esbuild");
const source = await build({
  stdin: {
    contents:
      'export * from "./src/db/request.ts";export * from "./src/observability/performance.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { requestDatabase, RequestPerformance, observedObjects } = await import(
  `data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString("base64")}`
);
test("request database shares one session, preserves statement/batch behavior and distinguishes SQL count from round trips", async () => {
  let sessions = 0;
  const prepared = new Set();
  const result = { results: [{ value: 7 }], meta: { duration: 2, rows_read: 1, rows_written: 0 } };
  const raw = {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          return result;
        },
        async run() {
          return result;
        },
        async raw() {
          return [[7]];
        },
      };
      prepared.add(statement);
      return statement;
    },
    async batch(statements) {
      assert.ok(statements.every((s) => prepared.has(s)));
      return statements.map(() => result);
    },
    getBookmark() {
      return "bookmark";
    },
  };
  const trace = new RequestPerformance(),
    db = requestDatabase(
      {
        withSession() {
          sessions++;
          return raw;
        },
      },
      trace,
    );
  assert.equal(await db.withSession("first-primary").prepare("query").bind(1).first("value"), 7);
  await assert.rejects(db.prepare("query").first("missing"), /D1_COLUMN_NOTFOUND/);
  assert.deepEqual(await db.prepare("query").raw(), [[7]]);
  await db.batch([db.prepare("a"), db.prepare("b")]);
  assert.equal(sessions, 1);
  assert.equal(trace.databaseCalls, 4);
  assert.equal(trace.queries, 5);
  assert.equal(db.withSession().getBookmark(), "bookmark");
  assert.equal(trace.metadataQueries, 4);
  assert.match(trace.header(), /d1_calls;desc="4"/);
});
test("RPC timings invoke the function directly without accessing remote apply/bind properties", async () => {
  const invoke = new Proxy(
    function (x) {
      return Promise.resolve(x + 1);
    },
    {
      get() {
        throw new Error("remote property lookup");
      },
    },
  );
  const trace = new RequestPerformance(),
    objects = observedObjects({ getByName: () => ({ increment: invoke }) }, trace);
  assert.equal(await objects.getByName("box").increment(4), 5);
  assert.match(trace.header(), /do_calls;desc="1"/);
});
