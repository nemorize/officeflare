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
    await page.getByRole("heading", { name: "What would you like to get done?" }).waitFor();
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
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  "AI console configures credentials, model prices, routing and feature access using typed forms",
  { timeout: 90000 },
  async (t) => {
    const f = await browserFixture(t, {}, "admin"),
      { page, origin } = f;
    await page.goto(origin + "/console/ai/accounts");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await choose(page, "AI provider", "Fixture");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("UI credential");
    await dialog.getByLabel("API key", { exact: true }).fill("fixture-ui-provider-key");
    await choose(page, "Account access", "Whole workspace");
    await choose(page, "Sharing authorization", "Provider permits workspace sharing");
    await dialog
      .getByRole("textbox", { name: "Authorization reference", exact: true })
      .fill("approved-workspace-use");
    await mutation(page, "/api/ai/admin/accounts", () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    const account = (await f.admin("/accounts")).items.find(
      (item) => item.name === "UI credential",
    );
    assert.ok(account.has_secret);
    assert.ok(!(await page.locator("body").textContent()).includes("fixture-ui-provider-key"));
    const accountRow = page.getByRole("row").filter({ hasText: "UI credential" });
    await accountRow.getByRole("button", { name: "Edit", exact: true }).click();
    dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByLabel("API key", { exact: true }).inputValue(), "");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("UI credential updated");
    await mutation(page, `/accounts/${account.id}`, () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      (await f.admin("/accounts")).items.find((item) => item.id === account.id).credential_version,
      account.credential_version,
    );
    await page.goto(origin + "/console/ai/models");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Identifier", exact: true }).fill("ui-model");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("UI model");
    await dialog.getByRole("textbox", { name: "Model vendor", exact: true }).fill("Fixture vendor");
    await mutation(page, "/api/ai/admin/models", () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    await page.goto(origin + "/console/ai/deployments");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    dialog = page.getByRole("dialog");
    await choose(page, "AI provider", "Fixture");
    await choose(page, "Model", "UI model");
    await dialog
      .getByRole("textbox", { name: "Provider model ID", exact: true })
      .fill("fixture-ui-model");
    await dialog
      .getByRole("spinbutton", { name: "Context window (tokens)", exact: true })
      .fill("131072");
    await dialog
      .getByRole("spinbutton", { name: "Maximum output tokens", exact: true })
      .fill("8192");
    await dialog
      .getByRole("checkbox", { name: "The model's usage bounds are verified", exact: true })
      .check();
    await dialog
      .getByRole("spinbutton", { name: "Input price (USD / 1M tokens)", exact: true })
      .fill("2.5");
    await dialog
      .getByRole("spinbutton", { name: "Output price (USD / 1M tokens)", exact: true })
      .fill("10");
    await mutation(page, "/api/ai/admin/deployments", () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    const deployment = (await f.admin("/deployments")).items.find(
      (item) => item.provider_model_id === "fixture-ui-model",
    );
    assert.equal(JSON.parse(deployment.pricing_json).input, 2500000);
    assert.equal(JSON.parse(deployment.pricing_json).output, 10000000);
    await page.goto(origin + "/console/ai/profiles");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Identifier", exact: true }).fill("ui-profile");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("UI profile");
    await mutation(page, "/api/ai/admin/profiles", () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    await page.goto(origin + "/console/ai/routes");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    dialog = page.getByRole("dialog");
    await choose(page, "Model profile", "UI profile");
    await choose(page, "AI provider", "Fixture");
    await choose(page, "Model deployment", "fixture-ui-model");
    await choose(page, "Account pool", "Pool");
    await mutation(page, "/api/ai/admin/routes", () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    await page.goto(origin + "/console/ai/consumers");
    await page
      .getByRole("row")
      .filter({ hasText: "hub.chat" })
      .getByRole("button", { name: "Model profiles", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: "UI profile", exact: true }).check();
    await mutation(page, "/consumers/hub.chat/profiles", () =>
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    );
    await dialog.waitFor({ state: "hidden" });
    assert.ok(
      (await f.call("/api/ai/models")).profiles.some((profile) => profile.key === "ui-profile"),
    );
    if (process.env.AI_UI_CAPTURE_DIR)
      await page.screenshot({
        path: process.env.AI_UI_CAPTURE_DIR + "/console-desktop.png",
        fullPage: true,
      });
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
    await viewer.goto(origin + "/console/ai/providers");
    await viewer.getByRole("heading", { name: "Access restricted", exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  },
);
