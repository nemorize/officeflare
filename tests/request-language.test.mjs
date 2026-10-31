import { test } from "node:test";
import assert from "node:assert/strict";
import { withRequestLanguage } from "../src/i18n.ts";
import { getLocale, t } from "../shared/i18n/index.ts";
import { permissionCatalog, permissionGroups } from "../src/authorization/permissions.ts";
import { notificationTypes } from "../src/notifications/catalog.ts";

const request = (language) =>
  new Request("https://office.test/api", {
    headers: language ? { "Accept-Language": language } : {},
  });
test("simultaneous request languages remain isolated across asynchronous work", async () => {
  const results = await Promise.all(
    ["ko-KR", "ja-JP", "fr", "en-US"].map((language) =>
      withRequestLanguage(request(language), async () => {
        const initial = t("common.save");
        await new Promise((resolve) => setTimeout(resolve, language === "ko-KR" ? 10 : 0));
        return [
          getLocale(),
          initial,
          t("common.save"),
          permissionGroups.services,
          permissionCatalog["calendar.access"].label,
          notificationTypes["calendar.invited"].label,
        ];
      }),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.slice(0, 3)),
    [
      ["ko", "저장", "저장"],
      ["ja", "保存", "保存"],
      ["en", "Save", "Save"],
      ["en", "Save", "Save"],
    ],
  );
  assert.equal(results[0][3], "서비스 접근 권한");
  assert.equal(results[1][4], "カレンダーにアクセス");
  assert.equal(results[0][5], "일정 초대");
  assert.equal(t("common.save"), "Save");
});
