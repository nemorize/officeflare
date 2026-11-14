import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "./ai-fixture.mjs";
import { returnToWorkspace } from "../web/lib/profile.ts";

test(
  "external MCP consent survives login, narrows scopes and reviews writes on mobile",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, { configure: false, assets: true });
    const client = await f.call("/api/mcp/oauth/register", {
      actor: null,
      method: "POST",
      data: {
        client_name: "External assistant",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      },
      expected: 201,
    });
    const verifier = randomBytes(32).toString("base64url");
    const origin = (await f.mf.ready).origin;
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: origin + "/api/mcp",
      scope: "contacts.read contacts.write",
      state: "review-test",
    });
    const authorization = await f.mf.dispatchFetch(origin + "/api/mcp/oauth/authorize?" + query, {
      redirect: "manual",
    });
    assert.equal(authorization.status, 302);
    const requestId = new URL(authorization.headers.get("location")).searchParams.get("request");
    const path = "/mcp/authorize?request=" + requestId;
    assert.equal(returnToWorkspace(path), path);
    assert.equal(returnToWorkspace(path + "&redirect=https://evil.example"), "/");
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 390, height: 844 },
    });
    t.after(() => context.close());
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + path);
    await page.locator("input[type=email]").fill("alice@office.test");
    await page
      .locator("input[type=password]")
      .fill("a long password for calendar integration tests");
    await page.locator("button[type=submit]").click();
    await page.waitForURL(origin + path);
    await page.getByRole("heading", { name: "External assistant" }).waitFor();
    const checkboxes = page.getByRole("checkbox");
    assert.equal(await checkboxes.count(), 2);
    await checkboxes.nth(1).uncheck();
    let callback;
    await context.route("https://client.example/**", async (route) => {
      callback = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: "text/html", body: "<p>Connected</p>" });
    });
    await page.getByRole("button", { name: "Allow connection", exact: true }).click();
    await page.waitForURL("https://client.example/**");
    assert.equal(callback.searchParams.get("state"), "review-test");
    const tokenResponse = await f.mf.dispatchFetch(origin + "/api/mcp/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "authorization_code",
        code: callback.searchParams.get("code"),
        redirect_uri: client.redirect_uris[0],
        code_verifier: verifier,
        resource: origin + "/api/mcp",
      }).toString(),
    });
    assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
    const tokens = await tokenResponse.json();
    assert.equal(tokens.scope, "contacts.read");
    const key = await f.call("/api/mcp/api-keys", {
      method: "POST",
      data: {
        name: "Review key",
        scopes: ["contacts.write"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      expected: 201,
    });
    const rpc = await f.call("/api/mcp", {
      actor: null,
      method: "POST",
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "contacts.create",
          arguments: { data: { display_name: "<script>must stay text</script>" } },
        },
      },
      headers: {
        Authorization: "Bearer " + key.key.token,
        Accept: "application/json, text/event-stream",
      },
    });
    const operation = JSON.parse(rpc.result.content[0].text);
    await page.goto(origin + operation.review_path);
    await page.getByText("<script>must stay text</script>", { exact: false }).waitFor();
    assert.equal(await page.locator(".login-card script").count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const [decision] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/operations/${operation.operation_id}/decision`) &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Deny", exact: true }).click(),
    ]);
    assert.equal(decision.status(), 200, await decision.text());
    assert.equal(
      (await f.call("/api/mcp/operations/" + operation.operation_id)).operation.status,
      "denied",
    );
    assert.equal((await f.db.prepare("SELECT count(*) n FROM contacts").first()).n, 0);
    assert.deepEqual(errors, []);
  },
);
