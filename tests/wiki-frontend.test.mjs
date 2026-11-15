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
    const checkControlSizes = async (controls) => {
      await controls.first().waitFor();
      const baseline = await tab.locator(".wiki-topbar > [data-ui-button]").boundingBox();
      for (const control of await controls.all()) {
        const box = await control.boundingBox();
        assert.ok(box && box.height >= baseline.height, await control.getAttribute("aria-label"));
      }
    };
    const checkPanelPosition = async () => {
      const header = await tab.locator(".wiki-topbar").boundingBox(),
        panel = await tab.locator(".wiki-side-panel").boundingBox();
      assert.ok(Math.abs(panel.y - (header.y + header.height)) <= 1);
    };
    tab.setDefaultTimeout(15000);
    tab.on("pageerror", (error) => errors.push(error.message));
    tab.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
        errors.push(message.text());
    });
    await tab.goto(`${origin}/login`);
    await tab.locator('input[type="email"]').fill("alice@office.test");
    await tab
      .locator('input[type="password"]')
      .fill("a long password for calendar integration tests");
    await tab.locator('button[type="submit"]').click();
    await tab.waitForURL((url) => url.pathname !== "/login");
    await tab.goto(`${origin}/wiki`);
    await tab.getByRole("heading", { name: "Personal space", exact: true }).waitFor();
    const personalHome = tab.url();
    await tab.locator(".wiki-home").getByRole("button", { name: "New page", exact: true }).click();
    await tab.getByRole("textbox", { name: "Page title", exact: true }).fill("Private notes");
    await tab.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    await tab.getByRole("button", { name: "Switch space" }).click();
    await tab.getByRole("menuitem", { name: "New space", exact: true }).click();
    const dialog = tab.getByRole("dialog");
    const choose = async (control, label) => {
      await control.click();
      await tab.getByRole("option", { name: label, exact: true }).click();
    };
    assert.equal(await dialog.getByRole("radio").count(), 0);
    await dialog.getByLabel("Space name").fill("Product handbook");
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("Our shared decisions, working agreements, and project notes.");
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/space-dialog.png` });
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await tab.waitForURL(
      (url) => url.href !== personalHome && /^\/wiki\/[^/]+$/.test(url.pathname),
    );
    const home = tab.url();
    await tab
      .locator(".wiki-home")
      .getByRole("button", { name: "New page", exact: true })
      .first()
      .click();
    await tab.locator('.collaborative-prose[contenteditable="true"]').waitFor();
    const documentUrl = tab.url();
    await tab.getByRole("textbox", { name: "Page title", exact: true }).fill("How we work");
    await tab.getByRole("textbox", { name: "Page title", exact: true }).press("Enter");
    await tab.waitForFunction(() =>
      document.activeElement?.classList.contains("collaborative-prose"),
    );
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
    await editor.locator("h1").hover();
    await tab.getByRole("button", { name: "Block actions", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Duplicate block", exact: true }).waitFor();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/block-actions.png` });
    await tab.getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
    assert.equal(await editor.locator("h1").count(), 2);
    await editor.locator("h1").last().hover();
    await tab.getByRole("button", { name: "Block actions", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Move block down", exact: true }).click();
    assert.deepEqual(
      (
        await editor.locator(":scope > *").evaluateAll((nodes) => nodes.map((el) => el.tagName))
      ).slice(0, 3),
      ["H1", "P", "H1"],
    );
    await editor.locator("h1").last().hover();
    await tab.getByRole("button", { name: "Block actions", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Delete block", exact: true }).click();
    assert.equal(await editor.locator("h1").count(), 1);
    await editor
      .getByText("Write decisions down. Make room for questions. Keep learning together.", {
        exact: true,
      })
      .click({ clickCount: 3 });
    const formatting = tab.getByRole("toolbar", { name: "Page content", exact: true });
    await formatting.getByRole("button", { name: "Bold", exact: true }).waitFor();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/formatting.png` });
    await formatting.getByRole("button", { name: "Bold", exact: true }).click();
    await editor
      .locator("p > strong")
      .getByText("Write decisions down.", { exact: false })
      .waitFor();
    await editor.press("ArrowRight");
    await editor.locator("h1").hover();
    await tab
      .getByRole("button", { name: "Block actions", exact: true })
      .dragTo(editor.locator("p").last());
    assert.notEqual(
      await editor
        .locator(":scope > *")
        .first()
        .evaluate((el) => el.tagName),
      "H1",
    );
    for (
      let attempt = 0;
      attempt < 4 &&
      (await editor
        .locator(":scope > *")
        .first()
        .evaluate((el) => el.tagName)) !== "H1";
      attempt++
    ) {
      await editor.locator("h1").hover();
      await tab.getByRole("button", { name: "Block actions", exact: true }).click();
      await tab.getByRole("menuitem", { name: "Move block up", exact: true }).click();
    }
    assert.equal(
      await editor
        .locator(":scope > *")
        .first()
        .evaluate((el) => el.tagName),
      "H1",
    );

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
    assert.equal(
      await tab
        .locator('.wiki-favorites a[aria-current="page"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      await tab
        .locator('.wiki-tree-row:has(> a[aria-current="page"])')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    await checkControlSizes(tab.locator(".wiki-page-action-buttons > [data-ui-button]"));
    const [chooser] = await Promise.all([
      tab.waitForEvent("filechooser"),
      tab.getByRole("button", { name: "Attach file", exact: true }).press("Enter"),
    ]);
    await chooser.setFiles({
      name: "guidelines.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Team editing guidelines"),
    });
    await tab
      .locator(".wiki-assets")
      .getByRole("button", { name: /guidelines.txt/ })
      .waitFor();
    await tab.getByRole("button", { name: "Share", exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).waitFor();
    await tab.waitForFunction(
      () => !document.querySelector('.wiki-share-footer button[data-variant="primary"]')?.disabled,
    );
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/share.png` });
    await choose(dialog.getByRole("combobox", { name: "Share", exact: true }), "Restricted");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await tab.locator(".wiki-page-meta").getByText("Restricted", { exact: true }).waitFor();
    await tab
      .locator(".wiki-page-action-buttons")
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    const comments = tab.getByRole("complementary", { name: "Comments" });
    await comments
      .getByRole("textbox", { name: "Comments", exact: true })
      .fill("Keep this decision with the page.");
    await comments.getByRole("button", { name: "Post", exact: true }).click();
    await comments.getByText("Keep this decision with the page.", { exact: true }).waitFor();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/comments.png` });
    await comments.getByRole("button", { name: "Close", exact: true }).click();

    assert.equal(await tab.locator(".wiki-breadcrumb-current").textContent(), "How we work");
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({
        path: `${process.env.WIKI_UI_CAPTURE_DIR}/document.png`,
        fullPage: true,
      });
    await tab.locator(".wiki-quick-nav").getByRole("link", { name: "Overview" }).click();
    await tab.locator(".wiki-page-table").getByText("How we work", { exact: true }).waitFor();
    await tab.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("searchbox").fill("How we work");
    await dialog.getByRole("option", { name: /^How we work/ }).waitFor();
    const searchBox = await dialog.boundingBox();
    assert.ok(Math.abs(searchBox.x + searchBox.width / 2 - tab.viewportSize().width / 2) <= 1);
    assert.equal(
      await tab.locator(".wiki-search-input").evaluate((el) => {
        const style = getComputedStyle(el);
        return (
          style.borderTopStyle !== "none" &&
          parseFloat(style.borderTopWidth) > 0 &&
          style.borderTopColor !== "rgba(0, 0, 0, 0)"
        );
      }),
      true,
    );
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/search.png` });
    await dialog.getByRole("searchbox").press("Enter");
    await tab.waitForURL(documentUrl);
    await editor.waitFor();
    await tab.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("searchbox").fill("unmatched-search");
    await dialog.getByText("No matching pages", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Clear search", exact: true }).click();
    await dialog.getByRole("option", { name: /^How we work/ }).waitFor();
    await tab.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await tab.locator(".wiki-quick-nav").getByRole("link", { name: "Overview" }).click();
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
    await tab
      .locator(".wiki-page-action-buttons")
      .getByRole("button", { name: "Page actions" })
      .click();
    await tab.getByRole("menuitem", { name: "Version history" }).click();
    const history = tab.getByRole("complementary", { name: "Version history" });
    await history.getByRole("button", { name: "Save a version" }).click();
    await tab.waitForFunction(() => {
      const button = document.querySelector(".wiki-checkpoint");
      return button && !button.disabled;
    });
    await history.locator(".wiki-revision-choice").first().click();
    await tab
      .getByRole("region", { name: "Version preview" })
      .getByRole("heading", { name: "How we work", exact: true })
      .waitFor();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/history.png` });
    await history.getByRole("button", { name: "Restore", exact: true }).first().click();
    await tab
      .getByRole("alertdialog")
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await tab.getByRole("alertdialog").waitFor({ state: "hidden" });
    await history.waitFor({ state: "hidden" });
    await tab.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    await editor.locator("h1").getByText("Working together", { exact: true }).waitFor();
    await tab
      .locator(".wiki-page-action-buttons")
      .getByRole("button", { name: "Page actions" })
      .click();
    await tab.getByRole("menuitem", { name: "Add a subpage" }).click();
    await tab.waitForURL(
      (url) => url.href !== documentUrl && /\/wiki\/[^/]+\/[^/]+$/.test(url.pathname),
    );
    await tab.getByRole("textbox", { name: "Page title", exact: true }).fill("Meeting notes");
    await tab.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    const nestedPageId = new URL(tab.url()).pathname.split("/").at(-1);
    const nestedRow = tab
      .locator(".wiki-tree-row")
      .filter({ has: tab.getByRole("link", { name: "Meeting notes", exact: true }) });
    await nestedRow.hover();
    await nestedRow.getByRole("button", { name: "Page actions", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await tab.waitForFunction(() => document.activeElement?.classList.contains("wiki-title"));
    await tab.getByRole("textbox", { name: "Page title", exact: true }).fill("Meeting archive");
    await tab.getByRole("textbox", { name: "Page title", exact: true }).press("Enter");
    await tab.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    const renamedRow = tab
      .locator(".wiki-tree-row")
      .filter({ has: tab.getByRole("link", { name: "Meeting archive", exact: true }) });
    await renamedRow.hover();
    await renamedRow.getByRole("button", { name: "Page actions", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Move page", exact: true }).click();
    await dialog.getByRole("option", { name: /Team handbook/ }).click();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/move.png` });
    await dialog.getByRole("button", { name: "Move page", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      (await f.db.prepare("SELECT parent_id FROM wiki_pages WHERE id=?").bind(nestedPageId).first())
        .parent_id,
      null,
    );
    await tab
      .locator(".wiki-page-action-buttons")
      .getByRole("button", { name: "Page actions" })
      .click();
    await tab.getByRole("menuitem", { name: "Move to trash" }).click();
    await tab.waitForURL(home);
    await tab
      .locator(".wiki-sidebar-footer")
      .getByRole("link", { name: "Trash", exact: true })
      .click();
    await tab.getByRole("button", { name: "Restore", exact: true }).click();
    await tab.getByRole("heading", { name: "No pages in trash" }).waitFor();
    await tab.getByRole("button", { name: "Switch space" }).click();
    await tab.getByRole("menuitem", { name: "Personal space", exact: true }).click();
    await tab.waitForURL(personalHome);
    await tab
      .locator(".wiki-page-table")
      .getByRole("link", { name: "Private notes", exact: true })
      .waitFor();
    await tab.getByRole("button", { name: "Space settings", exact: true }).click();
    await dialog.getByLabel("Space name").fill("My notes");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
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
    await tab.getByRole("button", { name: "Search this space", exact: true }).click();
    await dialog.getByRole("searchbox").fill("How we work");
    await dialog.getByRole("option", { name: /^How we work/ }).waitFor();
    await dialog.getByRole("searchbox").press("Enter");
    await editor.waitFor();
    await tab.getByRole("button", { name: "Open navigation", exact: true }).click();
    await checkControlSizes(
      tab.locator(".workspace-navigation-drawer .wiki-tree-row [data-ui-button]"),
    );
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/mobile-navigation.png` });
    await tab
      .getByRole("dialog")
      .locator(".wiki-tree")
      .getByRole("link", { name: "How we work", exact: true })
      .click();
    await tab.getByRole("dialog").waitFor({ state: "hidden" });
    await editor.waitFor();
    await tab.locator(".workspace-navigation-drawer").waitFor({ state: "detached" });
    await tab.getByRole("button", { name: "Open navigation", exact: true }).click();
    await tab
      .getByRole("dialog")
      .getByRole("button", { name: "Search this space", exact: true })
      .click();
    await tab.getByRole("dialog").getByRole("searchbox").fill("How we work");
    await tab.getByRole("dialog").getByRole("searchbox").press("Enter");
    await tab.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await checkControlSizes(tab.locator(".wiki-page-action-buttons > [data-ui-button]"));
    await editor.click();
    await tab.locator(".wiki-mobile-formatting").waitFor();
    await checkControlSizes(tab.locator(".wiki-mobile-formatting [data-ui-button]"));
    await checkControlSizes(tab.locator(".wiki-section-heading [data-ui-button]"));
    assert.equal(
      await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/mobile-editing.png` });
    const cdp = await context.newCDPSession(tab);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 24, bottom: 34, left: 0, right: 0 },
    });
    await tab
      .locator(".wiki-page-action-buttons")
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    await tab.getByRole("complementary", { name: "Comments" }).waitFor();
    await checkPanelPosition();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({
        path: `${process.env.WIKI_UI_CAPTURE_DIR}/mobile-comments-safe-area.png`,
      });
    await tab
      .getByRole("complementary", { name: "Comments" })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await tab
      .locator(".wiki-page-action-buttons")
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await tab.getByRole("menuitem", { name: "Version history", exact: true }).click();
    await history.locator(".wiki-revision-choice").first().click();
    await history.getByRole("region", { name: "Version preview", exact: true }).waitFor();
    await checkPanelPosition();
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/mobile-history.png` });
    await history.getByRole("button", { name: "Version history", exact: true }).click();
    await history
      .getByRole("region", { name: "Version preview", exact: true })
      .waitFor({ state: "hidden" });
    await history.getByRole("button", { name: "Close", exact: true }).click();
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    await cdp.detach();
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
