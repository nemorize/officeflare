import { workerModules } from "./worker-modules.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";

test("React Router assets and API routes coexist in the Workers runtime", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: "officeflare",
          modules: workerModules,
          compatibilityDate: "2026-09-29",
          d1Databases: { DB: "web-tests" },
          assets: {
            directory: "dist/client",
            run_worker_first: ["/api", "/api/*"],
            routerConfig: { has_user_worker: true },
            assetConfig: { not_found_handling: "single-page-application" },
          },
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const shell = await readFile("dist/client/index.html", "utf8");

  for (const path of [
    "/",
    "/login",
    "/login/",
    "/mail",
    "/calendar",
    "/calendar/settings",
    "/calendar/settings/events",
    "/calendar/settings/calendars",
    "/calendar/settings/calendars/example",
    "/calendar/settings/working-hours",
    "/calendar/settings/data",
    "/drive",
    "/profile",
    "/profile/security",
    "/profile/sessions",
    "/profile/preferences",
    "/missing/nested-page",
  ]) {
    const response = await mf.dispatchFetch(`https://office.test${path}`, {
      headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" },
    });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(await response.text(), shell);
  }

  for (const path of ["/api", "/api/missing", "/api/auth/missing"]) {
    for (const method of ["GET", "POST"]) {
      const response = await mf.dispatchFetch(`https://office.test${path}`, {
        method,
        headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" },
      });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "Not found" });
    }
  }

  const assets = [...shell.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]);
  assert.ok(assets.some((path) => path.endsWith(".js")));
  for (const path of assets) {
    const response = await mf.dispatchFetch(`https://office.test${path}`);
    assert.equal(response.status, 200, path);
    assert.doesNotMatch(response.headers.get("content-type"), /text\/html/);
  }
});
