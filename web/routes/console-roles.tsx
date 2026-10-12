import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Textarea, Button, Field, Fieldset, Form, Icon, TextField, useNotifications } from "@/components/ui";
import { AccessDenied, useAccess } from "../components/console-access";
import { Check, Confirm, Notice, ResourceState, useResource } from "../components/console-shared";
import { PermissionPicker } from "../components/permission-picker";
import { ApiError, api, errorMessage } from "../lib/api";
import { canGrant, defaultEligible, managedPermissions, rolePayload, roleTemplates, type Role } from "../lib/console";
import "./console.css";

export function RolesPage() {
  const access = useAccess(), canRead = access.permissions.includes("admin.roles.read");
  const [cursors, setCursors] = useState<(string | null)[]>([null]), cursor = cursors.at(-1);
  const resource = useResource<{ roles: Role[]; next_cursor: string | null }>(canRead ? `/api/roles${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}` : null);
  return <section className="account-page console-page"><header className="account-page-header console-page-header"><div><h1>Roles</h1><p>Control service access and administration with explicit permissions.</p></div>
    {canRead && access.permissions.includes("admin.roles.create") && <Button nativeButton={false} render={<Link to="/console/roles/new" />} variant="primary"><Icon name="plus" />New role</Button>}</header>
    <section className="account-panel console-list-panel">{!canRead ? <p className="console-empty">You do not have permission to view roles.</p> : !resource.data ? <ResourceState {...resource} /> : <>
      <div className="console-table-scroll"><table className="console-table"><caption className="console-sr-only">Workspace roles</caption><thead><tr><th scope="col">Role</th><th scope="col">Permissions</th><th scope="col">Users</th><th scope="col">New users</th><th scope="col"><span className="console-sr-only">Actions</span></th></tr></thead><tbody>
        {resource.data.roles.map((role) => <tr key={role.id}><td><Link className="console-role-name" to={`/console/roles/${encodeURIComponent(role.id)}`}><span className="console-role-icon"><Icon name="shield" /></span><span><strong>{role.label}{role.is_system && <span className="console-badge" data-muted>System</span>}</strong><small>{role.description || role.key}</small></span></Link></td><td>{managedPermissions(role.permissions).length}</td><td>{role.assigned_user_count ?? 0}</td><td>{role.is_default ? <span className="console-badge">Default</span> : <span className="console-subtext">Optional</span>}</td><td><Button nativeButton={false} render={<Link to={`/console/roles/${encodeURIComponent(role.id)}`} />} variant="ghost" size="sm" aria-label={`View ${role.label}`}>View<Icon name="chevron" width="12" height="12" /></Button></td></tr>)}
      </tbody></table>{!resource.data.roles.length && <p className="console-empty">No roles yet. Create a role to define workspace access.</p>}</div>
      <div className="console-pagination"><span>Page {cursors.length} · {resource.data.roles.length} {resource.data.roles.length === 1 ? "role" : "roles"}</span><div><Button size="sm" disabled={cursors.length === 1} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</Button><Button size="sm" disabled={!resource.data.next_cursor} onClick={() => { if (resource.data?.next_cursor) setCursors((current) => [...current, resource.data!.next_cursor]); }}>Next</Button></div></div>
    </>}</section>
  </section>;
}

