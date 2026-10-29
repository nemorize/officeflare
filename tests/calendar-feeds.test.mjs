import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fixture } from "./calendar-fixture.mjs";
const bundle = await build({
  stdin: { contents: 'export * from "./src/calendar/feed-fetch.ts";', resolveDir: process.cwd() },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022",
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { feedUrl, fetchCalendarFeed } = module.exports;
const empty = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
const entry = (uid, title, extra = []) =>
  [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${title}`,
    "DTSTART;VALUE=DATE:20261025",
    "DTEND;VALUE=DATE:20261026",
    ...extra,
    "END:VEVENT",
  ].join("\r\n");
const file = (...entries) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...entries, "END:VCALENDAR", ""].join("\r\n");
const dns = (address) =>
  Response.json({ Status: 0, Answer: [{ type: 1, data: address ?? "93.184.216.34" }] });
const validators = { etag: null, last_modified: null };

test("Calendar feed URLs accept HTTPS and webcal without allowing local networks or credentials", () => {
  assert.equal(
    feedUrl("webcal://calendar.example.com/private.ics?key=secret#fragment").href,
    "https://calendar.example.com/private.ics?key=secret",
  );
  assert.equal(feedUrl("http://calendar.example.com/calendar.ics").protocol, "https:");
  for (const url of [
    "file:///etc/passwd",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://localhost/a",
    "https://test.internal/a",
    "https://user:pass@example.com/a",
    "https://example.com:8080/a",
    "https://example.com/\nother",
  ])
    assert.throws(() => feedUrl(url));
});
test("Calendar feed downloads validate DNS and each redirect, limit bytes, and hide transport secrets", async () => {
  await assert.rejects(
    () =>
      fetchCalendarFeed("https://example.com/private?secret=token", validators, async () =>
        dns("10.0.0.1"),
      ),
    /public address/,
  );
  const redirected = async (url) =>
    String(url).includes("cloudflare-dns.com")
      ? dns()
      : new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/private" } });
  await assert.rejects(
    () => fetchCalendarFeed("https://example.com/calendar.ics", validators, redirected),
    /public HTTPS/,
  );
  const tooLarge = async (url) =>
    String(url).includes("cloudflare-dns.com")
      ? dns()
      : new Response("x", { headers: { "Content-Length": "2097153" } });
  await assert.rejects(
    () => fetchCalendarFeed("https://example.com/calendar.ics", validators, tooLarge),
    /larger than 2 MiB/,
  );
  const failure = async (url) => {
    if (String(url).includes("cloudflare-dns.com")) return dns();
    throw new Error(String(url));
  };
  await assert.rejects(
    () => fetchCalendarFeed("https://example.com/calendar?secret=token", validators, failure),
    (error) => !error.message.includes("token") && error.code === "UNREACHABLE",
  );
});
test("Calendar feed downloads use bounded conditional requests without forwarding validators to redirect targets", async () => {
  const requests = [];
  const fetcher = async (input, init) => {
    const url = String(input);
    if (url.includes("cloudflare-dns.com")) return dns();
    requests.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
    return new Response(null, { status: 304 });
  };
  const result = await fetchCalendarFeed(
    "https://example.com/calendar",
    { etag: '"v1"', last_modified: "Sun, 25 Oct 2026 00:00:00 GMT" },
    fetcher,
  );
  assert.equal(result.content, null);
  assert.equal(requests[0].headers.get("if-none-match"), '"v1"');
  assert.equal(requests[0].headers.get("authorization"), null);
  assert.equal(requests[0].redirect, "manual");
  const redirectCalls = [];
  const redirect = async (input, init) => {
    const url = String(input);
    if (url.includes("cloudflare-dns.com")) return dns();
    redirectCalls.push(new Headers(init.headers));
    return redirectCalls.length === 1
      ? new Response(null, { status: 302, headers: { Location: "https://other.example.com/feed" } })
      : new Response(empty, { headers: { ETag: '"other"' } });
  };
  const redirected = await fetchCalendarFeed(
    "https://example.com/calendar",
    { etag: '"v1"', last_modified: null },
    redirect,
  );
  assert.equal(redirectCalls[1].get("if-none-match"), null);
  assert.equal(redirected.etag, null);
});
const create = (f, extra = {}, headers = {}) =>
  f.call("/feeds", {
    method: "POST",
    expected: 201,
    data: {
      name: "External team",
      url: "https://calendar.example.com/private.ics?key=synthetic-secret",
      time_zone: "Asia/Seoul",
      ...extra,
    },
    headers,
  });
const sync = async (f, id, data = {}, recover = false) => {
  const response = await f.faults.fetch(
    `https://office.test/test-calendar/${recover ? "feed-recover" : "feed-sync"}`,
    { method: "POST", body: JSON.stringify({ id, ...data }) },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const due = (f, id) =>
  f.db
    .prepare("UPDATE calendar_feeds SET next_sync_at=0,lease_until=0 WHERE calendar_id=?")
    .bind(id)
    .run();
const events = async (f, id) =>
  (
    await f.db
      .prepare("SELECT * FROM calendar_events WHERE organizer_calendar_id=? ORDER BY i_cal_uid")
      .bind(id)
      .all()
  ).results;
const state = async (f, id) => (await f.call(`/calendars/${id}/feed`)).feed;

test("Calendar feeds preserve UIDs and recurrence exceptions while applying updates, removals and 304 responses", async (t) => {
  const f = await fixture(t);
  const options = { "Idempotency-Key": "register-feed-once" };
  const registered = await create(f, {}, options),
    id = registered.calendar.id;
  assert.equal(registered.calendar.kind, "external");
  assert.equal(registered.feed.status, "pending");
  assert.ok(!JSON.stringify(registered).includes("synthetic-secret"));
  assert.equal((await create(f, {}, options)).calendar.id, id);
  const stored = await f.db
    .prepare("SELECT source_secret FROM calendar_feeds WHERE calendar_id=?")
    .bind(id)
    .first();
  assert.ok(!stored.source_secret.includes("synthetic-secret"));
  const initial = file(
    entry("a", "Meeting", ["RRULE:FREQ=DAILY;COUNT=3"]),
    entry("b", "Removed later"),
  );
  await sync(f, id, { content: initial, headers: { ETag: '"v1"' } });
  let list = await events(f, id);
  assert.equal(list.length, 2);
  assert.equal(list[0].authority, "remote");
  const eventId = list[0].id;
  assert.equal((await state(f, id)).status, "healthy");
  assert.equal((await state(f, id)).event_count, 2);
  const changed = file(
    entry("a", "Renamed", ["RRULE:FREQ=DAILY;COUNT=3"]),
    [
      "BEGIN:VEVENT",
      "UID:a",
      "RECURRENCE-ID;VALUE=DATE:20261026",
      "DTSTART;VALUE=DATE:20261029",
      "SUMMARY:Moved occurrence",
      "END:VEVENT",
    ].join("\r\n"),
  );
  await due(f, id);
  await sync(f, id, { content: changed, headers: { ETag: '"v2"' } });
  list = await events(f, id);
  assert.equal(list[0].id, eventId);
  assert.equal(list[0].title, "Renamed");
  assert.equal(list[0].version, 2);
  assert.ok(list[1].trashed_at);
  const instances = await f.instances(
    eventId,
    "2026-10-24T00:00:00Z",
    "2026-11-02T00:00:00Z",
    "",
    id,
  );
  assert.deepEqual(
    instances.map((item) => item.start.date),
    ["2026-10-25", "2026-10-27", "2026-10-29"],
  );
  assert.equal(instances[2].title, "Moved occurrence");
  await due(f, id);
  const notModified = await sync(f, id, { status: 304 });
  assert.equal(notModified.requests.at(-1).headers["if-none-match"], '"v2"');
  assert.equal((await events(f, id))[0].version, 2);
  await due(f, id);
  await sync(f, id, { content: changed });
  assert.equal((await events(f, id))[0].version, 2);
  await due(f, id);
  await sync(f, id, { content: empty });
  assert.ok((await events(f, id)).every((event) => event.trashed_at));
  assert.equal((await f.call("/trash/events")).events.length, 0);
  await due(f, id);
  await sync(f, id, { content: initial });
  list = await events(f, id);
  assert.equal(list[0].id, eventId);
  assert.equal(list[0].trashed_at, null);
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM calendar_event_attendees").first()).n,
    0,
  );
});
test("Calendar feed failures preserve the last snapshot and validators, with retry and reconnect controls", async (t) => {
  const f = await fixture(t),
    { calendar } = await create(f),
    id = calendar.id;
  await sync(f, id, { content: file(entry("keep", "Keep me")), headers: { ETag: '"good"' } });
  const prior = await events(f, id);
  for (const data of [
    { status: 403 },
    { content: "<html>Sign in</html>" },
    { content: file(entry("bad", "Unsupported recurrence", ["RRULE:FREQ=HOURLY;COUNT=2"])) },
    { content: file(entry("replacement", "Must roll back")), fail_batch: true },
  ]) {
    await due(f, id);
    await sync(f, id, data);
    assert.deepEqual(await events(f, id), prior);
    const feed = await state(f, id);
    assert.equal(feed.status, "error");
    assert.ok(feed.error_message);
    assert.ok(feed.last_success_at);
    assert.ok(feed.next_sync_at > Date.now() / 1000);
    assert.equal(
      (await f.db.prepare("SELECT etag FROM calendar_feeds WHERE calendar_id=?").bind(id).first())
        .etag,
      '"good"',
    );
  }
  let feed = await state(f, id);
  await f.call(`/calendars/${id}/feed/refresh`, {
    method: "POST",
    expected: 429,
    data: { version: feed.version },
  });
  await f.call(`/calendars/${id}/feed`, {
    method: "PATCH",
    data: { version: feed.version, url: "webcal://new.example.com/fresh.ics?key=new-secret" },
  });
  feed = await state(f, id);
  assert.equal(feed.source_host, "new.example.com");
  assert.equal(feed.status, "pending");
  await sync(f, id, { content: file(entry("keep", "Reconnected")) });
  assert.equal((await events(f, id))[0].title, "Reconnected");
  assert.equal((await state(f, id)).error_message, null);
});
test("Calendar feed claims fence stale jobs, skip paused or disabled owners, and stop after disconnect", async (t) => {
  const f = await fixture(t),
    { calendar } = await create(f),
    id = calendar.id;
  await sync(f, id, { content: file(entry("stable", "Original")) });
  await due(f, id);
  await sync(f, id, {
    content: file(entry("stable", "Stale result")),
    before_commit: `UPDATE calendar_feeds SET version=version+1,lease_token=NULL,lease_until=0 WHERE calendar_id='${id}'`,
  });
  assert.equal((await events(f, id))[0].title, "Original");
  let feed = await state(f, id);
  await f.call(`/calendars/${id}/feed`, {
    method: "PATCH",
    data: { version: feed.version, enabled: false },
  });
  assert.equal((await sync(f, id)).requests.length, 0);
  feed = await state(f, id);
  await f.call(`/calendars/${id}/feed`, {
    method: "PATCH",
    data: { version: feed.version, enabled: true },
  });
  await f.db.prepare("UPDATE users SET disabled_at=unixepoch() WHERE id='alice'").run();
  assert.equal((await sync(f, id)).requests.length, 0);
  await f.db.prepare("UPDATE users SET disabled_at=NULL WHERE id='alice'").run();
  await f.db.prepare("DELETE FROM user_roles WHERE user_id='alice'").run();
  assert.equal((await sync(f, id)).requests.length, 0);
  await f.db
    .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('alice','calendar-test')")
    .run();
  await sync(f, id, { content: file(entry("stable", "Scheduled refresh")) }, true);
  assert.equal((await events(f, id))[0].title, "Scheduled refresh");
  feed = await state(f, id);
  await f.call(`/calendars/${id}/feed?version=${feed.version}`, {
    method: "DELETE",
    expected: 204,
  });
  assert.equal((await sync(f, id)).requests.length, 0);
  assert.equal(
    (
      await f.db
        .prepare("SELECT source_secret FROM calendar_feeds WHERE calendar_id=?")
        .bind(id)
        .first()
    ).source_secret,
    null,
  );
  assert.ok(!(await f.call("/bootstrap")).calendars.some((cal) => cal.id === id));
});
test("External calendar subscriptions enforce ownership, read-only events and URL validation", async (t) => {
  const f = await fixture(t),
    { calendar } = await create(f),
    id = calendar.id;
  await f.call("/feeds", {
    method: "POST",
    expected: 409,
    data: {
      name: "Duplicate",
      url: "https://calendar.example.com/private.ics?key=synthetic-secret",
    },
  });
  await f.call("/feeds", {
    actor: "read-only",
    method: "POST",
    expected: 403,
    data: { name: "Denied", url: "https://example.com/feed" },
  });
  await f.call(`/calendars/${id}/feed`, { actor: "bob", expected: 404 });
  for (const url of [
    "https://127.0.0.1/a",
    "https://localhost/a",
    "https://user:pass@example.com/a",
  ])
    await f.call("/feeds", { method: "POST", expected: 400, data: { name: "Bad", url } });
  await sync(f, id, { content: file(entry("read-only", "Source event")) });
  const event = (await events(f, id))[0];
  await f.call(`/calendars/${id}/events`, {
    method: "POST",
    expected: 403,
    data: { title: "Cannot add", start: { date: "2026-10-25" }, end: { date: "2026-10-26" } },
  });
  await f.call(`/calendars/${id}/imports`, {
    method: "POST",
    expected: 403,
    data: { content: file(entry("x", "Cannot import")) },
  });
  await f.call(`/calendars/${id}/events/${event.id}`, {
    method: "PATCH",
    expected: 403,
    data: { version: 1, title: "Cannot edit" },
  });
  await f.call(`/calendars/${id}/events/${event.id}/duplicate`, {
    method: "POST",
    expected: 403,
    data: { version: 1 },
  });
  const native = await f.create({
    title: "Native",
    start: { date: "2026-10-25" },
    end: { date: "2026-10-26" },
  });
  await f.call(`/calendars/primary/events/${native.event.id}/move`, {
    method: "POST",
    expected: 403,
    data: { version: 1, target_calendar_id: id },
  });
  let feed = await state(f, id);
  await f.call(`/calendars/${id}/feed`, {
    method: "PATCH",
    expected: 412,
    data: { version: feed.version + 100, enabled: false },
  });
});
test("Calendar feed bulk snapshots handle more than file-import limits and keep unchanged versions stable", async (t) => {
  const f = await fixture(t),
    { calendar } = await create(f),
    id = calendar.id;
  const content = file(
    ...Array.from({ length: 250 }, (_, index) =>
      entry(`bulk-${index}`, `일정 ${index}`, ["DESCRIPTION:" + "한글".repeat(250)]),
    ),
  );
  await sync(f, id, { content });
  let snapshot = await events(f, id);
  assert.equal(snapshot.length, 250);
  assert.ok(snapshot.every((event) => event.version === 1));
  assert.equal((await state(f, id)).event_count, 250);
  await due(f, id);
  await sync(f, id, { content });
  snapshot = await events(f, id);
  assert.ok(snapshot.every((event) => event.version === 1));
  await f.call(`/calendars/${id}`, {
    method: "PATCH",
    data: { version: calendar.version, time_zone: "America/New_York" },
  });
  const stored = await f.db
    .prepare("SELECT etag,next_sync_at,lease_until FROM calendar_feeds WHERE calendar_id=?")
    .bind(id)
    .first();
  assert.equal(stored.etag, null);
  assert.equal(stored.lease_until, 0);
  assert.ok(stored.next_sync_at <= Date.now() / 1000);
});
