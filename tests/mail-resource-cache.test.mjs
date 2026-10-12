import { test } from "node:test";
import assert from "node:assert/strict";
import { MailResourceCache } from "../web/lib/mail-resource-cache.ts";
import { applyReadReceipt } from "../web/lib/mail-resource-data.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
test("two consumers share an in-flight request and retain it across route revisits", async () => {
  const pending = deferred(); let calls = 0;
  const cache = new MailResourceCache(async () => { calls++; return pending.promise; });
  const unsubscribe = cache.subscribe("/addresses", () => {});
  const first = cache.load("/addresses"), second = cache.load("/addresses");
  await Promise.resolve(); assert.equal(calls, 1);
  pending.resolve({ addresses: ["one"] }); await Promise.all([first, second]);
  unsubscribe();
  await cache.load("/addresses");
  assert.equal(calls, 1); assert.equal(cache.snapshot("/addresses").loading, false);
  assert.deepEqual(cache.snapshot("/addresses").data, { addresses: ["one"] });
});
test("invalidation during a request queues one fresh load without losing a mutation", async () => {
  const first = deferred(), fresh = deferred(); let calls = 0;
  const cache = new MailResourceCache(() => ++calls === 1 ? first.promise : fresh.promise);
  cache.subscribe("/messages", () => {});
  const loading = cache.load("/messages"); await Promise.resolve();
  cache.revalidate("/messages", 1); cache.revalidate("/messages", 1);
  first.resolve({ version: 1 }); await loading; await Promise.resolve();
  assert.equal(calls, 2);
  fresh.resolve({ version: 2 }); await cache.load("/messages");
  assert.deepEqual(cache.snapshot("/messages").data, { version: 2 });
});
test("refresh preserves current data and a committed receipt survives an older response", async () => {
  const pending = deferred(); let calls = 0;
  const cache = new MailResourceCache(() => ++calls === 1 ? Promise.resolve({ message: { id: "m", version: 1, is_read: 0 } }) : pending.promise);
  await cache.load("/message");
  const refresh = cache.load("/message", true); await Promise.resolve();
  assert.equal(cache.snapshot("/message").data.message.is_read, 0);
  cache.update(() => true, data => applyReadReceipt(data, "m", 2));
  pending.resolve({ message: { id: "m", version: 1, is_read: 0 } }); await refresh;
  assert.equal(cache.snapshot("/message").data.message.is_read, 1);
  assert.equal(cache.snapshot("/message").data.message.version, 2);
});
test("a newer message version is not overwritten by an older read receipt", () => {
  const newer = { message: { id: "m", version: 4, is_read: 0 } };
  assert.deepEqual(applyReadReceipt(newer, "m", 2), newer);
  assert.deepEqual(applyReadReceipt({ messages: [{ id: "m", version: 1, is_read: 0 }, { id: "other", version: 1, is_read: 0 }] }, "m", 2), { messages: [{ id: "m", version: 2, is_read: 1 }, { id: "other", version: 1, is_read: 0 }] });
});
test("permission denial removes all cached data for that mailbox", async () => {
  let denied = false;
  const cache = new MailResourceCache(async () => { if (denied) throw Object.assign(new Error("Forbidden"), { status: 403 }); return { private: true }; });
  await cache.load("/api/mail/mailboxes/a/messages");
  await cache.load("/api/mail/mailboxes/a/settings");
  await cache.load("/api/mail/mailboxes/b/settings");
  denied = true; await cache.load("/api/mail/mailboxes/a/messages", true);
  assert.equal(cache.snapshot("/api/mail/mailboxes/a/messages").data, null);
  assert.equal(cache.snapshot("/api/mail/mailboxes/a/settings").data, null);
  assert.deepEqual(cache.snapshot("/api/mail/mailboxes/b/settings").data, { private: true });
});
test("disposing a session aborts its request and ignores a late private response", async () => {
  const pending = deferred(); let signal;
  const cache = new MailResourceCache((_path, requestSignal) => { signal = requestSignal; return pending.promise; });
  const request = cache.load("/private"); await Promise.resolve();
  cache.clear(); assert.equal(signal.aborted, true);
  pending.resolve({ secret: "previous user" }); await request;
  assert.equal(cache.snapshot("/private").data, null);
  const nextSession = new MailResourceCache(async () => ({ user: "new" }));
  await nextSession.load("/private");
  assert.deepEqual(nextSession.snapshot("/private").data, { user: "new" });
});
test("expired entries revalidate while temporary failures keep the visible data", async () => {
  let now = 100, calls = 0;
  const cache = new MailResourceCache(async () => { if (++calls > 1) throw Object.assign(new Error("Unavailable"), { status: 503 }); return { rows: [1] }; }, () => now, 30);
  await cache.load("/rows"); now = 140; await cache.load("/rows");
  assert.deepEqual(cache.snapshot("/rows").data, { rows: [1] });
  assert.match(cache.snapshot("/rows").error.message, /Unavailable/);
});
test("a mailbox change also invalidates a cached detail that is currently unmounted", async () => {
  let calls = 0;
  const cache = new MailResourceCache(async () => ({ version: ++calls }));
  await cache.load("/mailbox/message");
  cache.invalidateInactive(path => path.startsWith("/mailbox/"));
  assert.deepEqual(cache.snapshot("/mailbox/message").data, { version: 1 });
  await cache.load("/mailbox/message");
  assert.deepEqual(cache.snapshot("/mailbox/message").data, { version: 2 });
});
