import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./calendar-fixture.mjs";

test("account preferences retain calendar values and work without Calendar permissions", async (t) => {
  const f = await fixture(t, {
    beforeRegionalPreferencesMigration: async (db) => {
      await db
        .prepare(
          "INSERT INTO users(id,email_address) VALUES('legacy-region','legacy-region@office.test'),('legacy-default','legacy-default@office.test')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO calendar_preferences(user_id,time_zone,locale) VALUES('legacy-region','Asia/Seoul','ko-KR')",
        )
        .run();
    },
  });
  assert.deepEqual(
    await f.db
      .prepare("SELECT time_zone,regional_format FROM users WHERE id='legacy-region'")
      .first(),
    {
      time_zone: "Asia/Seoul",
      regional_format: "ko-KR",
    },
  );
  assert.deepEqual(
    await f.db
      .prepare("SELECT time_zone,regional_format FROM users WHERE id='legacy-default'")
      .first(),
    {
      time_zone: "UTC",
      regional_format: "en",
    },
  );
  const account = async (
    path = "",
    { method = "GET", actor = "alice", data, expected = 200 } = {},
  ) => {
    const response = await f.mf.dispatchFetch(`https://office.test/api/me${path}`, {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${f.tokens[actor]}` } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  };
  const values = { language: "ko", time_zone: "Asia/Seoul", regional_format: "ko-KR" };
  await account("/preferences", { method: "PUT", actor: null, data: values, expected: 401 });
  const saved = (
    await account("/preferences", { method: "PUT", actor: "no-calendar", data: values })
  ).user;
  for (const [key, value] of Object.entries(values)) assert.equal(saved[key], value);
  const reloaded = (await account("", { actor: "no-calendar" })).user;
  for (const [key, value] of Object.entries(values)) assert.equal(reloaded[key], value);
  assert.equal(
    await f.db.prepare("SELECT 1 FROM calendar_preferences WHERE user_id='no-calendar'").first(),
    null,
  );
  assert.equal(
    await f.db
      .prepare("SELECT 1 FROM calendar_primary_calendars WHERE user_id='no-calendar'")
      .first(),
    null,
  );

  const initial = (await f.call("/bootstrap")).preferences;
  await account("/preferences", { method: "PUT", data: values });
  const calendar = await f.call("/preferences");
  assert.equal(calendar.time_zone, values.time_zone);
  assert.equal(calendar.locale, values.regional_format);
  // A Calendar display form opened earlier must not overwrite the shared preferences.
  const display = await f.call("/preferences", {
    method: "PATCH",
    data: { version: initial.version, default_view: "day" },
  });
  assert.equal(display.time_zone, values.time_zone);
  assert.equal(display.locale, values.regional_format);
  await f.call("/preferences", {
    method: "PATCH",
    data: { version: display.version, time_zone: "Asia/Tokyo", locale: "ja-JP" },
  });
  const legacyUpdated = (await account()).user;
  assert.equal(legacyUpdated.time_zone, "Asia/Tokyo");
  assert.equal(legacyUpdated.regional_format, "ja-JP");
  const languageOnly = (await account("/language", { method: "PUT", data: { language: "en" } }))
    .user;
  assert.equal(languageOnly.time_zone, "Asia/Tokyo");
  assert.equal(languageOnly.regional_format, "ja-JP");

  for (const invalid of [
    { time_zone: "Invalid/Zone" },
    { time_zone: "+09:00" },
    { time_zone: "" },
    { time_zone: null },
    { regional_format: "bad_format" },
    { regional_format: "" },
    { regional_format: [] },
    { language: "fr" },
    { unknown: "field" },
  ])
    await account("/preferences", {
      method: "PUT",
      data: { ...values, ...invalid },
      expected: 400,
    });
  const unchanged = (await account()).user;
  assert.equal(unchanged.time_zone, "Asia/Tokyo");
  assert.equal(unchanged.regional_format, "ja-JP");
  assert.equal(unchanged.language, "en");
  const bob = (await account("", { actor: "bob" })).user;
  assert.equal(bob.time_zone, "UTC");
  assert.equal(bob.regional_format, "en");
});
