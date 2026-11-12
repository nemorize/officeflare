import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contactDraft,
  contactPayload,
  folderOptions,
  contactLocation,
} from "../web/lib/contact-model.ts";
import { returnToWorkspace } from "../web/lib/profile.ts";
import { workspaceApps } from "../web/lib/workspace-navigation.ts";
import { fixture } from "./calendar-fixture.mjs";

test("contact editor preserves zero, false, archived values and a contact's explicit root folder", () => {
  const fields = [
    { id: "score", label: "Score", value_type: "number", archived_at: null },
    { id: "active", label: "Active", value_type: "boolean", archived_at: null },
    { id: "legacy", label: "Legacy", value_type: "text", archived_at: 1 },
    { id: "unset", label: "Unset", value_type: "date", archived_at: null },
  ];
  const draft = contactDraft();
  draft.display_name = "Kim";
  draft.custom_fields = {
    score: "0",
    active: false,
    legacy: "Retain this",
    unset: "",
    untouched: undefined,
  };
  draft.emails = [
    {
      id: "existing-email",
      email_address: "Kim@Example.test",
      label: "Work",
      is_primary: true,
      sort_order: 8,
      draft_key: "local-only",
    },
  ];
  const values = contactPayload(draft, fields);
  assert.deepEqual(values.custom_fields, [
    { field_id: "score", value: 0 },
    { field_id: "active", value: false },
    { field_id: "legacy", value: "Retain this" },
  ]);
  assert.equal(values.emails[0].id, "existing-email");
  assert.equal(values.emails[0].sort_order, 0);
  assert.equal("draft_key" in values.emails[0], false);
  const record = { ...draft, folder_id: null, custom_fields: [], birthday: null };
  assert.equal(contactDraft(record, "current-folder").folder_id, null);
  draft.custom_fields.score = "not a number";
  assert.throws(() => contactPayload(draft, fields), /Score/);
});

test("contact editor removes blank rows without losing primary selection or child identifiers", () => {
  const draft = contactDraft();
  assert.throws(() => contactPayload(draft, []), /name/);
  draft.emails = [
    { email_address: "", label: "", is_primary: true, sort_order: 0 },
    {
      id: "retained",
      email_address: "person@example.test",
      label: "Home",
      is_primary: false,
      sort_order: 2,
    },
  ];
  const values = contactPayload(draft, []);
  assert.equal(values.emails.length, 1);
  assert.equal(values.emails[0].is_primary, true);
  assert.equal(values.emails[0].id, "retained");
  assert.equal(draft.emails.length, 2);
});

test("folder choices preserve ancestry and exclude the entire moved subtree", () => {
  const folders = [
    { id: "a", parent_id: null, name: "Customers" },
    { id: "b", parent_id: "a", name: "Partners" },
    { id: "c", parent_id: "b", name: "Seoul" },
    { id: "d", parent_id: null, name: "Friends" },
  ];
  assert.deepEqual(
    folderOptions(folders).map((item) => item.label),
    [
      "Address book root",
      "Customers",
      "Customers / Partners",
      "Customers / Partners / Seoul",
      "Friends",
    ],
  );
  assert.deepEqual(
    folderOptions(folders, "a").map((item) => item.value),
    ["root", "d"],
  );
  assert.deepEqual(
    folderOptions(folders, "b").map((item) => item.value),
    ["root", "a", "d"],
  );
});

test("contacts navigation restores authorized route shapes without accepting arbitrary redirects", () => {
  for (const path of [
    "/contacts",
    "/contacts/unfiled",
    "/contacts/trash",
    "/contacts/fields",
    "/contacts/folders/abc-123",
  ])
    assert.equal(returnToWorkspace(path), path);
  for (const path of [
    "//evil.test/contacts",
    "/contacts/folders/../../console",
    "/contacts/missing",
    "/contacts?redirect=evil",
  ])
    assert.equal(returnToWorkspace(path), "/");
  assert.deepEqual(contactLocation("/contacts/folders/abc-123"), {
    folder: "abc-123",
    trash: false,
    unfiled: false,
  });
  assert.equal(contactLocation("/contacts/trash").trash, true);
  assert.equal(workspaceApps.find((app) => app.path === "/contacts").permission, "contacts.access");
});

test("editing a loaded contact round-trips all backend fields and preserves archived custom data", async (t) => {
  const f = await fixture(t);
  await f.db
    .prepare("INSERT INTO user_roles(user_id,role_id) VALUES('alice','system-contacts-user')")
    .run();
  const request = async (path, method = "GET", data) => {
    const response = await f.mf.dispatchFetch("https://office.test/api/contacts" + path, {
      method,
      headers: { Authorization: `Bearer ${f.tokens.alice}`, "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    assert.equal(response.status, method === "POST" ? 201 : 200, await response.clone().text());
    return response.json();
  };
  const { field } = await request("/field-definitions", "POST", {
    key: "member",
    label: "Member",
    value_type: "boolean",
  });
  const { contact } = await request("", "POST", {
    display_name: "Hana Kim",
    emails: [{ email_address: "hana@example.test" }],
    phones: [{ phone_number: "+82 10 1234 5678", extension: "42" }],
    addresses: [{ city: "서울", street_address: "테스트로 1", country_code: "KR" }],
    links: [{ url: "https://example.test" }],
    custom_fields: [{ field_id: field.id, value: false }],
  });
  await request(`/field-definitions/${field.id}`, "PATCH", {
    version: field.version,
    archived: true,
  });
  const { fields } = await request("/field-definitions?include_archived=true");
  const draft = contactDraft(contact);
  draft.notes = "Edited in the contact screen";
  const { contact: saved } = await request(`/${contact.id}`, "PATCH", {
    version: contact.version,
    ...contactPayload(draft, fields),
  });
  assert.deepEqual(saved.emails, contact.emails);
  assert.deepEqual(saved.phones, contact.phones);
  assert.deepEqual(saved.addresses, contact.addresses);
  assert.deepEqual(saved.links, contact.links);
  assert.deepEqual(saved.custom_fields, contact.custom_fields);
  assert.equal(saved.notes, draft.notes);
  assert.equal(saved.version, contact.version + 1);
});
