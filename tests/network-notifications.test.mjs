import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture } from "./calendar-fixture.mjs";

test(
  "Internet transitions use one app-wide toast without startup or route-change messages",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, { assets: true });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ locale: "en-US" }),
      tab = await context.newPage();
    const origin = (await f.mf.ready).origin;
    await tab.goto(origin + "/login");
    await tab.locator('input[type="email"]').waitFor();
    const disconnected = tab
      .locator(".app-notification")
      .filter({ hasText: "Internet connection lost." });
    const reconnected = tab
      .locator(".app-notification")
      .filter({ hasText: "Internet connection restored." });
    assert.equal(await tab.locator(".app-notification").count(), 0);
    await tab.evaluate(() => window.dispatchEvent(new Event("online")));
    assert.equal(await reconnected.count(), 0);
    await context.setOffline(true);
    await disconnected.waitFor();
    const id = await disconnected.getAttribute("id");
    await tab.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("offline"));
    });
    assert.equal(await disconnected.count(), 1);
    assert.equal(await disconnected.getAttribute("id"), id);
    await context.setOffline(false);
    await reconnected.waitFor();
    await disconnected.waitFor({ state: "hidden" });
    await reconnected.getByRole("button", { name: "Dismiss notification" }).click();
    await reconnected.waitFor({ state: "hidden" });
    await tab.locator('input[type="email"]').fill("alice@office.test");
    await tab
      .locator('input[type="password"]')
      .fill("a long password for calendar integration tests");
    await tab.locator('button[type="submit"]').click();
    await tab.waitForURL((u) => u.pathname !== "/login");
    assert.equal(await tab.locator(".app-notification").count(), 0);
    await context.setOffline(true);
    await disconnected.waitFor();
    await context.setOffline(false);
    await reconnected.waitFor();
    await disconnected.waitFor({ state: "hidden" });
    assert.equal(await reconnected.count(), 1);
  },
);
