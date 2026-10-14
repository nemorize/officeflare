import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../src/db/schema.ts";
import { hashPassword } from "../src/auth/password.ts";
import {
  calendarUserPermissions,
  defaultEligible,
} from "../src/authorization/permissions.ts";
import { workerModules } from "./worker-modules.mjs";
const password = "a long password for calendar integration tests";
const harness = await build({
  entryPoints: ["tests/calendar-harness.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers", "../dist/index.js"],
  target: "es2022",
});
async function fixture(t) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const common = {
    compatibilityDate: "2026-09-29",
    d1Databases: { DB: "calendar-tests" },
    bindings: {
      AUTH_SIGNING_KEYS: JSON.stringify({
        active_kid: "test",
        keys: [{ ...(await exportJWK(privateKey)), kid: "test" }],
      }),
      MFA_ENCRYPTION_KEYS: JSON.stringify({
        active_version: 1,
        keys: { 1: randomBytes(32).toString("base64url") },
      }),
      AUTH_ISSUER: "officeflare",
      AUTH_AUDIENCE: "officeflare-api",
    },
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      workers: [
        { ...common, name: "officeflare", modules: workerModules },
        {
          ...common,
          name: "calendar-harness",
          modules: [
            {
              type: "ESModule",
              path: "tests/calendar-harness.mjs",
              contents: harness.outputFiles[0].text,
            },
            ...workerModules,
          ],
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB"),
    faults = await mf.getWorker("calendar-harness");
  for (const file of (await readdir("migrations")).sort()) {
    let statement = "",
      trigger = false;
    for (const line of (await readFile(`migrations/${file}`, "utf8")).split(
      "\n",
    )) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      statement += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
        await db.prepare(statement).run();
        statement = "";
        trigger = false;
      }
    }
    assert.equal(statement.trim(), "");
  }
  await db
    .prepare(
      "INSERT INTO roles(id,key,label) VALUES('calendar-test','calendar-test','Calendar test'),('calendar-read','calendar-read','Calendar read')",
    )
    .run();
  await db.batch(
    calendarUserPermissions.map((key) =>
      db
        .prepare(
          "INSERT INTO role_permissions(role_id,permission_key) VALUES('calendar-test',?)",
        )
        .bind(key),
    ),
  );
  await db
    .prepare(
      "INSERT INTO role_permissions(role_id,permission_key) VALUES('calendar-read','calendar.access')",
    )
    .run();
  const hash = await hashPassword(password);
  for (const id of ["alice", "bob", "read-only", "no-calendar", "admin"]) {
    await db
      .prepare(
        "INSERT INTO users(id,email_address,password_hash) VALUES(?,?,?)",
      )
      .bind(id, `${id}@office.test`, hash)
      .run();
    if (id !== "no-calendar")
      await db
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
        .bind(
          id,
          id === "admin"
            ? "system-administrator"
            : id === "read-only"
              ? "calendar-read"
              : "calendar-test",
        )
        .run();
  }
  let operation = 0;
  const tokens = {};
  for (const actor of ["alice", "bob", "read-only", "no-calendar", "admin"]) {
    const response = await mf.dispatchFetch(
      "https://office.test/api/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": `192.0.2.${++operation}`,
        },
        body: JSON.stringify({
          email_address: `${actor}@office.test`,
          password,
        }),
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    tokens[actor] = (await response.json()).access_token;
  }
  const raw = (
    path,
    { method = "GET", actor = "alice", data, headers = {}, fault = false } = {},
  ) => {
    const url = `https://office.test/api/calendar${path}`,
      options = {
        method,
        headers: {
          "cf-connecting-ip": `192.0.2.${++operation % 250}`,
          ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
          ...(method === "POST"
            ? { "Idempotency-Key": `calendar-test-${operation}` }
            : {}),
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      };
    return fault ? faults.fetch(url, options) : mf.dispatchFetch(url, options);
  };
  const call = async (path, options = {}) => {
    const response = await raw(path, options);
    assert.equal(
      response.status,
      options.expected ?? 200,
      `${options.method ?? "GET"} ${path}: ${await response.clone().text()}`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.status === 204 ? null : response.json();
  };
  const create = async (data, cal = "primary") =>
    call(`/calendars/${cal}/events`, { method: "POST", data, expected: 201 });
  const event = async (id, cal = "primary") =>
    (await call(`/calendars/${cal}/events/${id}`)).event;
  const patch = async (id, data, cal = "primary") =>
    call(`/calendars/${cal}/events/${id}`, {
      method: "PATCH",
      data: { version: (await event(id, cal)).version, ...data },
    });
  const instances = async (id, min, max, extra = "", cal = "primary") =>
    (
      await call(
        `/calendars/${cal}/events/${id}/instances?time_min=${encodeURIComponent(min)}&time_max=${encodeURIComponent(max)}${extra}`,
      )
    ).instances;
  const counts = async () =>
    db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM calendar_operations) operations,(SELECT COUNT(*) FROM calendar_events) events,(SELECT COUNT(*) FROM calendar_event_scopes) scopes,(SELECT COUNT(*) FROM calendar_event_overrides) overrides,(SELECT COUNT(*) FROM calendar_changes) changes,(SELECT COUNT(*) FROM calendar_activity) activity",
      )
      .first();
  return { mf, db, raw, call, create, event, patch, instances, counts };
}
const timed = (
  start = "2026-10-19T10:00:00+09:00",
  end = "2026-10-19T11:00:00+09:00",
  time_zone = "Asia/Seoul",
) => ({
  title: "Team meeting",
  start: { date_time: start, time_zone },
  end: { date_time: end, time_zone },
});
const day = (date = "2026-10-19", end = "2026-10-20") => ({
  title: "All day",
  start: { date },
  end: { date: end },
});

