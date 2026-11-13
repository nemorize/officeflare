import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture } from "./calendar-fixture.mjs";

test(
  "Wiki browser editors synchronize body/title, reconnect, and react to downgraded access",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { collaboration: true, assets: true });
    for (const user of ["alice", "bob"])
      await f.db
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,'system-wiki-user')")
        .bind(user)
        .run();
    const call = async (path, method = "GET", body) => {
      const response = await f.mf.dispatchFetch(`https://office.test/api/wiki${path}`, {
        method,
        headers: { Authorization: `Bearer ${f.tokens.alice}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const space = (await call("/spaces", "POST", { name: "Engineering" })).space;
    const page = (await call(`/spaces/${space.id}/pages`, "POST", {})).page;
    await call(`/spaces/${space.id}/members`, "PUT", {
      email: "bob@office.test",
      role: "editor",
      version: space.acl_version,
    });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const origin = (await f.mf.ready).origin,
      errors = [];
    const login = async (user) => {
      const context = await browser.newContext({ locale: "en-US" });
      t.after(() => context.close());
      await context.addInitScript(() => {
        const Native = window.WebSocket;
        window.WebSocket = class extends Native {
          constructor(...args) {
            super(...args);
            (window.fixtureSockets ??= []).push(this);
          }
        };
      });
      const tab = await context.newPage();
      tab.on("pageerror", (error) => errors.push(error.message));
      await tab.goto(`${origin}/login`);
      await tab.locator('input[type="email"]').fill(`${user}@office.test`);
      await tab
        .locator('input[type="password"]')
        .fill("a long password for calendar integration tests");
      await tab.locator('button[type="submit"]').click();
      await tab.waitForURL((url) => url.pathname !== "/login");
      await tab.goto(`${origin}/wiki/${space.id}/${page.id}`);
      await tab.locator('.collaborative-prose[contenteditable="true"]').waitFor();
      return tab;
    };
    const alice = await login("alice"),
      bob = await login("bob");
    await alice.locator(".wiki-title").fill("Collaborative knowledge");
    await bob.waitForFunction(
      () => document.querySelector(".wiki-title")?.value === "Collaborative knowledge",
    );
    await alice.locator(".collaborative-prose").fill("Shared paragraph ");
    await bob.waitForFunction(() =>
      document.querySelector(".collaborative-prose")?.textContent.includes("Shared paragraph"),
    );
    await alice.locator(".collaborative-prose").press("ControlOrMeta+End");
    await bob.locator(".collaborative-prose").press("ControlOrMeta+End");
    await Promise.all([alice.keyboard.insertText("alpha"), bob.keyboard.insertText("beta")]);
    for (const tab of [alice, bob])
      await tab.waitForFunction(() => {
        const text = document.querySelector(".collaborative-prose")?.textContent;
        return (
          text?.includes("alpha") &&
          text?.includes("beta") &&
          document.querySelector(".wiki-save-state")?.textContent === "Saved"
        );
      });
    const documentText = (tab) =>
      tab.locator(".collaborative-prose").evaluate((node) => {
        const copy = node.cloneNode(true);
        copy.querySelectorAll(".collaboration-carets__caret").forEach((caret) => caret.remove());
        return copy.textContent;
      });
    assert.equal(await documentText(alice), await documentText(bob));
    await bob.reload();
    await bob.waitForFunction(() =>
      document.querySelector(".collaborative-prose")?.textContent.includes("beta"),
    );
    assert.equal(await bob.locator(".wiki-title").inputValue(), "Collaborative knowledge");
    await alice.locator(".wiki-title").dispatchEvent("compositionstart");
    await bob.locator(".wiki-title").fill("Remote Collaborative knowledge");
    await bob.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    await alice.locator(".wiki-title").fill("Collaborative knowledge 한글");
    await alice.locator(".wiki-title").dispatchEvent("compositionend", { data: "한글" });
    for (const tab of [alice, bob])
      await tab.waitForFunction(
        () =>
          document.querySelector(".wiki-title")?.value === "Remote Collaborative knowledge 한글",
      );
    await alice.context().setOffline(true);
    await alice.evaluate(() =>
      window.fixtureSockets
        .filter((socket) => socket.url.includes("/collaboration/"))
        .forEach((socket) => socket.close()),
    );
    await alice.locator(".collaborative-prose").press("ControlOrMeta+End");
    await alice.keyboard.insertText(" Offline draft");
    await alice.waitForFunction(() =>
      document.querySelector(".wiki-save-state")?.textContent.includes("Offline"),
    );
    await alice.context().setOffline(false);
    for (const tab of [alice, bob])
      await tab.waitForFunction(
        () =>
          document.querySelector(".collaborative-prose")?.textContent.includes("Offline draft") &&
          document.querySelector(".wiki-save-state")?.textContent === "Saved",
      );
    const collaboration = async (action, body) => {
      const result = await f.mf.dispatchFetch(
        `https://office.test/api/collaboration/resources/${page.resource_id}/${action}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${f.tokens.alice}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      assert.ok(result.ok, await result.clone().text());
      return result.json();
    };
    const snapshot = await collaboration("snapshots");
    await alice.locator(".collaborative-prose").fill("Temporary replacement");
    await alice.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Saved",
    );
    await collaboration("restores", { snapshot_id: snapshot.id, epoch: 1 });
    for (const tab of [alice, bob])
      await tab.waitForFunction(
        () =>
          document.querySelector(".collaborative-prose")?.textContent.includes("Offline draft") &&
          document.querySelector(".wiki-save-state")?.textContent === "Saved",
      );
    const members = await call(`/spaces/${space.id}/members`);
    await call(`/spaces/${space.id}/members`, "PUT", {
      email: "bob@office.test",
      role: "viewer",
      version: members.version,
    });
    await bob.locator('.collaborative-prose[contenteditable="false"]').waitFor({ timeout: 10000 });
    assert.equal(await bob.locator(".wiki-title").getAttribute("readonly"), "");
    const current = await call(`/spaces/${space.id}/members`);
    await call(`/spaces/${space.id}/members`, "PUT", {
      email: "bob@office.test",
      role: "editor",
      version: current.version,
    });
    await bob.locator('.collaborative-prose[contenteditable="true"]').waitFor({ timeout: 10000 });
    await bob.context().setOffline(true);
    await bob.evaluate(() =>
      window.fixtureSockets
        .filter((socket) => socket.url.includes("/collaboration/"))
        .forEach((socket) => socket.close()),
    );
    await bob.locator(".collaborative-prose").press("ControlOrMeta+End");
    await bob.keyboard.insertText(" Retained draft");
    await bob.waitForFunction(() =>
      document.querySelector(".wiki-save-state")?.textContent.includes("Offline"),
    );
    const beforeRemoval = await call(`/spaces/${space.id}/members`);
    const removed = await f.mf.dispatchFetch(
      `https://office.test/api/wiki/spaces/${space.id}/members/bob?version=${beforeRemoval.version}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${f.tokens.alice}` } },
    );
    assert.equal(removed.status, 204);
    await bob.context().setOffline(false);
    await bob.waitForFunction(
      () => document.querySelector(".wiki-save-state")?.textContent === "Access was revoked.",
    );
    const refreshed = bob.waitForResponse((response) =>
      response.url().endsWith("/api/wiki/spaces"),
    );
    await bob.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    assert.match(await documentText(bob), /Retained draft/);
    await bob.getByRole("button", { name: "Download local copy" }).waitFor();
    await alice.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
  },
);
