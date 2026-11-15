import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture } from "./calendar-fixture.mjs";

test(
  "granular console tabs save real policies and general settings contain notifications",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { assets: true });
    await f.db.batch([
      f.db.prepare(
        "INSERT INTO mail_domains(id,name,provider_settings_json,outbound_enabled) VALUES('console-domain','console.test',json_object('outbound',json_object('id','cloudflare-bindings','provider','cloudflare','config',json('{}'))),1)",
      ),
      f.db.prepare(
        "INSERT INTO mail_mailboxes(id,owner_user_id,name,status) VALUES('console-box','admin','Calendar sender','active')",
      ),
      f.db.prepare(
        "INSERT INTO mail_addresses(id,domain_id,mailbox_id,local_part,send_enabled) VALUES('console-sender','console-domain','console-box','calendar',1)",
      ),
    ]);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "ko-KR",
      viewport: { width: 1440, height: 1000 },
    });
    t.after(() => context.close());
    const tab = await context.newPage(),
      origin = (await f.mf.ready).origin,
      errors = [];
    tab.on("pageerror", (e) => errors.push(e.message));
    await tab.goto(origin + "/login");
    await tab.locator("input[type=email]").fill("admin@office.test");
    await tab
      .locator("input[type=password]")
      .fill("a long password for calendar integration tests");
    await tab.locator("button[type=submit]").click();
    await tab.waitForURL((url) => url.pathname !== "/login");
    const root = tab.locator(".console-page");
    async function save(endpoint) {
      const [response] = await Promise.all([
        tab.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === endpoint &&
            response.request().method() === "PATCH",
        ),
        root.getByRole("button", { name: "변경 사항 저장", exact: true }).click(),
      ]);
      assert.ok(response.ok(), await response.text());
      await tab.waitForFunction(
        () => !!document.querySelector('.console-page button[type="submit"]')?.disabled,
      );
    }
    await tab.goto(origin + "/console/calendar");
    await tab.waitForURL(/\/calendar\/overview$/);
    for (const label of [
      "개요",
      "캘린더 목록",
      "공유",
      "초대 및 발송",
      "가져오기 및 구독",
      "감사 로그",
    ])
      await root.getByRole("tab", { name: label, exact: true }).waitFor();
    await root.getByRole("tab", { name: "공유", exact: true }).click();
    await root
      .getByRole("checkbox", { name: "워크스페이스 내부 캘린더 공유 허용", exact: true })
      .uncheck();
    await root
      .getByRole("spinbutton", { name: "공개 링크 최대 유효 기간(일)", exact: true })
      .fill("14");
    await save("/api/calendar/admin/settings");
    await root.getByRole("tab", { name: "초대 및 발송", exact: true }).click();
    await root.getByRole("combobox", { name: "발신 주소", exact: true }).click();
    await tab.getByRole("option", { name: "calendar@console.test", exact: true }).click();
    await save("/api/calendar/admin/settings");
    await root.getByRole("tab", { name: "가져오기 및 구독", exact: true }).click();
    await root
      .getByRole("checkbox", { name: "iCalendar 파일 가져오기 허용", exact: true })
      .uncheck();
    await save("/api/calendar/admin/settings");
    const settings = (await f.call("/admin/settings", { actor: "admin" })).settings;
    assert.equal(settings.public_link_max_days, 14);
    assert.equal(settings.internal_sharing_enabled, 0);
    assert.equal(settings.system_address_id, "console-sender");
    assert.equal(settings.imports_enabled, 0);

    await tab.goto(origin + "/console/contacts/contacts");
    await root
      .getByRole("spinbutton", { name: "계정별 연락처 한도(휴지통 포함)", exact: true })
      .fill("250");
    await save("/api/console/contacts/settings");
    assert.equal(await root.locator('a[href^="/console/roles/"]').count(), 0);
    for (const label of ["계정 및 사용 현황", "연락처", "폴더", "사용자 정의 필드", "감사 로그"])
      await root.getByRole("tab", { name: label, exact: true }).waitFor();
    await tab.goto(origin + "/console/wiki/settings");
    await root.getByRole("checkbox", { name: "새 팀 공간 생성 허용", exact: true }).uncheck();
    await save("/api/console/wiki/settings");
    assert.equal(await root.locator('a[href^="/console/roles/"]').count(), 0);
    for (const label of ["개요", "공간", "페이지", "공유", "정책", "감사 로그"])
      await root.getByRole("tab", { name: label, exact: true }).waitFor();

    await tab.goto(origin + "/console/general/workspace");
    await root
      .getByRole("textbox", { name: "워크스페이스 이름", exact: true })
      .fill("테스트 오피스");
    await root
      .getByRole("textbox", { name: "도움말 URL", exact: true })
      .fill("https://example.test/help");
    await save("/api/console/general/settings");
    await tab.waitForFunction(() => document.title.includes("테스트 오피스"));
    assert.equal(
      await tab.locator('.workspace-rail a[aria-label="도움말"]').getAttribute("href"),
      "https://example.test/help",
    );
    const menu = tab.locator(".workspace-sidebar .workspace-nav");
    assert.equal(await menu.locator('a[href="/console/notifications"]').count(), 0);
    await menu.locator('a[href="/console/general"]').filter({ hasText: "일반" }).waitFor();
    await tab.goto(origin + "/console/notifications");
    await tab.waitForURL(/\/general\/notifications$/);
    await root.getByRole("heading", { name: "일반", level: 1, exact: true }).waitFor();
    await root.getByRole("heading", { name: "알림 설정", level: 2, exact: true }).waitFor();

    await f.db.batch([
      f.db.prepare(
        "INSERT INTO roles(id,key,label) VALUES('console-reader','console-reader','Console reader')",
      ),
      f.db.prepare(
        'INSERT INTO role_permissions(role_id,permission_key) SELECT \'console-reader\',value FROM json_each(\'["console.access","admin.calendar.settings.read","admin.calendar.records.read","admin.contacts.settings.read","admin.contacts.accounts.read","admin.wiki.settings.read","admin.wiki.content.read","admin.workspace.settings.read","admin.notifications.settings.read"]\')',
      ),
      f.db.prepare("DELETE FROM user_roles WHERE user_id='admin'"),
      f.db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('admin','console-reader')"),
    ]);
    for (const [path, label] of [
      ["contacts/contacts", "새 연락처 생성 허용"],
      ["wiki/settings", "새 팀 공간 생성 허용"],
      ["calendar/integrations", "iCalendar 파일 가져오기 허용"],
    ]) {
      await tab.goto(origin + "/console/" + path);
      const checkbox = root.getByRole("checkbox", { name: label, exact: true });
      await checkbox.waitFor();
      assert.equal(await checkbox.isDisabled(), true);
      assert.equal(
        await root.getByRole("button", { name: "변경 사항 저장", exact: true }).count(),
        0,
      );
    }
    await f.db
      .prepare(
        "DELETE FROM role_permissions WHERE role_id='console-reader' AND permission_key<>'console.access'",
      )
      .run();
    for (const path of [
      "general/workspace",
      "calendar/sharing",
      "wiki/settings",
      "contacts/fields",
    ]) {
      await tab.goto(origin + "/console/" + path);
      await tab.getByRole("heading", { name: "접근 제한됨", exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
  },
);
