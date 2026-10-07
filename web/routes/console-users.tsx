import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Dialog, DialogPopup, Fieldset, Form, Icon, TextField, useNotifications } from "@/components/ui";
import { PasswordField } from "../components/password-field";
import { useAccount } from "../components/account-context";
import { useAccess } from "../components/console-access";
import { Check, Confirm, Notice, ResourceState, adminDate, useResource } from "../components/console-shared";
import { ApiError, api, errorMessage } from "../lib/api";
import { allRoles, canGrant, changesEndSessions, userChanges, type AdminUser, type Role, type UserChanges } from "../lib/console";
import { validatePassword } from "../lib/profile";
import { sessions } from "../lib/session";
import "./console.css";

export function UsersPage() {
  const access = useAccess(), canRead = access.permissions.includes("users.read");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1), resource = useResource<{ users: AdminUser[]; next_cursor: string | null }>(canRead ? `/api/users?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` : null);
  return <section className="account-page console-page">
    <header className="account-page-header console-page-header"><div><h1>Users</h1><p>Manage accounts and their access to your workspace.</p></div>
      {access.permissions.includes("users.create") && <Button nativeButton={false} render={<Link to="/console/users/new" />} variant="primary"><Icon name="plus" />New user</Button>}</header>
    <section className="account-panel console-list-panel">
      {!canRead ? <p className="console-empty">You do not have permission to view user accounts.</p> : !resource.data ? <ResourceState {...resource} /> : <>
        <div className="console-table-scroll"><table className="console-table"><caption className="console-sr-only">User accounts</caption><thead><tr><th scope="col">User</th><th scope="col">Status</th><th scope="col" className="console-date-column">Last sign-in</th><th scope="col"><span className="console-sr-only">Actions</span></th></tr></thead>
          <tbody>{resource.data.users.map((user) => <tr key={user.id}><td><Link to={`/console/users/${encodeURIComponent(user.id)}`} className="console-identity"><span className="console-initial">{(user.display_name || user.email_address).slice(0, 1).toUpperCase()}</span><span><strong>{user.display_name || user.email_address}</strong><small>{user.email_address}</small></span></Link></td>
            <td><span className="console-badge" data-muted={user.disabled_at !== null}>{user.disabled_at === null ? "Active" : "Disabled"}</span>{user.password_reset_required && <small className="console-subtext">Password change required</small>}</td>
            <td className="console-date-column">{adminDate(user.last_login_at)}</td><td><Button nativeButton={false} render={<Link to={`/console/users/${encodeURIComponent(user.id)}`} />} size="sm" variant="ghost" aria-label={`Manage ${user.email_address}`}>Manage<Icon name="chevron" width="12" height="12" /></Button></td></tr>)}</tbody>
        </table>{!resource.data.users.length && <p className="console-empty">No users found.</p>}</div>
        <div className="console-pagination"><span>Page {cursors.length} · {resource.data.users.length} {resource.data.users.length === 1 ? "user" : "users"}</span><div><Button size="sm" onClick={resource.reload}>Refresh</Button><Button size="sm" disabled={cursors.length === 1} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</Button><Button size="sm" disabled={!resource.data.next_cursor} onClick={() => { if (resource.data?.next_cursor) setCursors((current) => [...current, resource.data!.next_cursor]); }}>Next</Button></div></div>
      </>}
    </section>
  </section>;
}

