import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { MailResourceCache } from "../web/lib/mail-resource-cache.ts";
import { hydrateMailResources, mergeMailView, MailChangeScheduler } from "../web/lib/mail-ui.ts";
import {
  mailViewOptions,
  mailGrouped,
  isInboxFolder,
  inboxUnread,
  folderMoveLeavesMailView,
} from "../src/mail/ui-query.ts";
import { htmlFrame, mailFrameLink } from "../web/lib/mail-helpers.ts";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test("prepared mail displays embedded images without client image messages and still reports its size", () => {
  const nonce = "b".repeat(32),
    handlers = {},
    reports = [];
  let height = 50,
    resized;
  const document = {
    body: { getBoundingClientRect: () => ({ height }) },
    querySelectorAll() {
      assert.fail("The frame must not scan or rewrite image elements");
    },
  };
  const html = htmlFrame('<p>Safe</p><img src="data:image/png;base64,AP8BgA==">', nonce),
    script = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];
  vm.runInNewContext(script, {
    document,
    parent: { postMessage: (message) => reports.push(message) },
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
    ResizeObserver: class {
      constructor(callback) {
        resized = callback;
      }
      observe() {}
    },
    requestAnimationFrame: (fn) => fn(),
  });
  assert.equal(handlers.message, undefined);
  assert.match(html, /src="data:image\/png;base64,AP8BgA=="/);
  assert.equal(reports[0].nonce, nonce);
  assert.equal(reports[0].type, "officeflare:mail-body-height");
  assert.equal(reports[0].height, 90);
  height = 150;
  handlers.load();
  resized();
  assert.deepEqual(
    reports.map((report) => report.height),
    [90, 190, 190],
  );
});

test("trusted link clicks request parent confirmation without navigating the sandbox", () => {
  const nonce = "c".repeat(32),
    handlers = {},
    requests = [],
    source = {};
  const html = htmlFrame('<a href="https://example.com">Go</a>', nonce, "https://office.test"),
    script = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];
  vm.runInNewContext(script, {
    document: { body: { getBoundingClientRect: () => ({ height: 50 }) } },
    parent: { postMessage: (message, origin) => requests.push({ message, origin }) },
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
    ResizeObserver: class {
      observe() {}
    },
    requestAnimationFrame: (fn) => fn(),
  });
  requests.length = 0;
  const anchor = { getAttribute: () => "https://example.com" };
  let prevented = 0,
    stopped = 0;
  const event = {
    type: "click",
    button: 0,
    isTrusted: true,
    target: { nodeType: 1, closest: (selector) => (selector === "a[href]" ? anchor : null) },
    preventDefault() {
      prevented++;
    },
    stopPropagation() {
      stopped++;
    },
  };
  handlers.click(event);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].origin, "https://office.test");
  assert.equal(
    mailFrameLink(requests[0].message, nonce, source, source, "null"),
    "https://example.com/",
  );
  handlers.click({ ...event, isTrusted: false });
  assert.equal(requests.length, 1, "Synthetic clicks cannot request navigation");
  handlers.auxclick({ ...event, type: "auxclick", button: 2 });
  assert.equal(requests.length, 1, "Context menu clicks keep their normal behavior");
  handlers.auxclick({ ...event, type: "auxclick", button: 1 });
  assert.equal(requests.length, 2);
  handlers.click({ ...event, target: { parentElement: event.target } });
  assert.equal(requests.length, 3, "Text and nested link elements remain clickable");
  handlers.click({ ...event, target: { nodeType: 1, closest: () => null } });
  assert.equal(requests.length, 3);
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

test("a read receipt during prepared HTML loading preserves embedded images", async () => {
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
  const rendering = { html: '<img src="data:image/png;base64,AP8=">', assets: [], failures: 0 };
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
