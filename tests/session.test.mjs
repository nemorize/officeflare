import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SessionManager, SESSION_KEY } from "../web/lib/session-manager.ts";

const unauthorized = () => Object.assign(new Error("Unauthorized"), { status: 401 });
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  let now = 1_800_000_000_000, sequence = 0, tail = Promise.resolve();
  const values = new Map(), timers = new Map(), accessTokens = new Set(), rotations = new Map();
  let revoked = false, loseResponse = false, offline = false, refreshCalls = [], profileGate, refreshGate;
  const tokens = (sessionId = "session-one") => {
    const access = `access-${++sequence}`;
    accessTokens.add(access);
    return { token_type: "Bearer", access_token: access, expires_in: 900,
      refresh_token: `ofr_${randomBytes(32).toString("base64url")}`,
      refresh_expires_at: Math.floor(now / 1000) + 30 * 86400, session_id: sessionId };
  };
  const storage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const dependencies = {
    storage, now: () => now, requestId: () => randomBytes(32).toString("hex"),
    lock: (action) => {
      const result = tail.then(action);
      tail = result.catch(() => {});
      return result;
    },
    refresh: async (token, requestId) => {
      refreshCalls.push({ token, requestId });
      if (offline) throw new TypeError("Offline");
      if (revoked) throw unauthorized();
      let result = rotations.get(token);
      if (result && result.requestId !== requestId) { revoked = true; throw unauthorized(); }
      if (!result) { result = { requestId, tokens: tokens() }; rotations.set(token, result); }
      if (refreshGate) await refreshGate.promise;
      if (loseResponse) { loseResponse = false; throw new TypeError("Response lost after rotation"); }
      return result.tokens;
    },
    currentUser: async (access) => {
      if (offline) throw new TypeError("Offline");
      if (profileGate) await profileGate.promise;
      if (revoked || !accessTokens.has(access)) throw unauthorized();
      return { user: { email_address: "person@office.test" } };
    },
    logout: async () => { if (offline) throw new TypeError("Offline"); revoked = true; },
    schedule: (action, delay) => { const handle = {}; timers.set(handle, { action, at: now + delay }); return handle; },
    cancel: (handle) => timers.delete(handle),
  };
  return {
    tokens, storage, timers, refreshCalls, dependencies, create: () => new SessionManager(dependencies),
    stored: () => JSON.parse(storage.getItem(SESSION_KEY)),
    advance: (milliseconds) => { now += milliseconds; },
    fireTimers: () => { for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.action(); } },
    revoke: () => { revoked = true; }, loseResponse: () => { loseResponse = true; },
    offline: (value) => { offline = value; },
    holdProfile: () => { profileGate = deferred(); return profileGate; },
    holdRefresh: () => { refreshGate = deferred(); return refreshGate; },
  };
}

test("localStorage restores login after reload and validates the saved account", async () => {
  const f = fixture(), first = f.create();
  await first.accept(f.tokens(), "PERSON@OFFICE.TEST");
  const reload = f.create();
  await reload.restore();
  assert.equal(reload.getSnapshot().status, "signed_in");
  assert.equal(reload.getSnapshot().session.email, "person@office.test");
  assert.equal(f.refreshCalls.length, 0);
  assert.equal(f.stored().tokens.refresh_token, first.getSnapshot().session.tokens.refresh_token);
});

test("the scheduled refresh replaces both tokens before the 15 minute expiry", async () => {
  const f = fixture(), manager = f.create();
  const initial = f.tokens();
  await manager.accept(initial, "person@office.test");
  f.advance(870_000);
  f.fireTimers();
  await drain();
  assert.equal(manager.getSnapshot().status, "signed_in");
  assert.notEqual(f.stored().tokens.refresh_token, initial.refresh_token);
  assert.equal(f.stored().refreshRequestId, null);
  assert.equal(f.refreshCalls.length, 1);
});

test("two tabs and duplicate calls share the same durable rotation operation", async () => {
  const f = fixture(), one = f.create(), two = f.create();
  await one.accept(f.tokens(), "person@office.test");
  f.advance(900_000);
  const gate = f.holdRefresh();
  const a = one.restore(), duplicate = one.restore(), b = two.restore();
  assert.equal(a, duplicate);
  await drain();
  assert.equal(f.refreshCalls.length, 2);
  assert.equal(f.refreshCalls[0].requestId, f.refreshCalls[1].requestId);
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(one.getSnapshot().session.tokens.refresh_token, two.getSnapshot().session.tokens.refresh_token);
  assert.equal(one.getSnapshot().status, "signed_in");
  assert.equal(two.getSnapshot().status, "signed_in");
});

