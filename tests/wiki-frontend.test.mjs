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
    const dialog = tab.locator('[role="dialog"]:not([data-ui="toast-root"])');
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
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Meeting archive");
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/rename.png` });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await tab.getByRole("textbox", { name: "Page title", exact: true }).inputValue(),
      "Meeting archive",
    );
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
    const confirmation = tab.getByRole("alertdialog");
    assert.equal(
      (
        await f.db
          .prepare("SELECT trashed_at FROM wiki_pages WHERE id=?")
          .bind(nestedPageId)
          .first()
      ).trashed_at,
      null,
    );
    if (process.env.WIKI_UI_CAPTURE_DIR)
      await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/trash-confirmation.png` });
    await confirmation.getByRole("button", { name: "Move to trash", exact: true }).click();
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
    await tab.locator('[role="dialog"]:not([data-ui="toast-root"])').waitFor({ state: "hidden" });
    await editor.waitFor();
    await tab.locator(".workspace-navigation-drawer").waitFor({ state: "detached" });
    await tab.getByRole("button", { name: "Open navigation", exact: true }).click();
    await tab
      .getByRole("dialog")
      .getByRole("button", { name: "Search this space", exact: true })
      .click();
    await tab
      .locator('[role="dialog"]:not([data-ui="toast-root"])')
      .getByRole("searchbox")
      .fill("How we work");
    await tab
      .locator('[role="dialog"]:not([data-ui="toast-root"])')
      .getByRole("searchbox")
      .press("Enter");
    await tab.locator('[role="dialog"]:not([data-ui="toast-root"])').waitFor({ state: "hidden" });
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

