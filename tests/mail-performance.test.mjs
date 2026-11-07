import { test } from "node:test";
import assert from "node:assert/strict";
import { MailResourceCache } from "../web/lib/mail-resource-cache.ts";
import { hydrateMailResources, mergeMailView, MailChangeScheduler } from "../web/lib/mail-ui.ts";
import {
  mailViewOptions,
  mailGrouped,
  isInboxFolder,
  inboxUnread,
  folderMoveLeavesMailView,
} from "../src/mail/ui-query.ts";
import { htmlFrame, observeMailDocument, mailRenderingPath } from "../web/lib/mail-helpers.ts";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a conversation response supplies prepared HTML without another rendering request", async () => {
  const base = "/api/mail/mailboxes/box",
    message = { id: "m", version: 1, body_revision: "inbound.json" };
  const rendering = {
    html: '<p>Ready</p><img src="/api/mail/image">',
    failures: 0,
    pending: false,
  };
  let requests = 0;
  const cache = new MailResourceCache(async (path) => {
    requests++;
    const response = { message, messages: [message], rendering };
    hydrateMailResources(cache, path, response);
    return response;
  });
  await cache.load(base + "/ui/conversation/m?conversation=true");
  await cache.load(mailRenderingPath(base, message));
  assert.equal(requests, 1);
  assert.equal(cache.snapshot(mailRenderingPath(base, message)).data, rendering);
});

test("a bootstrap seeds the six initial resources without follow-up data requests", async () => {
  let requests = 0;
  const path = "/api/mail/ui/bootstrap?section=inbox";
  const options = mailViewOptions("inbox", undefined, "");
  options.set("grouped", String(mailGrouped("inbox", "", true)));
  const view = "/api/mail/mailboxes/b/ui/view?" + options;
  const response = {
    mailboxes: [{ id: "b" }],
    mailbox_id: "b",
    preferences: { conversation_view: true },
    capabilities: { features: {} },
    folders: [],
    summary: { folders: {} },
    cursor: 8,
    page: { messages: [{ id: "m", version: 1 }], next_cursor: null },
    view_path: view,
  };
  const cache = new MailResourceCache(async (key) => {
    requests++;
    assert.equal(key, path);
    hydrateMailResources(cache, key, response);
    return response;
  });
  await cache.load(path);
  await Promise.all(
    [
      "/api/mail/mailboxes",
      "/api/mail/preferences",
      "/api/mail/capabilities",
      "/api/mail/mailboxes/b/folders",
      "/api/mail/mailboxes/b/summary",
      view,
    ].map((key) => cache.load(key)),
  );
  assert.equal(requests, 1);
  assert.equal(cache.snapshot(view).data.messages[0].id, "m");
});

test("delta reconciliation preserves the paging boundary, unaffected rows and newer versions", () => {
  const a = { id: "a", thread_id: "ta", version: 3, received_at: 30 },
    b = { id: "b", thread_id: "tb", version: 1, received_at: 20 };
  const data = { messages: [a, b], next_cursor: "old-boundary" };
  const newMessage = { id: "new", thread_id: "tn", version: 1, received_at: 40 };
  const delta = {
    messages: [],
    thread_ids: ["ta", "tn"],
    removed: [],
    view: [{ ...a, version: 2 }, newMessage],
  };
  const next = mergeMailView(data, delta, true, false);
  assert.deepEqual(
    next.messages.map((row) => row.id),
    ["new", "a", "b"],
  );
  assert.equal(next.messages[1], a);
  assert.equal(next.messages[2], b);
  assert.equal(next.next_cursor, "old-boundary");
  assert.deepEqual(
    mergeMailView(data, delta, true, true).messages.map((row) => row.id),
    ["a", "b"],
  );
  assert.deepEqual(
    mergeMailView(data, { ...delta, thread_ids: ["ta"], view: [], removed: ["a"] }, true, false)
      .messages,
    [b],
  );
});

