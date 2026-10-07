import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Field, Fieldset, Form, Icon, TextField, useNotifications } from "@/components/ui";
import { AccessDenied, useAccess } from "../components/console-access";
import { Check, Confirm, Notice, ResourceState, useResource } from "../components/console-shared";
import { ApiError, api, errorMessage } from "../lib/api";
import { managedPermissions, rolePayload, type PermissionDefinition, type Role } from "../lib/console";
import "./console.css";

export function RolesPage() {
  const access = useAccess(), canRead = access.permissions.includes("roles.read");
  const [cursors, setCursors] = useState<(string | null)[]>([null]), cursor = cursors.at(-1);
  const resource = useResource<{ roles: Role[]; next_cursor: string | null }>(canRead ? `/api/roles${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}` : null);
  return <section className="account-page console-page"><header className="account-page-header console-page-header"><div><h1>Roles</h1><p>Define the access granted to users in your workspace.</p></div>
    {canRead && access.permissions.includes("roles.manage") && <Button nativeButton={false} render={<Link to="/console/roles/new" />} variant="primary"><Icon name="plus" />New role</Button>}</header>
    <section className="account-panel console-list-panel">{!canRead ? <p className="console-empty">You do not have permission to view roles.</p> : !resource.data ? <ResourceState {...resource} /> : <>
      <div className="console-table-scroll"><table className="console-table"><caption className="console-sr-only">Workspace roles</caption><thead><tr><th scope="col">Role</th><th scope="col">Permissions</th><th scope="col">Type</th><th scope="col"><span className="console-sr-only">Actions</span></th></tr></thead><tbody>
        {resource.data.roles.map((role) => <tr key={role.id}><td><Link className="console-role-name" to={`/console/roles/${encodeURIComponent(role.id)}`}><span className="console-role-icon"><Icon name="shield" /></span><span><strong>{role.label}</strong><small>{role.description || role.key}</small></span></Link></td><td>{managedPermissions(role.permissions).length}</td><td><span className="console-badge" data-muted>{role.is_system ? "System" : "Custom"}</span></td><td><Button nativeButton={false} render={<Link to={`/console/roles/${encodeURIComponent(role.id)}`} />} variant="ghost" size="sm" aria-label={`View ${role.label}`}>View<Icon name="chevron" width="12" height="12" /></Button></td></tr>)}
      </tbody></table>{!resource.data.roles.length && <p className="console-empty">No roles yet. Create a role to define workspace access.</p>}</div>
      <div className="console-pagination"><span>Page {cursors.length} · {resource.data.roles.length} {resource.data.roles.length === 1 ? "role" : "roles"}</span><div><Button size="sm" onClick={resource.reload}>Refresh</Button><Button size="sm" disabled={cursors.length === 1} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</Button><Button size="sm" disabled={!resource.data.next_cursor} onClick={() => { if (resource.data?.next_cursor) setCursors((current) => [...current, resource.data!.next_cursor]); }}>Next</Button></div></div>
    </>}</section>
  </section>;
}

