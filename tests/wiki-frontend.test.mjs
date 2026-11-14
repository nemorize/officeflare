import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture } from "./calendar-fixture.mjs";

test(
  "Wiki frontend creates spaces, inserts blocks, manages pages and works on mobile",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { collaboration: true, assets: true });
    for (const user of ["alice", "bob"])
      await f.db
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,'system-wiki-user')")
        .bind(user)
        .run();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1050 },
    });
    t.after(() => context.close());
    const tab = await context.newPage(),
      origin = (await f.mf.ready).origin,
      errors = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(`${origin}/login`);
    await tab.locator('input[type="email"]').fill("alice@office.test");
    await tab
      .locator('input[type="password"]')
      .fill("a long password for calendar integration tests");
    await tab.locator('button[type="submit"]').click();
    await tab.waitForURL((url) => url.pathname !== "/login");
    await tab.goto(`${origin}/wiki`);
    await tab.locator(".wiki-home").getByRole("button", { name: "New space" }).click();
    const dialog = tab.getByRole("dialog");
    const choose = async (control, label) => {
      await control.click();
      await tab.getByRole("option", { name: label, exact: true }).click();
    };
    await dialog.getByLabel("Space name").fill("Product handbook");
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("Our shared decisions, working agreements, and project notes.");
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/space-dialog.png` });
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await tab.waitForURL(/\/wiki\/[^/]+$/);
    const home = tab.url();
    await tab
      .locator(".wiki-home")
      .getByRole("button", { name: "New page", exact: true })
      .first()
      .click();
    await tab.locator('.collaborative-prose[contenteditable="true"]').waitFor();
    const documentUrl = tab.url();
    await tab.getByRole("textbox", { name: "Page title", exact: true }).fill("How we work");
    const editor = tab.locator(".collaborative-prose");
    await editor.pressSequentially("/h1");
    await tab.getByRole("listbox", { name: "Insert a block" }).waitFor();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/block-menu.png` });
    await editor.press("Enter");
    await tab.keyboard.insertText("Working together");
    assert.equal(await editor.locator("h1").textContent(), "Working together");
    await editor.press("Enter");
    await tab.keyboard.insertText(
      "Write decisions down. Make room for questions. Keep learning together.",
    );
    await editor.press("Enter");
    await tab.keyboard.insertText("/table");
    await tab.getByRole("option", { name: /^Table/ }).click();
    assert.equal(await editor.locator("table").count(), 1);
    await tab.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    await tab.getByRole("button", { name: "Change page icon" }).click();
    await tab.getByRole("button", { name: "📚", exact: true }).click();
    await tab.waitForFunction(
      () => document.querySelector(".wiki-page-icon")?.textContent === "📚",
    );
    await tab.getByRole("button", { name: "Add to favorites", exact: true }).click();
    await tab.getByRole("button", { name: "Remove from favorites", exact: true }).waitFor();
    await tab.getByRole("button", { name: "Share", exact: true }).click();
    await choose(dialog.getByRole("combobox", { name: "Share", exact: true }), "Restricted");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await tab.locator(".wiki-page-meta").getByText("Restricted", { exact: true }).waitFor();
    assert.equal(await tab.locator(".wiki-breadcrumb-current").textContent(), "How we work");
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({
        path: `${process.env.WIKI_UI_CAPTURE_DIR}/document.png`,
        fullPage: true,
      });
    await tab.locator(".wiki-quick-nav").getByRole("link", { name: "Overview" }).click();
    await tab.locator(".wiki-page-table").getByText("How we work", { exact: true }).waitFor();
    await tab.keyboard.press("ControlOrMeta+k");
    assert.equal(
      await tab.getByRole("searchbox").evaluate((input) => input === document.activeElement),
      true,
    );
    await tab.getByRole("searchbox").fill("How we work");
    await tab.getByRole("searchbox").press("Enter");
    await tab
      .locator(".wiki-settings")
      .getByRole("link", { name: "How we work", exact: true })
      .waitFor();
    await tab.getByRole("searchbox").fill("unmatched-search");
    await tab.getByRole("searchbox").press("Enter");
    await tab.getByText("No matching pages", { exact: true }).waitFor();
    await tab.getByRole("button", { name: "Clear search", exact: true }).click();
    await tab.locator(".wiki-home").waitFor();
    await tab.getByRole("button", { name: "Toggle wiki navigation", exact: true }).click();
    assert.equal(await tab.locator(".workspace-sidebar").isVisible(), false);
    await tab.getByRole("button", { name: "Toggle wiki navigation", exact: true }).click();
    await tab.locator(".workspace-sidebar").waitFor();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({
        path: `${process.env.WIKI_UI_CAPTURE_DIR}/overview.png`,
        fullPage: true,
      });
    await tab.locator(".wiki-quick-nav").getByRole("link", { name: "Favorites" }).click();
    await tab
      .locator(".wiki-settings")
      .getByRole("link", { name: "How we work", exact: true })
      .waitFor();
    await tab.locator(".wiki-quick-nav").getByRole("link", { name: "Overview" }).click();
    await tab.getByRole("button", { name: "Space settings", exact: true }).click();
    await dialog.getByLabel("Space name").fill("Team handbook");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await tab.getByRole("heading", { name: "Team handbook", exact: true }).waitFor();
    await tab
      .locator(".wiki-sidebar-footer")
      .getByRole("link", { name: "Members", exact: true })
      .click();
    await tab.getByRole("textbox", { name: "Email address", exact: true }).fill("bob@office.test");
    await choose(tab.getByRole("combobox", { name: "Role", exact: true }), "Editor");
    await tab.getByRole("button", { name: "Add member", exact: true }).click();
    await tab.getByRole("combobox", { name: "bob@office.test Role", exact: true }).waitFor();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/members.png` });
    await Promise.all([
      tab.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith("/members") &&
          response.ok(),
      ),
      choose(tab.getByRole("combobox", { name: "bob@office.test Role", exact: true }), "Viewer"),
    ]);
    await tab.goto(documentUrl);
    await editor.waitFor();
    await tab.getByRole("button", { name: "Page actions" }).click();
    await tab.getByRole("menuitem", { name: "Version history" }).click();
    await dialog.getByRole("button", { name: "Save a version" }).click();
    await dialog.getByRole("button", { name: "Restore", exact: true }).first().click();
    await tab
      .getByRole("alertdialog")
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await tab.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    await editor.locator("h1").getByText("Working together", { exact: true }).waitFor();
    await tab.getByRole("button", { name: "Page actions" }).click();
    await tab.getByRole("menuitem", { name: "Add a subpage" }).click();
    await tab.waitForURL(
      (url) => url.href !== documentUrl && /\/wiki\/[^/]+\/[^/]+$/.test(url.pathname),
    );
    await tab.getByRole("textbox", { name: "Page title", exact: true }).fill("Meeting notes");
    await tab.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    await tab.getByRole("button", { name: "Page actions" }).click();
    await tab.getByRole("menuitem", { name: "Move to trash" }).click();
    await tab.waitForURL(home);
    await tab
      .locator(".wiki-sidebar-footer")
      .getByRole("link", { name: "Trash", exact: true })
      .click();
    await tab.getByRole("button", { name: "Restore", exact: true }).click();
    await tab.getByRole("heading", { name: "No pages in trash" }).waitFor();
    await tab.getByRole("button", { name: "Switch space" }).click();
    await tab.getByRole("menuitem", { name: "New space", exact: true }).click();
    await dialog.getByLabel("Space name").fill("My notes");
    await dialog.getByRole("radio", { name: /Personal space/ }).check();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await tab.getByRole("heading", { name: "My notes", exact: true }).waitFor();
    await tab.getByRole("button", { name: "Switch space" }).click();
    await tab.getByRole("menuitem", { name: "Team handbook", exact: true }).click();
    await tab.getByRole("heading", { name: "Team handbook", exact: true }).waitFor();
    await tab.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({
        path: `${process.env.WIKI_UI_CAPTURE_DIR}/mobile.png`,
        fullPage: true,
      });
    await tab.getByRole("searchbox").fill("How we work");
    await tab.getByRole("searchbox").press("Enter");
    await tab
      .locator(".wiki-settings")
      .getByRole("link", { name: "How we work", exact: true })
      .waitFor();
    await tab.getByRole("button", { name: "Clear search", exact: true }).click();
    await tab.locator(".wiki-home").waitFor();
    await tab.getByRole("button", { name: "Open navigation", exact: true }).click();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/mobile-navigation.png` });
    await tab.getByRole("dialog").getByRole("link", { name: "How we work", exact: true }).click();
    await tab.getByRole("dialog").waitFor({ state: "hidden" });
    await editor.waitFor();
    assert.equal(
      await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    if (process.env.WIKI_UI_CAPTURE_DIR) {
      await tab.screenshot({
        path: `${process.env.WIKI_UI_CAPTURE_DIR}/mobile-document.png`,
        fullPage: true,
      });
      await tab.emulateMedia({ colorScheme: "dark" });
      await tab.waitForFunction(() => document.documentElement.dataset.colorScheme === "dark");
      await tab.setViewportSize({ width: 1440, height: 1050 });
      await tab.screenshot({
        path: `${process.env.WIKI_UI_CAPTURE_DIR}/dark-document.png`,
        fullPage: true,
        animations: "disabled",
        style: "* { transition: none !important; }",
      });
    }
    assert.deepEqual(errors, []);
  },
);
