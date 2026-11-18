import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture } from "./ai-fixture.mjs";

async function browserFixture(t, options = {}, actor = "alice") {
  const f = await fixture(t, { assets: true, ...options });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 1024 },
  });
  t.after(() => context.close());
  const page = await context.newPage(),
    errors = [],
    origin = (await f.mf.ready).origin;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/login");
  await page.locator("input[type=email]").fill(actor + "@office.test");
  await page.locator("input[type=password]").fill("a long password for calendar integration tests");
  await page.locator("button[type=submit]").click();
  await page.waitForURL((url) => url.pathname !== "/login");
  return { ...f, browser, context, page, origin, errors };
}
async function choose(page, label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function mutation(page, suffix, action) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith(suffix) && response.request().method() !== "GET",
    ),
    action(),
  ]);
  assert.ok(response.ok(), `${response.status()} ${await response.text()}`);
  return response.json().catch(() => null);
}
const lastRun = async (f, roomId) =>
  f.db
    .prepare("SELECT id,status FROM ai_runs WHERE room_id=? ORDER BY rowid DESC LIMIT 1")
    .bind(roomId)
    .first();

test(
  "AI uses workspace chrome with searchable history, composer model switching and mobile navigation",
  { timeout: 90000 },
  async (t) => {
    const f = await browserFixture(t),
      { page, origin } = f;
    const second = await f.create("profiles", {
      key: "fixture-focused",
      name: "Focused chat",
      enabled: true,
    });
    await f.create("routes", {
      profile_id: second.id,
      provider_id: f.provider.id,
      deployment_id: f.deployment.id,
      pool_id: f.pool.id,
      priority: 0,
      enabled: true,
    });
    const consumer = (await f.admin("/consumers")).items.find((item) => item.key === "hub.chat");
    await f.admin("/consumers/hub.chat/profiles", {
      method: "PUT",
      data: {
        version: consumer.version,
        profiles: [{ profile_id: f.profile.id, is_default: true }, { profile_id: second.id }],
      },
    });
    await page.goto(origin + "/contacts");
    await page.locator(".contacts-search").waitFor();
    const chromeStyle = () =>
      page.evaluate(() => {
        const top = getComputedStyle(document.querySelector(".workspace-topbar"));
        const create = getComputedStyle(
          document.querySelector(".workspace-sidebar .workspace-create-button"),
        );
        const search = getComputedStyle(document.querySelector('[data-ui="search-field"]'));
        return {
          height: top.height,
          padding: top.paddingInline,
          border: top.borderBottom,
          create: [create.height, create.backgroundColor, create.borderRadius, create.fontSize],
          search: [search.height, search.backgroundColor, search.borderRadius],
        };
      });
    const reference = await chromeStyle();
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({ path: process.env.AI_UI_CAPTURE_DIR + "/reference-contacts.png" });
    await page.goto(origin + "/ai");
    await page.getByRole("heading", { name: "New conversation" }).waitFor();
    await page.getByRole("combobox", { name: "Model", exact: true }).waitFor();
    assert.deepEqual(await chromeStyle(), reference);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Review recent mail");
    assert.ok(
      await input.evaluate(
        (element) => element.clientWidth >= element.closest("form").clientWidth - 40,
      ),
    );
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({ path: process.env.AI_UI_CAPTURE_DIR + "/welcome-desktop.png" });
    await choose(page, "Model", "Focused chat");
    const shortHeight = await input.evaluate((element) => element.clientHeight);
    await input.fill(Array.from({ length: 55 }, (_, i) => `Plan step ${i + 1}`).join("\n"));
    assert.ok((await input.evaluate((element) => element.clientHeight)) > shortHeight);
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    assert.equal((await f.call("/api/ai/rooms")).rooms.length, 0);
    await input.press("Shift+Enter");
    assert.equal((await f.call("/api/ai/rooms")).rooms.length, 0);
    await input.press("Enter");
    await page.waitForURL(/\/ai\/rooms\//);
    const roomId = new URL(page.url()).pathname.split("/").at(-1);
    assert.equal((await f.call(`/api/ai/rooms/${roomId}`)).room.profile_key, "fixture-focused");
    await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Model" }).isDisabled(), true);
    const run = await lastRun(f, roomId);
    await f.testCall("advance", { id: run.id });
    await page.locator(".ai-run-state").getByText("Completed", { exact: true }).waitFor();
    await mutation(page, `/rooms/${roomId}`, () => choose(page, "Model", "Fixture chat"));
    assert.equal((await f.call(`/api/ai/rooms/${roomId}`)).room.profile_key, "fixture-chat");
    await page.locator(".ai-chat-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole("button", { name: "Jump to latest messages", exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForResponse((response) => response.url().includes(`/rooms/${roomId}/messages?`));
    assert.equal(await page.locator(".ai-chat-scroll").evaluate((element) => element.scrollTop), 0);
    await page.getByRole("button", { name: "Jump to latest messages", exact: true }).click();
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    assert.equal(
      await page
        .locator(".workspace-ai")
        .evaluate((element) => element.classList.contains("ai-sidebar-collapsed")),
      true,
    );
    const search = page.getByRole("textbox", { name: "Search conversations", exact: true });
    await search.fill("no matching conversation");
    await page.locator(".ai-search-results").getByText("No conversations found.").waitFor();
    await search.fill("Plan step");
    await page.locator(".ai-search-results a").first().click();
    assert.equal(await search.inputValue(), "");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("link", { name: "Usage", exact: true }).click();
    await drawer.waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    assert.equal(await page.locator("h1").count(), 1);
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({ path: process.env.AI_UI_CAPTURE_DIR + "/usage-mobile.png" });
    await page.goto(origin + "/ai");
    await page.getByRole("heading", { name: "New conversation" }).waitFor();
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({ path: process.env.AI_UI_CAPTURE_DIR + "/welcome-mobile.png" });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({ path: process.env.AI_UI_CAPTURE_DIR + "/welcome-dark.png" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "languages", { get: () => ["ko-KR"] });
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.reload();
    await page.getByRole("heading", { name: "새 대화" }).waitFor();
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({ path: process.env.AI_UI_CAPTURE_DIR + "/welcome-ko-desktop.png" });
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  "AI chat restores tasks, approves tools exactly once and cancels queued work on mobile",
  { timeout: 90000 },
  async (t) => {
    const f = await browserFixture(t),
      { page, origin } = f;
    const connection = (
      await f.call("/api/ai/mcp/connections", {
        method: "POST",
        data: { server_id: "system-mcp-contacts", name: "My contacts" },
        expected: 201,
      })
    ).connection;
    await page.goto(origin + "/ai");
    await page.getByRole("heading", { name: "New conversation" }).waitFor();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("My unfinished plan");
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.waitForURL(/\/ai\/rooms\//);
    const roomId = new URL(page.url()).pathname.split("/").at(-1);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: /contacts.create/ }).check();
    await mutation(page, "/mcp-bindings", () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(),
      "My unfinished plan",
    );
    assert.equal(
      (await f.call(`/api/ai/rooms/${roomId}/mcp-bindings`)).bindings[0].connection_id,
      connection.id,
    );
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Help me draft a plan");
    await mutation(page, `/rooms/${roomId}/runs`, () =>
      page.getByRole("button", { name: "Send message", exact: true }).click(),
    );
    const run = await lastRun(f, roomId);
    await f.testCall("advance", { id: run.id });
    await page.locator(".ai-message-assistant").getByText("Hello", { exact: true }).waitFor();
    await f.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await page.getByRole("button", { name: "Copy response", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Hello");
    await f.bucket.put("ai-fixture-mode", JSON.stringify({ kind: "tools" }));
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a contact");
    await mutation(page, `/rooms/${roomId}/runs`, () =>
      page.getByRole("button", { name: "Send message", exact: true }).click(),
    );
    const toolRun = await lastRun(f, roomId);
    await f.testCall("advance", { id: toolRun.id });
    await f.testCall("advance", { id: toolRun.id });
    await page.getByText("Your approval is needed", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("Your approval is needed", { exact: true }).waitFor();
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({ path: process.env.AI_UI_CAPTURE_DIR + "/approval-desktop.png" });
    const approval = (await f.call(`/api/ai/runs/${toolRun.id}/approvals`)).approvals[0];
    await mutation(page, `/approvals/${approval.id}/decision`, () =>
      page.getByRole("button", { name: "Approve changes", exact: true }).click(),
    );
    await f.testCall("advance", { id: toolRun.id });
    await f.testCall("advance", { id: toolRun.id });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".ai-message-assistant .ai-message-text").length === 2 &&
        [...document.querySelectorAll(".ai-message-assistant .ai-message-text")].every(
          (element) => element.textContent === "Hello",
        ),
    );
    assert.equal((await f.db.prepare("SELECT count(*) n FROM contacts").first()).n, 1);
    await page.locator(".ai-run-state").getByText("Completed", { exact: true }).waitFor();
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({
        path: process.env.AI_UI_CAPTURE_DIR + "/chat-desktop.png",
        fullPage: true,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Another task");
    await mutation(page, `/rooms/${roomId}/runs`, () =>
      page.getByRole("button", { name: "Send message", exact: true }).click(),
    );
    const queued = await lastRun(f, roomId);
    await mutation(page, `/runs/${queued.id}/cancel`, () =>
      page.getByRole("button", { name: "Stop", exact: true }).click(),
    );
    await page.getByText("Cancelled", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({
        path: process.env.AI_UI_CAPTURE_DIR + "/chat-mobile.png",
        fullPage: true,
      });
    assert.deepEqual(f.errors, []);
  },
);

test(
  "AI chat connects Wiki and creates a page only after tool approval",
  { timeout: 90000 },
  async (t) => {
    const f = await browserFixture(t, { wiki: true }),
      { page, origin } = f;
    const space = (await f.call("/api/wiki/spaces")).spaces[0];
    await page.goto(origin + "/ai/connections");
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("My wiki");
    await choose(page, "MCP server", "Wiki");
    await mutation(page, "/api/ai/mcp/connections", () =>
      dialog.getByRole("button", { name: "Connect", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "View tools", exact: true }).click();
    await page.getByRole("dialog").getByText("wiki.get_page", { exact: true }).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Create API key", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("checkbox", { name: "Read wiki", exact: true })
      .waitFor();
    await page
      .getByRole("dialog")
      .getByRole("checkbox", { name: "Edit wiki", exact: true })
      .waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await page.goto(origin + "/ai");
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.waitForURL(/\/ai\/rooms\//);
    const roomId = new URL(page.url()).pathname.split("/").at(-1);
    dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: /wiki.create_page/ }).check();
    await mutation(page, "/mcp-bindings", () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    await f.bucket.put(
      "ai-fixture-mode",
      JSON.stringify({
        kind: "tools",
        arguments: { space_id: space.id, title: "Agent notes", text: "Page created through chat" },
      }),
    );
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a wiki page");
    await mutation(page, `/rooms/${roomId}/runs`, () =>
      page.getByRole("button", { name: "Send message", exact: true }).click(),
    );
    const run = await lastRun(f, roomId);
    await f.testCall("advance", { id: run.id });
    await f.testCall("advance", { id: run.id });
    await page.getByText("Your approval is needed", { exact: true }).waitFor();
    assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM wiki_pages").first()).n, 0);
    const approval = (await f.call(`/api/ai/runs/${run.id}/approvals`)).approvals[0];
    await mutation(page, `/approvals/${approval.id}/decision`, () =>
      page.getByRole("button", { name: "Approve changes", exact: true }).click(),
    );
    await f.testCall("advance", { id: run.id });
    await f.testCall("advance", { id: run.id });
    await page.locator(".ai-run-state").getByText("Completed", { exact: true }).waitFor();
    const pages = (await f.call(`/api/wiki/spaces/${space.id}/pages?q=Agent`)).pages;
    assert.equal(pages.length, 1);
    assert.equal(pages[0].title, "Agent notes");
    assert.deepEqual(f.errors, []);
  },
);

test(
  "AI connection screens issue scoped one-time keys and revoke them without exposing stored credentials",
  { timeout: 60000 },
  async (t) => {
    const f = await browserFixture(t, { configure: false }),
      { page, origin } = f;
    await page.goto(origin + "/ai/connections");
    await page.getByRole("heading", { name: "Connections", exact: true }).waitFor();
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("My contacts");
    await choose(page, "MCP server", "Contacts");
    await mutation(page, "/api/ai/mcp/connections", () =>
      dialog.getByRole("button", { name: "Connect", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "View tools", exact: true }).click();
    await page.getByRole("dialog").getByText("contacts.create", { exact: true }).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Create API key", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("External reader");
    await dialog.getByRole("checkbox", { name: "Read contacts", exact: true }).check();
    await mutation(page, "/api/mcp/api-keys", () =>
      dialog.getByRole("button", { name: "Create API key", exact: true }).click(),
    );
    const issued = page.getByRole("textbox", { name: "New API key", exact: true });
    await issued.waitFor();
    const token = await issued.inputValue();
    assert.match(token, /^ofmk_/);
    await page.getByRole("button", { name: "I have saved the key", exact: true }).click();
    assert.ok(!(await page.locator("body").textContent()).includes(token));
    assert.ok(!JSON.stringify(await f.call("/api/mcp/api-keys")).includes(token));
    const key = (await f.call("/api/mcp/api-keys")).keys[0];
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await mutation(page, `/api-keys/${key.id}`, () =>
      page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Disconnect", exact: true })
        .click(),
    );
    assert.ok((await f.call("/api/mcp/api-keys")).keys[0].revoked_at);
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({ path: process.env.AI_UI_CAPTURE_DIR + "/connections-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  "AI console configures providers and credentials together and orders provider models on a separate screen",
  { timeout: 90000 },
  async (t) => {
    const f = await browserFixture(t, { configure: false }, "admin"),
      { page, origin } = f;
    await page.goto(origin + "/console/ai/providers");
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await page.waitForURL("**/console/ai/providers/new");
    const editor = page.locator(".console-detail-page");
    await editor.getByRole("heading", { name: "Add provider", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("UI provider");
    await editor.getByRole("textbox", { name: "Identifier", exact: true }).fill("ui-provider");
    await editor
      .getByRole("textbox", { name: "API base URL", exact: true })
      .fill("https://provider.example/v1");
    await editor.getByLabel("API key", { exact: true }).fill("fixture-provider-key");
    const { item: createdProvider } = await mutation(page, "/api/ai/admin/provider-configs", () =>
      editor.getByRole("button", { name: "Add provider", exact: true }).click(),
    );
    await page.waitForURL(`**/console/ai/providers/${createdProvider.id}`);
    assert.ok(createdProvider.accounts[0].has_secret);
    assert.ok(!(await page.locator("body").textContent()).includes("fixture-provider-key"));
    await page.reload();
    assert.equal(await editor.getByLabel("API key", { exact: true }).inputValue(), "");
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("UI provider updated");
    const { item: provider } = await mutation(page, `/provider-configs/${createdProvider.id}`, () =>
      editor.getByRole("button", { name: "Save changes", exact: true }).click(),
    );
    await editor.getByRole("heading", { name: "UI provider updated", exact: true }).waitFor();
    assert.ok(page.url().endsWith("/console/ai/providers/" + provider.id));
    await page.route("**/api/ai/admin/provider-configs/*/models", async (route) =>
      route.fulfill({
        json: {
          models: [
            {
              id: "fixture-ui-model",
              name: "UI provider model",
              context_tokens: 131072,
              max_output_tokens: 8192,
              pricing: { input: 2500000, output: 10000000 },
            },
          ],
          next_cursor: null,
        },
      }),
    );
    await page.goto(origin + "/console/ai/models");
    await page.getByRole("button", { name: "Add model", exact: true }).click();
    await page.waitForURL("**/console/ai/models/new");
    await editor.getByRole("heading", { name: "Add model", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await editor.getByRole("textbox", { name: "Identifier", exact: true }).fill("ui-model");
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("UI model");
    await choose(page, "AI provider", provider.name);
    await choose(page, "Available provider models", "UI provider model (fixture-ui-model)");
    const limits = editor.locator("section").filter({
      has: page.getByRole("heading", { name: "Model capabilities and limits", exact: true }),
    });
    await limits
      .getByRole("spinbutton", { name: "Maximum context (tokens)", exact: true })
      .fill("65536");
    await limits
      .getByRole("spinbutton", { name: "Maximum output tokens", exact: true })
      .fill("4096");
    await editor.getByText("Advanced settings", { exact: true }).click();
    await editor.getByRole("checkbox", { name: "High", exact: true }).check();
    await choose(page, "Default reasoning level", "High");
    await editor.getByText("Advanced settings", { exact: true }).click();
    await editor
      .getByRole("checkbox", { name: "The model's usage bounds are verified", exact: true })
      .check();
    assert.equal(
      await editor
        .getByRole("spinbutton", { name: "Input price (USD / 1M tokens)", exact: true })
        .inputValue(),
      "2.5",
    );
    await editor.getByRole("button", { name: "Add provider", exact: true }).click();
    const second = editor.locator(".ai-config-record").nth(1);
    await second.getByRole("combobox", { name: "AI provider", exact: true }).click();
    await page.getByRole("option", { name: provider.name, exact: true }).click();
    await second.getByRole("combobox", { name: "Available provider models", exact: true }).click();
    await page.getByRole("option", { name: "Enter a model ID", exact: true }).click();
    await second
      .getByRole("textbox", { name: "Provider model ID", exact: true })
      .fill("second-provider-model");
    await second
      .getByRole("spinbutton", { name: "Input price (USD / 1M tokens)", exact: true })
      .fill("0");
    await second
      .getByRole("spinbutton", { name: "Output price (USD / 1M tokens)", exact: true })
      .fill("0");
    await second
      .getByRole("checkbox", { name: "The model's usage bounds are verified", exact: true })
      .check();
    await second.getByRole("button", { name: "Move provider up", exact: true }).click();
    assert.equal(
      await editor
        .locator(".ai-config-record")
        .first()
        .getByRole("textbox", { name: "Provider model ID", exact: true })
        .inputValue(),
      "second-provider-model",
    );
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({
        path: process.env.AI_UI_CAPTURE_DIR + "/model-providers-desktop.png",
      });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({
        path: process.env.AI_UI_CAPTURE_DIR + "/model-providers-mobile.png",
      });
    const { item: model } = await mutation(page, "/api/ai/admin/model-configs", () =>
      editor.getByRole("button", { name: "Add model", exact: true }).click(),
    );
    await page.waitForURL(`**/console/ai/models/${model.id}`);
    assert.deepEqual(
      model.providers.map((source) => source.provider_model_id),
      ["second-provider-model", "fixture-ui-model"],
    );
    assert.deepEqual(model.capabilities, {
      context_tokens: 65536,
      max_output_tokens: 4096,
      default_reasoning_effort: "high",
    });
    assert.deepEqual(model.providers[1].reasoning_levels, ["high"]);
    assert.ok(
      (await f.call("/api/ai/models")).profiles.some((profile) => profile.name === "UI model"),
    );
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.goto(origin + "/console/ai/models/" + model.id);
    assert.equal(
      await editor.getByRole("textbox", { name: "Name", exact: true }).inputValue(),
      "UI model",
    );
    assert.equal(
      await limits
        .getByRole("spinbutton", { name: "Maximum context (tokens)", exact: true })
        .inputValue(),
      "65536",
    );
    assert.equal(
      await limits
        .getByRole("combobox", { name: "Default reasoning level", exact: true })
        .textContent(),
      "High",
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForURL("**/console/ai/models");
    await page.goto(origin + "/console/ai/accounts");
    await page.waitForURL("**/console/ai/providers");
    assert.equal(
      await page.getByRole("tab", { name: "Provider accounts", exact: true }).count(),
      0,
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  "AI user limit screens preserve explicit zero limits and enforce read-only console access",
  { timeout: 60000 },
  async (t) => {
    const f = await browserFixture(t, {}, "admin"),
      { page, origin } = f;
    await page.goto(origin + "/console/ai/quotas");
    await choose(page, "User", "alice@office.test");
    await page.getByRole("button", { name: "Add limit", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Limit", exact: true }).fill("0");
    await mutation(page, "/users/alice/quota", () =>
      page.getByRole("button", { name: "Save changes", exact: true }).click(),
    );
    const quota = await f.admin("/users/alice/quota");
    assert.equal(quota.overrides[0].limit_value, 0);
    assert.equal(quota.overrides[0].metric, "invocations");
    await page.reload();
    await choose(page, "User", "alice@office.test");
    assert.equal(
      await page.getByRole("spinbutton", { name: "Limit", exact: true }).inputValue(),
      "0",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({
        path: process.env.AI_UI_CAPTURE_DIR + "/console-mobile.png",
        fullPage: true,
      });
    await f.db
      .prepare(
        "INSERT INTO roles(id,key,label) VALUES('ai-quota-viewer','ai-quota-viewer','AI quota viewer')",
      )
      .run();
    for (const permission of ["console.access", "admin.ai.quotas.read"])
      await f.db
        .prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('ai-quota-viewer',?)")
        .bind(permission)
        .run();
    await f.db
      .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('bob','ai-quota-viewer')")
      .run();
    const context = await f.browser.newContext({ locale: "en-US" });
    t.after(() => context.close());
    const viewer = await context.newPage();
    await viewer.goto(origin + "/login");
    await viewer.locator("input[type=email]").fill("bob@office.test");
    await viewer
      .locator("input[type=password]")
      .fill("a long password for calendar integration tests");
    await viewer.locator("button[type=submit]").click();
    await viewer.waitForURL((url) => url.pathname !== "/login");
    await viewer.goto(origin + "/console/ai/quotas");
    await choose(viewer, "User", "alice@office.test");
    await viewer.getByText("Individual overrides", { exact: true }).waitFor();
    assert.equal(
      await viewer.getByRole("button", { name: "Save changes", exact: true }).count(),
      0,
    );
    assert.equal(await viewer.getByRole("button", { name: "Add limit", exact: true }).count(), 0);
    await f.call("/api/ai/admin/users/alice/quota", {
      actor: "bob",
      method: "PUT",
      data: { version: quota.subject.version, overrides: [] },
      expected: 403,
    });
    await viewer.goto(origin + "/console/ai/providers/new");
    await viewer.getByRole("heading", { name: "Access restricted", exact: true }).waitFor();
    assert.equal(await viewer.locator(".console-form").count(), 0);
    assert.deepEqual(f.errors, []);
  },
);
