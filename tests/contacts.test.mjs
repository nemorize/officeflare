import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "../src/db/schema.ts";
import {
  contactsUserPermissions,
  defaultEligible,
  permissionClosure,
} from "../src/authorization/permissions.ts";
import { roleTemplates } from "../web/lib/console.ts";
import { fixture as calendarFixture } from "./calendar-fixture.mjs";
import { recoverContacts } from "../src/contacts/jobs.ts";

async function fixture(t, options) {
  const f = await calendarFixture(t, options);
  for (const actor of ["alice", "bob", "read-only"])
    await f.db
      .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
      .bind(actor, actor === "read-only" ? "system-contacts-reader" : "system-contacts-user")
      .run();
  let operation = 0;
  const raw = (
    path = "",
    { actor = "alice", method = "GET", data, headers = {}, fault = false } = {},
  ) => {
    const init = {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${f.tokens[actor]}` } : {}),
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "POST" ? { "Idempotency-Key": `contacts-test-${++operation}` } : {}),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    };
    const url = "https://office.test/api/contacts" + path;
    return fault ? f.faults.fetch(url, init) : f.mf.dispatchFetch(url, init);
  };
  const call = async (path = "", options = {}) => {
    const response = await raw(path, options);
    assert.equal(
      response.status,
      options.expected ?? 200,
      `${options.method ?? "GET"} ${path}: ${await response.clone().text()}`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.status === 204 ? null : response.json();
  };
  const create = async (data, options = {}) =>
    (await call("", { method: "POST", data, expected: 201, ...options })).contact;
  const get = async (id, options = {}) => (await call(`/${id}`, options)).contact;
  const patch = async (value, data, options = {}) =>
    call(`/${value.id}`, {
      method: "PATCH",
      data: { version: value.version, ...data },
      ...options,
    });
  const folder = async (name, parent_id = null, options = {}) =>
    (
      await call("/folders", {
        method: "POST",
        data: { name, parent_id },
        expected: 201,
        ...options,
      })
    ).folder;
  return { ...f, raw, call, create, get, patch, folder, calendarCall: f.call };
}

test("Contacts migrations match models and roles preserve existing assignments", async (t) => {
  const f = await fixture(t, {
    beforeContactsRolesMigration: async (db) => {
      await db
        .prepare(
          "INSERT INTO roles(id,key,label) VALUES('custom-contacts','contacts-user','Custom contacts')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO role_permissions(role_id,permission_key) VALUES('custom-contacts','mail.access')",
        )
        .run();
    },
  });
  for (const model of [
    schema.contactBooks,
    schema.contactFolders,
    schema.contacts,
    schema.contactEmails,
    schema.contactPhones,
    schema.contactAddresses,
    schema.contactLinks,
    schema.contactFieldDefinitions,
    schema.contactFieldValues,
    schema.contactOperations,
  ]) {
    const columns = (await f.db.prepare(`PRAGMA table_info(${getTableName(model)})`).all()).results
      .map((column) => column.name)
      .sort();
    assert.deepEqual(columns, Object.keys(getTableColumns(model)).sort());
  }
  const role = await f.db.prepare("SELECT * FROM roles WHERE id='system-contacts-user'").first();
  assert.match(role.key, /^officeflare-contacts-user-[a-f0-9]{8}$/);
  assert.equal(role.is_default, 1);
  assert.equal(role.is_system, 0);
  assert.equal(
    (await f.db.prepare("SELECT label FROM roles WHERE id='custom-contacts'").first()).label,
    "Custom contacts",
  );
  const grants = (
    await f.db
      .prepare(
        "SELECT permission_key FROM role_permissions WHERE role_id='system-contacts-user' ORDER BY permission_key",
      )
      .all()
  ).results.map((row) => row.permission_key);
  assert.deepEqual(grants, [...contactsUserPermissions].sort());
  assert.equal(defaultEligible(grants), true);
  assert.deepEqual(permissionClosure(grants).sort(), grants);
  assert.deepEqual(roleTemplates.find((role) => role.key === "contacts-user").permissions, [
    ...contactsUserPermissions,
  ]);
  assert.deepEqual(roleTemplates.find((role) => role.key === "contacts-reader").permissions, [
    "contacts.access",
  ]);
  assert.deepEqual(
    (await f.call("/capabilities")).permissions,
    [...contactsUserPermissions].sort(),
  );
  await f.call("/capabilities", { actor: null, expected: 401 });
  await f.call("/capabilities", { actor: "no-calendar", expected: 403 });
  assert.equal((await f.call("/capabilities")).shared_books, false);
  assert.equal((await f.call("/books")).books.length, 1);
});

test("Contacts isolate private books and enforce read-only roles on every mutation", async (t) => {
  const f = await fixture(t),
    alice = await f.create({
      display_name: "Alice private",
      emails: [{ email_address: "Alice@External.test" }],
    }),
    bobFolder = await f.folder("Bob", null, { actor: "bob" });
  await f.call(`/${alice.id}`, { actor: "bob", expected: 404 });
  await f.patch(alice, { display_name: "No" }, { actor: "bob", expected: 404 });
  assert.equal((await f.call("", { actor: "bob" })).contacts.length, 0);
  assert.equal((await f.call("/suggestions?q=Alice", { actor: "bob" })).suggestions.length, 0);
  assert.equal(
    (await f.call("/lookup?email_address=alice%40external.test", { actor: "bob" })).contacts.length,
    0,
  );
  await f.call(`?book_id=${alice.book_id}`, { actor: "bob", expected: 404 });
  await f.patch(alice, { folder_id: bobFolder.id }, { expected: 404 });
  await f.call("", {
    method: "POST",
    data: { book_id: alice.book_id, display_name: "No" },
    actor: "bob",
    expected: 404,
  });
  await f.call("", { actor: "read-only" });
  for (const [path, method, data] of [
    ["", "POST", { display_name: "No" }],
    [`/${alice.id}`, "PATCH", { version: 1 }],
    [`/${alice.id}?version=1`, "DELETE"],
    [`/${alice.id}/restore`, "POST", { version: 1 }],
    [`/${alice.id}/permanent?version=1`, "DELETE"],
    ["/folders", "POST", { name: "No" }],
    ["/folders/missing", "PATCH", { version: 1, name: "No" }],
    ["/folders/missing?version=1", "DELETE"],
    ["/field-definitions", "POST", { key: "no", label: "No", value_type: "text" }],
    ["/field-definitions/missing", "PATCH", { version: 1 }],
    ["/field-definitions/missing?version=1", "DELETE"],
  ]) {
    await f.call(path, { method, data, actor: "read-only", expected: 403 });
  }
  assert.equal((await f.get(alice.id)).display_name, "Alice private");
});

test("Contact aggregates support repeated fields, typed custom values and versioned replacement", async (t) => {
  const f = await fixture(t),
    fields = [];
  for (const [key, value_type, value, options] of [
    ["memo", "text", "사무실"],
    ["rank", "number", 7.5],
    ["active", "boolean", false],
    ["anniversary", "date", "2024-02-29"],
    ["portal", "url", "https://example.test"],
    ["tier", "select", "A", ["A", "B"]],
    ["teams", "multiselect", ["A", "B"], ["A", "B"]],
  ]) {
    const { field } = await f.call("/field-definitions", {
      method: "POST",
      expected: 201,
      data: { key, label: key, value_type, ...(options ? { options } : {}) },
    });
    fields.push({ field, value });
  }
  const contact = await f.create({
    display_name: "김연락",
    given_name: "연락",
    family_name: "김",
    organization: "Officeflare",
    birthday: "2000-02-29",
    notes: "메모",
    emails: [
      { email_address: "First@Example.test", label: "work" },
      { email_address: "second@example.test", is_primary: true },
    ],
    phones: [{ phone_number: "+82 (10) 1234-5678", extension: "12" }],
    addresses: [{ country_code: "kr", city: "서울", street_address: "테스트로 1" }],
    links: [{ url: "https://example.test", label: "회사" }],
    custom_fields: fields.map(({ field, value }) => ({ field_id: field.id, value })),
  });
  assert.equal(contact.emails[0].email_address, "First@Example.test");
  assert.equal(contact.emails[0].is_primary, false);
  assert.equal(contact.emails[1].is_primary, true);
  assert.equal(contact.addresses[0].country_code, "KR");
  assert.equal("email_key" in contact.emails[0], false);
  assert.equal("display_name_key" in contact, false);
  const stored = await f.get(contact.id);
  assert.deepEqual(stored, contact);
  assert.equal((await f.call("?q=Office")).contacts[0].primary_email, "second@example.test");
  assert.equal((await f.call("?q=%2B8210")).contacts[0].id, contact.id);
  assert.equal(
    (await f.call("/lookup?email_address=FIRST%40EXAMPLE.TEST")).contacts[0].id,
    contact.id,
  );
  const changed = (
    await f.patch(contact, {
      notes: "changed",
      emails: [{ id: contact.emails[1].id, email_address: "new@example.test" }],
      phones: [],
    })
  ).contact;
  assert.equal(changed.version, 2);
  assert.equal(changed.emails[0].id, contact.emails[1].id);
  assert.equal(changed.emails[0].is_primary, true);
  assert.equal(changed.phones.length, 0);
  assert.deepEqual(changed.addresses, contact.addresses);
  assert.deepEqual(changed.custom_fields, contact.custom_fields);
  await f.patch(contact, { emails: [], custom_fields: [] }, { expected: 412 });
  assert.deepEqual(await f.get(contact.id), changed);
  await f.call(`/${contact.id}`, { method: "PATCH", data: { notes: "no version" }, expected: 428 });
  const response = await f.raw(`/${contact.id}`, {
    method: "PATCH",
    data: { notes: "header version" },
    headers: { "If-Match": '"v2"' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"v3"');
  await f.patch({ ...contact, version: 3 }, { birthday: "2025-02-29" }, { expected: 400 });
  await f.patch(
    { ...contact, version: 3 },
    { links: [{ url: "javascript:alert(1)" }] },
    { expected: 400 },
  );
  await f.create({ phones: [{ phone_number: "010-1111-2222" }] });
  await f.call("", {
    method: "POST",
    data: {
      display_name: "Duplicate",
      emails: [{ email_address: "a@example.test" }, { email_address: "A@example.test" }],
    },
    expected: 400,
  });
  const other = await f.create({
    display_name: "Other",
    emails: [{ email_address: "other@example.test" }],
  });
  await f.patch(
    { ...contact, version: 3 },
    { emails: [{ id: other.emails[0].id, email_address: "new@example.test" }] },
    { expected: 400 },
  );
  await f.call(`/field-definitions/${fields[0].field.id}`, {
    method: "PATCH",
    data: { version: 1, value_type: "number" },
    expected: 409,
  });
  await f.call(`/field-definitions/${fields[0].field.id}?version=1`, {
    method: "DELETE",
    expected: 204,
  });
  assert.equal((await f.get(contact.id)).custom_fields.length, 7);
  await f.patch({ ...contact, version: 3 }, { custom_fields: contact.custom_fields });
  await f.call("", {
    method: "POST",
    data: {
      display_name: "No archived",
      custom_fields: [{ field_id: fields[0].field.id, value: "new" }],
    },
    expected: 400,
  });
});

test("Contact folder tree has one membership, prevents cycles and retains trash references", async (t) => {
  const f = await fixture(t),
    root = await f.folder("고객"),
    child = await f.folder("거래처", root.id),
    other = await f.folder("Other");
  await f.call("/folders", { method: "POST", data: { name: "고객" }, expected: 409 });
  await f.call(`/folders/${root.id}`, {
    method: "PATCH",
    data: { version: 1, parent_id: child.id },
    expected: 409,
  });
  assert.equal(
    (await f.call("/folders")).folders.find((item) => item.id === root.id).parent_id,
    null,
  );
  const value = await f.create({ display_name: "고객 1", folder_id: child.id });
  assert.equal((await f.call(`?folder_id=${child.id}`)).contacts.length, 1);
  const moved = (await f.patch(value, { folder_id: other.id })).contact;
  assert.equal((await f.call(`?folder_id=${child.id}`)).contacts.length, 0);
  assert.equal((await f.call(`?folder_id=${other.id}`)).contacts.length, 1);
  await f.call(`/folders/${root.id}?version=1`, { method: "DELETE", expected: 409 });
  await f.call(`/folders/${child.id}?version=1`, { method: "DELETE", expected: 204 });
  await f.call(`/${moved.id}?version=2`, { method: "DELETE", expected: 204 });
  await f.call(`/folders/${other.id}?version=1`, { method: "DELETE", expected: 409 });
  assert.equal((await f.call("?trashed=true")).contacts[0].id, moved.id);
  const restored = (
    await f.call(`/${moved.id}/restore`, { method: "POST", data: { version: 3, folder_id: null } })
  ).contact;
  assert.equal(restored.folder_id, null);
  assert.equal((await f.call("?folder_id=root")).contacts[0].id, moved.id);
  await f.call(`/folders/${other.id}?version=1`, { method: "DELETE", expected: 204 });
  await f.call(`/${moved.id}/permanent?version=4`, { method: "DELETE", expected: 404 });
  await f.call(`/${moved.id}?version=4`, { method: "DELETE", expected: 204 });
  await f.call(`/${moved.id}/permanent?version=5`, { method: "DELETE", expected: 204 });
  await f.call(`/${moved.id}?trashed=true`, { expected: 404 });
});

test("Contact search handles Korean, scoped cursors, email variants and trash", async (t) => {
  const f = await fixture(t);
  for (const name of ["가나다", "가나래", "가나리"])
    await f.create({
      display_name: name,
      emails: [
        {
          email_address: `${name === "가나다" ? "shared" : name === "가나래" ? "other" : "third"}@example.test`,
        },
      ],
    });
  await f.create({
    display_name: "가나다 duplicate",
    emails: [{ email_address: "SHARED@example.test" }],
  });
  const first = await f.call("?q=가나&limit=2");
  assert.equal(first.contacts.length, 2);
  assert.ok(first.next_cursor);
  const next = await f.call(`?q=가나&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`);
  assert.equal(next.contacts.length, 2);
  assert.equal(next.next_cursor, null);
  assert.equal(new Set([...first.contacts, ...next.contacts].map((item) => item.id)).size, 4);
  await f.call(`?q=other&cursor=${encodeURIComponent(first.next_cursor)}`, { expected: 400 });
  await f.call(`?q=가나&cursor=${encodeURIComponent(first.next_cursor)}`, {
    actor: "bob",
    expected: 400,
  });
  assert.equal((await f.call("/suggestions?q=가나")).suggestions.length, 3);
  assert.equal((await f.call("/lookup?email_address=shared%40example.test")).contacts.length, 2);
  assert.equal((await f.call("/suggestions?q=%25")).suggestions.length, 0);
  const candidate = first.contacts[0];
  await f.call(`/${candidate.id}?version=1`, { method: "DELETE", expected: 204 });
  assert.equal(
    (await f.call("/suggestions?q=가나")).suggestions.some(
      (item) => item.contact_id === candidate.id,
    ),
    false,
  );
  await f.call("?trashed=invalid", { expected: 400 });
});

test("Contact mutations replay safely, roll back failures and recheck authorization at commit", async (t) => {
  const f = await fixture(t),
    input = { display_name: "Retry", emails: [{ email_address: "retry@example.test" }] },
    headers = { "Idempotency-Key": "same-create" };
  const value = await f.create(input, { headers });
  assert.deepEqual(await f.create(input, { headers }), value);
  await f.call("", {
    method: "POST",
    data: { ...input, display_name: "Different" },
    headers,
    expected: 409,
  });
  const before = (await f.call("")).contacts.length;
  await f.call("", {
    method: "POST",
    data: { display_name: "Rolled back", emails: [{ email_address: "rollback@example.test" }] },
    fault: true,
    headers: { "x-test-fail-batch": "1" },
    expected: 500,
  });
  assert.equal((await f.call("")).contacts.length, before);
  assert.equal((await f.call("/lookup?email_address=rollback%40example.test")).contacts.length, 0);
  await f.patch(
    value,
    { emails: [{ email_address: "failed@example.test" }] },
    { fault: true, headers: { "x-test-fail-batch": "1" }, expected: 500 },
  );
  assert.deepEqual(await f.get(value.id), value);
  await f.patch(
    value,
    { display_name: "Stale" },
    {
      fault: true,
      headers: {
        "x-test-before-batch": `UPDATE contacts SET version=version+1 WHERE id='${value.id}'`,
      },
      expected: 412,
    },
  );
  assert.equal((await f.get(value.id)).display_name, "Retry");
  await f.patch(
    { ...value, version: 2 },
    { emails: [] },
    {
      fault: true,
      headers: {
        "x-test-before-batch":
          "DELETE FROM user_roles WHERE user_id='alice' AND role_id='system-contacts-user'",
      },
      expected: 403,
    },
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT COUNT(*) count FROM contact_emails WHERE contact_id=?")
        .bind(value.id)
        .first()
    ).count,
    1,
  );
  await f.call("/suggestions?q=Retry", { expected: 403 });
  await f.db.prepare("UPDATE contact_operations SET expires_at=0").run();
  await recoverContacts({ DB: f.db });
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) count FROM contact_operations").first()).count,
    0,
  );
});

test("Calendar invitations keep selected address snapshots after a contact changes", async (t) => {
  const f = await fixture(t),
    value = await f.create({
      display_name: "External Guest",
      emails: [{ email_address: "guest@external.test" }],
    });
  const [suggestion] = (await f.call("/suggestions?q=External")).suggestions;
  const { event } = await f.calendarCall("/calendars/primary/events", {
    method: "POST",
    expected: 201,
    data: {
      title: "Contact invitation",
      start: { date: "2026-11-10" },
      end: { date: "2026-11-11" },
      attendees: [
        { email_address: suggestion.email_address, display_name: suggestion.display_name },
      ],
    },
  });
  await f.patch(value, {
    display_name: "Changed",
    emails: [{ email_address: "changed@external.test" }],
  });
  const { attendees } = await f.calendarCall(`/calendars/primary/events/${event.id}/attendees`);
  assert.equal(attendees[0].email_address, "guest@external.test");
  assert.equal(attendees[0].display_name, "External Guest");
  assert.equal("contact_id" in attendees[0], false);
  await f.create({
    display_name: attendees[0].display_name,
    emails: [{ email_address: attendees[0].email_address }],
  });
});

test("Contact writes stay bounded with fifty custom fields and reject definition races", async (t) => {
  const f = await fixture(t),
    target = (await f.call("/books")).books[0];
  await f.db.batch(
    Array.from({ length: 50 }, (_, index) =>
      f.db
        .prepare(
          "INSERT INTO contact_field_definitions(id,book_id,key,label,value_type) VALUES(?,?,?,?, 'text')",
        )
        .bind(`field-${index}`, target.id, `field_${index}`, `Field ${index}`),
    ),
  );
  const value = await f.create({
    display_name: "Many fields",
    custom_fields: Array.from({ length: 50 }, (_, index) => ({
      field_id: `field-${index}`,
      value: `value ${index}`,
    })),
    emails: [{ email_address: "many@example.test" }],
    phones: [{ phone_number: "010-1234-5678" }],
    addresses: [{ city: "서울" }],
    links: [{ url: "https://example.test" }],
  });
  assert.equal((await f.get(value.id)).custom_fields.length, 50);
  await f.patch(
    value,
    { custom_fields: [{ field_id: "field-0", value: "validated before race" }] },
    {
      fault: true,
      headers: {
        "x-test-before-batch":
          "UPDATE contact_field_definitions SET version=version+1,archived_at=unixepoch() WHERE id='field-0'",
      },
      expected: 412,
    },
  );
  assert.equal((await f.get(value.id)).custom_fields.length, 50);
  const bobBook = (await f.call("/books", { actor: "bob" })).books[0];
  await f.db
    .prepare(
      "INSERT INTO contact_field_definitions(id,book_id,key,label,value_type) VALUES('bob-field',?,'bob_field','Bob field','text')",
    )
    .bind(bobBook.id)
    .run();
  await assert.rejects(
    () =>
      f.db
        .prepare(
          "INSERT INTO contact_field_values(book_id,contact_id,field_id,value_json) VALUES(?,?,?,'1')",
        )
        .bind(bobBook.id, value.id, "bob-field")
        .run(),
    /FOREIGN KEY/,
  );
  await f.call(`/${value.id}?version=1`, { method: "DELETE", expected: 204 });
  await f.call(`/${value.id}/permanent?version=2`, { method: "DELETE", expected: 204 });
  for (const table of [
    "contact_emails",
    "contact_phones",
    "contact_addresses",
    "contact_links",
    "contact_field_values",
  ])
    assert.equal(
      (
        await f.db
          .prepare(`SELECT COUNT(*) count FROM ${table} WHERE contact_id=?`)
          .bind(value.id)
          .first()
      ).count,
      0,
    );
});
