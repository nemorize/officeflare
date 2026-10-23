import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../web/lib/api-client.ts";
import { parseRecipients, scheduledTime, MailOperation, cancelableSubmission, retryableSubmission, htmlFrame, mailFrameHeight, embeddedMailImage } from "../web/lib/mail-helpers.ts";
import { returnToWorkspace } from "../web/lib/profile.ts";

test("mail uploads preserve bytes and encoded filenames through authentication refresh", async () => {
  const calls = [], body = new Blob([new Uint8Array([0, 255, 10, 128])]), filename = encodeURIComponent("서울 첨부파일.bin");
  let token = "expired";
  const api = createApiClient({ accessToken: async () => token, refresh: async () => { token = "renewed"; }, fetch: async (_path, options) => { calls.push(options); return calls.length === 1 ? Response.json({ error: "Expired" }, { status: 401 }) : Response.json({ upload: { id: "file" } }); } });
  await api("/api/mail/mailboxes/box/uploads", { method: "POST", body, headers: { "X-Filename-Encoded": filename, "Idempotency-Key": "upload-request", authorization: "untrusted" } });
  assert.equal(calls.length, 2);
  for (const [index, options] of calls.entries()) {
    assert.equal(options.body, body); assert.equal(options.headers["Content-Type"], "application/octet-stream");
    assert.equal(options.headers["X-Filename-Encoded"], filename); assert.equal(options.headers["Idempotency-Key"], "upload-request");
    assert.equal(options.headers.Authorization, `Bearer ${index ? "renewed" : "expired"}`); assert.equal(options.headers.authorization, undefined);
  }
  assert.deepEqual([...new Uint8Array(await calls[1].body.arrayBuffer())], [0, 255, 10, 128]);
});
test("draft and send retries keep their operation key and refuse a changed payload after an unknown outcome", () => {
  const operation = new MailOperation(), payload = { version: 4, address_id: "address", scheduled_at: 1234567 };
  const first = operation.headers(payload);
  assert.deepEqual(operation.headers({ ...payload }), first);
  assert.throws(() => operation.headers({ ...payload, version: 5 }), /unknown outcome/);
  operation.complete(); assert.notEqual(operation.headers({ ...payload, version: 5 })["Idempotency-Key"], first["Idempotency-Key"]);
});
test("mail operations can open and complete on HTTP origins without crypto.randomUUID", (t) => {
  const browserCrypto = globalThis.crypto;
  t.mock.getter(globalThis, "crypto", () => ({ getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) }));
  assert.equal(globalThis.crypto.randomUUID, undefined);
  const operation = new MailOperation(), payload = { name: "HTTP mailbox", kind: "shared", owner_user_id: "owner" };
  const first = operation.headers(payload)["Idempotency-Key"];
  assert.match(first, /^[a-zA-Z0-9_-]{8,200}$/);
  assert.equal(operation.headers({ ...payload })["Idempotency-Key"], first);
  assert.throws(() => operation.headers({ ...payload, name: "Changed" }), /unknown outcome/);
  assert.notEqual(new MailOperation().headers(payload)["Idempotency-Key"], first);
  operation.complete();
  assert.notEqual(operation.headers({ ...payload, name: "Next mailbox" })["Idempotency-Key"], first);
});
test("recipient and scheduling validation rejects malformed addresses and expired or excessive schedules", () => {
  assert.deepEqual(parseRecipients("Alex@Example.com;alex@example.com, team+tag@example.test\nother@example.org"), ["alex@example.com", "team+tag@example.test", "other@example.org"]);
  for (const address of ["Alex <alex@example.com>", ".alex@example.com", "a..b@example.com", "user@localhost", "user@bad_domain.com", "a".repeat(65) + "@example.test"]) assert.throws(() => parseRecipients(address), /email addresses/);
  const now = Date.parse("2026-10-07T00:00:00Z");
  assert.equal(scheduledTime("", now), undefined);
  assert.equal(scheduledTime("2026-10-08T00:00:00Z", now), (now + 86400000) / 1000);
  for (const value of ["invalid", "2026-10-06T23:59:59Z", "2027-10-09T00:00:00Z"]) assert.throws(() => scheduledTime(value, now), /future time/);
});
test("sending controls never retry ambiguous acceptance or cancel a processing send", () => {
  assert.equal(retryableSubmission("failed"), true);
  for (const status of ["unknown", "accepted", "queued", "processing", "scheduled"]) assert.equal(retryableSubmission(status), false);
  for (const status of ["scheduled", "queued", "retry_wait", "unknown"]) assert.equal(cancelableSubmission(status), true);
  for (const status of ["accepted", "processing", "failed"]) assert.equal(cancelableSubmission(status), false);
});
test("HTML email uses a restrictive frame policy that blocks remote images and scripts", () => {
  const frame = htmlFrame('<p>Mail body</p><img src="https://tracking.test/image">');
  assert.match(frame, /default-src 'none'/); assert.match(frame, /img-src blob: data:/); assert.match(frame, /form-action 'none'/); assert.match(frame, /base-uri 'none'/);
  assert.doesNotMatch(frame, /script-src.*unsafe-inline/);
});
test("verified mail images embed without relying on a sandbox's access to parent blob URLs", async () => {
  const image = await embeddedMailImage(new Blob([new Uint8Array([0, 255, 1, 128])], { type: "image/png" }));
  assert.equal(image, "data:image/png;base64,AP8BgA==");
  await assert.rejects(embeddedMailImage(new Blob(["<script>alert(1)</script>"], { type: "text/html" })), /Unsupported/);
  await assert.rejects(embeddedMailImage(new Blob([new Uint8Array(5 * 1024 ** 2 + 1)], { type: "image/png" })), /Unsupported/);
});
test("email sizing permits only its nonce-authorized observer and rejects forged size messages", () => {
  const nonce = "a".repeat(32), source = {};
  const frame = htmlFrame('<script>alert("untrusted")</script><img src="https://tracking.test/image">', nonce);
  const policy = frame.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /img-src blob: data:/);
  assert.match(policy, /script-src 'nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline|script-src[^;]*https:/);
  assert.throws(() => htmlFrame("", '"><script>'), /nonce/);
  const data = { type: "officeflare:mail-body-height", nonce, height: 241.1 };
  assert.equal(mailFrameHeight(data, nonce, source, source), 242);
  assert.equal(mailFrameHeight(data, nonce, {}, source), null);
  assert.equal(mailFrameHeight(data, "wrong", source, source), null);
  assert.equal(mailFrameHeight({ ...data, height: Infinity }, nonce, source, source), null);
  assert.equal(mailFrameHeight({ ...data, height: "300" }, nonce, source, source), null);
  assert.equal(mailFrameHeight({ ...data, height: 1_000_000 }, nonce, source, source), 24_000);
});
test("new mail routes restore safely after login without accepting arbitrary paths", () => {
  for (const path of ["/mail/settings", "/mail/integrations", "/mail/data", "/mail/spam", "/mail/snoozed", "/mail/folders/abcd-1234", "/console/mail/domains", "/console/mail/domains/new", "/console/mail/domains/abcd-1234", "/console/mail/mailboxes", "/console/mail/mailboxes/new", "/console/mail/mailboxes/abcd-1234"]) assert.equal(returnToWorkspace(path), path);
  for (const path of ["/mail/contacts", "/mail/templates", "//evil.test/mail", "/mail/folders/../../console", "/mail/settings?redirect=evil", "/console/mail/unknown", "/console/mail/providers", "/console/mail/domains/../users", "/console/mail/domains/abcd/extra", "/console/mail/mailboxes/../users", "/console/mail/mailboxes/abcd/extra"]) assert.equal(returnToWorkspace(path), "/");
});