test("a lost refresh response can be recovered after a reload without replaying a different operation", async () => {
  const f = fixture(), manager = f.create();
  await manager.accept(f.tokens(), "person@office.test");
  f.advance(900_000);
  f.loseResponse();
  await manager.restore();
  assert.equal(manager.getSnapshot().status, "signed_in");
  const pendingId = f.stored().refreshRequestId;
  assert.ok(pendingId);
  const reload = f.create();
  await reload.restore();
  assert.equal(f.refreshCalls[1].requestId, pendingId);
  assert.equal(f.stored().refreshRequestId, null);
  assert.equal(reload.getSnapshot().status, "signed_in");
});

test("an offline restore retains storage and retries after reconnection", async () => {
  const f = fixture(), manager = f.create();
  await manager.accept(f.tokens(), "person@office.test");
  f.offline(true);
  const reload = f.create();
  await reload.restore();
  assert.equal(reload.getSnapshot().status, "unavailable");
  assert.ok(f.stored().tokens.refresh_token);
  f.offline(false);
  reload.synchronize();
  await drain();
  assert.equal(reload.getSnapshot().status, "signed_in");
});

test("revocation and the 30 day session deadline clear stored credentials", async (t) => {
  for (const reason of ["revoked", "expired"]) await t.test(reason, async () => {
    const f = fixture(), manager = f.create();
    await manager.accept(f.tokens(), "person@office.test");
    if (reason === "revoked") f.revoke();
    else f.advance(30 * 86400 * 1000);
    await manager.restore();
    assert.equal(f.storage.getItem(SESSION_KEY), null);
    assert.equal(manager.getSnapshot().status, "signed_out");
  });
});

test("logout removes credentials and a different tab follows its storage event", async () => {
  const f = fixture(), one = f.create(), two = f.create();
  await one.accept(f.tokens(), "person@office.test");
  await two.restore();
  await one.signOut();
  two.synchronize();
  await drain();
  assert.equal(f.storage.getItem(SESSION_KEY), null);
  assert.equal(one.getSnapshot().status, "signed_out");
  assert.equal(two.getSnapshot().status, "signed_out");
});

test("an offline logout keeps the recoverable session and reports failure", async () => {
  const f = fixture(), manager = f.create();
  await manager.accept(f.tokens(), "person@office.test");
  f.offline(true);
  await assert.rejects(manager.signOut(), /Offline/);
  assert.ok(f.storage.getItem(SESSION_KEY));
  assert.equal(manager.getSnapshot().status, "signed_in");
});

test("a delayed refresh cannot resurrect a session removed in another tab", async () => {
  const f = fixture(), manager = f.create();
  await manager.accept(f.tokens(), "person@office.test");
  f.advance(900_000);
  const gate = f.holdRefresh(), pending = manager.restore();
  await drain();
  f.storage.removeItem(SESSION_KEY);
  manager.synchronize();
  gate.resolve();
  await pending;
  await drain();
  assert.equal(f.storage.getItem(SESSION_KEY), null);
  assert.equal(manager.getSnapshot().status, "signed_out");
});

test("a delayed initial restore cannot overwrite a new login", async () => {
  const f = fixture(), manager = f.create();
  await manager.accept(f.tokens(), "person@office.test");
  const gate = f.holdProfile(), pending = manager.restore();
  await drain();
  const newer = f.tokens("session-two");
  await manager.accept(newer, "new@office.test");
  gate.resolve();
  await pending;
  assert.equal(manager.getSnapshot().session.tokens.session_id, "session-two");
  assert.equal(manager.getSnapshot().session.email, "new@office.test");
});

test("a login in another tab while logout prepares cannot be revoked or removed", async () => {
  const f = fixture(), manager = f.create();
  await manager.accept(f.tokens(), "person@office.test");
  const logout = manager.signOut();
  await manager.accept(f.tokens("session-two"), "new@office.test");
  await logout;
  assert.equal(f.stored().tokens.session_id, "session-two");
  assert.equal(manager.getSnapshot().session.tokens.session_id, "session-two");
  await manager.restore();
  assert.equal(manager.getSnapshot().status, "signed_in");
});

test("corrupt storage is removed and unavailable storage never reports a successful login", async () => {
  const f = fixture();
  f.storage.setItem(SESSION_KEY, "{broken");
  const manager = f.create();
  await manager.restore();
  assert.equal(manager.getSnapshot().status, "signed_out");
  assert.equal(f.storage.getItem(SESSION_KEY), null);
  const unavailable = new SessionManager({ ...f.dependencies,
    storage: { ...f.storage, setItem: () => { throw new Error("Storage full"); } } });
  await assert.rejects(unavailable.accept(f.tokens(), "person@office.test"), /Enable browser storage/);
  assert.notEqual(unavailable.getSnapshot().status, "signed_in");
});