test("Calendar core: D1 schema, authorization, lifecycle and recurring edits", async (t) => {
  const f = await fixture(t),
    { db, raw, call, create, event, patch, instances, counts } = f;
  let primary, secondary, single, series;
  await t.test(
    "authentication and capability gating are explicit",
    async () => {
      await call("/capabilities", { actor: null, expected: 401 });
      await call("/capabilities", { actor: "no-calendar", expected: 403 });
      const caps = await call("/capabilities");
      assert.equal(caps.phase, 1);
      assert.equal(caps.recurrence, true);
      assert.equal(caps.email_delivery, false);
      assert.equal(caps.external_sharing, false);
      assert.ok(defaultEligible(calendarUserPermissions));
      await call("/calendars/primary/events", {
        actor: "read-only",
        method: "POST",
        data: day(),
        expected: 403,
      });
    },
  );
  await t.test(
    "primary provisioning is concurrent and idempotent",
    async () => {
      const [a, b] = await Promise.all([
        call("/bootstrap"),
        call("/bootstrap"),
      ]);
      primary = a.primary_calendar_id;
      assert.equal(primary, b.primary_calendar_id);
      assert.equal(a.calendars.filter((value) => value.is_primary).length, 1);
      assert.notEqual(
        (await call("/bootstrap", { actor: "bob" })).primary_calendar_id,
        primary,
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT COUNT(*) n FROM calendars WHERE data_owner_user_id='alice'",
            )
            .first()
        ).n,
        1,
      );
    },
  );
  await t.test(
    "DDL columns and Drizzle models agree; administrators have core grants",
    async () => {
      const modelNames = [
        "calendars",
        "calendarPrimaryCalendars",
        "calendarAcl",
        "calendarSubscriptions",
        "calendarPreferences",
        "calendarLabels",
        "calendarEvents",
        "calendarEventScopes",
        "calendarEventOverrides",
        "calendarEventCopies",
        "calendarOperations",
        "calendarSeriesLinks",
        "calendarChanges",
        "calendarActivity",
      ];
      const ddl = await readFile("migrations/0019_calendar_core.sql", "utf8"),
        names = [...ddl.matchAll(/CREATE TABLE (\w+)/g)].map(
          (value) => value[1],
        );
      assert.equal(names.length, modelNames.length);
      for (let index = 0; index < names.length; index++) {
        const actual = (
          await db.prepare(`PRAGMA table_info(${names[index]})`).all()
        ).results.map((value) => value.name);
        assert.deepEqual(
          Object.keys(getTableColumns(schema[modelNames[index]])),
          actual,
          names[index],
        );
      }
      for (const key of calendarUserPermissions)
        assert.ok(
          await db
            .prepare(
              "SELECT 1 FROM role_permissions WHERE role_id='system-administrator' AND permission_key=?",
            )
            .bind(key)
            .first(),
        );
    },
  );
  await t.test(
    "calendar creation receipts, scoped access and default subscriptions",
    async () => {
      const options = {
        method: "POST",
        data: { name: "Project", time_zone: "Asia/Seoul" },
        headers: { "Idempotency-Key": "calendar-create-receipt" },
        expected: 201,
      };
      const a = await call("/calendars", options),
        b = await call("/calendars", options);
      assert.deepEqual(a, b);
      secondary = a.calendar;
      await call("/calendars", {
        ...options,
        data: { name: "Different" },
        expected: 409,
      });
      await call(`/calendars/${secondary.id}`, { actor: "bob", expected: 404 });
      await call(`/calendars/${secondary.id}`, {
        actor: "admin",
        expected: 404,
      });
      assert.ok(
        (await call("/subscriptions")).subscriptions.some(
          (value) => value.calendar_id === secondary.id,
        ),
      );
      await call(`/calendars/primary?version=1`, {
        method: "DELETE",
        expected: 409,
      });
    },
  );
  await t.test(
    "preferences and subscription settings use independent versions",
    async () => {
      const prefs = await call("/preferences");
      await call("/preferences", {
        method: "PATCH",
        data: {
          version: prefs.version,
          time_zone: "Asia/Seoul",
          locale: "ko",
          week_start: 0,
          display_options: { show_weekends: false },
        },
      });
      await call("/preferences", {
        method: "PATCH",
        data: { version: prefs.version, locale: "en" },
        expected: 412,
      });
      await call("/preferences", {
        method: "PATCH",
        data: { version: prefs.version + 1, time_zone: "Bad/Zone" },
        expected: 400,
      });
      const sub = (await call("/subscriptions")).subscriptions.find(
        (value) => value.calendar_id === secondary.id,
      );
      await call(`/subscriptions/${secondary.id}`, {
        method: "PATCH",
        data: {
          version: sub.version,
          color: "#AABBCC",
          name_override: "Personal name",
          selected: false,
        },
      });
      assert.equal(
        (await call(`/calendars/${secondary.id}`)).calendar.name,
        "Project",
      );
      assert.equal(
        (await call("/subscriptions")).subscriptions.find(
          (value) => value.calendar_id === secondary.id,
        ).color,
        "#aabbcc",
      );
    },
  );
  await t.test(
    "timed and all-day schedules preserve exclusive endpoints",
    async () => {
      single = await create({
        ...timed(),
        description_html: "<p>Safe</p><script>alert(1)</script>",
      });
      assert.equal(single.event.start.date_time, "2026-10-19T10:00:00+09:00");
      assert.equal(single.event.description_html, "<p>Safe</p>");
      const allDay = await create(day("2026-10-19", "2026-10-21"));
      assert.equal(allDay.event.end.date, "2026-10-21");
      assert.equal(
        (
          await instances(
            allDay.event.id,
            "2026-10-21T00:00:00Z",
            "2026-10-22T00:00:00Z",
          )
        ).length,
        0,
      );
      await assert.rejects(
        db
          .prepare("UPDATE calendar_events SET end_at=NULL WHERE id=?")
          .bind(single.event.id)
          .run(),
        /CHECK/,
      );
      await assert.rejects(
        db
          .prepare(
            "UPDATE calendar_events SET start_date='2026-10-19' WHERE id=?",
          )
          .bind(single.event.id)
          .run(),
        /CHECK/,
      );
    },
  );
  await t.test(
    "invalid unions, dates, offsets and unsupported features are rejected",
    async () => {
      const baseline = await counts();
      for (const data of [
        { ...day(), end: { date_time: "2026-10-20T00:00:00Z" } },
        day("2026-02-30"),
        timed("2026-10-19T11:00:00+09:00", "2026-10-19T10:00:00+09:00"),
        timed("2026-10-19T10:00:00.123+09:00"),
        timed(
          "2026-10-19T10:00:00-04:00",
          "2026-10-19T11:00:00-04:00",
          "Asia/Seoul",
        ),
        { ...day(), recurrence: ["RRULE:FREQ=HOURLY"] },
        { ...day(), recurrence: ["RRULE:FREQ=DAILY;COUNT=5;UNTIL=20261025"] },
        { ...day(), recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=1MO"] },
        {
          ...timed(
            "2026-11-01T01:30:00-04:00",
            "2026-11-01T01:15:00-05:00",
            "America/New_York",
          ),
          recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
        },
        { ...day(), organizer_user_id: "bob" },
        { ...day(), attendees: [{ email_address: "guest@example.com" }] },
      ])
        await call("/calendars/primary/events", {
          method: "POST",
          data,
          expected: 400,
        });
      await call("/calendars/primary/events", {
        method: "POST",
        data: { ...day(), event_type: "focus_time" },
        expected: 422,
      });
      assert.deepEqual(await counts(), baseline);
    },
  );
  await t.test(
    "ETags, stale writes and idempotent event creation",
    async () => {
      const response = await raw(
          `/calendars/primary/events/${single.event.id}`,
        ),
        etag = response.headers.get("etag");
      assert.equal(etag, '"v1"');
      await call(`/calendars/primary/events/${single.event.id}`, {
        method: "PATCH",
        headers: { "If-Match": etag },
        data: { title: "Updated" },
      });
      const baseline = await counts();
      await call(`/calendars/primary/events/${single.event.id}`, {
        method: "PATCH",
        data: { version: 1, title: "Stale" },
        expected: 412,
      });
      assert.deepEqual(await counts(), baseline);
      await call(`/calendars/primary/events/${single.event.id}`, {
        method: "PATCH",
        data: { title: "Missing version" },
        expected: 428,
      });
      await call(`/calendars/primary/events/${single.event.id}`, {
        method: "PATCH",
        headers: { "If-Match": '"v2"' },
        data: { version: 3, title: "Mismatch" },
        expected: 400,
      });
      const options = {
        method: "POST",
        data: day("2026-11-01", "2026-11-02"),
        headers: { "Idempotency-Key": "event-receipt" },
        expected: 201,
      };
      assert.deepEqual(
        await call("/calendars/primary/events", options),
        await call("/calendars/primary/events", options),
      );
    },
  );
  await t.test(
    "weekly wall times survive DST; nonexistent times do not consume COUNT",
    async () => {
      const weekly = await create({
        ...timed(
          "2026-03-01T09:00:00-05:00",
          "2026-03-01T10:00:00-05:00",
          "America/New_York",
        ),
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
      });
      const list = await instances(
        weekly.event.id,
        "2026-03-01T00:00:00Z",
        "2026-03-20T00:00:00Z",
      );
      assert.deepEqual(
        list.map((value) => value.start.date_time),
        [
          "2026-03-01T09:00:00-05:00",
          "2026-03-08T09:00:00-04:00",
          "2026-03-15T09:00:00-04:00",
        ],
      );
      const gap = await create({
        ...timed(
          "2026-03-06T02:30:00-05:00",
          "2026-03-06T03:30:00-05:00",
          "America/New_York",
        ),
        recurrence: ["RRULE:FREQ=DAILY;COUNT=4"],
      });
      assert.deepEqual(
        (
          await instances(
            gap.event.id,
            "2026-03-05T00:00:00Z",
            "2026-03-12T00:00:00Z",
          )
        ).map((value) => value.start.date_time.slice(0, 10)),
        ["2026-03-06", "2026-03-07", "2026-03-09", "2026-03-10"],
      );
    },
  );
  await t.test(
    "month ends, ordinal weekdays, leap days, RDATE and EXDATE",
    async () => {
      const monthly = await create({
        ...day("2026-01-31", "2026-02-01"),
        recurrence: ["RRULE:FREQ=MONTHLY;COUNT=4"],
      });
      assert.deepEqual(
        (
          await instances(
            monthly.event.id,
            "2026-01-01T00:00:00Z",
            "2026-08-01T00:00:00Z",
          )
        ).map((value) => value.start.date),
        ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"],
      );
      const lastFriday = await create({
        ...day("2026-01-30", "2026-01-31"),
        recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=3"],
      });
      assert.deepEqual(
        (
          await instances(
            lastFriday.event.id,
            "2026-01-01T00:00:00Z",
            "2026-04-01T00:00:00Z",
          )
        ).map((value) => value.start.date),
        ["2026-01-30", "2026-02-27", "2026-03-27"],
      );
      const leap = await create({
        ...day("2024-02-29", "2024-03-01"),
        recurrence: ["RRULE:FREQ=YEARLY;COUNT=3"],
      });
      assert.equal(
        (
          await instances(
            leap.event.id,
            "2028-01-01T00:00:00Z",
            "2028-12-31T00:00:00Z",
          )
        )[0].start.date,
        "2028-02-29",
      );
      const extras = await create({
        ...day(),
        recurrence: [
          "RRULE:FREQ=DAILY;COUNT=3",
          "EXDATE;VALUE=DATE:20261020",
          "RDATE;VALUE=DATE:20261025",
        ],
      });
      assert.deepEqual(
        (
          await instances(
            extras.event.id,
            "2026-10-18T00:00:00Z",
            "2026-10-27T00:00:00Z",
          )
        ).map((value) => value.start.date),
        ["2026-10-19", "2026-10-21", "2026-10-25"],
      );
    },
  );
  await t.test(
    "UTC recurrence dates remain distinct across the repeated DST hour",
    async () => {
      const value = await create({
        ...timed(
          "2026-11-01T01:30:00-04:00",
          "2026-11-01T02:30:00-05:00",
          "America/New_York",
        ),
        recurrence: [
          "RRULE:FREQ=WEEKLY;COUNT=2",
          "RDATE:20261101T063000Z",
          "EXDATE:20261101T053000Z",
        ],
      });
      const list = await instances(
        value.event.id,
        "2026-11-01T00:00:00Z",
        "2026-11-09T00:00:00Z",
      );
      assert.equal(list.length, 2);
      assert.equal(list[0].occurrence_key, "t:2026-11-01T06:30:00Z");
      assert.equal(list[0].start.date_time, "2026-11-01T01:30:00-05:00");
      const read = (
        await call(
          `/calendars/primary/events/${value.event.id}/instances/${encodeURIComponent(list[0].occurrence_key)}`,
        )
      ).event;
      assert.equal(read.start.date_time, list[0].start.date_time);
      const short = await create({
        ...timed(
          "2026-11-01T01:15:00-04:00",
          "2026-11-01T01:45:00-05:00",
          "America/New_York",
        ),
        recurrence: ["RDATE:20261101T061500Z"],
      });
      const overlap = await instances(
        short.event.id,
        "2026-11-01T00:00:00Z",
        "2026-11-02T00:00:00Z",
      );
      assert.deepEqual(
        overlap.map((value) => value.end.date_time),
        ["2026-11-01T01:45:00-05:00", "2026-11-01T01:45:00-05:00"],
      );
      assert.ok(
        overlap.every(
          (value) =>
            Date.parse(value.end.date_time) > Date.parse(value.start.date_time),
        ),
      );
      const until = await create({
        ...timed(
          "2026-10-25T01:30:00-04:00",
          "2026-10-25T02:30:00-04:00",
          "America/New_York",
        ),
        recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20261101T062959Z"],
      });
      assert.equal(
        (
          await instances(
            until.event.id,
            "2026-11-01T00:00:00Z",
            "2026-11-02T00:00:00Z",
          )
        ).length,
        1,
      );
    },
  );
  await t.test(
    "moved exceptions are found outside their original window and inherit unmodified fields",
    async () => {
      series = await create({
        ...day(),
        title: "Series",
        recurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
      });
      await patch(series.event.id, {
        scope: "single",
        occurrence_key: "d:2026-10-20",
        start: { date: "2026-11-05" },
        end: { date: "2026-11-06" },
      });
      assert.equal(
        (
          await instances(
            series.event.id,
            "2026-10-20T00:00:00Z",
            "2026-10-21T00:00:00Z",
          )
        ).length,
        0,
      );
      const moved = await instances(
        series.event.id,
        "2026-11-05T00:00:00Z",
        "2026-11-06T00:00:00Z",
      );
      assert.equal(moved.length, 1);
      assert.equal(moved[0].occurrence_key, "d:2026-10-20");
      assert.equal(moved[0].original_start.date, "2026-10-20");
      await patch(series.event.id, { title: "Inherited new title" });
      assert.equal(
        (
          await instances(
            series.event.id,
            "2026-11-05T00:00:00Z",
            "2026-11-06T00:00:00Z",
          )
        )[0].title,
        "Inherited new title",
      );
      await call(
        `/calendars/primary/events/${series.event.id}/instances/${encodeURIComponent("d:2026-12-01")}`,
        { expected: 404 },
      );
    },
  );
  await t.test(
    "cancellation and restoration of a single occurrence preserve identity",
    async () => {
      const current = await event(series.event.id);
      await call(
        `/calendars/primary/events/${series.event.id}?version=${current.version}&scope=single&occurrence_key=d%3A2026-10-21`,
        { method: "DELETE", expected: 204 },
      );
      assert.equal(
        (
          await instances(
            series.event.id,
            "2026-10-21T00:00:00Z",
            "2026-10-22T00:00:00Z",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await instances(
            series.event.id,
            "2026-10-21T00:00:00Z",
            "2026-10-22T00:00:00Z",
            "&show_deleted=true",
          )
        )[0].status,
        "cancelled",
      );
      await call(`/calendars/primary/events/${series.event.id}/restore`, {
        method: "POST",
        data: {
          version: (await event(series.event.id)).version,
          scope: "single",
          occurrence_key: "d:2026-10-21",
        },
      });
      assert.equal(
        (
          await instances(
            series.event.id,
            "2026-10-21T00:00:00Z",
            "2026-10-22T00:00:00Z",
          )
        )[0].occurrence_key,
        "d:2026-10-21",
      );
    },
  );
  await t.test(
    "this and following splits COUNT, migrates overrides and issues a new UID",
    async () => {
      const value = await create({
        ...day(),
        title: "Before",
        recurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
      });
      await patch(value.event.id, {
        scope: "single",
        occurrence_key: "d:2026-10-22",
        title: "Exception",
      });
      const result = await patch(value.event.id, {
        scope: "following",
        occurrence_key: "d:2026-10-21",
        title: "After",
      });
      assert.notEqual(result.event.i_cal_uid, value.event.i_cal_uid);
      assert.deepEqual(
        (
          await instances(
            value.event.id,
            "2026-10-18T00:00:00Z",
            "2026-10-26T00:00:00Z",
          )
        ).map((value) => value.start.date),
        ["2026-10-19", "2026-10-20"],
      );
      const future = await instances(
        result.event.id,
        "2026-10-18T00:00:00Z",
        "2026-10-26T00:00:00Z",
      );
      assert.deepEqual(
        future.map((value) => value.start.date),
        ["2026-10-21", "2026-10-22", "2026-10-23"],
      );
      assert.equal(future[1].title, "Exception");
    },
  );
  await t.test(
    "unmatched edited exceptions detach and failed claims cannot create detached events",
    async () => {
      const value = await create({
        ...day(),
        recurrence: ["RRULE:FREQ=DAILY;COUNT=4"],
      });
      await patch(value.event.id, {
        scope: "single",
        occurrence_key: "d:2026-10-20",
        title: "Keep me",
      });
      const before = await counts();
      await call(`/calendars/primary/events/${value.event.id}`, {
        method: "PATCH",
        data: { version: 1, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"] },
        expected: 412,
      });
      assert.deepEqual(await counts(), before);
      const result = await patch(value.event.id, {
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
      });
      assert.equal(result.detached_event_ids.length, 1);
      assert.equal(
        (await event(result.detached_event_ids[0])).title,
        "Keep me",
      );
    },
  );
  await t.test(
    "same-version concurrent edits only commit one change and audit",
    async () => {
      const value = await create(day("2026-12-01", "2026-12-02")),
        before = await counts();
      const responses = await Promise.all([
        raw(`/calendars/primary/events/${value.event.id}`, {
          method: "PATCH",
          data: { version: 1, title: "One" },
        }),
        raw(`/calendars/primary/events/${value.event.id}`, {
          method: "PATCH",
          data: { version: 1, title: "Two" },
        }),
      ]);
      assert.deepEqual(
        responses.map((value) => value.status).sort(),
        [200, 412],
      );
      const after = await counts();
      assert.equal(after.activity - before.activity, 1);
      assert.equal(after.changes - before.changes, 1);
    },
  );
  await t.test(
    "authorization is rechecked within claims and SQL errors roll back every write",
    async () => {
      const before = await counts();
      await call(`/calendars/primary/events/${single.event.id}`, {
        method: "PATCH",
        data: {
          version: (await event(single.event.id)).version,
          title: "Revoked",
        },
        fault: true,
        headers: {
          "x-test-before-batch":
            "DELETE FROM role_permissions WHERE role_id='calendar-test' AND permission_key='calendar.events.update'",
        },
        expected: 403,
      });
      assert.deepEqual(await counts(), before);
      await db
        .prepare(
          "INSERT INTO role_permissions(role_id,permission_key) VALUES('calendar-test','calendar.events.update')",
        )
        .run();
      await call("/calendars/primary/events", {
        method: "POST",
        data: day("2026-12-02", "2026-12-03"),
        fault: true,
        headers: { "x-test-fail-batch": "true" },
        expected: 500,
      });
      assert.deepEqual(await counts(), before);
    },
  );
  await t.test(
    "private serializers and writer-without-private access do not leak search or edits",
    async () => {
      await db
        .prepare(
          "INSERT INTO calendar_acl(id,calendar_id,scope_type,scope_key,role) VALUES('bob-grant',?,'user','bob','reader')",
        )
        .bind(primary)
        .run();
      const redacted = (
        await call(`/calendars/${primary}/events/${single.event.id}`, {
          actor: "bob",
        })
      ).event;
      assert.equal(redacted.title, "Busy");
      assert.equal(redacted.is_redacted, true);
      assert.equal(Object.hasOwn(redacted, "description_html"), false);
      const search = await call(
        `/calendars/${primary}/events?time_min=2026-10-18T00%3A00%3A00Z&time_max=2026-10-25T00%3A00%3A00Z&q=Updated`,
        { actor: "bob" },
      );
      assert.equal(search.events.length, 0);
      await db
        .prepare(
          "UPDATE calendar_acl SET role='writer_without_private' WHERE id='bob-grant'",
        )
        .run();
      await call(`/calendars/${primary}/events/${single.event.id}`, {
        actor: "bob",
        method: "PATCH",
        data: {
          version: (await event(single.event.id)).version,
          title: "Forbidden",
        },
        expected: 404,
      });
      const visible = await create({
        ...day("2026-12-03", "2026-12-04"),
        visibility: "public",
      });
      assert.equal(
        (
          await call(`/calendars/${primary}/events/${visible.event.id}`, {
            actor: "bob",
          })
        ).event.is_redacted,
        false,
      );
      const withPrivate = await create({
        ...day("2027-01-10", "2027-01-11"),
        visibility: "public",
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
      });
      await patch(withPrivate.event.id, {
        scope: "single",
        occurrence_key: "d:2027-01-17",
        visibility: "private",
        title: "Secret occurrence",
      });
      const version = (await event(withPrivate.event.id)).version;
      const boundary = "d:2027-01-17";
      const hidden = (
        await call(
          `/calendars/${primary}/events/${withPrivate.event.id}/instances/${encodeURIComponent(boundary)}`,
          { actor: "bob" },
        )
      ).event;
      assert.equal(hidden.title, "Busy");
      await call(`/calendars/${primary}/events/${withPrivate.event.id}`, {
        actor: "bob",
        method: "PATCH",
        data: {
          version,
          scope: "single",
          occurrence_key: boundary,
          title: "Forbidden",
        },
        expected: 404,
      });
      await call(
        `/calendars/${primary}/events/${withPrivate.event.id}?version=${version}&scope=single&occurrence_key=${encodeURIComponent(boundary)}`,
        { actor: "bob", method: "DELETE", expected: 404 },
      );
      const bobPrimary = (await call("/bootstrap", { actor: "bob" }))
        .primary_calendar_id;
      for (const action of ["duplicate", "move"])
        await call(
          `/calendars/${primary}/events/${withPrivate.event.id}/${action}`,
          {
            actor: "bob",
            method: "POST",
            data: { version, target_calendar_id: bobPrimary },
            expected: 404,
          },
        );
      await db.prepare("DELETE FROM calendar_acl WHERE id='bob-grant'").run();
    },
  );
  await t.test(
    "labels and personal copies remain separate from the event",
    async () => {
      const label = (
        await call(`/calendars/${primary}/labels`, {
          method: "POST",
          data: { name: "Work", color: "#123456" },
          expected: 201,
        })
      ).label;
      const copy = (await call(`/copies/${single.copy_id}`)).copy;
      await call(`/copies/${copy.id}`, {
        method: "PATCH",
        data: {
          version: copy.version,
          label_id: label.id,
          color: "#654321",
          private_properties: { note: "personal" },
        },
      });
      assert.equal((await event(single.event.id)).title, "Updated");
      assert.equal(
        (await event(single.event.id)).private_properties.note,
        "personal",
      );
      await call(`/copies/${copy.id}`, { actor: "bob", expected: 404 });
      await call(
        `/calendars/${primary}/labels/${label.id}?version=${label.version}`,
        { method: "DELETE", expected: 204 },
      );
      assert.equal((await call(`/copies/${copy.id}`)).copy.label_id, null);
      const current = (await call(`/copies/${copy.id}`)).copy;
      await call(`/copies/${copy.id}?version=${current.version}`, {
        method: "DELETE",
        expected: 204,
      });
      const query =
        "/calendars/primary/events?time_min=2026-10-19T00%3A00%3A00Z&time_max=2026-10-20T00%3A00%3A00Z";
      assert.ok(
        !(await call(query)).events.some(
          (value) => value.id === single.event.id,
        ),
      );
      assert.equal((await event(single.event.id)).status, "confirmed");
      await call(`/copies/${copy.id}`, {
        method: "PATCH",
        data: { version: current.version + 1, hidden: false },
      });
      assert.ok(
        (await call(query)).events.some(
          (value) => value.id === single.event.id,
        ),
      );
    },
  );
  await t.test(
    "duplicate and move are scoped and keep stable idempotency receipts",
    async () => {
      const duplicate = await call(
        `/calendars/primary/events/${single.event.id}/duplicate`,
        {
          method: "POST",
          data: { version: (await event(single.event.id)).version },
          expected: 201,
        },
      );
      assert.notEqual(duplicate.event.i_cal_uid, single.event.i_cal_uid);
      const options = {
        method: "POST",
        data: {
          version: duplicate.event.version,
          target_calendar_id: secondary.id,
        },
        headers: { "Idempotency-Key": "move-receipt" },
      };
      const moved = await call(
        `/calendars/primary/events/${duplicate.event.id}/move`,
        options,
      );
      assert.equal(moved.event.i_cal_uid, duplicate.event.i_cal_uid);
      assert.deepEqual(
        await call(
          `/calendars/primary/events/${duplicate.event.id}/move`,
          options,
        ),
        moved,
      );
      await call(`/calendars/primary/events/${duplicate.event.id}`, {
        expected: 404,
      });
    },
  );
  await t.test(
    "a recurring duplicate preserves moved and cancelled exceptions",
    async () => {
      const value = await create({
        ...day("2026-12-10", "2026-12-11"),
        recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      });
      await patch(value.event.id, {
        scope: "single",
        occurrence_key: "d:2026-12-11",
        start: { date: "2026-12-20" },
        end: { date: "2026-12-21" },
      });
      await call(
        `/calendars/primary/events/${value.event.id}?version=2&scope=single&occurrence_key=d%3A2026-12-12`,
        { method: "DELETE", expected: 204 },
      );
      const copy = await call(
        `/calendars/primary/events/${value.event.id}/duplicate`,
        { method: "POST", data: { version: 3 }, expected: 201 },
      );
      assert.deepEqual(
        (
          await instances(
            copy.event.id,
            "2026-12-01T00:00:00Z",
            "2026-12-25T00:00:00Z",
          )
        ).map((value) => value.start.date),
        ["2026-12-10", "2026-12-20"],
      );
    },
  );
  await t.test(
    "moving between data owners clears the previous owner private copy metadata",
    async () => {
      const bobCalendar = (await call("/bootstrap", { actor: "bob" }))
        .primary_calendar_id;
      await db
        .prepare(
          "INSERT INTO calendar_acl(id,calendar_id,scope_type,scope_key,role) VALUES('alice-writer',?,'user','alice','writer')",
        )
        .bind(bobCalendar)
        .run();
      const created = await create({
        ...day("2026-12-27", "2026-12-28"),
        copy_preferences: {
          private_properties: { note: "Alice only" },
          color: "#123456",
        },
      });
      await call(`/calendars/primary/events/${created.event.id}/move`, {
        method: "POST",
        data: { version: 1, target_calendar_id: bobCalendar },
      });
      const received = (
        await call(`/calendars/${bobCalendar}/events/${created.event.id}`, {
          actor: "bob",
        })
      ).event;
      assert.deepEqual(received.private_properties, {});
      assert.equal(received.color, null);
      await db
        .prepare("DELETE FROM calendar_acl WHERE id='alice-writer'")
        .run();
    },
  );
  await t.test(
    "added-date splits require an explicit new rule and scope is unambiguous",
    async () => {
      const value = await create({
        ...day(),
        recurrence: ["RRULE:FREQ=MONTHLY;COUNT=3", "RDATE;VALUE=DATE:20261025"],
      });
      await call(`/calendars/primary/events/${value.event.id}`, {
        method: "PATCH",
        data: {
          version: 1,
          scope: "following",
          occurrence_key: "d:2026-10-25",
          title: "Wrong anchor",
        },
        expected: 422,
      });
      await call(`/calendars/primary/events/${value.event.id}`, {
        method: "PATCH",
        data: {
          version: 1,
          occurrence_key: "d:2026-10-25",
          title: "Missing scope",
        },
        expected: 400,
      });
      const result = await patch(value.event.id, {
        scope: "following",
        occurrence_key: "d:2026-10-25",
        recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=19;COUNT=2"],
      });
      assert.deepEqual(
        (
          await instances(
            result.event.id,
            "2026-10-20T00:00:00Z",
            "2027-01-01T00:00:00Z",
          )
        ).map((value) => value.start.date),
        ["2026-10-25", "2026-11-19", "2026-12-19"],
      );
    },
  );
  await t.test(
    "following cancellation after a finite rule does not extend COUNT or UNTIL",
    async () => {
      for (const rule of [
        "RRULE:FREQ=MONTHLY;COUNT=2",
        "RRULE:FREQ=MONTHLY;UNTIL=20261119",
      ]) {
        const value = await create({
          ...day(),
          recurrence: [rule, "RDATE;VALUE=DATE:20270219"],
        });
        await call(
          `/calendars/primary/events/${value.event.id}?version=1&scope=following&occurrence_key=d%3A2027-02-19`,
          { method: "DELETE", expected: 204 },
        );
        assert.deepEqual(
          (
            await instances(
              value.event.id,
              "2026-10-01T00:00:00Z",
              "2027-04-01T00:00:00Z",
            )
          ).map((item) => item.start.date),
          ["2026-10-19", "2026-11-19"],
        );
      }
    },
  );
  await t.test(
    "signed pagination and private change feeds are bound to query and actor",
    async () => {
      const query =
        "/calendars/primary/events?time_min=2026-10-01T00%3A00%3A00Z&time_max=2026-11-01T00%3A00%3A00Z&limit=1";
      const first = await call(query);
      assert.ok(first.next_cursor);
      const next = await call(
        `${query}&cursor=${encodeURIComponent(first.next_cursor)}`,
      );
      assert.notDeepEqual(next.events[0], first.events[0]);
      await call(`${query}&cursor=${encodeURIComponent(first.next_cursor)}x`, {
        expected: 400,
      });
      const changes = await call("/changes?limit=1");
      assert.ok(changes.has_more);
      await call(`/changes?cursor=${encodeURIComponent(changes.cursor)}`, {
        actor: "bob",
        expected: 400,
      });
      const range =
        "/calendars/primary/events?time_min=2026-01-01T00%3A00%3A00Z&time_max=2028-01-01T00%3A00%3A00Z";
      await call(range, { expected: 400 });
    },
  );
  await t.test(
    "event and calendar trash preserve data and can be restored",
    async () => {
      const current = await event(single.event.id);
      await call(
        `/calendars/primary/events/${single.event.id}?version=${current.version}`,
        { method: "DELETE", expected: 204 },
      );
      await call(`/calendars/primary/events/${single.event.id}`, {
        expected: 404,
      });
      assert.ok(
        (await call("/trash/events")).events.some(
          (value) => value.id === single.event.id,
        ),
      );
      await call(`/calendars/primary/events/${single.event.id}/restore`, {
        method: "POST",
        data: { version: current.version + 1 },
      });
      assert.equal((await event(single.event.id)).status, "confirmed");
      const cal = (await call(`/calendars/${secondary.id}`)).calendar;
      await call(`/calendars/${secondary.id}?version=${cal.version}`, {
        method: "DELETE",
        expected: 204,
      });
      await call(`/calendars/${secondary.id}`, { expected: 404 });
      await call(`/calendars/${secondary.id}/restore`, {
        method: "POST",
        data: { version: cal.version + 1 },
      });
      assert.equal(
        (await call(`/calendars/${secondary.id}`)).calendar.trashed_at,
        null,
      );
    },
  );
});
