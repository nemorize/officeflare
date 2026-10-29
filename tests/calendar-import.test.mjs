import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fixture } from "./calendar-fixture.mjs";

const bundle = await build({
  stdin: {
    contents:
      'export * from "./src/calendar/ical-import.ts"; export { expand } from "./src/calendar/recurrence.ts";',
    resolveDir: process.cwd(),
  },
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
const { parseCalendarImport, expand } = module.exports;
const cal = {
  id: "destination",
  data_owner_user_id: "alice",
  time_zone: "Asia/Seoul",
  default_visibility: "private",
};
const file = (...entries) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Import test//EN",
    ...entries,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
const entry = (uid, properties) =>
  ["BEGIN:VEVENT", `UID:${uid}`, ...properties, "END:VEVENT"].join("\r\n");
const timed = (uid, extra = []) =>
  entry(uid, ["DTSTART:20261023T010000Z", "DTEND:20261023T020000Z", ...extra]);

test("iCalendar import preserves folded and escaped text, all-day ends, privacy and safe descriptions", () => {
  const report = parseCalendarImport(
    "\uFEFF" +
      file(
        entry("all-day", [
          "DTSTART;VALUE=DATE:20261023",
          "DTEND;VALUE=DATE:20261026",
          "SUMMARY:Team\\, trip\\; ",
          " continued",
          "DESCRIPTION:<script>alert(1)</script>\\nSecond line",
          "LOCATION:Room\\, A",
          "CLASS:CONFIDENTIAL",
          "TRANSP:TRANSPARENT",
        ]),
      ),
    cal,
  );
  assert.equal(report.entries[0].status, "ready");
  const event = report.plans[0].event;
  assert.equal(event.i_cal_uid, "all-day");
  assert.equal(event.title, "Team, trip; continued");
  assert.equal(event.start_date, "2026-10-23");
  assert.equal(event.end_date, "2026-10-26");
  assert.equal(event.visibility, "private");
  assert.equal(event.transparency, "free");
  assert.match(event.description_html, /&lt;script&gt;/);
  assert.match(event.description_html, /<br/);
  assert.equal(JSON.parse(event.location_json).label, "Room, A");
});
test("iCalendar import handles UTC, floating times, duration and all-day default duration", () => {
  const parsed = parseCalendarImport(
    file(
      timed("utc"),
      entry("floating", ["DTSTART:20261023T100000", "DURATION:PT90M"]),
      entry("day", ["DTSTART;VALUE=DATE:20261023"]),
    ),
    cal,
  );
  assert.equal(parsed.plans.length, 3);
  assert.equal(parsed.plans[0].event.start_at, Date.parse("2026-10-23T01:00:00Z") / 1000);
  assert.equal(parsed.plans[1].event.start_at, parsed.plans[0].event.start_at);
  assert.equal(parsed.plans[1].event.end_local, "2026-10-23T11:30:00");
  assert.match(parsed.entries[1].warnings.join(" "), /Floating/);
  assert.equal(parsed.plans[2].event.end_date, "2026-10-24");
});
test("iCalendar import supports floating UNTIL, GEO and timezone aliases without guessing unknown zones", () => {
  const parsed = parseCalendarImport(
    file(
      "BEGIN:VTIMEZONE\r\nTZID:/vendor/Asia/Seoul\r\nX-LIC-LOCATION:Asia/Seoul\r\nEND:VTIMEZONE",
      entry("alias", [
        "DTSTART;TZID=/vendor/Asia/Seoul:20261023T090000",
        "DURATION:PT1H",
        "LOCATION:Seoul office",
        "GEO:37.5;127.0",
      ]),
      entry("until", [
        "DTSTART:20261023T090000",
        "DURATION:PT1H",
        "RRULE:FREQ=DAILY;UNTIL=20261025T090000",
      ]),
    ),
    cal,
  );
  assert.equal(parsed.plans.length, 2);
  assert.equal(parsed.plans[0].event.start_time_zone, "Asia/Seoul");
  assert.deepEqual(JSON.parse(parsed.plans[0].event.location_json), {
    label: "Seoul office",
    latitude: 37.5,
    longitude: 127,
  });
  assert.deepEqual(JSON.parse(parsed.plans[1].event.recurrence_json), [
    "RRULE:FREQ=DAILY;UNTIL=20261025T000000Z",
  ]);
});
test("iCalendar import keeps local recurrence across DST and converts TZID exception dates", () => {
  const parsed = parseCalendarImport(
    file(
      entry("dst", [
        "DTSTART;TZID=America/New_York:20261030T090000",
        "DTEND;TZID=America/New_York:20261030T100000",
        "RRULE:FREQ=DAILY;COUNT=5",
        "EXDATE;TZID=America/New_York:20261031T090000",
        "RDATE;TZID=America/New_York:20261106T090000",
      ]),
    ),
    cal,
  );
  assert.equal(parsed.plans.length, 1);
  const event = parsed.plans[0].event;
  assert.equal(event.start_time_zone, "America/New_York");
  const dates = expand(
    event,
    [],
    Date.parse("2026-10-29T00:00:00Z") / 1000,
    Date.parse("2026-11-08T00:00:00Z") / 1000,
    cal.time_zone,
  ).map((item) => new Date(item.event.start_at * 1000).toISOString());
  assert.deepEqual(dates, [
    "2026-10-30T13:00:00.000Z",
    "2026-11-01T14:00:00.000Z",
    "2026-11-02T14:00:00.000Z",
    "2026-11-03T14:00:00.000Z",
    "2026-11-06T14:00:00.000Z",
  ]);
});
test("iCalendar import reports invalid and unsupported entries alongside valid events", () => {
  const parsed = parseCalendarImport(
    file(
      timed("valid", [
        "ATTENDEE:mailto:guest@example.test",
        "ORGANIZER:mailto:owner@example.test",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT15M",
        "END:VALARM",
      ]),
      entry("date", ["DTSTART:20260230T090000Z", "DURATION:PT1H"]),
      entry("gap", ["DTSTART;TZID=America/New_York:20260308T023000", "DURATION:PT1H"]),
      timed("unsupported-rule", ["RRULE:FREQ=HOURLY;COUNT=5"]),
      entry("zone", ["DTSTART;TZID=Custom/Zone:20261023T090000", "DURATION:PT1H"]),
      "BEGIN:VTODO\r\nUID:todo\r\nSUMMARY:Task\r\nEND:VTODO",
      timed("extra-rule", ["RRULE:FREQ=DAILY;BYHOUR=9;COUNT=2"]),
      entry("no-end", ["DTSTART:20261023T090000Z"]),
    ),
    cal,
  );
  assert.equal(parsed.plans.length, 1);
  assert.deepEqual(
    parsed.entries.map((item) => item.status),
    ["ready", "error", "error", "error", "error", "skipped", "error", "error"],
  );
  assert.equal(parsed.entries[0].warnings.length, 2);
  assert.match(parsed.entries[2].message, /daylight-saving gap/);
  assert.match(parsed.entries[4].message, /Unsupported time zone/);
});
test("iCalendar import keeps moved and cancelled occurrences and rejects incomplete series", () => {
  const parsed = parseCalendarImport(
    file(
      entry("series", [
        "RECURRENCE-ID;VALUE=DATE:20261024",
        "DTSTART;VALUE=DATE:20261026",
        "DTEND;VALUE=DATE:20261027",
        "SUMMARY:Moved",
      ]),
      entry("series", [
        "DTSTART;VALUE=DATE:20261023",
        "RRULE:FREQ=DAILY;COUNT=3",
        "SUMMARY:Master",
      ]),
      entry("series", ["RECURRENCE-ID;VALUE=DATE:20261025", "STATUS:CANCELLED"]),
    ),
    cal,
  );
  assert.equal(parsed.plans.length, 1);
  assert.equal(parsed.plans[0].overrides.length, 2);
  assert.equal(parsed.plans[0].overrides[0].key, "d:2026-10-24");
  assert.equal(parsed.plans[0].overrides[0].event.start_date, "2026-10-26");
  assert.equal(parsed.plans[0].overrides[1].cancelled, 1);
  for (const content of [
    file(timed("same"), timed("same")),
    file(entry("orphan", ["RECURRENCE-ID;VALUE=DATE:20261025", "STATUS:CANCELLED"])),
  ]) {
    const invalid = parseCalendarImport(content, cal);
    assert.equal(invalid.plans.length, 0);
    assert.ok(invalid.entries.every((item) => item.status === "error"));
  }
  const broken = parseCalendarImport(
    file(
      timed("broken", ["RRULE:FREQ=DAILY;COUNT=3"]),
      entry("broken", ["RECURRENCE-ID:20261024T010000Z", "not a property"]),
    ),
    cal,
  );
  assert.equal(broken.plans.length, 0);
  assert.ok(broken.entries.every((item) => item.status === "error"));
});
test("iCalendar import rejects malformed files and bounded input before writing", () => {
  for (const content of [
    "not a calendar",
    "BEGIN:VCALENDAR\r\nVERSION:2.0",
    file(timed("one")) + file(timed("two")),
    file(...Array.from({ length: 201 }, (_, i) => timed(String(i)))),
    "x".repeat(1048577),
  ])
    assert.throws(() => parseCalendarImport(content, cal));
});

test("Calendar import API previews, imports into the chosen calendar, preserves exceptions and prevents duplicates", async (t) => {
  const f = await fixture(t);
  const { calendar } = await f.call("/calendars", {
    method: "POST",
    expected: 201,
    data: { name: "Imported", time_zone: "America/New_York" },
  });
  const path = `/calendars/${calendar.id}/imports`;
  const content = file(
    entry("series", [
      "DTSTART;VALUE=DATE:20261023",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Imported series",
    ]),
    entry("series", [
      "RECURRENCE-ID;VALUE=DATE:20261024",
      "DTSTART;VALUE=DATE:20261026",
      "SUMMARY:Moved",
    ]),
    entry("series", ["RECURRENCE-ID;VALUE=DATE:20261025", "STATUS:CANCELLED"]),
    entry("timed", [
      "DTSTART:20261023T090000",
      "DURATION:PT1H",
      "ATTENDEE:mailto:guest@example.test",
    ]),
    entry("invalid", ["DTSTART:20260230T000000Z", "DURATION:PT1H"]),
  );
  const preview = await f.call(path, { method: "POST", data: { content, dry_run: true } });
  assert.deepEqual(preview.summary, { ready: 4, imported: 0, skipped: 0, failed: 1 });
  assert.equal((await f.counts()).events, 0);
  const options = {
    method: "POST",
    data: { content, dry_run: false },
    headers: { "Idempotency-Key": "import-once" },
  };
  const result = await f.call(path, options);
  assert.equal(result.events_imported, 2);
  assert.deepEqual(result.summary, { ready: 0, imported: 4, skipped: 0, failed: 1 });
  assert.deepEqual(await f.call(path, options), result);
  const series = await f.event(result.entries[0].event_id, calendar.id);
  assert.equal(series.i_cal_uid, "series");
  const instances = await f.instances(
    series.id,
    "2026-10-20T00:00:00Z",
    "2026-10-30T00:00:00Z",
    "",
    calendar.id,
  );
  assert.deepEqual(
    instances.map((item) => item.start.date),
    ["2026-10-23", "2026-10-26"],
  );
  assert.equal(instances[1].title, "Moved");
  assert.equal(
    (await f.event(result.entries[3].event_id, calendar.id)).start.time_zone,
    "America/New_York",
  );
  const duplicate = await f.call(path, { method: "POST", data: { content } });
  assert.equal(duplicate.events_imported, 0);
  assert.equal(duplicate.summary.skipped, 4);
  assert.equal((await f.counts()).events, 2);
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM calendar_event_attendees").first()).n,
    0,
  );
});
test("Calendar imports enforce authorization, request validation and atomic writes", async (t) => {
  const f = await fixture(t),
    content = file(timed("auth")),
    path = "/calendars/primary/imports";
  await f.call(path, { actor: null, method: "POST", data: { content }, expected: 401 });
  await f.call(path, {
    actor: "read-only",
    method: "POST",
    data: { content, dry_run: true },
    expected: 403,
  });
  const boot = await f.call("/bootstrap");
  await f.call(`/calendars/${boot.primary_calendar_id}/imports`, {
    actor: "bob",
    method: "POST",
    data: { content },
    expected: 404,
  });
  for (const data of [{ content: "bad" }, { content, dry_run: "yes" }, { content, extra: true }])
    await f.call(path, { method: "POST", data, expected: 400 });
  const larger = file(timed("large-file", ["X-IMPORT-PADDING:" + "x".repeat(70_000)]));
  assert.equal(
    (await f.call(path, { method: "POST", data: { content: larger, dry_run: true } })).summary
      .ready,
    1,
  );
  await f.call(path, {
    method: "POST",
    data: { content: "한".repeat(350_000), dry_run: true },
    expected: 400,
  });
  await f.call(path, {
    method: "POST",
    data: { content },
    headers: { "Idempotency-Key": "" },
    expected: 400,
  });
  const before = await f.counts();
  const response = await f.raw(path, {
    method: "POST",
    data: { content },
    headers: { "x-test-fail-batch": "1" },
    fault: true,
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await f.counts(), before);
  await f.call(path, {
    method: "POST",
    data: { content },
    headers: {
      "x-test-before-batch": `UPDATE calendars SET version=version+1 WHERE id='${boot.primary_calendar_id}'`,
    },
    fault: true,
    expected: 412,
  });
  assert.equal((await f.counts()).events, 0);
});
