import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fixture } from "./calendar-fixture.mjs";

const bundle = await build({
  stdin: {
    contents:
      'export * from "./web/lib/calendar-resource-cache.ts"; export * from "./web/lib/calendar-date.ts"; export { loadCalendarEvents } from "./web/lib/calendar.ts"; export { setLoader } from "calendar-test-api";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "calendar-api-fixture",
      setup(build) {
        build.onResolve({ filter: /^calendar-test-api$|^\.\/api$/ }, (args) =>
          args.path === "calendar-test-api" || args.importer.endsWith("/web/lib/calendar.ts")
            ? { path: "api", namespace: "calendar-test" }
            : undefined,
        );
        build.onLoad({ filter: /.*/, namespace: "calendar-test" }, () => ({
          contents:
            "let loader; export const setLoader = value => { loader = value; }; export const api = (...args) => loader(...args); export class ApiError extends Error { constructor(status,message) { super(message); this.status=status; } } export const errorMessage = error => error.message;",
        }));
      },
    },
  ],
});
const ui = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("calendar revisits reuse fresh ranges and concurrent requests; stale refreshes keep visible results", async () => {
  let now = 0,
    calls = 0,
    finish;
  const cache = new ui.CalendarResourceCache(
    async (_key, _signal, progress) => {
      calls++;
      progress(["first page"]);
      await new Promise((resolve) => {
        finish = resolve;
      });
      return ["first page", "second page"];
    },
    () => now,
  );
  const first = cache.load("week");
  assert.equal(cache.load("week"), first);
  await tick();
  assert.deepEqual(cache.snapshot("week").data, ["first page"]);
  assert.equal(cache.snapshot("week").loading, true);
  finish();
  await first;
  await cache.load("week");
  assert.equal(calls, 1);
  now = 30_001;
  const refresh = cache.load("week");
  assert.deepEqual(cache.snapshot("week").data, ["first page", "second page"]);
  await tick();
  finish();
  await refresh;
  assert.equal(calls, 2);
});

test("calendar mutation invalidation cancels stale pages and discards saved inactive ranges", async () => {
  const pending = [];
  const cache = new ui.CalendarResourceCache((key, signal, progress) =>
    key === "saved"
      ? Promise.resolve(["deleted event"])
      : new Promise((resolve) => pending.push({ signal, progress, resolve })),
  );
  await cache.load("saved");
  const unsubscribe = cache.subscribe("visible", () => {});
  const old = cache.load("visible");
  await tick();
  pending[0].progress(["old"]);
  cache.invalidate();
  await tick();
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(cache.snapshot("saved").data, null);
  pending[1].progress(["new"]);
  pending[0].progress(["late old page"]);
  pending[0].resolve(["late old result"]);
  await old;
  assert.deepEqual(cache.snapshot("visible").data, ["new"]);
  const current = cache.load("visible");
  pending[1].resolve(["new"]);
  await current;
  assert.equal(cache.snapshot("visible").loading, false);
  unsubscribe();
});

test("calendar failures retain usable results, but revoked access removes every cached range", async () => {
  let now = 0,
    status = 0;
  const cache = new ui.CalendarResourceCache(
    async (key) => {
      if (status) throw Object.assign(new Error("failed"), { status });
      return [key];
    },
    () => now,
  );
  await cache.load("a");
  await cache.load("b");
  now = 30_001;
  status = 500;
  await cache.load("a");
  assert.deepEqual(cache.snapshot("a").data, ["a"]);
  assert.equal(cache.snapshot("a").loading, false);
  status = 403;
  await cache.load("a");
  assert.equal(cache.snapshot("a").data, null);
  assert.equal(cache.snapshot("b").data, null);
  const nextSession = new ui.CalendarResourceCache(async () => []);
  assert.equal(nextSession.snapshot("a").data, null);
});

test("calendar cache bounds idle ranges and rejects responses from a disposed scope", async () => {
  let finish;
  const cache = new ui.CalendarResourceCache(
    async (key) =>
      key === "pending"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : [key],
    Date.now,
    30_000,
    2,
  );
  await cache.load("a");
  await cache.load("b");
  await cache.load("c");
  assert.equal(cache.snapshot("a").data, null);
  const request = cache.load("pending");
  await tick();
  cache.clear();
  finish(["old account"]);
  await request;
  assert.equal(cache.snapshot("pending").data, null);
});

