import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Script, createContext } from "node:vm";
import { fixture } from "./calendar-fixture.mjs";

const bundle = await build({ stdin: { contents: 'export * from "./web/lib/calendar-date.ts"; export * from "./web/lib/calendar-editor.ts"; export * from "./web/lib/calendar-sharing.ts"; export * from "./src/calendar/public-page.ts";', resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const event = (start, end, extra = {}) => ({ id: "event", calendar_id: "primary", title: "Team meeting", version: 1, status: "confirmed", transparency: "busy", is_redacted: false, start: { date_time: start, time_zone: "Asia/Seoul" }, end: { date_time: end, time_zone: "Asia/Seoul" }, recurrence: [], ...extra });

test("Calendar UI date ranges include full weeks, leap days and exclusive all-day ends", () => {
  const range = ui.viewRange("2026-08-15", "month", 1);
  assert.equal(range.start, "2026-07-27"); assert.equal(range.end, "2026-09-07"); assert.equal(range.days.length, 42);
  assert.equal(ui.navigateDate("2028-01-31", "month", 1), "2028-02-29");
  assert.equal(ui.validDate("2026-02-30"), null); assert.equal(ui.validDate("1969-12-31"), null);
  const value = event(null, null, { start: { date: "2026-10-12" }, end: { date: "2026-10-15" } });
  assert.equal(ui.occursOn(value, "2026-10-14", "America/New_York"), true);
  assert.equal(ui.occursOn(value, "2026-10-15", "Asia/Seoul"), false);
  const draft = ui.draftForEvent(value, "Asia/Seoul"); assert.equal(draft.endDate, "2026-10-14"); assert.deepEqual(ui.draftTimes(draft), { start: value.start, end: value.end });
});
test("Calendar UI rejects typed DST gaps, chooses the first repeated time and normalizes grid clicks", () => {
  assert.throws(() => ui.localEndpoint("2026-03-08", "02:30", "America/New_York"), /clocks change/);
  assert.equal(ui.localEndpoint("2026-11-01", "01:30", "America/New_York").date_time, "2026-11-01T05:30:00Z");
  assert.equal(ui.endpointLocal(ui.initialNewEvent("2026-03-08", "America/New_York", 30, 150).start, "America/New_York").time, "03:30");
  const late = ui.initialNewEvent("2026-10-15", "Asia/Seoul", 60, 1410);
  assert.deepEqual(ui.endpointLocal(late.end, "Asia/Seoul"), { date: "2026-10-16", time: "00:30", minute: 30 });
});
test("Calendar UI clips overnight events at midnight and lays out overlapping events without collisions", () => {
  const overnight = event("2026-10-14T23:00:00+09:00", "2026-10-15T01:00:00+09:00");
  assert.deepEqual(ui.timedPlacements([overnight], "2026-10-14", "Asia/Seoul").map(({ start, end }) => [start, end]), [[1380, 1440]]);
  assert.deepEqual(ui.timedPlacements([overnight], "2026-10-15", "Asia/Seoul").map(({ start, end }) => [start, end]), [[0, 60]]);
  const values = [["09:00", "11:00"], ["09:30", "10:30"], ["10:00", "12:00"], ["12:00", "13:00"]].map(([start, end], index) => event(`2026-10-15T${start}:00+09:00`, `2026-10-15T${end}:00+09:00`, { id: String(index) }));
  const positions = ui.timedPlacements(values, "2026-10-15", "Asia/Seoul");
  assert.deepEqual(positions.map(({ columns }) => columns), [3, 3, 3, 1]);
  for (const a of positions) for (const b of positions) if (a !== b && a.start < b.end && b.start < a.end) assert.notEqual(a.column, b.column);
  const bars = ui.monthPlacements(values, ui.dateDays("2026-10-12", 7), "Asia/Seoul"); assert.equal(new Set(bars.map(({ row }) => row)).size, 4);
});
test("Calendar UI translates series edits back to the master in its local time zone", () => {
  const master = event("2026-10-07T23:30:00Z", "2026-10-08T00:30:00Z", { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"] });
  const clicked = event("2026-10-14T23:30:00Z", "2026-10-15T00:30:00Z", { recurrence: master.recurrence });
  const initial = ui.draftForEvent(clicked, "Asia/Seoul"), draft = { ...initial, startDate: "2026-10-16", endDate: "2026-10-16", startTime: "10:00", endTime: "11:00" };
  const all = ui.eventChanges(draft, initial, master, "all"), single = ui.eventChanges(draft, initial, master, "single");
  assert.equal(ui.endpointLocal(all.start, "Asia/Seoul").date, "2026-10-09"); assert.equal(ui.endpointLocal(single.start, "Asia/Seoul").date, "2026-10-16");
  assert.deepEqual(ui.eventChanges({ ...initial, title: "New title" }, initial, master, "single"), { title: "New title" });
  const shifted = ui.draftForEvent({ ...clicked, ...ui.shiftedEventTimes(clicked, "2026-10-16", "Asia/Seoul", 600) }, "Asia/Seoul");
  assert.equal("recurrence" in ui.eventChanges(shifted, initial, master, "single"), false);
});
test("Calendar UI preserves monthly ordinal rules, exception dates and unexposed recurrence options", () => {
  const source = event("2026-10-19T10:00:00+09:00", "2026-10-19T11:00:00+09:00", { recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=3MO;WKST=MO;COUNT=8", "EXDATE:20261116T010000Z"] });
  const draft = ui.draftForEvent(source, "Asia/Seoul");
  const rules = ui.draftRecurrence({ ...draft, interval: 2 }, source.recurrence);
  assert.match(rules[0], /BYDAY=3MO/); assert.match(rules[0], /WKST=MO/); assert.match(rules[0], /INTERVAL=2/); assert.equal(rules[1], source.recurrence[1]);
});
test("Calendar people picker respects sharing permissions and excludes inactive accounts", async t => {
  const f = await fixture(t);
  await f.call("/people?q=alice", { actor: null, expected: 401 });
  await f.call("/people?q=alice", { actor: "read-only", expected: 403 });
  assert.deepEqual((await f.call("/people?q=a")).people, []);
  await f.db.prepare("UPDATE users SET display_name='Project Person' WHERE id='bob'").run();
  assert.equal((await f.call("/people?q=project")).people[0].id, "bob");
  assert.equal((await f.call(`/people?q=${encodeURIComponent("alice@office.test")}`)).people[0].id, "alice");
  assert.deepEqual((await f.call("/people?q=%25")).people, []);
  await f.call("/bootstrap");
  await f.call("/calendars/primary/acl", { method: "POST", expected: 201, data: { scope_type: "user", scope_key: "bob", role: "reader" } });
  const grant = (await f.call("/calendars/primary/acl")).acl.find(grant => grant.scope_key === "bob");
  assert.equal(grant.display_name, "Project Person"); assert.equal(grant.email_address, "bob@office.test");
  await f.db.prepare("UPDATE users SET disabled_at=unixepoch() WHERE id='bob'").run();
  assert.deepEqual((await f.call("/people?q=project")).people, []);
  await f.call(`/people?q=${"x".repeat(256)}`, { expected: 400 });
});

test("Calendar registration forms save one-off policies and create occurrence overrides from inherited series settings", async t => {
  const f = await fixture(t), value = await f.create({ title: "Registration", start: { date: "2027-01-11" }, end: { date: "2027-01-12" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"] });
  const path = `/calendars/primary/events/${value.event.id}`;
  const original = (await f.call(path + "/registration-policy")).policy;
  await f.call(path + "/registration-policy", { method: "PUT", data: ui.registrationPolicyBody(original, "", { capacity: 12 }) });
  const saved = (await f.call(path + "/registration-policy")).policy;
  assert.equal(saved.capacity, 12);
  const occurrence = (await f.instances(value.event.id, "2027-01-01T00:00:00Z", "2027-02-01T00:00:00Z"))[1].occurrence_key;
  const inherited = (await f.call(path + `/registration-policy?occurrence_key=${encodeURIComponent(occurrence)}`)).policy;
  await f.call(path + "/registration-policy", { method: "PUT", data: ui.registrationPolicyBody(inherited, occurrence, { capacity: 4 }) });
  assert.equal((await f.call(path + `/registration-policy?occurrence_key=${encodeURIComponent(occurrence)}`)).policy.capacity, 4);
  assert.equal((await f.call(path + "/registration-policy")).policy.capacity, 12);
});

test("Public calendar scripts parse, format exclusive all-day ranges and sort shared events chronologically", () => {
  const headers = {}, c = { header: (name, value) => { headers[name] = value; }, html: value => value };
  const html = ui.sharePage(c), script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  new Script(script);
  const context = createContext({ Date, Intl });
  new Script(script.split(" const base=")[0]).runInContext(context);
  const allDay = { start: { date: "2026-10-12" }, end: { date: "2026-10-15" } };
  assert.equal(context.eventLabel(allDay, "Asia/Seoul"), "October 12, 2026 – October 14, 2026 · All day");
  assert.equal(context.wireDate(new Date("2026-10-15T01:02:03.456Z")), "2026-10-15T01:02:03Z");
  const earlier = { start: { date_time: "2026-10-15T11:00:00+09:00" } }, later = { start: { date_time: "2026-10-15T03:00:00Z" } };
  assert.ok(context.eventOrder(earlier, later) < 0);
  assert.match(headers["Content-Security-Policy"], /script-src 'nonce-/);
  new Script(ui.invitationPage(c, "invitation").match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
});
