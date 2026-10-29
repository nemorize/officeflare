import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApiClient } from "../web/lib/api-client.ts";
import { label, profileChanges, returnToWorkspace, validatePassword } from "../web/lib/profile.ts";

test("workspace API calls use the restored bearer token and omit cookies", async () => {
  const calls = [];
  const api = createApiClient({
    accessToken: async () => "access-token",
    refresh: async () => {},
    fetch: async (path, options) => {
      calls.push({ path, options });
      return Response.json({ user: { display_name: "Alex" } });
    },
  });
  const result = await api("/api/me/profile", {
    method: "PATCH",
    body: { display_name: "Alex", fields: {} },
  });
  assert.equal(result.user.display_name, "Alex");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { display_name: "Alex", fields: {} });
});

test("a rejected access token refreshes once and retries with the replacement", async () => {
  let token = "expired",
    refreshes = 0;
  const calls = [];
  const api = createApiClient({
    accessToken: async () => token,
    refresh: async () => {
      refreshes++;
      token = "renewed";
    },
    fetch: async (_path, options) => {
      calls.push(options.headers.Authorization);
      return calls.length === 1
        ? Response.json({ error: "Expired" }, { status: 401 })
        : Response.json({ sessions: [] });
    },
  });
  assert.deepEqual(await api("/api/me/sessions"), { sessions: [] });
  assert.equal(refreshes, 1);
  assert.deepEqual(calls, ["Bearer expired", "Bearer renewed"]);
});

test("password reauthentication and one-use grants are never retried with an access token", async () => {
  for (const options of [
    { method: "POST", retryAuth: false, body: { password: "wrong" } },
    { method: "PUT", token: "one-use-grant", body: { new_password: "replacement password" } },
  ]) {
    let calls = 0,
      refreshes = 0;
    const api = createApiClient({
      accessToken: async () => "access-token",
      refresh: async () => {
        refreshes++;
      },
      fetch: async (_path, request) => {
        calls++;
        assert.equal(request.headers.Authorization, `Bearer ${options.token ?? "access-token"}`);
        return Response.json({ error: "Invalid credentials or token" }, { status: 401 });
      },
    });
    await assert.rejects(
      api("/api/me/password", options),
      (error) => error instanceof ApiError && error.status === 401,
    );
    assert.equal(calls, 1);
    assert.equal(refreshes, 0);
  }
});

test("API errors preserve validation messages and session deletion accepts an empty response", async () => {
  const deps = { accessToken: async () => "access", refresh: async () => {} };
  const conflict = createApiClient({
    ...deps,
    fetch: async () => Response.json({ error: "Profile policy changed; reload" }, { status: 409 }),
  });
  await assert.rejects(conflict("/api/me/profile"), /Profile policy changed; reload/);
  const serverError = createApiClient({
    ...deps,
    fetch: async () => Response.json({ error: "Internal details" }, { status: 500 }),
  });
  await assert.rejects(
    serverError("/api/me/profile"),
    (error) => !error.message.includes("Internal details"),
  );
  const remove = createApiClient({
    ...deps,
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(await remove("/api/me/sessions/id", { method: "DELETE" }), undefined);
});

const field = (key, value_type, extra = {}) => ({
  id: key,
  key,
  label: { en: key },
  value_type,
  editable_by: "user",
  required: false,
  options: null,
  ...extra,
});

test("profile submissions preserve false and zero, convert numbers, and exclude administrator fields", () => {
  const definitions = [
    field("name", "text"),
    field("age", "number"),
    field("enabled", "boolean"),
    field("tags", "multiselect"),
    field("organization", "text", { editable_by: "admin" }),
  ];
  assert.deepEqual(
    profileChanges(definitions, {
      name: "",
      age: "0",
      enabled: false,
      tags: [],
      organization: "Changed",
    }),
    { name: null, age: 0, enabled: false, tags: null },
  );
});

test("required profile fields and invalid numbers stop submission", () => {
  assert.throws(
    () => profileChanges([field("Name", "text", { required: true })], { Name: "  " }),
    /Name is required/,
  );
  assert.throws(
    () => profileChanges([field("Teams", "multiselect", { required: true })], { Teams: [] }),
    /Teams is required/,
  );
  assert.throws(
    () => profileChanges([field("Age", "number")], { Age: "not-a-number" }),
    /Age must be a number/,
  );
  assert.deepEqual(
    profileChanges([field("Active", "boolean", { required: true })], { Active: false }),
    { Active: false },
  );
  assert.equal(label({ ko: "이름", en: "Name" }, "fallback"), "Name");
});

test("password validation matches the API character and byte limits", () => {
  assert.doesNotThrow(() => validatePassword("😀".repeat(15), "😀".repeat(15)));
  assert.throws(() => validatePassword("short", "short"), /15–128/);
  assert.throws(() => validatePassword("a".repeat(129), "a".repeat(129)), /15–128/);
  assert.throws(
    () => validatePassword("a valid long password", "different password"),
    /do not match/,
  );
});

test("login returns only to known workspace routes", () => {
  for (const path of [
    "/mail",
    "/mail/drafts",
    "/mail/sent",
    "/mail/archive",
    "/mail/trash",
    "/calendar",
    "/calendar/shared",
    "/drive",
    "/drive/shared",
    "/drive/starred",
    "/drive/trash",
    "/profile",
    "/profile/security",
    "/profile/sessions",
  ])
    assert.equal(returnToWorkspace(path), path);
  for (const path of [
    undefined,
    "https://other.test",
    "//other.test",
    "javascript:alert(1)",
    "/api/me",
    "/mail/unknown",
  ])
    assert.equal(returnToWorkspace(path), "/");
});