export function UserEditorPage({ creating = false }: { creating?: boolean }) {
  const notify = useNotifications();
  const { id = "" } = useParams(), navigate = useNavigate(), access = useAccess(), account = useAccount();
  const resource = useResource<{ user: AdminUser }>(creating ? null : `/api/users/${encodeURIComponent(id)}`);
  const user = resource.data?.user, canUpdate = creating || access.permissions.includes("users.update");
  const [name, setName] = useState(""), [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [disabled, setDisabled] = useState(false), [passwordReset, setPasswordReset] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState<UserChanges | null>(null), [remove, setRemove] = useState(false), [reset, setReset] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { setPending(null); setRemove(false); setReset(false); setError(""); setPassword(""); }, [id, creating]);
  useEffect(() => { if (user) { setName(user.display_name ?? ""); setEmail(user.email_address); setDisabled(user.disabled_at !== null); setPasswordReset(user.password_reset_required); } }, [user]);

  async function patch(changes: object, message = "The user account has been updated.") {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ user: AdminUser }>(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: changes });
      resource.update(result); notify.success(message);
      if (result.user.id === account.user?.id) {
        account.update(result.user);
        if ("password" in changes || changesEndSessions(changes as UserChanges)) await sessions.restore(true);
      }
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current) return;
    setError("");
    try {
      if ([...name.trim()].length > 200) throw new Error("Display name must contain at most 200 characters.");
      if (creating) {
        validatePassword(password, password); inFlight.current = true; setBusy(true);
        try {
          const result = await api<{ user: AdminUser }>("/api/users", { method: "POST", body: { display_name: name.trim() || null, email_address: email.trim().toLowerCase(), password, disabled, password_reset_required: passwordReset } });
          setPassword("");
          notify.success("The user account has been created.");
          if (access.permissions.includes("users.read")) navigate(`/console/users/${encodeURIComponent(result.user.id)}`);
          else { setName(""); setEmail(""); }
        } finally { inFlight.current = false; setBusy(false); }
      } else if (user) {
        const changes = userChanges(user, { name, email, disabled, passwordReset }, access.permissions);
        if (!Object.keys(changes).length) { notify.info("No changes to save."); return; }
        if (changesEndSessions(changes)) setPending(changes); else await patch(changes);
      }
    } catch (failure) {
      if (failure instanceof ApiError || failure instanceof TypeError) notify.error(errorMessage(failure));
      else setError(failure instanceof Error ? failure.message : errorMessage(failure));
      if (failure instanceof ApiError && failure.status === 403) access.refresh();
    }
  }

  return <section className="account-page console-page console-detail-page">
    <Link to="/console/users" className="console-back">← Users</Link>
    <header className="account-page-header"><h1>{creating ? "New user" : user?.display_name || user?.email_address || "User account"}</h1><p>{creating ? "Create an account for your workspace." : "Manage account information, status and roles."}</p></header>
    {!creating && !user ? <ResourceState {...resource} /> : <>
      <Form onSubmit={submit} aria-busy={busy}><section className="account-panel"><div className="account-panel-header"><h2>Account information</h2><p>{creating ? "The user should change their temporary password when they first sign in." : "Account security changes end the user's active sessions."}</p></div>
        <Fieldset.Root disabled={busy}>
          <TextField label="Display name" name="display_name" autoComplete="off" value={name} onValueChange={setName} readOnly={!canUpdate} />
          <TextField label="Email" name="email_address" type="email" autoComplete="off" required value={email} onValueChange={setEmail} readOnly={!canUpdate || !creating && !access.permissions.includes("users.email.update")} />
          {creating && <><PasswordField id="user-temporary-password" label="Temporary password" value={password} onChange={setPassword} autoComplete="new-password" /><p className="console-subtext">Use 15–128 characters.</p></>}
          <Check checked={disabled} onChange={setDisabled} disabled={!canUpdate}>Disable this account</Check>
          <Check checked={passwordReset} onChange={setPasswordReset} disabled={!canUpdate}>Require a password change at next sign-in</Check>
        </Fieldset.Root>
        <Notice error={error} />
        <div className="account-actions"><Button type="button" disabled={busy} onClick={() => creating ? navigate("/console/users") : resource.reload()}>{creating ? "Cancel" : "Reload"}</Button>{canUpdate && <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : creating ? "Create user" : "Save changes"}</Button>}</div>
      </section></Form>
      {!creating && user && <>
        {access.permissions.includes("users.roles.read") && <UserRoles user={user} />}
        <section className="account-panel"><div className="account-panel-header"><h2>Account activity</h2></div><dl className="console-facts"><div><dt>Created</dt><dd>{adminDate(user.created_at)}</dd></div><div><dt>Last sign-in</dt><dd>{adminDate(user.last_login_at)}</dd></div><div><dt>Password changed</dt><dd>{adminDate(user.password_changed_at)}</dd></div></dl></section>
        {canUpdate && <section className="account-panel account-danger-panel"><div><h2>Reset password</h2><p>Set a temporary password and require a change at the next sign-in.</p></div><Button disabled={busy} onClick={() => setReset(true)}>Reset password</Button></section>}
        {access.permissions.includes("users.delete") && <section className="account-panel account-danger-panel"><div><h2>Delete account</h2><p>Remove this user from the workspace and end all their sessions.</p></div><Button variant="danger" disabled={busy} onClick={() => setRemove(true)}>Delete user</Button></section>}
        <ResetPassword open={reset} onClose={() => setReset(false)} onSave={async (next) => { await patch({ password: next, password_reset_required: true }, "The user's password has been reset."); }} />
        <Confirm open={remove} destructive title="Delete this user?" description={`Delete ${user.email_address}? They will lose access to the workspace and all their sessions will end.`} label="Delete user" onClose={() => setRemove(false)} onConfirm={async () => { await api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }); notify.success("The user account has been deleted."); if (id === account.user?.id) await sessions.restore(true); navigate("/console/users"); }} />
      </>}
    </>}
    <Confirm open={pending !== null} title="Update account security?" description="Changing the email, account status or password-change requirement ends this user's current sessions. They will need to sign in again." label="Save changes" onClose={() => setPending(null)} onConfirm={async () => { if (pending) await patch(pending); }} />
  </section>;
}

