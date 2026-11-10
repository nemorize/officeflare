import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./calendar-fixture.mjs";
import { roleTemplates } from "../web/lib/console.ts";

test("Calendar role migration preserves custom roles and supplies assignable permission sets", async (t) => {
  const templates = roleTemplates.filter((template) => template.key.startsWith("calendar-"));
  const f = await fixture(t, {
    beforeRolesMigration: async (db) => {
      await db
        .prepare(
          "INSERT INTO users(id,email_address) VALUES('legacy-calendar','legacy@office.test')",
        )
        .run();
      for (const template of templates) {
        await db
          .prepare("INSERT INTO roles(id,key,label) VALUES(?,?,?)")
          .bind(`legacy-${template.key}`, template.key, "Existing custom role")
          .run();
        await db
          .prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES(?,'mail.access')")
          .bind(`legacy-${template.key}`)
          .run();
      }
      await db
        .prepare(
          "INSERT INTO user_roles(user_id,role_id) VALUES('legacy-calendar','legacy-calendar-user')",
        )
        .run();
    },
  });
  for (const template of templates) {
    const id = `system-${template.key}`;
    const response = await f.mf.dispatchFetch(`https://office.test/api/roles/${id}`, {
      headers: { Authorization: `Bearer ${f.tokens.admin}` },
    });
    assert.equal(response.status, 200);
    const { role } = await response.json();
    assert.match(role.key, new RegExp(`^officeflare-${template.key}-[a-f0-9]{8}$`));
    assert.equal(role.is_system, false);
    assert.equal(role.is_default, template.key === "calendar-user");
    assert.equal(role.assigned_user_count, 0);
    assert.deepEqual([...role.permissions].sort(), [...template.permissions].sort());
    const legacy = await f.db
      .prepare("SELECT label FROM roles WHERE key=?")
      .bind(template.key)
      .first();
    assert.equal(legacy.label, "Existing custom role");
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT permission_key FROM role_permissions WHERE role_id=?")
          .bind(`legacy-${template.key}`)
          .all()
      ).results,
      [{ permission_key: "mail.access" }],
    );
  }
  assert.deepEqual(
    (
      await f.db
        .prepare("SELECT role_id FROM user_roles WHERE user_id='legacy-calendar' ORDER BY role_id")
        .all()
    ).results,
    [{ role_id: "legacy-calendar-user" }],
  );

  const assign = async (actor, role) => {
    await f.db.prepare("DELETE FROM user_roles WHERE user_id=?").bind(actor).run();
    await f.db
      .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
      .bind(actor, role)
      .run();
  };
  await assign("bob", "system-calendar-reader");
  await f.call("/bootstrap", { actor: "bob" });
  await f.call("/calendars", {
    actor: "bob",
    method: "POST",
    data: { name: "Denied" },
    expected: 403,
  });
  const event = {
    title: "Calendar role test",
    start: { date: "2026-11-10" },
    end: { date: "2026-11-11" },
  };
  await f.call("/calendars/primary/events", {
    actor: "bob",
    method: "POST",
    data: event,
    expected: 403,
  });
  await f.call("/admin/settings", { actor: "bob", expected: 403 });
  await assign("bob", "system-calendar-user");
  await f.call("/calendars/primary/events", {
    actor: "bob",
    method: "POST",
    data: event,
    expected: 201,
  });
  await f.call("/admin/settings", { actor: "bob", expected: 403 });

  await assign("no-calendar", "system-calendar-manager");
  const { settings } = await f.call("/admin/settings", { actor: "no-calendar" });
  const changed = await f.call("/admin/settings", {
    actor: "no-calendar",
    method: "PATCH",
    data: { version: settings.version, public_link_password_required: true },
  });
  assert.equal(changed.settings.public_link_password_required, 1);
  await f.call("/bootstrap", { actor: "no-calendar", expected: 403 });
});
