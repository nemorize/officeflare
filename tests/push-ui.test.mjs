import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";

const bundle = await build({
  stdin: {
    contents: `import { createRoot } from 'react-dom/client'; import { createElement } from 'react';
    import { PushNotificationProvider } from './web/components/push-notifications';
    import { PushNotificationSettings } from './web/components/push-settings';
    import { setLocaleResolver } from './shared/i18n/index.ts';
    setLocaleResolver(() => 'en');
    createRoot(document.getElementById('root')).render(createElement(PushNotificationProvider, null, createElement(PushNotificationSettings)));`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "push-browser-fixture",
      setup(builder) {
        builder.onLoad({ filter: /web\/components\/account-context\.tsx$/ }, () => ({
          contents: `export const useAccount = () => ({ user: { id: 'alice', email_address: 'alice@office.test' } });`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /web\/lib\/session\.ts$/ }, () => ({
          contents: `export const sessions = { getSnapshot: () => ({ session: { tokens: { session_id: window.fixture.sessionId }, email: 'alice@office.test' } }) }; export const useSession = () => sessions.getSnapshot();`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /web\/lib\/api\.ts$/ }, () => ({
          contents: `export class ApiError extends Error {} export const errorMessage = (e) => e.message; export async function api(path, options) { window.fixture.requests.push({ path, ...options }); if (path === '/api/push/config') return { available: window.fixture.available }; return {}; }`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /web\/lib\/push-browser\.ts$/ }, () => ({
          contents: `export const pushSupported = () => window.fixture.supported; export const pushChoiceKey = (id) => 'officeflare.push.choice.' + id; export const pushDeviceId = () => 'device_1234567890'; export const browserPushToken = async () => { window.fixture.tokenRequests++; if (window.fixture.holdToken) await new Promise((resolve) => window.fixture.releaseToken = resolve); return 'test-token'; }; export const bindPushWorker = async (binding) => { window.fixture.bindings.push(binding); };`,
          loader: "ts",
        }));
      },
    },
  ],
});
const script = bundle.outputFiles[0].text;

test("web push browser consent, preferences, and account switching", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function pageFixture(options = {}) {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await page.route("http://office.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>',
      }),
    );
    await page.goto("http://office.test");
    await page.addStyleTag({ content: await readFile("web/components/ui/components.css", "utf8") });
    await page.evaluate((options) => {
      window.fixture = {
        sessionId: "alice-session",
        available: true,
        supported: true,
        permission: "default",
        result: "granted",
        tokenRequests: 0,
        permissionRequests: 0,
        requests: [],
        bindings: [],
        ...options,
      };
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: {
          get permission() {
            return window.fixture.permission;
          },
          requestPermission: async () => {
            window.fixture.permissionRequests++;
            window.fixture.permission = window.fixture.result;
            return window.fixture.result;
          },
        },
      });
      if (options.choice) localStorage.setItem("officeflare.push.choice.alice", options.choice);
    }, options);
    await page.addScriptTag({ content: script });
    return page;
  }
  await t.test(
    "first visit asks once and Later keeps reconnection available in preferences",
    async () => {
      const page = await pageFixture();
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.evaluate(() => window.fixture.permissionRequests), 0);
      await page.getByRole("button", { name: "Later", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(() => localStorage.getItem("officeflare.push.choice.alice")),
        "dismissed",
      );
      await page.getByRole("button", { name: "Enable web push", exact: true }).click();
      await page.getByText("Web push is connected on this browser.", { exact: true }).waitFor();
      const state = await page.evaluate(() => window.fixture);
      assert.equal(state.permissionRequests, 1);
      const registration = state.requests.find((request) => request.method === "PUT");
      assert.equal(registration.body.token_type, "fcm_web");
      assert.equal(registration.body.session_id, "alice-session");
      await page.getByRole("button", { name: "Disable on this browser", exact: true }).click();
      await page.getByText("Web push is not connected on this browser.", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => localStorage.getItem("officeflare.push.choice.alice")),
        "disabled",
      );
      assert.ok(
        await page.evaluate(() =>
          window.fixture.requests.some((request) => request.method === "DELETE"),
        ),
      );
    },
  );
  await t.test(
    "disabled integration and unsupported browsers never ask for permission",
    async () => {
      for (const options of [{ available: false }, { supported: false }]) {
        const page = await pageFixture(options);
        await page
          .getByText(
            options.available === false
              ? "Web push is currently unavailable."
              : "This browser does not support web push. Use a supported browser over HTTPS.",
            { exact: true },
          )
          .waitFor();
        assert.equal(await page.getByRole("dialog").count(), 0);
        assert.equal(await page.evaluate(() => window.fixture.permissionRequests), 0);
        assert.equal(
          await page.getByRole("button", { name: "Enable web push", exact: true }).count(),
          0,
        );
      }
    },
  );
  await t.test(
    "previous browser permission alone does not opt a user in; denial shows recovery guidance",
    async () => {
      const granted = await pageFixture({ permission: "granted" });
      await granted.getByRole("dialog").waitFor();
      assert.equal(await granted.evaluate(() => window.fixture.tokenRequests), 0);
      const denied = await pageFixture({ permission: "denied" });
      await denied
        .getByText(
          "Notifications are blocked. Allow notifications in your browser settings, then try again.",
          { exact: true },
        )
        .waitFor();
      assert.equal(await denied.getByRole("dialog").count(), 0);
      assert.equal(
        await denied.getByRole("button", { name: "Enable web push", exact: true }).isDisabled(),
        true,
      );
    },
  );
  await t.test(
    "connected browsers renew tokens without prompting and account changes cancel pending registration",
    async () => {
      const connected = await pageFixture({ choice: "enabled", permission: "granted" });
      await connected
        .getByText("Web push is connected on this browser.", { exact: true })
        .waitFor();
      assert.equal(await connected.evaluate(() => window.fixture.permissionRequests), 0);
      assert.equal(await connected.evaluate(() => window.fixture.tokenRequests), 1);
      const switching = await pageFixture({ holdToken: true });
      await switching.getByRole("dialog").waitFor();
      await switching
        .getByRole("dialog")
        .getByRole("button", { name: "Enable web push", exact: true })
        .click();
      await switching.waitForFunction(() => typeof window.fixture.releaseToken === "function");
      await switching.evaluate(() => {
        window.fixture.sessionId = "bob-session";
        window.fixture.releaseToken();
      });
      await switching.waitForFunction(
        () => document.querySelectorAll("button[disabled]").length === 0,
      );
      assert.equal(
        await switching.evaluate(
          () => window.fixture.requests.filter((request) => request.method === "PUT").length,
        ),
        0,
      );
      assert.equal(
        await switching.evaluate(() => localStorage.getItem("officeflare.push.choice.alice")),
        null,
      );
    },
  );
});

