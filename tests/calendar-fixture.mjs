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
  external: ["cloudflare:workers", "../dist/index.js", "node:*"],
  target: "es2022",
});
export async function fixture(t) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const common = {
    compatibilityDate: "2026-09-29",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "calendar-tests" },
    r2Buckets: ["MAIL_BUCKET", "DRIVE_BUCKET"],
    serviceBindings: {
      EMAIL: { name: "calendar-harness", entrypoint: "FakeEmail" },
    },
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
  const bucket = await mf.getR2Bucket("MAIL_BUCKET"),
    driveBucket = await mf.getR2Bucket("DRIVE_BUCKET");
  const flush = async (ids) => {
    const response = await faults.fetch(
      "https://office.test/test-calendar/flush",
      { method: "POST", body: JSON.stringify({ ids }) },
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return {
    mf,
    db,
    raw,
    call,
    create,
    event,
    patch,
    instances,
    counts,
    bucket,
    driveBucket,
    flush,
    faults,
    tokens,
  };
}
