import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./calendar-fixture.mjs";

test("calendar settings persist per account and view navigation does not conflict with forms", async (t) => {
  const f = await fixture(t),
    initial = (await f.call("/bootstrap")).preferences;
  assert.equal(initial.remember_view, true);
  assert.equal(initial.last_view, null);
  assert.equal(initial.default_calendar_id, null);
  await f.call("/preferences/view", { method: "PUT", data: { view: "month" } });
  const afterView = await f.call("/preferences");
  assert.equal(afterView.last_view, "month");
  assert.equal(afterView.version, initial.version);
  const saved = await f.call("/preferences", {
    method: "PATCH",
    data: { version: initial.version, remember_view: false, default_view: "day", locale: "ko-KR" },
  });
  assert.equal(saved.last_view, "month");
  assert.equal(saved.remember_view, false);
  assert.equal(saved.locale, "ko-KR");
  assert.equal(saved.version, initial.version + 1);
  await f.call("/preferences/view", { method: "PUT", data: { view: "agenda" } });
  assert.equal((await f.call("/bootstrap")).preferences.last_view, "agenda");
  const bob = (await f.call("/bootstrap", { actor: "bob" })).preferences;
  assert.equal(bob.last_view, null);
  assert.equal(bob.remember_view, true);
  await f.call("/preferences/view", {
    method: "PUT",
    actor: null,
    data: { view: "week" },
    expected: 401,
  });
  await f.call("/preferences/view", {
    method: "PUT",
    actor: "no-calendar",
    data: { view: "week" },
    expected: 403,
  });
  for (const view of ["schedule", null, 1])
    await f.call("/preferences/view", { method: "PUT", data: { view }, expected: 400 });
  await f.call("/preferences", {
    method: "PATCH",
    data: { version: saved.version, remember_view: "yes" },
    expected: 400,
  });
  await f.call("/preferences", {
    method: "PATCH",
    data: { version: initial.version, default_view: "month" },
    expected: 412,
  });
});

test("combined calendar bootstrap uses the remembered or fixed view without loading the wrong range", async (t) => {
  const f = await fixture(t),
    prefs = (await f.call("/bootstrap")).preferences;
  const query = async (suffix) =>
    new URLSearchParams(
      (await f.call(`/bootstrap?include_events=true&date=2026-10-15${suffix}`)).initial_events
        .query,
    );
  const days = (query) =>
    (Date.parse(query.get("time_max")) - Date.parse(query.get("time_min"))) / 86400000;
  await f.call("/preferences/view", { method: "PUT", data: { view: "day" } });
  assert.equal(days(await query("&cached_view=month")), 1);
  assert.equal(days(await query("&view=week")), 7);
  await f.call("/preferences", {
    method: "PATCH",
    data: { version: prefs.version, remember_view: false, default_view: "week" },
  });
  assert.equal(days(await query("&cached_view=month")), 7);
  assert.equal(days(await query("&view=day")), 1);
});

test("default creation calendar accepts writable calendars and rejects unavailable or external destinations", async (t) => {
  const f = await fixture(t);
  let prefs = (await f.call("/bootstrap")).preferences;
  const secondary = (
    await f.call("/calendars", { method: "POST", expected: 201, data: { name: "Projects" } })
  ).calendar;
  prefs = await f.call("/preferences", {
    method: "PATCH",
    data: { version: prefs.version, default_calendar_id: secondary.id },
  });
  assert.equal((await f.call("/bootstrap")).preferences.default_calendar_id, secondary.id);
  await f.call("/preferences", {
    method: "PATCH",
    actor: "bob",
    data: { version: 1, default_calendar_id: secondary.id },
    expected: 404,
  });
  const external = (
    await f.call("/feeds", {
      method: "POST",
      expected: 201,
      data: { name: "External", url: "https://example.com/calendar.ics", time_zone: "UTC" },
    })
  ).calendar;
  await f.call("/preferences", {
    method: "PATCH",
    data: { version: prefs.version, default_calendar_id: external.id },
    expected: 403,
  });
  prefs = await f.call("/preferences", {
    method: "PATCH",
    data: { version: prefs.version, default_calendar_id: null },
  });
  assert.equal(prefs.default_calendar_id, null);
});

test("working hours retain multiple intervals, days off and date overrides across saves", async (t) => {
  const f = await fixture(t),
    saved = await f.call("/working-hours", {
      method: "PUT",
      data: {
        version: 0,
        time_zone: "Asia/Seoul",
        weekly: {
          1: [
            { start: "09:00", end: "12:00" },
            { start: "13:00", end: "18:00" },
          ],
        },
        exceptions: { "2026-11-02": [], "2026-11-03": [{ start: "10:00", end: "15:00" }] },
      },
    });
  const hours = (await f.call("/working-hours")).working_hours;
  assert.equal(hours.version, saved.working_hours.version);
  assert.equal(hours.weekly[1].length, 2);
  assert.deepEqual(hours.exceptions["2026-11-02"], []);
  assert.deepEqual(hours.exceptions["2026-11-03"], [{ start: 600, end: 900 }]);
});
