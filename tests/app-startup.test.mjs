import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

test("the existing loading bar covers language restoration and app loading", async () => {
  let restore;
  const harness = {
    events: [],
    markup: "",
    sessionReady: new Promise((resolve) => {
      restore = resolve;
    }),
  };
  const result = await build({
    entryPoints: ["web/main.tsx"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    jsx: "automatic",
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "controlled-startup",
        setup(builder) {
          builder.onLoad({ filter: /web\/main\.tsx$/ }, async ({ path }) => {
            const source = await readFile(path, "utf8");
            const start = source.indexOf("\nroot.render(");
            assert.ok(start > 0);
            return {
              contents:
                source.slice(0, start) +
                "\nexport async function start() {" +
                source.slice(start) +
                "\n}",
              loader: "tsx",
            };
          });
          builder.onLoad({ filter: /web\/lib\/app-root\.ts$/ }, () => ({
            contents: `import { renderToStaticMarkup } from 'react-dom/server'; export const root = { render(node) { harness.markup = renderToStaticMarkup(node); harness.events.push('loading'); } };`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /web\/lib\/session\.ts$/ }, () => ({
            contents: `import { setLocaleResolver } from '../../shared/i18n/index.ts'; export const sessions = { start() { harness.events.push('session-start'); }, restore() { return harness.sessionReady.then(() => { setLocaleResolver(() => 'ja'); }); }, subscribe() { harness.events.push('session-ready'); } };`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /web\/lib\/browser-theme\.ts$/ }, () => ({
            contents: "",
            loader: "ts",
          }));
          builder.onLoad({ filter: /web\/lib\/browser-language\.ts$/ }, () => ({
            contents: `export const browserLanguage = { start() { harness.events.push('language-ready'); } };`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /web\/app\.tsx$/ }, () => ({
            contents: `import { t } from '../shared/i18n/index.ts'; harness.events.push('app:' + t('common.save'));`,
            loader: "tsx",
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", "harness", result.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
    harness,
  );
  const pending = module.exports.start();
  assert.deepEqual(harness.events, ["loading", "session-start"]);
  assert.match(harness.markup, /class="workspace-loading"/);
  assert.match(harness.markup, /role="progressbar"/);
  assert.match(harness.markup, /aria-busy="true"/);
  assert.doesNotMatch(harness.markup, /<p[\s>]/);
  restore();
  await pending;
  assert.deepEqual(harness.events, [
    "loading",
    "session-start",
    "session-ready",
    "app:保存",
    "language-ready",
  ]);
});
