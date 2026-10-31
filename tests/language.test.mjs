import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedLanguages, isLanguagePreference, resolveLocale } from "../shared/i18n/locale.ts";
import { getLocale, messageParts, plural, setLocaleResolver, t } from "../shared/i18n/index.ts";
import { createLanguageStore } from "../web/lib/language.ts";
import { createApiClient } from "../web/lib/api-client.ts";
import { label } from "../web/lib/profile.ts";

test("system language matches regional variants in UA order and falls back to English", () => {
  for (const [languages, expected] of [
    [[], "en"],
    [["fr-FR", "de-DE"], "en"],
    [["ko-KR", "en-US"], "ko"],
    [["ja-JP", "ko-KR"], "ja"],
    [["en-GB", "ko"], "en"],
    [["fr", "JA-jp", "en"], "ja"],
    [["ko-KR-u-ca-gregory"], "ko"],
  ])
    assert.equal(resolveLocale("system", languages), expected);
  for (const locale of ["en", "ko", "ja"])
    assert.equal(resolveLocale(locale, ["fr", "en"]), locale);
  for (const value of [null, undefined, "", "fr", "ko-KR", {}, 0])
    assert.equal(isLanguagePreference(value), false);
  for (const value of ["system", "en", "ko", "ja"]) assert.equal(isLanguagePreference(value), true);
  assert.deepEqual(acceptedLanguages("fr-FR, en;q=0.4, ja-JP;q=0.9, ko;q=0, xx;q=oops"), [
    "fr-FR",
    "ja-JP",
    "en",
  ]);
  assert.equal(resolveLocale("system", acceptedLanguages("fr, ja;q=0.8, en;q=0.5")), "ja");
});

test("language initialization precedes static labels; later effective changes reload once", () => {
  let languages = ["ko-KR"],
    reloads = 0;
  const applied = [];
  const store = createLanguageStore({
    languages: () => languages,
    apply: (value) => applied.push(value),
    reload: () => reloads++,
  });
  assert.equal(store.getPreference(), "system");
  assert.equal(applied.at(-1), "ko");
  store.setPreference("ja");
  assert.equal(reloads, 0);
  store.start();
  store.setPreference("ja");
  assert.equal(reloads, 0);
  store.setPreference("system");
  assert.equal(reloads, 1);
  languages = ["fr-FR"];
  store.systemChanged();
  assert.equal(applied.at(-1), "en");
  assert.equal(reloads, 2);
  store.setPreference("en");
  languages = ["ja"];
  store.systemChanged();
  assert.equal(reloads, 2);
  assert.equal(store.getPreference(), "en");
  store.setPreference(null);
  assert.equal(store.getPreference(), "system");
  assert.equal(applied.at(-1), "ja");
});

test("translation, plurals, rich content and organization labels use the selected locale", (context) => {
  context.after(() => setLocaleResolver(() => "en"));
  setLocaleResolver(() => "ko");
  assert.equal(getLocale(), "ko");
  assert.equal(t("common.save"), "저장");
  assert.equal(plural("counts.items", 1), "항목 1개");
  assert.equal(plural("counts.items", 2), "항목 2개");
  assert.equal(label({ en: "Name", ko: "이름" }, "fallback"), "이름");
  const node = { kind: "element" };
  assert.ok(messageParts("workspace.navigation", { name: node }).includes(node));
  assert.equal(t("workspace.navigation", { name: "{name} $& <Mail>" }), "{name} $& <Mail> 탐색");
  setLocaleResolver(() => "ja");
  assert.equal(t("common.save"), "保存");
  assert.equal(plural("counts.items", 1), "項目1件");
  assert.equal(label({ en: "Name", ko: "이름" }, "fallback"), "Name");
});

test("API retries send the effective display language with the request", async (context) => {
  context.after(() => setLocaleResolver(() => "en"));
  setLocaleResolver(() => "ja");
  const calls = [];
  const api = createApiClient({
    accessToken: async () => "token",
    refresh: async () => {},
    fetch: async (_path, options) => {
      calls.push(options);
      return calls.length === 1 ? Response.json({}, { status: 401 }) : Response.json({});
    },
  });
  await api("/api/me");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.headers["Accept-Language"] === "ja"));
});
