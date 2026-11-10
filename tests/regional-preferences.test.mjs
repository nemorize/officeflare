import { test } from "node:test";
import assert from "node:assert/strict";
import { getLocale, setLocaleResolver } from "../shared/i18n/index.ts";
import { setRegionalPreferences, formatDateTime } from "../web/lib/regional.ts";
import { mailDate } from "../web/lib/mail-helpers.ts";
import { driveDate, formatBytes } from "../web/lib/drive.ts";

test("mail and Drive use the account region and time zone independently of display language", (t) => {
  t.after(() => {
    setRegionalPreferences(null);
    setLocaleResolver(() => "en");
  });
  setLocaleResolver(() => "ko");
  const timestamp = Date.parse("2026-11-10T01:30:00Z") / 1000;
  for (const [time_zone, regional_format] of [
    ["Asia/Seoul", "ko-KR"],
    ["America/Los_Angeles", "en-GB"],
    ["Asia/Tokyo", "ja-JP"],
  ]) {
    setRegionalPreferences({ time_zone, regional_format });
    const expected = new Intl.DateTimeFormat(regional_format, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: time_zone,
    }).format(new Date(timestamp * 1000));
    assert.equal(formatDateTime(timestamp), expected);
    assert.equal(mailDate(timestamp), expected);
    assert.equal(driveDate(timestamp, true), expected);
    assert.equal(
      driveDate(timestamp),
      new Intl.DateTimeFormat(regional_format, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: time_zone,
      }).format(new Date(timestamp * 1000)),
    );
    assert.equal(getLocale(), "ko");
  }
  setRegionalPreferences({ time_zone: "UTC", regional_format: "de-DE" });
  assert.match(formatBytes(1536), /^1,5 /);
  assert.equal(mailDate(null), "—");
});
