import { test } from "node:test";
import assert from "node:assert/strict";
import { allRoles, canGrant, changesEndSessions, consoleMenu, managedPermissions, rolePayload, userChanges } from "../web/lib/console.ts";
import { returnToWorkspace } from "../web/lib/profile.ts";

const user = { id: "user-id", display_name: "Alex", email_address: "alex@example.test", disabled_at: null, password_reset_required: false };
const values = { name: "Alex", email: "alex@example.test", disabled: false, passwordReset: false };

test("console navigation is limited to account administration permissions", () => {
  for (const permissions of [[], ["unknown"], ["mail.domains.manage"]]) assert.deepEqual(consoleMenu(permissions), []);
  assert.deepEqual(consoleMenu(["users.read"]).map((item) => item.path), ["/console/users"]);
  assert.deepEqual(consoleMenu(["roles.read"]).map((item) => item.path), ["/console/roles"]);
  assert.deepEqual(consoleMenu(["users.create", "roles.manage"]).map((item) => item.path), ["/console/users", "/console/roles"]);
  assert.equal(canGrant(["users.read"], ["users.read", "users.delete"]), false);
  assert.equal(canGrant(["users.read", "users.delete"], ["users.read"]), true);
});

test("ordinary account edits omit email and security fields that have not changed", () => {
  assert.deepEqual(userChanges(user, { ...values, name: "  New name  ", email: " ALEX@EXAMPLE.TEST " }, ["users.update"]), { display_name: "New name" });
  assert.deepEqual(userChanges(user, values, ["users.update"]), {});
  assert.equal(changesEndSessions({ display_name: "New name" }), false);
  assert.throws(() => userChanges(user, values, ["users.read"]), /permission to update/);
});

test("email changes require their separate grant and security changes preserve explicit false values", () => {
  assert.throws(() => userChanges(user, { ...values, email: "new@example.test" }, ["users.update"]), /permission to change email/);
  const changes = userChanges({ ...user, disabled_at: 10, password_reset_required: true }, { ...values, name: " ", email: " NEW@EXAMPLE.TEST " }, ["users.update", "users.email.update"]);
  assert.deepEqual(changes, { display_name: null, email_address: "new@example.test", disabled: false, password_reset_required: false });
  assert.equal(changesEndSessions(changes), true);
  assert.equal(changesEndSessions({ disabled: false }), true);
});

test("account changes reject self-disable while allowing other edits and other users' status changes", () => {
  assert.throws(() => userChanges(user, { ...values, disabled: true, name: "Must not save" }, ["users.update"], user.id), /cannot disable your own account/);
  assert.deepEqual(userChanges(user, { ...values, name: "Updated name" }, ["users.update"], user.id), { display_name: "Updated name" });
  assert.deepEqual(userChanges(user, { ...values, disabled: true }, ["users.update"], "other-user"), { disabled: true });
});

test("role updates preserve other existing permissions and submit the concurrency version", () => {
  const role = { key: "staff", is_system: false, permissions: ["users.read", "mail.domains.manage"], version: 7 };
  const body = rolePayload({ key: "ignored", label: " Staff ", description: " Team members ", permissions: ["users.read", "users.read", "users.update", "mail.providers.manage"] }, role);
  assert.deepEqual(body, { label: "Staff", description: "Team members", permissions: ["mail.domains.manage", "users.read", "users.update"], version: 7 });
  assert.deepEqual(managedPermissions(body.permissions), ["users.read", "users.update"]);
  assert.throws(() => rolePayload({ key: "staff", label: "Staff", description: "", permissions: [] }, { ...role, is_system: true }), /System roles/);
});

test("new roles validate names and keys and cannot acquire non-console grants", () => {
  assert.deepEqual(rolePayload({ key: "team-manager", label: " Manager ", description: "", permissions: ["users.read", "mail.domains.manage"] }), { key: "team-manager", label: "Manager", description: null, permissions: ["users.read"] });
  for (const key of ["UPPER", "space key", "-prefix", "a".repeat(65)]) assert.throws(() => rolePayload({ key, label: "Role", description: "", permissions: [] }), /lowercase role key/);
  assert.throws(() => rolePayload({ key: "role", label: " ", description: "", permissions: [] }), /role name/);
});

test("role assignment loads every page, encodes cursors and rejects pagination loops", async () => {
  const signal = new AbortController().signal, calls = [];
  const roles = await allRoles(async (path, options) => {
    calls.push(path); assert.equal(options.signal, signal);
    return calls.length === 1 ? { roles: [{ id: "first" }], next_cursor: "team_manager" } : { roles: [{ id: "first" }, { id: "last" }], next_cursor: null };
  }, signal);
  assert.deepEqual(calls, ["/api/roles", "/api/roles?cursor=team_manager"]);
  assert.deepEqual(roles.map((role) => role.id), ["first", "last"]);
  await assert.rejects(allRoles(async () => ({ roles: [], next_cursor: "repeated" }), signal), /Unable to load all roles/);
});

test("aborted role assignment requests stop before fetching another page", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(allRoles(async () => { calls++; controller.abort(); return { roles: [], next_cursor: "next" }; }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("login can return to console routes without accepting arbitrary destinations", () => {
  for (const path of ["/console", "/console/users", "/console/users/new", "/console/users/user-123", "/console/roles/system-administrator"]) assert.equal(returnToWorkspace(path), path);
  for (const path of ["/consoleevil", "/console/users/../roles", "/console/users/a/extra", "//console/users", "/console/users?id=1"]) assert.equal(returnToWorkspace(path), "/mail");
});
