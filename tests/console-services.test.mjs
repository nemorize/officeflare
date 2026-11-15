import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture } from "./calendar-fixture.mjs";

test(
  "service console menus open working pages and calendar policies persist",
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
        "INSERT INTO mail_addresses(id,domain_id,mailbox_id,local_part,send_enabled) VALUES('console-sender','console-domain','console-box','calendar',1),('disabled-sender','console-domain','console-box','disabled',0)",
      ),
    ]);
    const { sending_addresses } = await f.call("/admin/settings", { actor: "admin" });
    assert.deepEqual(sending_addresses, [
      { id: "console-sender", email_address: "calendar@console.test" },
    ]);
    await f.call("/admin/settings", { actor: "alice", expected: 403 });

    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ locale: "ko-KR" });
    t.after(() => context.close());
    const tab = await context.newPage(),
      origin = (await f.mf.ready).origin,
      errors = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(`${origin}/login`);
    await tab.locator('input[type="email"]').fill("admin@office.test");
    await tab
      .locator('input[type="password"]')
      .fill("a long password for calendar integration tests");
    await tab.locator('button[type="submit"]').click();
    await tab.waitForURL((url) => url.pathname !== "/login");
    await tab.goto(`${origin}/console/calendar`);
    const menu = tab.locator(".workspace-sidebar .workspace-nav");
    for (const [path, name] of [
      ["calendar", "캘린더"],
      ["contacts", "연락처"],
      ["wiki", "위키"],
    ])
      await menu.locator(`a[href="/console/${path}"]`).filter({ hasText: name }).waitFor();
    const internal = tab.getByRole("checkbox", {
        name: "워크스페이스 내부 캘린더 공유 허용",
        exact: true,
      }),
      maxDays = tab.getByRole("spinbutton", { name: "공개 링크 최대 유효 기간(일)", exact: true });
    await internal.waitFor();
    assert.equal(await internal.isChecked(), true);
    await internal.uncheck();
    await maxDays.fill("14");
    await tab.getByRole("checkbox", { name: "공개 링크 비밀번호 필수", exact: true }).check();
    await tab.getByRole("combobox", { name: "발신 주소", exact: true }).click();
    await tab.getByRole("option", { name: "calendar@console.test", exact: true }).click();
    await tab.getByRole("button", { name: "변경 사항 저장", exact: true }).click();
    await tab
      .getByRole("button", { name: "변경 사항 저장", exact: true })
      .waitFor({ state: "visible" });
    await tab.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled);
    const { settings } = await f.call("/admin/settings", { actor: "admin" });
    assert.equal(settings.internal_sharing_enabled, 0);
    assert.equal(settings.public_link_max_days, 14);
    assert.equal(settings.public_link_password_required, 1);
    assert.equal(settings.system_address_id, "console-sender");
    await tab.reload();
    await maxDays.waitFor();
    assert.equal(await maxDays.inputValue(), "14");
    assert.equal(await internal.isChecked(), false);

    await menu.locator('a[href="/console/wiki"]').click();
    await tab.getByRole("heading", { name: "위키", exact: true }).waitFor();
    await tab.locator('table a[href="/console/roles/system-wiki-user"]').waitFor();
    assert.equal(
      await tab.locator('table a[href="/console/roles/system-contacts-user"]').count(),
      0,
    );
    await menu.locator('a[href="/console/contacts"]').click();
    await tab.getByRole("heading", { name: "연락처", exact: true }).waitFor();
    await tab.locator('table a[href="/console/roles/system-contacts-user"]').waitFor();
    assert.equal(await tab.locator('table a[href="/console/roles/system-wiki-user"]').count(), 0);
    await tab.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.equal(
      await tab
        .locator(".console-table-scroll")
        .evaluate((node) => node.scrollWidth > node.clientWidth),
      true,
    );
    await tab.setViewportSize({ width: 1280, height: 720 });
    await tab.locator('table a[href="/console/roles/system-contacts-user"]').click();
    await tab.getByRole("heading", { name: "역할 정보", exact: true }).waitFor();

    await f.db.batch([
      f.db.prepare(
        "INSERT INTO roles(id,key,label) VALUES('console-reader','console-reader','Console reader')",
      ),
      f.db.prepare(
        "INSERT INTO role_permissions(role_id,permission_key) VALUES('console-reader','console.access'),('console-reader','admin.calendar.settings.read'),('console-reader','admin.roles.read')",
      ),
      f.db.prepare("DELETE FROM user_roles WHERE user_id='admin'"),
      f.db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('admin','console-reader')"),
    ]);
    await tab.goto(`${origin}/console/calendar`);
    await maxDays.waitFor();
    assert.equal(await maxDays.isDisabled(), true);
    assert.equal(await internal.isDisabled(), true);
    assert.equal(
      await tab.getByRole("combobox", { name: "발신 주소", exact: true }).isDisabled(),
      true,
    );
    assert.equal(await tab.getByRole("button", { name: "변경 사항 저장", exact: true }).count(), 0);
    await tab.goto(`${origin}/console/wiki`);
    await tab.locator('table a[href="/console/roles/system-wiki-user"]').waitFor();
    assert.equal(await tab.getByRole("button", { name: "새 역할", exact: true }).count(), 0);
    await f.call("/admin/settings", {
      actor: "admin",
      method: "PATCH",
      data: { version: settings.version, public_link_max_days: 30 },
      expected: 403,
    });
    await f.db
      .prepare(
        "DELETE FROM role_permissions WHERE role_id='console-reader' AND permission_key<>'console.access'",
      )
      .run();
    for (const path of ["calendar", "wiki", "contacts"]) {
      await tab.goto(`${origin}/console/${path}`);
      await tab.getByRole("heading", { name: "접근 제한됨", exact: true }).waitFor();
      assert.equal(await menu.locator(`a[href="/console/${path}"]`).count(), 0);
    }
    assert.deepEqual(errors, []);
  },
);
