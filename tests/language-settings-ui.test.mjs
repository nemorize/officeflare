import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("preferences render localized language settings without save guidance", async () => {
  const result = await build({
    stdin: {
      contents: `export { PreferencesPage } from './web/routes/preferences'; export { setLocaleResolver } from './shared/i18n/index.ts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    jsx: "automatic",
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "isolated-account",
        setup(builder) {
          builder.onLoad({ filter: /web\/components\/account-context\.tsx$/ }, () => ({
            contents: `export const useAccount = () => ({ user: { id: 'test-user', language: 'system', time_zone: 'Asia/Seoul', regional_format: 'ko-KR' }, update() {} });`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /web\/lib\/api\.ts$/ }, () => ({
            contents: `export const api = async () => ({}); export const errorMessage = String;`,
            loader: "ts",
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const { PreferencesPage, setLocaleResolver } = module.exports;
  for (const [locale, heading, sectionTitle, title, system, hint] of [
    ["en", "Preferences", "Language and notation", "Language", "System", "reloads the page"],
    ["ko", "환경설정", "언어 및 표기", "언어", "시스템", "페이지가 새로고침됩니다"],
    ["ja", "環境設定", "言語と表記", "言語", "システム", "ページが再読み込みされます"],
  ]) {
    setLocaleResolver(() => locale);
    const html = renderToStaticMarkup(createElement(PreferencesPage));
    assert.ok(html.includes(`<h1>${heading}</h1>`));
    assert.ok(html.includes(`<h2>${sectionTitle}</h2>`));
    assert.ok(html.includes(system));
    assert.ok(!html.includes(hint));
    assert.match(html, /role="combobox"/);
    assert.ok(html.includes(`aria-label="${title}"`));
    assert.match(html, /name="language"/);
    assert.match(html, /name="time_zone"/);
    assert.match(html, /name="regional_format"/);
    assert.ok(html.includes('value="Asia/Seoul"'));
    assert.match(html, /type="submit"[^>]*disabled=""/);
    assert.match(html, /type="submit"/);
  }
});