test("event bursts and events during catch-up are bounded and not lost", async () => {
  let calls = 0,
    finish;
  const scheduler = new MailChangeScheduler(async () => {
    calls++;
    if (calls === 1)
      await new Promise((resolve) => {
        finish = resolve;
      });
  });
  for (let i = 0; i < 100; i++) scheduler.request();
  await wait(120);
  assert.equal(calls, 1);
  for (let i = 0; i < 100; i++) scheduler.request();
  finish();
  await wait(120);
  assert.equal(calls, 2);
  scheduler.request();
  scheduler.stop();
  await wait(120);
  assert.equal(calls, 2);
});

test("mail frames use R2 URLs without executable scripts", () => {
  const html = htmlFrame(
    '<img src="/api/mail/mailboxes/b/messages/m/render/assets/hash?grant=test">',
    "https://office.test",
    "/api/mail/mailboxes/b/messages/m/render/assets/",
  );
  assert.match(
    html,
    /img-src https:\/\/office.test\/api\/mail\/mailboxes\/b\/messages\/m\/render\/assets\//,
  );
  assert.match(html, /script-src 'none'/);
  assert.doesNotMatch(html, /<script|postMessage|data:image/);
});
test("the parent observes height and confirms trusted email links while frame scripts stay disabled", () => {
  const handlers = {},
    reports = [],
    requests = [];
  let height = 50,
    resized,
    animation,
    disconnected = false;
  const document = {
    body: { getBoundingClientRect: () => ({ height }) },
    addEventListener(name, handler) {
      handlers[name] = handler;
    },
    removeEventListener(name, handler) {
      if (handlers[name] === handler) delete handlers[name];
    },
  };
  const cleanup = observeMailDocument(
    document,
    (height) => reports.push(height),
    (url) => requests.push(url),
    {
      ResizeObserver: class {
        constructor(callback) {
          resized = callback;
        }
        observe() {}
        disconnect() {
          disconnected = true;
        }
      },
      requestAnimationFrame(callback) {
        animation = callback;
        return 1;
      },
      cancelAnimationFrame() {},
    },
  );
  assert.deepEqual(reports, [96]);
  height = 150;
  resized();
  animation();
  assert.deepEqual(reports, [96, 190]);
  let prevented = 0;
  const event = {
    type: "click",
    button: 0,
    isTrusted: true,
    target: { nodeType: 1, closest: () => ({ getAttribute: () => "https://example.com" }) },
    preventDefault() {
      prevented++;
    },
    stopPropagation() {},
  };
  handlers.click(event);
  assert.deepEqual(requests, ["https://example.com/"]);
  assert.equal(prevented, 1);
  handlers.click({ ...event, isTrusted: false });
  handlers.auxclick({ ...event, type: "auxclick", button: 2 });
  assert.equal(requests.length, 1);
  handlers.auxclick({ ...event, type: "auxclick", button: 1 });
  assert.equal(requests.length, 2);
  cleanup();
  assert.equal(disconnected, true);
  assert.equal(handlers.click, undefined);
  assert.equal(handlers.auxclick, undefined);
});