test("push service worker filters account/session, shows data messages, and constrains click targets", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://office.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto("http://office.test");
  const source = await readFile("public/push-sw.js", "utf8");
  await page.evaluate(() => {
    window.handlers = {};
    window.shown = [];
    window.navigated = [];
    window.fakeSelf = {
      location: { origin: location.origin },
      addEventListener: (name, action) => {
        window.handlers[name] = action;
      },
      registration: {
        getNotifications: async () => [],
        showNotification: async (title, options) => window.shown.push({ title, ...options }),
      },
      clients: {
        matchAll: async () => [],
        openWindow: async (path) => window.navigated.push(path),
        claim: async () => {},
      },
      skipWaiting: async () => {},
    };
    window.dispatchWorker = async (kind, event) => {
      let task;
      window.handlers[kind]({ ...event, waitUntil: (promise) => (task = promise) });
      await task;
    };
  });
  await page.evaluate((source) => {
    new Function("self", source)(window.fakeSelf);
  }, source);
  await page.evaluate(async () => {
    await window.dispatchWorker("message", {
      source: { url: location.href },
      data: { kind: "officeflare.push.bind", binding: { userId: "alice", sessionId: "session-a" } },
      ports: [],
    });
    const payload = {
      title: "Hello",
      body: "Body",
      notification_id: "event-1",
      user_id: "alice",
      session_id: "session-a",
      target_path: "https://evil.test/",
    };
    await window.dispatchWorker("push", {
      data: { json: () => ({ data: { ...payload, user_id: "bob" } }) },
    });
    await window.dispatchWorker("push", {
      data: { json: () => ({ data: { ...payload, session_id: "old-session" } }) },
    });
    await window.dispatchWorker("push", { data: { json: () => ({ data: payload }) } });
    await window.dispatchWorker("notificationclick", {
      notification: { data: window.shown[0].data, close() {} },
    });
    await window.dispatchWorker("message", {
      source: { url: location.href },
      data: { kind: "officeflare.push.bind", binding: null },
      ports: [],
    });
    await window.dispatchWorker("push", { data: { json: () => ({ data: payload }) } });
  });
  const state = await page.evaluate(() => ({ shown: window.shown, navigated: window.navigated }));
  assert.equal(state.shown.length, 1);
  assert.equal(state.shown[0].tag, "officeflare-event-1");
  assert.deepEqual(state.navigated, ["/notifications"]);
});
