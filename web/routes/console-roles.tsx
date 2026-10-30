import { t, plural } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  Textarea,
  Button,
  Field,
  Fieldset,
  Form,
  Icon,
  TextField,
  useNotifications,
} from "@/components/ui";
import { AccessDenied, useAccess } from "../components/console-access";
import { Check, Confirm, Notice, ResourceState, useResource } from "../components/console-shared";
import { PermissionPicker } from "../components/permission-picker";
import { ApiError, api, errorMessage } from "../lib/api";
import {
  canGrant,
  defaultEligible,
  managedPermissions,
  rolePayload,
  roleTemplates,
  type Role,
} from "../lib/console";
import "./console.css";

export function RolesPage() {
  const access = useAccess(),
    canRead = access.permissions.includes("admin.roles.read");
  const [cursors, setCursors] = useState<(string | null)[]>([null]),
    cursor = cursors.at(-1);
  const resource = useResource<{ roles: Role[]; next_cursor: string | null }>(
    canRead ? `/api/roles${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}` : null,
  );
  return (
    <section className="account-page console-page">
      <header className="account-page-header console-page-header">
        <div>
          <h1>{t("routesConsoleRoles.roles")}</h1>
          <p>
            {t("routesConsoleRoles.controlServiceAccessAndAdministrationWithExplicitPermissions")}
          </p>
        </div>
        {canRead && access.permissions.includes("admin.roles.create") && (
          <Button nativeButton={false} render={<Link to="/console/roles/new" />} variant="primary">
            <Icon name="plus" />
            {t("routesConsoleRoles.newRole")}
          </Button>
        )}
      </header>
      <section className="account-panel console-list-panel">
        {!canRead ? (
          <p className="console-empty">
            {t("routesConsoleRoles.youDoNotHavePermissionToViewRoles")}
          </p>
        ) : !resource.data ? (
          <ResourceState
            {...resource}
            kind="list"
            label={t("routesConsoleRoles.loadingRoles")}
            rows={5}
          />
        ) : (
          <>
            <div className="console-table-scroll">
              <table className="console-table">
                <caption className="console-sr-only">
                  {t("routesConsoleRoles.workspaceRoles")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t("routesConsoleRoles.role")}</th>
                    <th scope="col">{t("routesConsoleRoles.permissions")}</th>
                    <th scope="col">{t("routesConsoleRoles.users")}</th>
                    <th scope="col">{t("routesConsoleRoles.newUsers")}</th>
                    <th scope="col">
                      <span className="console-sr-only">{t("common.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.roles.map((role) => (
                    <tr key={role.id}>
                      <td>
                        <Link
                          className="console-role-name"
                          to={`/console/roles/${encodeURIComponent(role.id)}`}
                        >
                          <span className="console-role-icon">
                            <Icon name="shield" />
                          </span>
                          <span>
                            <strong>
                              {role.label}
                              {role.is_system && (
                                <span className="console-badge" data-muted>
                                  {t("routesConsoleRoles.system")}
                                </span>
                              )}
                            </strong>
                            <small>{role.description || role.key}</small>
                          </span>
                        </Link>
                      </td>
                      <td>{managedPermissions(role.permissions).length}</td>
                      <td>{role.assigned_user_count ?? 0}</td>
                      <td>
                        {role.is_default ? (
                          <span className="console-badge">{t("routesConsoleRoles.default")}</span>
                        ) : (
                          <span className="console-subtext">
                            {t("routesConsoleRoles.optional")}
                          </span>
                        )}
                      </td>
                      <td>
                        <Button
                          nativeButton={false}
                          render={<Link to={`/console/roles/${encodeURIComponent(role.id)}`} />}
                          variant="ghost"
                          size="sm"
                          aria-label={t("routesConsoleRoles.view", { label: role.label })}
                        >
                          {t("routesConsoleRoles.view2")}
                          <Icon name="chevron" width="12" height="12" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!resource.data.roles.length && (
                <p className="console-empty">
                  {t("routesConsoleRoles.noRolesYetCreateARoleToDefineWorkspace")}
                </p>
              )}
            </div>
            <div className="console-pagination">
              <span>
                {t("routesConsoleRoles.page", {
                  page: cursors.length,
                  roles: plural("counts.roles", resource.data.roles.length),
                })}
              </span>
              <div>
                <Button
                  size="sm"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors((current) => current.slice(0, -1))}
                >
                  {t("common.previous")}
                </Button>
                <Button
                  size="sm"
                  disabled={!resource.data.next_cursor}
                  onClick={() => {
                    if (resource.data?.next_cursor)
                      setCursors((current) => [...current, resource.data!.next_cursor]);
                  }}
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </section>
  );
}

export function RoleEditorPage({ creating = false }: { creating?: boolean }) {
  const notify = useNotifications();
  const { id = "" } = useParams(),
    access = useAccess(),
    navigate = useNavigate();
  const canRead = access.permissions.includes("admin.roles.read"),
    canCreate = access.permissions.includes("admin.roles.create");
  const resource = useResource<{ role: Role }>(
    !creating && canRead ? `/api/roles/${encodeURIComponent(id)}` : null,
  );
  const role = resource.data?.role,
    owned = !role || canGrant(access.permissions, role.permissions);
  const canDefaults =
    owned && access.permissions.includes("admin.roles.defaults.manage") && !role?.is_system;
  const editable =
    owned &&
    (creating
      ? canCreate
      : access.permissions.includes("admin.roles.update") && (!role?.is_default || canDefaults)) &&
    !role?.is_system;
  const canDelete =
    owned &&
    access.permissions.includes("admin.roles.delete") &&
    !role?.is_system &&
    (!role?.is_default || canDefaults);
  const [key, setKey] = useState(""),
    [label, setLabel] = useState(""),
    [description, setDescription] = useState(""),
    [selected, setSelected] = useState<string[]>([]);
  const [isDefault, setDefault] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [remove, setRemove] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    setRemove(false);
    setError("");
  }, [id, creating]);
  useEffect(() => {
    if (role) {
      setKey(role.key);
      setLabel(role.label);
      setDescription(role.description ?? "");
      setSelected(managedPermissions(role.permissions));
    }
  }, [role?.id, role?.key, role?.label, role?.description, role?.permissions.join()]);
  useEffect(() => {
    if (role) setDefault(role.is_default);
  }, [role?.id, role?.is_default]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || inFlight.current) return;
    setError("");
    let body;
    try {
      body = rolePayload({ key, label, description, permissions: selected }, role);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t("routesConsoleRoles.checkTheRoleSettings"),
      );
      return;
    }
    if (
      role &&
      body.label === role.label &&
      body.description === role.description &&
      [...body.permissions].sort().join() === [...role.permissions].sort().join()
    ) {
      notify.info(t("routesConsoleRoles.noChangesToSave"));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await api<{ role: Role }>(
        creating ? "/api/roles" : `/api/roles/${encodeURIComponent(id)}`,
        { method: creating ? "POST" : "PUT", body },
      );
      notify.success(
        creating
          ? t("routesConsoleRoles.theRoleHasBeenCreated")
          : t("routesConsoleRoles.theRoleHasBeenUpdated"),
      );
      if (creating) navigate(`/console/roles/${encodeURIComponent(result.role.id)}`);
      else resource.update(result);
      access.refresh();
    } catch (failure) {
      notify.error(errorMessage(failure));
      if (failure instanceof ApiError && failure.status === 403) access.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function saveDefault() {
    if (!role || !canDefaults || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await api<{ role: Role }>(`/api/roles/${encodeURIComponent(id)}/default`, {
        method: "PATCH",
        body: { is_default: isDefault, version: role.version },
      });
      resource.update(result);
      notify.success(t("routesConsoleRoles.theDefaultRoleSettingHasBeenUpdated"));
    } catch (failure) {
      notify.error(errorMessage(failure));
      if (failure instanceof ApiError && failure.status === 403) access.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  if (!canRead || (creating && !canCreate)) return <AccessDenied />;
  return (
    <section
      className="account-page console-page console-detail-page"
      data-ui-theme={
        (role?.permissions ?? selected).some(
          (key) => key.startsWith("drive.") || key.startsWith("admin.drive."),
        )
          ? "neutral"
          : undefined
      }
    >
      <Link to="/console/roles" className="console-back">
        {t("routesConsoleRoles.roles2")}
      </Link>
      <header className="account-page-header">
        <h1>
          {creating ? t("routesConsoleRoles.newRole") : role?.label || t("routesConsoleRoles.role")}
        </h1>
        <p>
          {creating
            ? t("routesConsoleRoles.chooseServiceAccessAndAdministrativeActions")
            : role?.is_system
              ? t("routesConsoleRoles.thisProtectedSystemRoleIsManagedByOfficeflare")
              : t("routesConsoleRoles.assignedToUsersPermissionChangesApplyImmediately", {
                  value1: role?.assigned_user_count ?? 0,
                })}
        </p>
      </header>
      {!creating && !role ? (
        <ResourceState {...resource} kind="form" label={t("routesConsoleRoles.loadingRole")} />
      ) : (
        <>
          <Form onSubmit={submit} aria-busy={busy}>
            <section className="account-panel">
              <div className="account-panel-header">
                <h2>{t("routesConsoleRoles.roleInformation")}</h2>
                {!owned && (
                  <p>
                    {t("routesConsoleRoles.youCannotChangeThisRoleBecauseItContainsPermissions")}
                  </p>
                )}
              </div>
              <Fieldset.Root disabled={busy}>
                <TextField
                  label={t("routesConsoleRoles.roleName")}
                  name="label"
                  required
                  maxLength={100}
                  value={label}
                  onValueChange={setLabel}
                  readOnly={!editable}
                />
                <TextField
                  label={t("routesConsoleRoles.roleKey")}
                  name="key"
                  required
                  maxLength={64}
                  value={key}
                  onValueChange={setKey}
                  readOnly={!creating}
                  description={
                    creating
                      ? t("routesConsoleRoles.aUniqueLowercaseNameSuchAsTeamManagerIt")
                      : undefined
                  }
                />
                <Field.Root name="description">
                  <Field.Label htmlFor="console-role-description">
                    {t("routesConsoleRoles.description")}
                  </Field.Label>
                  <Textarea
                    id="console-role-description"
                    name="description"
                    maxLength={1000}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    readOnly={!editable}
                    rows={3}
                  />
                </Field.Root>
              </Fieldset.Root>
            </section>
            <section className="account-panel">
              <div className="account-panel-header">
                <h2>{t("routesConsoleRoles.permissions")}</h2>
                <p>
                  {editable
                    ? t(
                        "routesConsoleRoles.requiredParentPermissionsAreSelectedTogetherRemovingAParent",
                      )
                    : t(
                        "routesConsoleRoles.serviceEntryAndAdministrativeActionsAreIndependentPermissions",
                      )}
                </p>
              </div>
              {creating && editable && (
                <div className="console-role-templates">
                  <span>{t("routesConsoleRoles.startWithATemplate")}</span>
                  {roleTemplates.map((template) => (
                    <Button
                      type="button"
                      key={template.key}
                      size="sm"
                      disabled={
                        busy ||
                        !canGrant(access.permissions, template.permissions) ||
                        (!!role?.is_default && !defaultEligible(template.permissions))
                      }
                      onClick={() => {
                        setSelected(template.permissions);
                        if (creating && !key)
                          setKey(
                            template.key === "mail-user" || template.key.startsWith("drive-")
                              ? `${template.key}-custom`
                              : template.key,
                          );
                        if (creating && !label) setLabel(template.label);
                      }}
                    >
                      {template.label}
                    </Button>
                  ))}
                </div>
              )}
              <PermissionPicker
                selected={selected}
                onChange={setSelected}
                editable={editable}
                owned={access.permissions}
                busy={busy}
                defaultOnly={role?.is_default}
              />
              <Notice error={error} />
              {editable && (
                <div className="account-actions">
                  {creating && (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => navigate("/console/roles")}
                    >
                      {t("common.cancel")}
                    </Button>
                  )}
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy
                      ? t("common.saving")
                      : creating
                        ? t("routesConsoleRoles.createRole")
                        : t("common.saveChanges")}
                  </Button>
                </div>
              )}
            </section>
          </Form>
          {!creating && role && !role.is_system && (
            <section className="account-panel">
              <div className="account-panel-header">
                <h2>{t("routesConsoleRoles.newUserDefaults")}</h2>
                <p>
                  {t("routesConsoleRoles.defaultRolesAreSelectedWhenCreatingUsersChangesApply")}
                </p>
              </div>
              <Check
                checked={isDefault}
                onChange={setDefault}
                disabled={busy || !canDefaults || !defaultEligible(role.permissions)}
              >
                {t("routesConsoleRoles.assignThisRoleToNewUsersByDefault")}
              </Check>
              {!defaultEligible(role.permissions) && (
                <p className="console-subtext">
                  {t("routesConsoleRoles.defaultRolesCanOnlyGrantMailCalendarOrDrive")}
                </p>
              )}
              {canDefaults && (
                <div className="account-actions">
                  <Button
                    disabled={busy || isDefault === role.is_default}
                    onClick={() => {
                      void saveDefault();
                    }}
                  >
                    {t("routesConsoleRoles.saveDefaultSetting")}
                  </Button>
                </div>
              )}
            </section>
          )}
          {!creating && role && canDelete && (
            <section className="account-panel account-danger-panel">
              <div>
                <h2>{t("routesConsoleRoles.deleteRole")}</h2>
                <p>
                  {t("routesConsoleRoles.removeThisRoleFromAssignedUsers", {
                    value1: role.assigned_user_count ?? 0,
                    value2: role.is_default ? t("routesConsoleRoles.andFromNewUserDefaults") : "",
                  })}
                </p>
              </div>
              <Button variant="danger" disabled={busy} onClick={() => setRemove(true)}>
                {t("routesConsoleRoles.deleteRole")}
              </Button>
            </section>
          )}
        </>
      )}
      <Confirm
        open={remove}
        destructive
        title={t("routesConsoleRoles.deleteThisRole")}
        description={t("routesConsoleRoles.deleteAllAssignedUsersImmediatelyLoseTheAccessIt", {
          value1: role?.label || t("routesConsoleRoles.thisRole"),
        })}
        label={t("routesConsoleRoles.deleteRole")}
        onClose={() => setRemove(false)}
        onConfirm={async () => {
          await api(`/api/roles/${encodeURIComponent(id)}`, { method: "DELETE" });
          notify.success(t("routesConsoleRoles.theRoleHasBeenDeleted"));
          access.refresh();
          navigate("/console/roles");
        }}
      />
    </section>
  );
}