test("calendar pagination publishes the first page before later requests finish and stops on abort", async () => {
  const controller = new AbortController(),
    pages = [];
  let calls = 0,
    finish;
  ui.setLoader(async (path) => {
    calls++;
    assert.match(path, /limit=500/);
    if (calls === 1) return { events: [{ id: "first" }], next_cursor: "next" };
    assert.match(path, /cursor=next/);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const request = ui.loadCalendarEvents(
    new URLSearchParams({ q: "meeting" }),
    controller.signal,
    (events) => pages.push(events.map((event) => event.id)),
  );
  await tick();
  assert.deepEqual(pages, [["first"]]);
  controller.abort();
  finish({ events: [{ id: "late" }], next_cursor: "more" });
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(calls, 2);
  assert.deepEqual(pages, [["first"]]);
});

test("cached calendar date conversions remain correct across zones, DST, midnight and edited endpoints", () => {
  const value = {
    start: { date_time: "2026-11-01T05:30:00Z", time_zone: "America/New_York" },
    end: { date_time: "2026-11-02T05:00:00Z", time_zone: "America/New_York" },
  };
  const bounds = ui.eventDayBounds(value, "America/New_York");
  assert.deepEqual(bounds, { start: "2026-11-01", end: "2026-11-02" });
  assert.equal(ui.eventDayBounds(value, "America/New_York"), bounds);
  assert.equal(ui.endpointLocal(value.start, "America/New_York").time, "01:30");
  assert.equal(ui.endpointLocal(value.start, "Asia/Seoul").time, "14:30");
  value.end.date_time = "2026-11-02T05:00:00.000000001Z";
  assert.equal(ui.eventDayBounds(value, "America/New_York").end, "2026-11-03");
  value.start.date_time = "2026-11-02T06:00:00Z";
  assert.equal(ui.endpointLocal(value.start, "America/New_York").date, "2026-11-02");
  assert.equal(ui.eventDayBounds(value, "America/New_York").start, "2026-11-02");
});

test("event listing reads the authorized calendar catalog once for many calendars and bootstrap reuses it", async (t) => {
  const f = await fixture(t);
  const bootstrap = await f.call("/bootstrap"),
    ids = [bootstrap.primary_calendar_id];
  for (let i = 0; i < 12; i++)
    ids.push(
      (
        await f.call("/calendars", {
          method: "POST",
          expected: 201,
          data: { name: `Calendar ${i}`, time_zone: "Asia/Seoul" },
        })
      ).calendar.id,
    );
  const measure = async (path) => {
    const response = await f.raw(path, {
      fault: true,
      headers: { "x-test-calendar-queries": "1" },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(Number(response.headers.get("x-test-calendar-catalog-reads")), 1);
    return Number(response.headers.get("x-test-calendar-query-count"));
  };
  await measure("/bootstrap");
  const query = "/events?time_min=2026-10-01T00:00:00Z&time_max=2026-11-01T00:00:00Z&calendar_ids=";
  const one = await measure(query + ids[0]),
    many = await measure(query + ids.join(","));
  assert.equal(many, one, "query count must not grow with selected calendars");
  await f.call(query + "primary," + ids[0]);
  await f.call(query + ids[0] + ",missing-calendar", { expected: 404 });
  // Batched attendance lookups must keep different calendar owners' responses apart.
  await f.db
    .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('no-calendar','calendar-test')")
    .run();
  const owners = [];
  for (const actor of ["bob", "no-calendar"]) {
    owners.push((await f.call("/bootstrap", { actor })).primary_calendar_id);
    await f.call("/calendars/primary/acl", {
      actor,
      method: "POST",
      expected: 201,
      data: { scope_type: "user", scope_key: "alice", role: "writer" },
    });
    const pref = await f.call("/preferences", { actor });
    await f.call("/preferences", {
      actor,
      method: "PATCH",
      data: { version: pref.version, invitation_policy: "on_response" },
    });
  }
  const invited = await f.create({
    title: "Shared attendance",
    start: { date: "2026-10-15" },
    end: { date: "2026-10-16" },
    attendees: [{ user_id: "bob" }, { user_id: "no-calendar" }],
  });
  const attendees = (await f.call(`/calendars/primary/events/${invited.event.id}/attendees`))
    .attendees;
  const bob = attendees.find((attendee) => attendee.user_id === "bob");
  await f.call(`/inbox-invitations/${bob.id}/rsvp`, {
    actor: "bob",
    method: "POST",
    data: { version: bob.version, response_status: "accepted" },
  });
  assert.equal((await f.call(query + owners.join(","))).events.length, 1);
  assert.equal((await f.call(query + owners[1])).events.length, 0);
});

test("calendar bootstrap includes the authorized first event page and frontend consumes it without another request", async (t) => {
  const f = await fixture(t);
  await f.call("/bootstrap");
  await f.create({
    title: "First page",
    start: { date: "2026-10-15" },
    end: { date: "2026-10-16" },
  });
  const result = await f.call("/bootstrap?include_events=true&date=2026-10-15&view=month");
  assert.ok(result.initial_events.events.some((event) => event.title === "First page"));
  const page = await f.call("/events?" + result.initial_events.query + "&limit=500");
  assert.deepEqual(result.initial_events.events, page.events);
  ui.setLoader(() => {
    throw new Error("duplicate initial read");
  });
  const events = await ui.loadCalendarEvents(
    new URLSearchParams(result.initial_events.query),
    new AbortController().signal,
    undefined,
    result.initial_events,
  );
  assert.deepEqual(events, page.events);
});

test("a rejected initial event query preserves calendar metadata and surfaces the event error without another request", async (t) => {
  const f = await fixture(t);
  const result = await f.call("/bootstrap?include_events=true&q=" + "x".repeat(256));
  assert.ok(result.calendars.length);
  assert.ok(result.preferences.time_zone);
  assert.equal(result.initial_events.error.status, 400);
  ui.setLoader(() => {
    throw new Error("duplicate rejected query");
  });
  await assert.rejects(
    ui.loadCalendarEvents(
      new URLSearchParams(result.initial_events.query),
      new AbortController().signal,
      undefined,
      result.initial_events,
    ),
    { status: 400 },
  );
});
