import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allRoles,
  canGrant,
  changesEndSessions,
  consoleMenu,
  managedPermissions,
  rolePayload,
  userChanges,
} from "../web/lib/console.ts";
import {
  permissionClosure,
  togglePermission,
  missingPrerequisites,
  effectivePermissions,
  defaultEligible,
  permissionCatalog,
} from "../src/authorization/permissions.ts";
import { returnToWorkspace } from "../web/lib/profile.ts";
const user = {
  id: "user-id",
  display_name: "Alex",
  email_address: "alex@example.test",
  disabled_at: null,
  password_reset_required: false,
};
const values = { name: "Alex", email: "alex@example.test", disabled: false, passwordReset: false };

test("console entry and administrative records are separate from service access", () => {
  for (const permissions of [
    [],
    ["unknown"],
    ["mail.access"],
    ["admin.users.read"],
    ["console.access"],
  ])
    assert.deepEqual(consoleMenu(permissions), []);
  assert.deepEqual(
    consoleMenu(permissionClosure(["admin.users.read"])).map((item) => item.path),
    ["/console/users"],
  );
  assert.deepEqual(
    consoleMenu(permissionClosure(["admin.roles.read"])).map((item) => item.path),
    ["/console/roles"],
  );
  assert.equal(canGrant(["admin.users.create"], ["admin.users.create"]), false);
  assert.equal(canGrant(permissionClosure(["admin.users.create"]), ["admin.users.read"]), true);
  assert.equal(canGrant(["unknown"], ["unknown"]), false);
});

test("permission selections complete their parents and remove dependent children", () => {
  const selected = togglePermission(["mail.access"], "admin.users.roles.assign", true);
  assert.deepEqual(missingPrerequisites(selected), []);
  for (const key of [
    "console.access",
    "admin.users.read",
    "admin.roles.read",
    "admin.users.roles.read",
  ])
    assert.ok(selected.includes(key));
  assert.deepEqual(togglePermission(selected, "console.access", false), ["mail.access"]);
  assert.ok(
    !togglePermission(selected, "admin.roles.read", false).includes("admin.users.roles.assign"),
  );
  assert.deepEqual(effectivePermissions(["admin.users.create", "mail.access"]), ["mail.access"]);
  assert.ok(defaultEligible(["mail.access", "drive.access"]));
  assert.ok(!defaultEligible(["console.access"]));
  for (const key of Object.keys(permissionCatalog))
    assert.deepEqual(missingPrerequisites(permissionClosure([key])), []);
});

test("profile, email, account status and credentials each require their own permission", () => {
  assert.deepEqual(
    userChanges(user, { ...values, name: "  New name  ", email: " ALEX@EXAMPLE.TEST " }, [
      "admin.users.profile.update",
    ]),
    { display_name: "New name" },
  );
  assert.deepEqual(userChanges(user, values, ["admin.users.read"]), {});
  assert.throws(
    () => userChanges(user, { ...values, name: "Changed" }, ["admin.users.read"]),
    /permission to update/,
  );
  assert.throws(
    () =>
      userChanges(user, { ...values, email: "new@example.test" }, ["admin.users.profile.update"]),
    /permission to change email/,
  );
  assert.throws(
    () => userChanges(user, { ...values, disabled: true }, ["admin.users.profile.update"]),
    /account status/,
  );
  assert.throws(
    () => userChanges(user, { ...values, passwordReset: true }, ["admin.users.profile.update"]),
    /credentials/,
  );
  const changes = userChanges(
    { ...user, disabled_at: 10, password_reset_required: true },
    { ...values, name: " ", email: " NEW@EXAMPLE.TEST " },
    [
      "admin.users.profile.update",
      "admin.users.email.update",
      "admin.users.status.update",
      "admin.users.credentials.reset",
    ],
  );
  assert.deepEqual(changes, {
    display_name: null,
    email_address: "new@example.test",
    disabled: false,
    password_reset_required: false,
  });
  assert.equal(changesEndSessions(changes), true);
  assert.equal(changesEndSessions({ display_name: "New name" }), false);
});

test("account changes reject self-disable while allowing other edits and other users' status changes", () => {
  assert.throws(
    () => userChanges(user, { ...values, disabled: true }, ["admin.users.status.update"], user.id),
    /cannot disable your own account/,
  );
  assert.deepEqual(
    userChanges(user, { ...values, name: "Updated name" }, ["admin.users.profile.update"], user.id),
    { display_name: "Updated name" },
  );
  assert.deepEqual(
    userChanges(user, { ...values, disabled: true }, ["admin.users.status.update"], "other-user"),
    { disabled: true },
  );
});

test("role payloads cover the full catalog and reject incomplete or unknown grants", () => {
  const permissions = permissionClosure([
    "admin.users.read",
    "admin.mail.domains.manage",
    "mail.access",
  ]);
  const role = { key: "staff", is_system: false, permissions, version: 7 };
  const body = rolePayload(
    {
      key: "ignored",
      label: " Staff ",
      description: " Team members ",
      permissions: [...permissions, "mail.access"],
    },
    role,
  );
  assert.deepEqual(body, { label: "Staff", description: "Team members", permissions, version: 7 });
  assert.deepEqual(managedPermissions(body.permissions), permissions);
  assert.throws(
    () =>
      rolePayload({
        key: "staff",
        label: "Staff",
        description: "",
        permissions: ["admin.users.create"],
      }),
    /required permissions/,
  );
  assert.throws(
    () => rolePayload({ key: "staff", label: "Staff", description: "", permissions: ["unknown"] }),
    /Unknown permission/,
  );
  assert.throws(
    () =>
      rolePayload(
        { key: "staff", label: "Staff", description: "", permissions: [] },
        { ...role, is_system: true },
      ),
    /System roles/,
  );
  for (const key of ["UPPER", "space key", "-prefix", "a".repeat(65)])
    assert.throws(
      () => rolePayload({ key, label: "Role", description: "", permissions: [] }),
      /lowercase role key/,
    );
});

test("role assignment loads every page, encodes cursors and rejects pagination loops", async () => {
  const signal = new AbortController().signal,
    calls = [];
  const roles = await allRoles(async (path, options) => {
    calls.push(path);
    assert.equal(options.signal, signal);
    return calls.length === 1
      ? { roles: [{ id: "first" }], next_cursor: "team_manager" }
      : { roles: [{ id: "first" }, { id: "last" }], next_cursor: null };
  }, signal);
  assert.deepEqual(calls, ["/api/roles", "/api/roles?cursor=team_manager"]);
  assert.deepEqual(
    roles.map((role) => role.id),
    ["first", "last"],
  );
  await assert.rejects(
    allRoles(async () => ({ roles: [], next_cursor: "repeated" }), signal),
    /Unable to load all roles/,
  );
});
test("aborted role assignment requests stop before fetching another page", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    allRoles(async () => {
      calls++;
      controller.abort();
      return { roles: [], next_cursor: "next" };
    }, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});
test("login returns to allowed routes and uses a permission-aware home for invalid destinations", () => {
  for (const path of [
    "/",
    "/console",
    "/console/users/new",
    "/console/users/user-123",
    "/console/roles/system-administrator",
  ])
    assert.equal(returnToWorkspace(path), path);
  for (const path of [
    "/consoleevil",
    "/console/users/../roles",
    "/console/users/a/extra",
    "//console/users",
    "/console/users?id=1",
  ])
    assert.equal(returnToWorkspace(path), "/");
});