function ResetPassword({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (password: string) => Promise<void> }) {
  const notify = useNotifications();
  const access = useAccess();
  const [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const running = useRef(false);
  useEffect(() => { setPassword(""); setConfirmation(""); setError(""); }, [open]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (running.current) return;
    try { validatePassword(password, confirmation); } catch (failure) { setError(failure instanceof Error ? failure.message : "Check the password."); return; }
    running.current = true; setBusy(true); setError("");
    try { await onSave(password); setPassword(""); setConfirmation(""); onClose(); }
    catch (failure) { notify.error(errorMessage(failure)); if (failure instanceof ApiError && failure.status === 403) access.refresh(); }
    finally { running.current = false; setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !running.current) onClose(); }}><DialogPopup><Dialog.Title>Reset password</Dialog.Title><Dialog.Description>Set a temporary password with 15–128 characters. This user will be signed out and must change it at their next sign-in.</Dialog.Description>
    <Form className="account-dialog-form" onSubmit={submit}><Fieldset.Root disabled={busy}><PasswordField id="reset-user-password" label="Temporary password" value={password} onChange={setPassword} autoComplete="new-password" /><PasswordField id="confirm-reset-user-password" label="Confirm temporary password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" /></Fieldset.Root><Notice error={error} /><div className="account-actions"><Button type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Reset password"}</Button></div></Form>
  </DialogPopup></Dialog.Root>;
}

function UserRoles({ user }: { user: AdminUser }) {
  const notify = useNotifications();
  const access = useAccess(), [revision, setRevision] = useState(0);
  const [assigned, setAssigned] = useState<Role[]>([]), [roles, setRoles] = useState<Role[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [confirm, setConfirm] = useState(false);
  const canReadRoles = access.permissions.includes("roles.read"), editable = canReadRoles && access.permissions.includes("users.roles.manage");
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void Promise.all([api<{ roles: Role[] }>(`/api/users/${encodeURIComponent(user.id)}/roles`, { signal: controller.signal }), canReadRoles ? allRoles(api, controller.signal) : Promise.resolve([])]).then(([result, available]) => {
      if (controller.signal.aborted) return;
      setAssigned(result.roles); setSelected(result.roles.map((role) => role.id)); setRoles(available);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : errorMessage(failure)); if (failure instanceof ApiError && failure.status === 403) access.refresh(); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user.id, canReadRoles, revision, access.refresh]);
  const changed = [...selected].sort().join() !== assigned.map((role) => role.id).sort().join();
  return <section className="account-panel"><div className="account-panel-header"><h2>Assigned roles</h2><p>Roles determine what this user can access and manage. You can assign up to 50 roles.</p></div><Notice error={error} />
    {loading ? <p className="account-loading" role="status">Loading roles…</p> : error ? <Button onClick={() => setRevision((value) => value + 1)}>Try again</Button> : editable ? <>
      <div className="console-role-options">{roles.map((role) => <Check key={role.id} checked={selected.includes(role.id)} disabled={!selected.includes(role.id) && (selected.length >= 50 || !canGrant(access.permissions, role.permissions))} onChange={(checked) => setSelected((current) => checked ? [...current, role.id] : current.filter((id) => id !== role.id))}><strong>{role.label}</strong>{role.description && <small>{role.description}</small>}{!canGrant(access.permissions, role.permissions) && <small>You cannot grant this role.</small>}</Check>)}{!roles.length && <p className="console-empty">No roles available.</p>}</div>
      <div className="account-actions"><Button disabled={!changed} onClick={() => setSelected(assigned.map((role) => role.id))}>Discard changes</Button><Button variant="primary" disabled={!changed} onClick={() => setConfirm(true)}>Save roles</Button></div>
    </> : <ul className="console-assigned-roles">{assigned.map((role) => <li key={role.id}><Icon name="shield" /><span>{role.label}</span></li>)}{!assigned.length && <li>No roles assigned.</li>}</ul>}
    <Confirm open={confirm} title="Update assigned roles?" description={`Update workspace access for ${user.email_address}? The new permissions take effect immediately.`} label="Save roles" onClose={() => setConfirm(false)} onConfirm={async () => { await api(`/api/users/${encodeURIComponent(user.id)}/roles`, { method: "PUT", body: { role_ids: selected } }); notify.success("Assigned roles have been updated."); setRevision((value) => value + 1); access.refresh(); }} />
  </section>;
}