export function RoleEditorPage({ creating = false }: { creating?: boolean }) {
  const notify = useNotifications();
  const { id = "" } = useParams(), access = useAccess(), navigate = useNavigate();
  const canRead = access.permissions.includes("admin.roles.read"), canCreate = access.permissions.includes("admin.roles.create");
  const resource = useResource<{ role: Role }>(!creating && canRead ? `/api/roles/${encodeURIComponent(id)}` : null);
  const role = resource.data?.role, owned = !role || canGrant(access.permissions, role.permissions);
  const canDefaults = owned && access.permissions.includes("admin.roles.defaults.manage") && !role?.is_system;
  const editable = owned && (creating ? canCreate : access.permissions.includes("admin.roles.update") && (!role?.is_default || canDefaults)) && !role?.is_system;
  const canDelete = owned && access.permissions.includes("admin.roles.delete") && !role?.is_system && (!role?.is_default || canDefaults);
  const [key, setKey] = useState(""), [label, setLabel] = useState(""), [description, setDescription] = useState(""), [selected, setSelected] = useState<string[]>([]);
  const [isDefault, setDefault] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [remove, setRemove] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { setRemove(false); setError(""); }, [id, creating]);
  useEffect(() => { if (role) { setKey(role.key); setLabel(role.label); setDescription(role.description ?? ""); setSelected(managedPermissions(role.permissions)); } }, [role?.id, role?.key, role?.label, role?.description, role?.permissions.join()]);
  useEffect(() => { if (role) setDefault(role.is_default); }, [role?.id, role?.is_default]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editable || inFlight.current) return;
    setError(""); let body;
    try { body = rolePayload({ key, label, description, permissions: selected }, role); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Check the role settings."); return; }
    if (role && body.label === role.label && body.description === role.description && [...body.permissions].sort().join() === [...role.permissions].sort().join()) { notify.info("No changes to save."); return; }
    inFlight.current = true; setBusy(true);
    try {
      const result = await api<{ role: Role }>(creating ? "/api/roles" : `/api/roles/${encodeURIComponent(id)}`, { method: creating ? "POST" : "PUT", body });
      notify.success(creating ? "The role has been created." : "The role has been updated.");
      if (creating) navigate(`/console/roles/${encodeURIComponent(result.role.id)}`); else resource.update(result);
      access.refresh();
    } catch (failure) { notify.error(errorMessage(failure)); if (failure instanceof ApiError && failure.status === 403) access.refresh(); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function saveDefault() {
    if (!role || !canDefaults || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const result = await api<{ role: Role }>(`/api/roles/${encodeURIComponent(id)}/default`, { method: "PATCH", body: { is_default: isDefault, version: role.version } });
      resource.update(result); notify.success("The default role setting has been updated.");
    } catch (failure) { notify.error(errorMessage(failure)); if (failure instanceof ApiError && failure.status === 403) access.refresh(); }
    finally { inFlight.current = false; setBusy(false); }
  }
  if (!canRead || creating && !canCreate) return <AccessDenied />;
  return <section className="account-page console-page console-detail-page"><Link to="/console/roles" className="console-back">← Roles</Link>
    <header className="account-page-header"><h1>{creating ? "New role" : role?.label || "Role"}</h1><p>{creating ? "Choose service access and administrative actions." : role?.is_system ? "This protected system role is managed by Officeflare." : `Assigned to ${role?.assigned_user_count ?? 0} users. Permission changes apply immediately.`}</p></header>
    {!creating && !role ? <ResourceState {...resource} /> : <>
      <Form onSubmit={submit} aria-busy={busy}><section className="account-panel"><div className="account-panel-header"><h2>Role information</h2>{!owned && <p>You cannot change this role because it contains permissions you do not hold.</p>}</div><Fieldset.Root disabled={busy}>
        <TextField label="Role name" name="label" required maxLength={100} value={label} onValueChange={setLabel} readOnly={!editable} />
        <TextField label="Role key" name="key" required maxLength={64} value={key} onValueChange={setKey} readOnly={!creating} description={creating ? "A unique lowercase name, such as team-manager. It cannot be changed later." : undefined} />
        <Field.Root name="description"><Field.Label htmlFor="console-role-description">Description</Field.Label><Textarea id="console-role-description" name="description" maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} readOnly={!editable} rows={3} /></Field.Root>
      </Fieldset.Root></section>
      <section className="account-panel"><div className="account-panel-header"><h2>Permissions</h2><p>{editable ? "Required parent permissions are selected together. Removing a parent also removes dependent actions." : "Service entry and administrative actions are independent permissions."}</p></div>
        {creating && editable && <div className="console-role-templates"><span>Start with a template</span>{roleTemplates.map((template) => <Button type="button" key={template.key} size="sm" disabled={busy || !canGrant(access.permissions, template.permissions) || !!role?.is_default && !defaultEligible(template.permissions)} onClick={() => { setSelected(template.permissions); if (creating && !key) setKey(template.key === "mail-user" ? "mail-user-custom" : template.key); if (creating && !label) setLabel(template.label); }}>{template.label}</Button>)}</div>}
        <PermissionPicker selected={selected} onChange={setSelected} editable={editable} owned={access.permissions} busy={busy} defaultOnly={role?.is_default} />
        <Notice error={error} />{editable && <div className="account-actions">{creating && <Button type="button" disabled={busy} onClick={() => navigate("/console/roles")}>Cancel</Button>}<Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : creating ? "Create role" : "Save changes"}</Button></div>}
      </section></Form>
      {!creating && role && !role.is_system && <section className="account-panel"><div className="account-panel-header"><h2>New user defaults</h2><p>Default roles are selected when creating users. Changes apply to future accounts.</p></div>
        <Check checked={isDefault} onChange={setDefault} disabled={busy || !canDefaults || !defaultEligible(role.permissions)}>Assign this role to new users by default</Check>
        {!defaultEligible(role.permissions) && <p className="console-subtext">Default roles can only grant Mail, Calendar or Drive access. Administrative roles require explicit assignment.</p>}
        {canDefaults && <div className="account-actions"><Button disabled={busy || isDefault === role.is_default} onClick={() => { void saveDefault(); }}>Save default setting</Button></div>}
      </section>}
      {!creating && role && canDelete && <section className="account-panel account-danger-panel"><div><h2>Delete role</h2><p>Remove this role from {role.assigned_user_count ?? 0} assigned users{role.is_default ? " and from new user defaults" : ""}.</p></div><Button variant="danger" disabled={busy} onClick={() => setRemove(true)}>Delete role</Button></section>}
    </>}
    <Confirm open={remove} destructive title="Delete this role?" description={`Delete ${role?.label || "this role"}? All assigned users immediately lose the access it provides.`} label="Delete role" onClose={() => setRemove(false)} onConfirm={async () => { await api(`/api/roles/${encodeURIComponent(id)}`, { method: "DELETE" }); notify.success("The role has been deleted."); access.refresh(); navigate("/console/roles"); }} />
  </section>;
}