test(
  "Wiki long navigation, photos, comment recovery and shared feedback remain usable",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { collaboration: true, assets: true });
    for (const user of ["alice", "bob"])
      await f.db
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,'system-wiki-user')")
        .bind(user)
        .run();
    const call = async (path, data, method = data ? "POST" : "GET") => {
      const r = await f.mf.dispatchFetch("https://office.test/api" + path, {
        method,
        headers: { Authorization: "Bearer " + f.tokens.alice, "Content-Type": "application/json" },
        body: data ? JSON.stringify(data) : undefined,
      });
      assert.ok(r.ok, await r.clone().text());
      return r.status === 204 ? null : r.json();
    };
    const space = (await call("/wiki/spaces", { name: "UX regression" })).space;
    await call(
      `/wiki/spaces/${space.id}/members`,
      { email: "bob@office.test", role: "editor", version: space.acl_version },
      "PUT",
    );
    const page = (await call(`/wiki/spaces/${space.id}/pages`, {})).page;
    for (let i = 0; i < 48; i++) {
      const id = crypto.randomUUID(),
        resource = crypto.randomUUID();
      await f.db
        .prepare(
          "INSERT INTO collaboration_resources(id,service,resource_id,schema_key) VALUES(?,'wiki',?,'rich-text.v1')",
        )
        .bind(resource, id)
        .run();
      await f.db
        .prepare(
          "INSERT INTO wiki_pages(id,space_id,resource_id,title,sort_order,created_by) VALUES(?,?,?,?,?,?)",
        )
        .bind(id, space.id, resource, `Guide ${i}`, i + 1, "alice")
        .run();
    }
    let parent = page.id;
    for (let i = 0; i < 9; i++) {
      const child = (await call(`/wiki/spaces/${space.id}/pages`, { parent_id: parent })).page;
      await f.db
        .prepare("UPDATE wiki_pages SET title=? WHERE id=?")
        .bind(`Nested ${i}`, child.id)
        .run();
      parent = child.id;
    }
    await f.db.batch(
      Array.from({ length: 205 }, (_, i) =>
        f.db
          .prepare(
            "INSERT INTO wiki_comments(id,page_id,author_user_id,body,created_at) VALUES(?,?,?,?,1000)",
          )
          .bind(`browser-comment-${i}`, page.id, "alice", `Previous comment ${i}`),
      ),
    );
    const sharp = (await import("sharp")).default;
    const image = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#3981b8" },
    })
      .png()
      .toBuffer();
    const key = "profiles/alice/ui.png";
    await (
      await f.mf.getR2Bucket("PROFILE_BUCKET")
    ).put(key, image, { httpMetadata: { contentType: "image/png" } });
    await f.db.prepare("UPDATE users SET profile_image_key=? WHERE id=?").bind(key, "alice").run();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 960 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const tab = await context.newPage();
    tab.setDefaultTimeout(10000);
    const origin = (await f.mf.ready).origin;
    await tab.goto(origin + "/login");
    await tab.locator("input[type=email]").fill("alice@office.test");
    await tab
      .locator("input[type=password]")
      .fill("a long password for calendar integration tests");
    await tab.locator("button[type=submit]").click();
    await tab.waitForURL((u) => u.pathname != "/login");
    const url = `${origin}/wiki/${space.id}/${page.id}`;
    await tab.goto(url);
    await tab.locator(".wiki-save-state.state-saved").waitFor();
    await tab.getByRole("textbox", { name: "Page title", exact: true }).fill("Audit document");
    await tab.locator(".wiki-participants img").waitFor();
    const second = await context.newPage();
    await second.goto(url);
    await second.locator(".wiki-save-state.state-saved").waitFor();
    assert.equal(await tab.locator(".wiki-participants > span").count(), 1);
    await second.close();
    const tree = await tab.locator(".workspace-sidebar .wiki-tree").boundingBox(),
      last = await tab.locator(".workspace-sidebar .wiki-tree-row").last().boundingBox();
    assert.ok(last.y + last.height <= tree.y + tree.height + 1);
    const widths = await tab
      .locator(".workspace-sidebar .wiki-tree-row a > span:nth-child(2)")
      .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().width));
    assert.ok(widths.every((w) => w > 0));
    const capture = async (name) => {
      if (process.env.WIKI_UI_CAPTURE_DIR)
        await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/${name}.png` });
    };
    await capture("deep-audit-navigation");
    await tab.getByRole("button", { name: "Share", exact: true }).click();
    const share = tab.locator(".wiki-share-dialog");
    const shareBox = await share.boundingBox();
    assert.ok(Math.abs(shareBox.x + shareBox.width / 2 - 720) < 1);
    assert.equal(shareBox.width, 610);
    assert.equal(await share.getAttribute("role"), "dialog");
    await share.getByText("Current access: Editor", { exact: true }).waitFor();
    for (const avatar of await share.locator(".wiki-person-avatar").all()) {
      const b = await avatar.boundingBox();
      assert.equal(b.width, b.height);
      assert.equal(b.width, 28);
    }
    const membership = await call(`/wiki/spaces/${space.id}/members`);
    await call(
      `/wiki/spaces/${space.id}/members`,
      { email: "bob@office.test", role: "editor", version: membership.version },
      "PUT",
    );
    await share.getByRole("button", { name: "Save", exact: true }).click();
    await share.getByRole("alert").filter({ hasText: "Current permissions are shown" }).waitFor();
    await share.getByRole("button", { name: "Save", exact: true }).click();
    await share.waitFor({ state: "hidden" });
    await tab.getByRole("button", { name: "Share", exact: true }).click();
    await share.getByText("Current access: Editor", { exact: true }).waitFor();

    await share.getByRole("button", { name: "Copy page link", exact: true }).click();
    await tab.locator(".app-notification").filter({ hasText: "Link copied" }).waitFor();
    await capture("deep-audit-share");
    await tab.keyboard.press("Escape");
    await tab
      .locator(".wiki-page-action-buttons")
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    let panel = tab.getByRole("complementary", { name: "Comments", exact: true });
    await panel.locator(".wiki-comments li").nth(204).waitFor();
    await panel.getByRole("textbox", { name: "Comments", exact: true }).fill("Preserve this draft");
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await tab
      .locator(".wiki-page-action-buttons")
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    panel = tab.getByRole("complementary", { name: "Comments", exact: true });
    assert.equal(
      await panel.getByRole("textbox", { name: "Comments", exact: true }).inputValue(),
      "Preserve this draft",
    );
    const pattern = `**/api/wiki/pages/${page.id}/comments`;
    const failure = async (route) => {
      if (route.request().method() === "POST")
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      else await route.continue();
    };
    await tab.route(pattern, failure);
    await panel.getByRole("button", { name: "Post", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    await tab.waitForResponse(
      async (response) =>
        new URL(response.url()).pathname === `/api/wiki/pages/${page.id}/comments` &&
        response.request().method() === "GET" &&
        (await response.json()).next_cursor === null,
    );
    assert.equal(await panel.getByRole("alert").count(), 1);
    await tab.unroute(pattern, failure);
    await panel.getByRole("button", { name: "Post", exact: true }).click();
    await panel.locator(".wiki-comments p").filter({ hasText: "Preserve this draft" }).waitFor();
    assert.equal(await panel.getByRole("alert").count(), 0);
    assert.equal(
      await panel.getByRole("textbox", { name: "Comments", exact: true }).inputValue(),
      "",
    );
    await panel.locator(".wiki-side-panel-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await capture("deep-audit-comments");
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await tab.keyboard.press("ControlOrMeta+k");
    const search = tab.getByRole("searchbox");
    await search.waitFor();
    await search.press("ArrowDown");
    await search.press("ArrowDown");
    const chosen = await tab.getByRole("option", { selected: true }).getAttribute("id");
    const response = tab.waitForResponse((r) => r.url().includes(`/spaces/${space.id}/pages`));
    await tab.evaluate(() => window.dispatchEvent(new Event("focus")));
    await response;
    await tab.waitForFunction(
      () => document.querySelector(".wiki-search-results")?.getAttribute("aria-busy") === "false",
    );
    assert.equal(await tab.getByRole("option", { selected: true }).getAttribute("id"), chosen);
    await search.fill("Nested 8");
    await tab.getByRole("option", { name: /^Nested 8/ }).waitFor();
    await search.press("Enter");
    await tab.waitForURL((u) => u.pathname.endsWith("/" + parent));
    await tab.setViewportSize({ width: 390, height: 844 });
    await tab.getByRole("button", { name: "Open navigation", exact: true }).click();
    let drawer = tab.locator(".workspace-navigation-drawer");
    await drawer.getByRole("button", { name: "Collapse Audit document", exact: true }).click();
    await tab.getByRole("button", { name: "Close navigation", exact: true }).click();
    await tab.getByRole("button", { name: "Open navigation", exact: true }).click();
    drawer = tab.locator(".workspace-navigation-drawer");
    await drawer.getByRole("button", { name: "Expand Audit document", exact: true }).waitFor();
    await capture("deep-audit-mobile");
    await drawer.getByRole("button", { name: "Search this space", exact: true }).click();
    await tab.getByRole("searchbox").fill("Nested 7");
    await tab.getByRole("option", { name: /^Nested 7/ }).waitFor();
    await tab.getByRole("searchbox").press("Enter");
    await tab.getByRole("button", { name: "Open navigation", exact: true }).click();
    drawer = tab.locator(".workspace-navigation-drawer");
    await drawer.getByRole("button", { name: "Collapse Audit document", exact: true }).waitFor();
    await drawer
      .locator('.wiki-tree a[aria-current="page"]')
      .filter({ hasText: "Nested 7" })
      .waitFor();
  },
);

test(
  "Drive and Wiki common actions use the same dialogs and retain failed changes",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { assets: true, collaboration: true });
    for (const role of ["system-drive-user", "system-wiki-user"])
      await f.db
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('alice',?)")
        .bind(role)
        .run();
    await f.db
      .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('bob','system-wiki-user')")
      .run();
    const call = async (path, body, method = "POST") => {
      const response = await f.mf.dispatchFetch(`https://office.test/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${f.tokens.alice}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const { item } = await call("/drive/folders", { name: "Shared handbook" });
    const { space } = await call("/wiki/spaces", { name: "Shared handbook" });
    await call(
      `/wiki/spaces/${space.id}/members`,
      { email: "bob@office.test", role: "editor", version: space.acl_version },
      "PUT",
    );
    const { page } = await call(`/wiki/spaces/${space.id}/pages`, {});
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
        locale: "en-US",
        viewport: { width: 1440, height: 960 },
      }),
      tab = await context.newPage();
    tab.setDefaultTimeout(15000);
    const origin = (await f.mf.ready).origin;
    await tab.goto(`${origin}/login`);
    await tab.locator('input[type="email"]').fill("alice@office.test");
    await tab
      .locator('input[type="password"]')
      .fill("a long password for calendar integration tests");
    await tab.locator('button[type="submit"]').click();
    await tab.waitForURL((u) => u.pathname !== "/login");
    await tab.goto(`${origin}/drive`);
    await tab.getByRole("button", { name: "Actions for Shared handbook", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Share", exact: true }).click();
    const dialog = tab.locator('[role="dialog"].workspace-dialog');
    await dialog.waitFor();
    const shape = () =>
      dialog.evaluate((el) => {
        const css = getComputedStyle(el),
          title = getComputedStyle(el.querySelector('[data-ui="dialog-title"]'));
        return {
          width: el.getBoundingClientRect().width,
          padding: css.padding,
          radius: css.borderRadius,
          font: title.fontSize,
          weight: title.fontWeight,
        };
      });
    const driveShape = await shape();
    const capture = async (name) => {
      if (process.env.WIKI_UI_CAPTURE_DIR)
        await tab.screenshot({ path: `${process.env.WIKI_UI_CAPTURE_DIR}/${name}.png` });
    };
    await capture("common-drive-share");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await tab.getByRole("button", { name: "Actions for Shared handbook", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Do not save");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(
      (await f.db.prepare("SELECT name FROM drive_items WHERE id=?").bind(item.id).first()).name,
      "Shared handbook",
    );
    await tab.getByRole("button", { name: "Actions for Shared handbook", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed handbook");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await tab.getByRole("button", { name: "Actions for Renamed handbook", exact: true }).click();
    await tab.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
    await tab.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(
      (await f.db.prepare("SELECT trashed_at FROM drive_items WHERE id=?").bind(item.id).first())
        .trashed_at,
      null,
    );
    await tab.goto(`${origin}/wiki/${space.id}/${page.id}`);
    await tab.locator(".wiki-save-state.state-saved").waitFor();
    await tab.getByRole("button", { name: "Share", exact: true }).click();
    await dialog.getByText("Current access: Owner", { exact: true }).waitFor();
    assert.deepEqual(await shape(), driveShape);
    await capture("common-wiki-share");
    let release, started;
    const requestStarted = new Promise((resolve) => (started = resolve));
    const blocked = new Promise((resolve) => (release = resolve));
    t.after(() => release());
    const path = `**/api/wiki/pages/${page.id}/grants`;
    await tab.route(path, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      started();
      await blocked;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await requestStarted;
    assert.equal(
      await dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await dialog.getByRole("button", { name: "Close", exact: true }).isDisabled(),
      true,
    );
    await tab.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    release();
    await dialog.getByRole("alert").waitFor();
    await tab.unroute(path);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await tab.setViewportSize({ width: 390, height: 844 });
    await tab.getByRole("button", { name: "Share", exact: true }).click();
    await dialog.getByText("Current access: Editor", { exact: true }).waitFor();
    assert.ok((await dialog.boundingBox()).width <= 358);
    assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    for (const row of await dialog.locator(".wiki-members li").all()) {
      const photo = await row.locator(".wiki-person-avatar").boundingBox(),
        person = await row.locator(".wiki-share-person").boundingBox();
      assert.ok(Math.abs(photo.y + photo.height / 2 - person.y - person.height / 2) <= 1);
    }
    const close = await tab
      .locator('.app-notification [data-ui="toast-close"]')
      .last()
      .boundingBox();
    assert.ok(close.width >= 44 && close.height >= 44);
    await capture("common-wiki-share-mobile");
  },
);
