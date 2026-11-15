import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./calendar-fixture.mjs";

test(
  "service administration persists policies, enforces limits, protects private data, and inherits general defaults",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { collaboration: true });
    for (const role of ["system-contacts-user", "system-wiki-user"])
      await f.db
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('alice',?)")
        .bind(role)
        .run();
    let sequence = 0;
    const call = async (path, { actor = "admin", method = "GET", data, expected = 200 } = {}) => {
      const response = await f.mf.dispatchFetch(`https://office.test/api${path}`, {
        method,
        headers: {
          ...(actor ? { Authorization: `Bearer ${f.tokens[actor]}` } : {}),
          ...(data ? { "Content-Type": "application/json" } : {}),
          "Idempotency-Key": `admin-test-${++sequence}`,
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${await response.clone().text()}`,
      );
      return response.status === 204 ? null : response.json();
    };
    const save = async (service, changes) => {
      const { settings } = await call(`/console/${service}/settings`);
      return call(`/console/${service}/settings`, {
        method: "PATCH",
        data: { version: settings.version, ...changes },
      });
    };
    for (const path of [
      "contacts/overview",
      "contacts/accounts",
      "contacts/contacts",
      "contacts/folders",
      "contacts/fields",
      "contacts/activity",
      "wiki/overview",
      "wiki/spaces",
      "wiki/pages",
      "wiki/sharing",
      "wiki/activity",
      "calendar/overview",
      "calendar/calendars",
      "calendar/sharing",
      "calendar/invitations",
      "calendar/integrations",
      "calendar/activity",
    ]) {
      await call(`/console/${path}`);
      await call(`/console/${path}`, { actor: "alice", expected: 403 });
      await call(`/console/${path}`, { actor: null, expected: 401 });
    }
    const original = (await call("/console/general/settings")).settings;
    await save("general", {
      workspace_name: "Team Office",
      support_url: "https://example.test/help",
      default_language: "ko",
      default_time_zone: "Asia/Seoul",
      default_regional_format: "ko-KR",
    });
    assert.equal((await call("/workspace", { actor: "alice" })).workspace_name, "Team Office");
    await call("/console/general/settings", {
      method: "PATCH",
      data: { version: original.version, workspace_name: "Stale" },
      expected: 412,
    });
    const current = (await call("/console/general/settings")).settings;
    for (const changes of [
      { support_url: "javascript:alert(1)" },
      { default_time_zone: "Invalid/Zone" },
      { unknown: true },
      { default_language: "invalid" },
    ])
      await call("/console/general/settings", {
        method: "PATCH",
        data: { version: current.version, ...changes },
        expected: 400,
      });
    await call("/console/general/settings", {
      actor: "alice",
      method: "PATCH",
      data: { version: current.version, workspace_name: "Forbidden" },
      expected: 403,
    });
    const created = await call("/users", {
      method: "POST",
      expected: 201,
      data: {
        email_address: "new-console-user@example.test",
        password: "a long password for console tests",
        role_ids: [],
        password_reset_required: false,
      },
    });
    assert.equal(created.user.language, "ko");
    assert.equal(created.user.time_zone, "Asia/Seoul");
    assert.equal(created.user.regional_format, "ko-KR");

    const contact = await call("/contacts", {
      actor: "alice",
      method: "POST",
      expected: 201,
      data: {
        display_name: "Private contact name",
        notes: "Private notes",
        emails: [{ email_address: "private-person@example.test" }],
      },
    });
    assert.ok(contact.contact.id);
    const listing = JSON.stringify(await call("/console/contacts/accounts"));
    assert.doesNotMatch(listing, /Private contact|Private notes|private-person/);
    await save("contacts", { max_contacts: 2 });
    const concurrent = await Promise.all(
      ["Two", "Three"].map((name) =>
        f.mf.dispatchFetch("https://office.test/api/contacts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${f.tokens.alice}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ display_name: name }),
        }),
      ),
    );
    assert.equal(concurrent.filter((response) => response.status === 201).length, 1);
    assert.ok(concurrent.every((response) => [201, 409, 412].includes(response.status)));
    assert.equal((await f.db.prepare("SELECT COUNT(*) count FROM contacts").first()).count, 2);
    await save("contacts", {
      entries_enabled: false,
      folders_enabled: false,
      fields_enabled: false,
    });
    await call("/contacts", {
      actor: "alice",
      method: "POST",
      data: { display_name: "Blocked" },
      expected: 403,
    });
    await call("/contacts/folders", {
      actor: "alice",
      method: "POST",
      data: { name: "Blocked" },
      expected: 403,
    });
    await call("/contacts/field-definitions", {
      actor: "alice",
      method: "POST",
      data: { key: "blocked", label: "Blocked", value_type: "text" },
      expected: 403,
    });
    assert.ok(
      (await call("/console/contacts/activity")).items.some(
        (item) => item.name === "contacts.create",
      ),
    );

    const space = (
      await call("/wiki/spaces", {
        actor: "alice",
        method: "POST",
        expected: 201,
        data: { name: "Team Knowledge" },
      })
    ).space;
    await call(`/wiki/spaces/${space.id}/pages`, {
      actor: "alice",
      method: "POST",
      expected: 201,
      data: {},
    });
    const personal = await f.db
      .prepare("SELECT id FROM wiki_spaces WHERE owner_user_id='alice' AND kind='personal'")
      .first();
    await call(`/wiki/spaces/${personal.id}/pages`, {
      actor: "alice",
      method: "POST",
      expected: 201,
      data: {},
    });
    assert.equal((await call("/console/wiki/spaces")).items.length, 1);
    assert.equal((await call("/console/wiki/pages")).items.length, 1);
    await save("wiki", {
      spaces_enabled: false,
      pages_enabled: false,
      comments_enabled: false,
      sharing_enabled: false,
    });
    await call("/wiki/spaces", {
      actor: "alice",
      method: "POST",
      data: { name: "Blocked" },
      expected: 403,
    });
    await call(`/wiki/spaces/${space.id}/pages`, {
      actor: "alice",
      method: "POST",
      data: {},
      expected: 403,
    });
    const page = (await call("/console/wiki/pages")).items[0];
    await call(`/wiki/pages/${page.id}/comments`, {
      actor: "alice",
      method: "POST",
      data: { body: "Blocked" },
      expected: 403,
    });
    const members = await call(`/wiki/spaces/${space.id}/members`, { actor: "alice" });
    await call(`/wiki/spaces/${space.id}/members`, {
      actor: "alice",
      method: "PUT",
      data: { email: "bob@office.test", role: "viewer", version: members.version },
      expected: 403,
    });

    const config = (await f.call("/admin/settings", { actor: "admin" })).settings;
    await f.call("/admin/settings", {
      actor: "admin",
      method: "PATCH",
      data: { version: config.version, imports_enabled: false, subscriptions_enabled: false },
    });
    const caps = await f.call("/capabilities");
    assert.equal(caps.ics_import, false);
    assert.equal(caps.ics_subscriptions, false);
    await f.call("/calendars/primary/imports", {
      method: "POST",
      data: { content: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR", dry_run: true },
      expected: 403,
    });
    await f.call("/feeds", {
      method: "POST",
      data: { name: "Blocked feed", url: "https://example.com/feed.ics", time_zone: "UTC" },
      expected: 403,
    });
    await assert.rejects(
      f.db.prepare("UPDATE console_audit SET action='changed'").run(),
      /immutable/,
    );
  },
);
