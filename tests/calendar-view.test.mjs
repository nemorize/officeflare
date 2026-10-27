import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarView, calendarStartView, readCalendarView, saveCalendarView } from "../web/lib/calendar-view.ts";

test("calendar start view respects links, account preferences and a legacy browser cache", () => {
  const prefs = { default_view: "week", remember_view: true, last_view: "month" };
  assert.equal(calendarStartView(null, prefs, "day"), "month");
  assert.equal(calendarStartView("agenda", prefs, "day"), "agenda");
  assert.equal(calendarStartView(null, { ...prefs, remember_view: false }, "day"), "week");
  assert.equal(calendarStartView(null, { ...prefs, remember_view: 0 }, "day"), "week");
  assert.equal(calendarStartView(null, { ...prefs, last_view: null }, "day"), "day");
  assert.equal(calendarStartView("invalid", prefs), "month");
  assert.equal(calendarStartView(null, undefined, "agenda"), "agenda");
  assert.equal(calendarStartView(null), "week");
});

test("calendar view survives reopening and stays separate for each account", () => {
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  try {
    assert.equal(readCalendarView("alice@example.com"), null);
    for (const view of ["day", "week", "month", "agenda"]) {
      saveCalendarView("alice@example.com", view);
      assert.equal(readCalendarView("Alice@example.com"), view);
      assert.equal(readCalendarView("bob@example.com"), null);
    }
    values.set("officeflare.calendar.view:alice@example.com", "invalid");
    assert.equal(readCalendarView("alice@example.com"), null);
    assert.equal(calendarView("agenda"), "agenda");
    assert.equal(calendarView("schedule"), null);
    assert.equal(calendarView(null), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});

test("unavailable browser storage does not prevent calendar navigation", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
  try {
    assert.equal(readCalendarView("alice@example.com"), null);
    assert.doesNotThrow(() => saveCalendarView("alice@example.com", "month"));
    assert.equal(readCalendarView(""), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});
