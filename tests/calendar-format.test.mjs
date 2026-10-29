import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarRegionalFormatOptions } from "../web/lib/calendar-settings.ts";

test("regional formats keep legacy English available across all supported selections", () => {
  const initial = calendarRegionalFormatOptions("en");
  for (const locale of ["en-US", "en-GB", "ko-KR", "ja-JP", "en"]) {
    const options = calendarRegionalFormatOptions(locale);
    assert.equal(options, initial);
    assert.ok(options.some((option) => option.value === locale && option.label));
    assert.ok(options.some((option) => option.value === "en" && option.label === "English"));
  }
  assert.equal(new Set(initial.map((option) => option.value)).size, initial.length);
  assert.ok(initial.every((option) => option.value && option.label));
});

test("saved custom locales remain selectable without adding a blank option", () => {
  const options = calendarRegionalFormatOptions("fr-FR");
  assert.deepEqual(options.at(-1), { value: "fr-FR", label: "fr-FR" });
  assert.ok(options.some((option) => option.value === "ko-KR"));
  assert.ok(options.some((option) => option.value === "en"));
  assert.ok(calendarRegionalFormatOptions("").every((option) => option.value && option.label));
});
