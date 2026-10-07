import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApiClient } from "../web/lib/api-client.ts";
import { authenticatorKey, createMfaClient } from "../web/lib/mfa.ts";

const clock = 1_800_000_000_000;
const grant = (id) => ({ reauthentication_token: id, expires_at: clock / 1000 + 120 });
const setup = { method_id: "test-method", setup_expires_at: clock / 1000 + 600,
  provisioning_uri: "otpauth://totp/Officeflare:test%40office.test?secret=JBSWY3DPEHPK3PXP&issuer=Officeflare&digits=6&period=30" };
const session = (id) => ({ token_type: "Bearer", access_token: `access-${id}`, refresh_token: `refresh-${id}`,
  expires_in: 900, refresh_expires_at: clock / 1000 + 86400, session_id: id });

test("enrollment uses separate one-use grants and persists the replacement session after activation", async () => {
  const used = new Set(), stored = [], requests = [];
  let refreshes = 0;
  const api = createApiClient({ accessToken: async () => "original-access", refresh: async () => { refreshes++; },
    fetch: async (path, options) => {
      requests.push({ path, options });
      const token = options.headers.Authorization;
      if (used.has(token)) return Response.json({ error: "Grant already consumed" }, { status: 401 });
      used.add(token);
      return Response.json(path === "/api/me/mfa/totp" ? setup : { ...session("enabled"), method_id: setup.method_id });
    } });
  const client = createMfaClient({ api, now: () => clock, email: () => "test@office.test",
    acceptSession: async (result, email) => { stored.push({ result, email }); } });
  const pending = await client.start(grant("setup-grant"), " Phone ");
  assert.equal(stored.length, 0, "creating a pending authenticator must not replace the session");
  await assert.rejects(client.activate(grant("setup-grant"), pending, "123456"), (error) => error instanceof ApiError && error.status === 401);
  assert.equal(stored.length, 0);
  const activated = await client.activate(grant("activation-grant"), pending, "123456");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].result, activated);
  assert.equal(stored[0].email, "test@office.test");
  assert.equal(activated.refresh_token, "refresh-enabled");
  assert.equal(refreshes, 0, "a rejected grant must never be retried using a refreshed access token");
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ options }) => options.credentials === "omit"));
  assert.deepEqual(JSON.parse(requests[0].options.body), { name: "Phone" });
});

test("expired setup, expired grants and malformed codes never submit activation", async () => {
  let calls = 0;
  const client = createMfaClient({ now: () => clock, api: async () => { calls++; throw new Error("Unexpected request"); },
    acceptSession: async () => {}, email: () => "test@office.test" });
  await assert.rejects(client.activate(grant("valid"), { ...setup, setup_expires_at: clock / 1000 }, "123456"), /setup has expired/);
  await assert.rejects(client.activate({ ...grant("expired"), expires_at: clock / 1000 }, setup, "123456"), /Verification expired/);
  for (const code of ["12345", "1234567", "abcdef"]) await assert.rejects(client.activate(grant("valid"), setup, code), /six-digit/);
  assert.equal(calls, 0);
});

test("recovery generation and method removal both persist rotated tokens", async () => {
  const stored = [];
  const client = createMfaClient({ now: () => clock, email: () => "test@office.test",
    api: async (path) => path.endsWith("recovery-codes") ? { ...session("recovery"), recovery_codes: ["one-use-code"] } : session("removed"),
    acceptSession: async (result) => { stored.push(result); } });
  const codes = await client.recoveryCodes(grant("codes"));
  await client.remove(grant("remove"), setup.method_id);
  assert.deepEqual(codes.recovery_codes, ["one-use-code"]);
  assert.deepEqual(stored.map((result) => result.refresh_token), ["refresh-recovery", "refresh-removed"]);
});

test("a failed local session write cannot report a successful credential change", async () => {
  const client = createMfaClient({ now: () => clock, email: () => "test@office.test", api: async () => session("enabled"),
    acceptSession: async () => { throw new Error("Local session storage unavailable"); } });
  await assert.rejects(client.activate(grant("activate"), setup, "123456"), /Local session storage unavailable/);
  await assert.rejects(client.recoveryCodes(grant("recovery")), /Local session storage unavailable/);
  await assert.rejects(client.remove(grant("remove"), setup.method_id), /Local session storage unavailable/);
});

test("manual setup only accepts authenticator URIs with a base32 secret", () => {
  assert.equal(authenticatorKey(setup.provisioning_uri), "JBSWY3DPEHPK3PXP");
  for (const uri of ["https://other.test/?secret=JBSWY3DPEHPK3PXP", "otpauth://hotp/test?secret=JBSWY3DPEHPK3PXP",
    "otpauth://totp/test", "otpauth://totp/test?secret=not-a-valid-key"]) assert.throws(() => authenticatorKey(uri));
});