export function RoleEditorPage({ creating = false }: { creating?: boolean }) {
  const notify = useNotifications();
  const { id = "" } = useParams(), access = useAccess(), navigate = useNavigate();
  const canRead = access.permissions.includes("roles.read"), canManage = access.permissions.includes("roles.manage");
  const resource = useResource<{ role: Role }>(!creating && canRead ? `/api/roles/${encodeURIComponent(id)}` : null);
  const catalog = useResource<{ permissions: PermissionDefinition[] }>(canRead ? "/api/permissions" : null);
  const role = resource.data?.role, editable = canManage && !role?.is_system;
  const [key, setKey] = useState(""), [label, setLabel] = useState(""), [description, setDescription] = useState(""), [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [remove, setRemove] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { setRemove(false); setError(""); }, [id, creating]);
  useEffect(() => { if (role) { setKey(role.key); setLabel(role.label); setDescription(role.description ?? ""); setSelected(managedPermissions(role.permissions)); } }, [role]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editable || inFlight.current) return;
    setError("");
    let body;
    try { body = rolePayload({ key, label, description, permissions: selected }, role); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Check the role settings."); return; }
    inFlight.current = true; setBusy(true);
    try {
      const result = await api<{ role: Role }>(creating ? "/api/roles" : `/api/roles/${encodeURIComponent(id)}`, { method: creating ? "POST" : "PUT", body });
      notify.success(creating ? "The role has been created." : "The role has been updated.");
      if (creating) navigate(`/console/roles/${encodeURIComponent(result.role.id)}`);
      else resource.update(result);
      access.refresh();
    } catch (failure) { notify.error(errorMessage(failure)); if (failure instanceof ApiError && failure.status === 403) access.refresh(); }
    finally { inFlight.current = false; setBusy(false); }
  }
  if (!canRead || creating && !canManage) return <AccessDenied />;
  const definitions = (catalog.data?.permissions ?? []).filter((permission) => managedPermissions([permission.key]).length > 0);
  return <section className="account-page console-page console-detail-page"><Link to="/console/roles" className="console-back">← Roles</Link>
    <header className="account-page-header"><h1>{creating ? "New role" : role?.label || "Role"}</h1><p>{creating ? "Choose the access this role will provide." : role?.is_system ? "This system role is managed by Officeflare." : "Manage the permissions granted by this role."}</p></header>
    {!creating && !role ? <ResourceState {...resource} /> : !catalog.data ? <ResourceState {...catalog} /> : <>
      <Form onSubmit={submit} aria-busy={busy}><section className="account-panel"><div className="account-panel-header"><h2>Role information</h2></div><Fieldset.Root disabled={busy}>
        <TextField label="Role name" name="label" required maxLength={100} value={label} onValueChange={setLabel} readOnly={!editable} />
        <TextField label="Role key" name="key" required maxLength={64} value={key} onValueChange={setKey} readOnly={!creating} description={creating ? "A unique lowercase name, such as team-manager. It cannot be changed later." : undefined} />
        <Field.Root name="description"><Field.Label htmlFor="console-role-description">Description</Field.Label><textarea id="console-role-description" name="description" className="console-textarea" maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} readOnly={!editable} rows={3} /></Field.Root>
      </Fieldset.Root></section>
      <section className="account-panel"><div className="account-panel-header"><h2>Permissions</h2><p>{editable ? "Select the actions users with this role can perform. You can grant permissions you already have." : "Actions available to users with this role."}</p></div>
        <div className="console-permissions">{[{ title: "User accounts", prefix: "users." }, { title: "Roles", prefix: "roles." }].map((group) => <fieldset key={group.prefix}><legend>{group.title}</legend>{definitions.filter((permission) => permission.key.startsWith(group.prefix)).map((permission) => <Check key={permission.key} checked={selected.includes(permission.key)} disabled={busy || !editable || !access.permissions.includes(permission.key) && !selected.includes(permission.key)} onChange={(checked) => setSelected((current) => checked ? [...current, permission.key] : current.filter((key) => key !== permission.key))}>{permission.label}</Check>)}</fieldset>)}</div>
        <Notice error={error} /><div className="account-actions"><Button type="button" disabled={busy} onClick={() => creating ? navigate("/console/roles") : resource.reload()}>{creating ? "Cancel" : "Reload"}</Button>{editable && <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : creating ? "Create role" : "Save changes"}</Button>}</div>
      </section></Form>
      {!creating && role && !role.is_system && canManage && <section className="account-panel account-danger-panel"><div><h2>Delete role</h2><p>Remove this role and its access from every assigned user.</p></div><Button variant="danger" disabled={busy} onClick={() => setRemove(true)}>Delete role</Button></section>}
    </>}
    <Confirm open={remove} destructive title="Delete this role?" description={`Delete ${role?.label || "this role"}? All users assigned this role will immediately lose the access it provides.`} label="Delete role" onClose={() => setRemove(false)} onConfirm={async () => { await api(`/api/roles/${encodeURIComponent(id)}`, { method: "DELETE" }); notify.success("The role has been deleted."); access.refresh(); navigate("/console/roles"); }} />
  </section>;
}
