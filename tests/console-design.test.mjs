import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { fixture } from "./ai-fixture.mjs";

test(
  "console pages share the reference layouts on direct entry, mobile, and service navigation",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, { assets: true });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1000 },
    });
    t.after(() => context.close());
    const page = await context.newPage(),
      origin = (await f.mf.ready).origin,
      errors = [],
      captureDir = process.env.CONSOLE_UI_CAPTURE_DIR;
    page.on("pageerror", (error) => errors.push(error.message));
    if (captureDir) await mkdir(captureDir, { recursive: true });
    await page.goto(`${origin}/login`);
    await page.locator('input[type="email"]').fill("admin@office.test");
    await page
      .locator('input[type="password"]')
      .fill("a long password for calendar integration tests");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname !== "/login");

    const paths = [
      // These must work before visiting a page that previously loaded console.css.
      "general/workspace",
      "general/regional",
      "general/notifications",
      "calendar/overview",
      "calendar/calendars",
      "calendar/sharing",
      "calendar/invitations",
      "calendar/integrations",
      "calendar/activity",
      "contacts/overview",
      "contacts/accounts",
      "contacts/contacts",
      "contacts/folders",
      "contacts/fields",
      "contacts/activity",
      "wiki/overview",
      "wiki/spaces",
      "wiki/pages",
      "wiki/sharing",
      "wiki/settings",
      "wiki/activity",
      "users",
      "roles",
      "mail/overview",
      "mail/domains",
      "mail/mailboxes",
      "mail/flow",
      "mail/settings",
      "mail/activity",
      "drive/overview",
      "drive/accounts",
      "drive/items",
      "drive/sharing",
      "drive/settings",
      "drive/activity",
      "ai/providers",
      "ai/accounts",
      "ai/gateways",
      "ai/pools",
      "ai/models",
      "ai/deployments",
      "ai/profiles",
      "ai/routes",
      "ai/consumers",
      "ai/mcp-servers",
      "ai/quota-plans",
      "ai/settings",
      "ai/quotas",
      "ai/usage",
      "ai/activity",
      "ai/reconciliation",
    ];
    const tables = new Set([
      "calendar/calendars",
      "calendar/sharing",
      "calendar/invitations",
      "calendar/integrations",
      "calendar/activity",
      "contacts/accounts",
      "contacts/contacts",
      "contacts/folders",
      "contacts/fields",
      "contacts/activity",
      "wiki/spaces",
      "wiki/pages",
      "wiki/sharing",
      "wiki/activity",
      "users",
      "roles",
      "mail/mailboxes",
      "mail/flow",
      "mail/activity",
      "drive/accounts",
      "drive/items",
      "drive/sharing",
      "drive/activity",
      "ai/providers",
      "ai/accounts",
      "ai/gateways",
      "ai/pools",
      "ai/models",
      "ai/deployments",
      "ai/profiles",
      "ai/routes",
      "ai/consumers",
      "ai/mcp-servers",
      "ai/quota-plans",
      "ai/usage",
      "ai/activity",
    ]);
    const measurements = [];
    for (const path of paths) {
      await page.goto(`${origin}/console/${path}`);
      const root = page.locator(".account-page.console-page");
      await root.locator(":scope > .console-page-header h1").waitFor();
      await page.waitForFunction(() => !document.querySelector(".console-page .loading-skeleton"));
      if (tables.has(path)) await root.getByRole("table").waitFor();
      assert.equal(await root.getByRole("heading", { level: 1 }).count(), 1, path);
      assert.equal(await root.locator('[role="alert"]').count(), 0, path);
      measurements.push({
        path,
        ...(await root.evaluate((node) => {
          const heading = node.querySelector("h1"),
            styles = getComputedStyle(node),
            header = getComputedStyle(heading),
            cell = node.querySelector("table th");
          return {
            width: node.getBoundingClientRect().width,
            padding: styles.padding,
            titleSize: header.fontSize,
            titleWeight: header.fontWeight,
            table: cell
              ? {
                  background: getComputedStyle(cell).backgroundColor,
                  padding: getComputedStyle(cell).padding,
                  fontSize: getComputedStyle(cell).fontSize,
                }
              : null,
          };
        })),
      });
      if (captureDir)
        await page.screenshot({
          path: `${captureDir}/${path.replaceAll("/", "-")}-desktop.png`,
          fullPage: true,
        });
      await page.setViewportSize({ width: 390, height: 844 });
      if (captureDir)
        await page.screenshot({
          path: `${captureDir}/${path.replaceAll("/", "-")}-mobile.png`,
          fullPage: true,
        });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${path} must fit mobile`,
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const reference = measurements.find((item) => item.path === "users");
    for (const item of measurements) {
      assert.equal(item.width, reference.width, `${item.path} page width`);
      assert.equal(item.padding, reference.padding, `${item.path} page spacing`);
      assert.equal(item.titleSize, reference.titleSize, `${item.path} title size`);
      assert.equal(item.titleWeight, reference.titleWeight, `${item.path} title weight`);
      if (item.table) assert.deepEqual(item.table, reference.table, `${item.path} table styling`);
    }

    const consolePage = page.locator(".console-page");
    const editor = consolePage.locator(".console-detail-page");
    const panelStyle = () =>
      editor
        .locator(".console-section")
        .first()
        .evaluate((node) => {
          const style = getComputedStyle(node);
          const input = node.querySelector('[data-ui="input"]');
          return {
            width: node.getBoundingClientRect().width,
            padding: style.padding,
            radius: style.borderRadius,
            inputWidth: input.getBoundingClientRect().width,
          };
        });
    await page.goto(`${origin}/console/mail/domains/new`);
    await editor.getByRole("textbox", { name: "Domain", exact: true }).waitFor();
    const mailPanel = await panelStyle();

    await page.goto(`${origin}/console/ai/providers`);
    await consolePage.getByRole("table").waitFor();
    assert.equal(await consolePage.getByRole("tablist").count(), 1);
    await consolePage.getByRole("table").waitFor();
    const search = consolePage.getByRole("searchbox");
    await search.fill("no matching provider account");
    await consolePage.locator(".console-empty").waitFor();
    assert.equal(await consolePage.locator("tbody tr").count(), 0);
    await search.fill("");
    const account = consolePage.getByRole("row").filter({ hasText: "Shared fixture" });
    await account.waitFor();
    await account.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForURL(`**/console/ai/providers/${f.provider.id}`);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await editor.getByRole("textbox", { name: "Name", exact: true }).waitFor();
    assert.equal(await editor.locator('[data-ui="form"].console-form').count(), 1);
    assert.equal(await editor.locator(".console-form > .console-section").count(), 3);
    assert.deepEqual(await panelStyle(), mailPanel);
    if (captureDir)
      await page.screenshot({
        path: `${captureDir}/ai-provider-editor-desktop.png`,
        fullPage: true,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    if (captureDir)
      await page.screenshot({
        path: `${captureDir}/ai-provider-editor-mobile.png`,
        fullPage: true,
      });
    await editor.getByRole("link", { name: "Providers", exact: true }).click();
    await page.waitForURL("**/console/ai/providers");
    await f.db
      .prepare(
        "WITH RECURSIVE events(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM events WHERE n<205) INSERT INTO ai_audit_events(event_key,actor_key,action,target_type) SELECT 'console-layout-'||n,'admin','console-layout.'||n,'settings' FROM events",
      )
      .run();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/console/ai/activity`);
    await consolePage.getByRole("cell", { name: "console-layout.205", exact: true }).waitFor();
    assert.equal(
      await consolePage.getByRole("button", { name: "Previous", exact: true }).isDisabled(),
      true,
    );
    await consolePage.getByRole("button", { name: "Next", exact: true }).click();
    await consolePage.getByRole("cell", { name: "console-layout.105", exact: true }).waitFor();
    await consolePage.getByRole("button", { name: "Previous", exact: true }).click();
    await consolePage.getByRole("cell", { name: "console-layout.205", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  },
);
