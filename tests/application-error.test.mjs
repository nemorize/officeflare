import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isModuleLoadError } from "../web/lib/application-error.ts";

test("deployment asset failures are recognized across browsers without treating all network errors as updates", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: https://office.test/assets/mail-old.js",
    "error loading dynamically imported module: https://office.test/assets/mail-old.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/mail-old.css",
    "Loading chunk 12 failed.",
    "Loading CSS chunk 12 failed.",
  ])
    assert.equal(isModuleLoadError(new TypeError(message)), true, message);
  for (const error of [
    new Error("Failed to fetch"),
    new Error("Private rendering details"),
    { status: 503 },
    null,
    undefined,
    "Failed to fetch dynamically imported module",
  ])
    assert.equal(isModuleLoadError(error), false);
});

const result = await build({
  stdin: {
    contents: `export { ApplicationErrorPage } from './web/components/application-error';
      export { RouteErrorBoundary } from './web/components/route-error';
      export { setLocaleResolver } from './shared/i18n/index.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  jsx: "automatic",
  loader: { ".css": "empty" },
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { ApplicationErrorPage, RouteErrorBoundary, setLocaleResolver } = module.exports;

test("error pages offer full-page recovery in every language without exposing exception details", () => {
  for (const [locale, loadTitle, unexpectedTitle, notFoundTitle, refresh, home] of [
    [
      "en",
      "This page could not be loaded",
      "Something went wrong",
      "Page not found",
      "Refresh",
      "Return to workspace",
    ],
    [
      "ko",
      "화면을 불러오지 못했습니다",
      "문제가 발생했습니다",
      "페이지를 찾을 수 없습니다",
      "새로고침",
      "워크스페이스로 돌아가기",
    ],
    [
      "ja",
      "画面を読み込めませんでした",
      "問題が発生しました",
      "ページが見つかりません",
      "更新",
      "ワークスペースに戻る",
    ],
  ]) {
    setLocaleResolver(() => locale);
    for (const [props, title] of [
      [
        {
          error: new TypeError(
            "Failed to fetch dynamically imported module: https://office.test/assets/private.js",
          ),
        },
        loadTitle,
      ],
      [
        { error: new Error("Private exception details <script>alert(1)</script>") },
        unexpectedTitle,
      ],
      [{ notFound: true }, notFoundTitle],
    ]) {
      const html = renderToStaticMarkup(createElement(ApplicationErrorPage, props));
      assert.ok(html.includes(title));
      assert.ok(html.includes(home));
      assert.match(html, /href="\/"/);
      assert.match(html, /role="link"/);
      assert.match(html, /<main[^>]*aria-labelledby=/);
      if (!props.notFound) assert.ok(html.includes(refresh));
      assert.doesNotMatch(
        html,
        /private\.js|Private exception|<script>|Unexpected Application Error|Hey developer|<pre>/,
      );
    }
  }
});

test("router error responses render the custom page instead of the default developer screen", async () => {
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  for (const [error, expected] of [
    [
      new TypeError("Failed to fetch dynamically imported module: /assets/private.js"),
      "This page could not be loaded",
    ],
    [new Response("Private response details", { status: 404 }), "Page not found"],
  ]) {
    setLocaleResolver(() => "en");
    const router = createMemoryRouter(
      [
        {
          errorElement: createElement(RouteErrorBoundary),
          children: [
            {
              path: "/mail",
              loader() {
                throw error;
              },
              element: createElement("p", null, "Mail"),
            },
          ],
        },
      ],
      { initialEntries: ["/mail"] },
    );
    try {
      if (!router.state.initialized)
        await new Promise((resolve) => {
          const unsubscribe = router.subscribe((state) => {
            if (state.initialized) {
              unsubscribe();
              resolve();
            }
          });
        });
      const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
      assert.ok(html.includes(expected));
      assert.doesNotMatch(html, /private\.js|Private response|Unexpected Application Error|<pre>/);
    } finally {
      router.dispose();
    }
  }
});