test("default mail resize scheduling and cleanup preserve the Window receiver", (t) => {
  const reports = [];
  let height = 80,
    resized,
    animation,
    scheduled = 0,
    canceled,
    disconnected = false;
  const window = {
    requestAnimationFrame(callback) {
      assert.equal(this, window, "requestAnimationFrame requires its Window receiver");
      animation = callback;
      return ++scheduled;
    },
    cancelAnimationFrame(handle) {
      assert.equal(this, window, "cancelAnimationFrame requires its Window receiver");
      canceled = handle;
    },
  };
  const globals = {
    window,
    ResizeObserver: class {
      constructor(callback) {
        resized = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const document = {
    body: { getBoundingClientRect: () => ({ height }) },
    addEventListener() {},
    removeEventListener() {},
  };
  const cleanup = observeMailDocument(
    document,
    (height) => reports.push(height),
    () => {},
  );
  assert.deepEqual(reports, [120]);
  height = 240;
  resized();
  resized();
  assert.equal(scheduled, 1);
  animation();
  assert.deepEqual(reports, [120, 280]);
  resized();
  cleanup();
  assert.equal(disconnected, true);
  assert.equal(canceled, 2);
});

test("conversation headers accept new mail and deletions without reloading unrelated bodies", async () => {
  const { applyMailHeaders } = await import("../web/lib/mail-ui.ts");
  const body = { html: "<p>Kept body</p>" },
    first = { id: "a", thread_id: "t", version: 2, received_at: 20, body },
    second = { id: "b", thread_id: "t", version: 1, received_at: 10 };
  const data = { message: first, messages: [first, second] };
  const next = applyMailHeaders(
    data,
    [{ id: "c", thread_id: "t", version: 1, received_at: 30 }],
    ["b"],
  );
  assert.deepEqual(
    next.messages.map((message) => message.id),
    ["c", "a"],
  );
  assert.equal(next.message.body, body);
  assert.equal(applyMailHeaders(next, [{ ...first, version: 1 }]).message.version, 2);
});

test("a read receipt during prepared HTML loading preserves R2 image URLs", async () => {
  const { applyMailHeaders } = await import("../web/lib/mail-ui.ts");
  const headers = [{ id: "a", thread_id: "t", version: 2, is_read: 1 }];
  let finish;
  const cache = new MailResourceCache(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const key = "/api/mail/mailboxes/b/messages/a/render?revision=body";
  const rendering = {
    html: '<img src="/api/mail/mailboxes/b/messages/a/render/assets/hash?grant=test">',
    assets: [],
    failures: 0,
  };
  const loading = cache.load(key);
  await Promise.resolve();
  cache.update(
    (path) => path.startsWith("/api/mail/mailboxes/b/messages/"),
    (data) => applyMailHeaders(data, headers),
  );
  finish(rendering);
  await loading;
  assert.equal(cache.snapshot(key).data, rendering);
  assert.equal(applyMailHeaders(rendering, headers), rendering);
});

test("expired bootstrap revalidation owns its six child resources on revisit", async () => {
  let now = 1,
    calls = [];
  const path = "/api/mail/ui/bootstrap?section=inbox",
    view = "/api/mail/mailboxes/b/ui/view?folder_id=inbox";
  const response = {
    mailboxes: [{ id: "b" }],
    mailbox_id: "b",
    preferences: {},
    capabilities: {},
    folders: [],
    summary: { folders: {} },
    cursor: 0,
    page: { messages: [], next_cursor: null },
    view_path: view,
  };
  const cache = new MailResourceCache(
    async (key) => {
      calls.push(key);
      await wait(5);
      hydrateMailResources(cache, key, response);
      return response;
    },
    () => now,
  );
  const release = cache.subscribe(path, () => {});
  await cache.load(path);
  calls = [];
  now = 30_002;
  await Promise.all(
    [
      path,
      "/api/mail/mailboxes",
      "/api/mail/preferences",
      "/api/mail/capabilities",
      "/api/mail/mailboxes/b/folders",
      "/api/mail/mailboxes/b/summary",
      view,
    ].map((key) => cache.load(key)),
  );
  assert.deepEqual(calls, [path]);
  release();
});

test("combined Inbox includes custom folders in its query, unread badge and optimistic moves", () => {
  const options = mailViewOptions("inbox", undefined, "");
  assert.equal(options.get("view"), "inbox");
  assert.equal(options.has("folder_id"), false);
  for (const id of ["inbox", "custom-folder"]) assert.equal(isInboxFolder(id), true);
  for (const id of ["sent", "archive", "spam", "trash", "drafts"])
    assert.equal(isInboxFolder(id), false);
  assert.equal(
    inboxUnread({
      inbox: { unread: 2 },
      custom: { unread: 3 },
      archive: { unread: 4 },
      sent: { unread: 5 },
      trash: { unread: 6 },
      spam: { unread: 7 },
      drafts: { unread: 8 },
    }),
    5,
  );
  assert.equal(folderMoveLeavesMailView("inbox", "", "custom-folder"), false);
  assert.equal(folderMoveLeavesMailView("inbox", "", "archive"), true);
  assert.equal(folderMoveLeavesMailView("inbox", "", "trash"), true);
  assert.equal(folderMoveLeavesMailView("folder", "", "other-folder"), true);
  assert.equal(mailViewOptions("folder", "custom-folder", "").get("folder_id"), "custom-folder");
  assert.equal(mailViewOptions("inbox", undefined, "subject:test").get("q"), "subject:test");
});
