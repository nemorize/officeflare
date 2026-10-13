import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Dialog, DialogPopup, Fieldset, Form, Icon, TextField, useNotifications } from "@/components/ui";
import { PasswordField } from "../components/password-field";
import { useAccount } from "../components/account-context";
import { PermissionPicker } from "../components/permission-picker";
import { UserAvatar } from "../components/user-avatar";
import { useAccess } from "../components/console-access";
import { Check, Confirm, Notice, ResourceState, adminDate, useResource } from "../components/console-shared";
import { ApiError, api, errorMessage } from "../lib/api";
import { allRoles, canGrant, changesEndSessions, userChanges, type AdminUser, type Role, type UserChanges } from "../lib/console";
import { validatePassword } from "../lib/profile";
import { sessions } from "../lib/session";
import { DomainSetupLink, MailAddressField, preferredDomain, UserMailPanel, type UserMailDomain } from "../components/user-mail";
import { useMailResource } from "../components/mail-common";
import { LoadingSkeleton } from "../components/loading-skeleton";
import "./console.css";

export function UsersPage() {
  const access = useAccess(), canRead = access.permissions.includes("admin.users.read");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1), resource = useResource<{ users: AdminUser[]; next_cursor: string | null }>(canRead ? `/api/users?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` : null);
  return <section className="account-page console-page">
    <header className="account-page-header console-page-header"><div><h1>Users</h1><p>Manage people, personal mail addresses and workspace access.</p></div>
      {access.permissions.includes("admin.users.create") && <Button nativeButton={false} render={<Link to="/console/users/new" />} variant="primary"><Icon name="plus" />New user</Button>}</header>
    <section className="account-panel console-list-panel">
      {!canRead ? <p className="console-empty">You do not have permission to view user accounts.</p> : !resource.data ? <ResourceState {...resource} kind="list" label="Loading users…" rows={5} /> : <>
        <div className="console-table-scroll"><table className="console-table"><caption className="console-sr-only">User accounts</caption><thead><tr><th scope="col">User</th><th scope="col">Personal mail</th><th scope="col">Status</th><th scope="col" className="console-date-column">Last sign-in</th><th scope="col"><span className="console-sr-only">Actions</span></th></tr></thead>
          <tbody>{resource.data.users.map((user) => <tr key={user.id}><td><Link to={`/console/users/${encodeURIComponent(user.id)}`} className="console-identity"><UserAvatar user={user} /><span><strong>{user.display_name || user.email_address}</strong><small>{user.email_address}</small></span></Link></td>
            <td><span>{user.mail?.email_address ?? (user.mail?.mail_enabled ? "Address not set" : "Not enabled")}</span><small className="console-subtext">{!user.mail?.mail_enabled ? "Mail not enabled" : user.mail?.mailbox ? user.mail.mailbox.status === "active" ? "Mailbox ready" : user.mail.mailbox.status === "provisioning" ? "Preparing mailbox" : "Mailbox disabled" : user.mail?.mail_enabled ? "Set up from user details" : "No Mail role"}</small></td><td><span className="console-badge" data-muted={user.disabled_at !== null}>{user.disabled_at === null ? "Active" : "Disabled"}</span>{user.password_reset_required && <small className="console-subtext">Password change required</small>}</td>
            <td className="console-date-column">{adminDate(user.last_login_at)}</td><td><Button nativeButton={false} render={<Link to={`/console/users/${encodeURIComponent(user.id)}`} />} size="sm" variant="ghost" aria-label={`Manage ${user.email_address}`}>Manage<Icon name="chevron" width="12" height="12" /></Button></td></tr>)}</tbody>
        </table>{!resource.data.users.length && <p className="console-empty">No users found.</p>}</div>
        <div className="console-pagination"><span>Page {cursors.length} · {resource.data.users.length} {resource.data.users.length === 1 ? "user" : "users"}</span><div><Button size="sm" disabled={cursors.length === 1} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</Button><Button size="sm" disabled={!resource.data.next_cursor} onClick={() => { if (resource.data?.next_cursor) setCursors((current) => [...current, resource.data!.next_cursor]); }}>Next</Button></div></div>
      </>}
    </section>
  </section>;
}

export function UserEditorPage({ creating = false }: { creating?: boolean }) {
  const notify = useNotifications();
  const { id = "" } = useParams(), navigate = useNavigate(), access = useAccess(), account = useAccount();
  const resource = useResource<{ user: AdminUser }>(creating ? null : `/api/users/${encodeURIComponent(id)}`);
  const user = resource.data?.user, canProfile = creating || access.permissions.includes("admin.users.profile.update");
  const canEmail = creating || access.permissions.includes("admin.users.email.update"), canReset = creating || access.permissions.includes("admin.users.credentials.reset");
  const canUpdate = canProfile || canEmail || canReset || access.permissions.includes("admin.users.status.update");
  const isSelf = !creating && user?.id === account.user?.id;
  const canDisable = (creating || access.permissions.includes("admin.users.status.update")) && (creating || !!account.user && !isSelf);
  const [creationRoles, setCreationRoles] = useState<string[] | null>(null), [creationMail, setCreationMail] = useState(true);
  const mailOptions = useMailResource<{ domains: UserMailDomain[] }>(creating ? "/api/users/mail-options" : null);
  const [mailLocal, setMailLocal] = useState(""), [mailDomain, setMailDomain] = useState("");
  const selectedDomain = mailOptions.data?.domains.find((domain) => domain.id === mailDomain);
  useEffect(() => { if (mailOptions.data && !mailDomain) setMailDomain(preferredDomain(mailOptions.data.domains)?.id ?? ""); }, [mailOptions.data, mailDomain]);
  const [name, setName] = useState(""), [email, setEmail] = useState(""), [password, setPassword] = useState("");
  useEffect(() => { if (creating && creationMail && selectedDomain) setEmail(mailLocal ? `${mailLocal}@${selectedDomain.name}` : ""); }, [creating, creationMail, mailLocal, selectedDomain?.name]);
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
      resource.update(result); notify.success(message); window.dispatchEvent(new Event("officeflare:mail-access-changed"));
      if (result.user.id === account.user?.id) {
        account.update(result.user);
        if ("password" in changes || changesEndSessions(changes as UserChanges)) await sessions.restore(true);
      }
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current) return;
    if (creating && creationRoles === null) return;
    setError("");
    try {
      if ([...name.trim()].length > 200) throw new Error("Display name must contain at most 200 characters.");
      if (creating) {
        validatePassword(password, password); inFlight.current = true; setBusy(true);
        try {
          const result = await api<{ user: AdminUser }>("/api/users", { method: "POST", body: { display_name: name.trim() || null, email_address: (creationMail && selectedDomain ? `${mailLocal.trim()}@${selectedDomain.name}` : email.trim()).toLowerCase(), ...(creationMail && selectedDomain ? { mail_address: { domain_id: selectedDomain.id, local_part: mailLocal.trim().toLowerCase() } } : {}), password, disabled, password_reset_required: passwordReset, role_ids: creationRoles } });
          setPassword("");
          notify.success("The user account has been created.");
          if (access.permissions.includes("admin.users.read")) navigate(`/console/users/${encodeURIComponent(result.user.id)}`);
          else { setName(""); setEmail(""); setMailLocal(""); }
        } finally { inFlight.current = false; setBusy(false); }
      } else if (user) {
        const changes = userChanges(user, { name, email, disabled, passwordReset }, access.permissions, account.user?.id);
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
    <header className="account-page-header"><h1>{creating ? "New user" : user?.display_name || user?.email_address || "User account"}</h1><p>{creating ? "Create a person with their workspace address and personal mail together." : "Manage personal mail, account information and workspace access."}</p></header>
    {!creating && !user ? <ResourceState {...resource} kind="form" label="Loading user…" /> : <>
      {!creating && user && <UserMailPanel user={user} />}
      <Form onSubmit={submit} aria-busy={busy}><section className="account-panel"><div className="account-panel-header"><h2>{creating ? "User details" : "Account information"}</h2><p>{creating ? "The user should change their temporary password when they first sign in." : "Account security changes end the user's active sessions."}</p></div>
        <Fieldset.Root disabled={busy}>
          <TextField label="Display name" name="display_name" autoComplete="off" value={name} onValueChange={setName} readOnly={!canProfile} />
          {creating && creationMail && selectedDomain ? <><MailAddressField domains={mailOptions.data?.domains ?? []} local={mailLocal} domainId={mailDomain} onLocalChange={setMailLocal} onDomainChange={setMailDomain} /><p className="console-subtext">This is their sign-in email and primary mail address. Their personal mailbox is ready after creation.</p></> : <TextField label="Sign-in email" description={creating ? undefined : "Changing sign-in email does not change personal mail or aliases."} name="email_address" type="email" autoComplete="off" required value={email} onValueChange={(value) => { setEmail(value); setMailLocal(value.split("@")[0] ?? ""); }} readOnly={!canEmail} />}
          {creating && mailOptions.error && <Notice error={mailOptions.error} />}
          {creating && creationMail && mailOptions.data && !mailOptions.data.domains.length && <DomainSetupLink />}
          {creating && <><PasswordField id="user-temporary-password" label="Temporary password" value={password} onChange={setPassword} autoComplete="new-password" /><p className="console-subtext">Use 15–128 characters.</p></>}
          <section className="console-role-summary console-account-security"><h3>Account security</h3><div className="console-role-options"><Check checked={disabled} onChange={setDisabled} disabled={!canDisable}>Disable this account{isSelf && <small>You cannot disable your own account.</small>}</Check><Check checked={passwordReset} onChange={setPasswordReset} disabled={!canReset}>Require a password change at next sign-in</Check></div></section>
        </Fieldset.Root>
        {creating && <InitialRoles onChange={setCreationRoles} onMailChange={setCreationMail} disabled={busy} />}
        <Notice error={error} />
        {canUpdate && <div className="account-actions">{creating && <Button type="button" disabled={busy} onClick={() => navigate("/console/users")}>Cancel</Button>}<Button type="submit" variant="primary" disabled={busy || creating && (creationRoles === null || mailOptions.loading || !!mailOptions.error)}>{busy ? "Saving…" : creating ? "Create user" : "Save changes"}</Button></div>}
      </section></Form>
      {!creating && user && <>
        {access.permissions.includes("admin.users.roles.read") && <UserRoles user={user} />}
        <section className="account-panel"><div className="account-panel-header"><h2>Account activity</h2></div><dl className="console-facts"><div><dt>Created</dt><dd>{adminDate(user.created_at)}</dd></div><div><dt>Last sign-in</dt><dd>{adminDate(user.last_login_at)}</dd></div><div><dt>Password changed</dt><dd>{adminDate(user.password_changed_at)}</dd></div></dl></section>
        {canReset && <section className="account-panel account-danger-panel"><div><h2>Reset password</h2><p>Set a temporary password and require a change at the next sign-in.</p></div><Button disabled={busy} onClick={() => setReset(true)}>Reset password</Button></section>}
        {access.permissions.includes("admin.users.delete") && <section className="account-panel account-danger-panel"><div><h2>Delete account</h2><p>Remove this user from the workspace and end all their sessions.</p></div><Button variant="danger" disabled={busy} onClick={() => setRemove(true)}>Delete user</Button></section>}
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

function InitialRoles({ onChange, onMailChange, disabled }: { onChange: (ids: string[] | null) => void; onMailChange: (enabled: boolean) => void; disabled: boolean }) {
  const access = useAccess(), canReadRoles = access.permissions.includes("admin.roles.read");
  const [roles, setRoles] = useState<Role[]>([]), [selected, setSelected] = useState<string[]>([]), [defaults, setDefaults] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); onChange(null);
    void Promise.all([api<{ roles: Role[] }>("/api/users/default-roles", { signal: controller.signal }), canReadRoles ? allRoles(api, controller.signal) : Promise.resolve([])]).then(([result, available]) => {
      if (controller.signal.aborted) return;
      const ids = result.roles.map((role) => role.id);
      setDefaults(ids); setSelected(ids); setRoles(available.length ? available : result.roles); onChange(ids); onMailChange(result.roles.some((role) => role.permissions.includes("mail.access")));
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canReadRoles, onChange, onMailChange]);
  return <details className="console-role-summary"><summary>Workspace access and roles{error ? " · Unable to load" : ""}</summary><p className="console-subtext">Default roles are selected automatically. A role with Mail access includes a personal mailbox.</p>
    {loading ? <LoadingSkeleton label="Loading default roles…" /> : error ? <Notice error={error} /> : <div className="console-role-options">{roles.map((role) => {
      const isDefault = defaults.includes(role.id), allowed = access.permissions.includes(isDefault ? "admin.users.roles.remove" : "admin.users.roles.assign") && canGrant(access.permissions, role.permissions);
      return <Check key={role.id} checked={selected.includes(role.id)} disabled={disabled || !allowed || !selected.includes(role.id) && selected.length >= 50} onChange={(checked) => {
        const ids = checked ? [...selected, role.id] : selected.filter((id) => id !== role.id); setSelected(ids); onChange(ids); onMailChange(roles.some((entry) => ids.includes(entry.id) && entry.permissions.includes("mail.access")));
      }}><strong>{role.label}{isDefault && <span className="console-badge">Default</span>}</strong><small>{role.description}</small></Check>;
    })}{!roles.length && <p className="console-subtext">No default roles configured. This user will have access to their account settings.</p>}</div>}
  </details>;
}

function UserRoles({ user }: { user: AdminUser }) {
  const notify = useNotifications(), access = useAccess(), [revision, setRevision] = useState(0);
  const [assigned, setAssigned] = useState<Role[]>([]), [roles, setRoles] = useState<Role[]>([]), [selected, setSelected] = useState<string[]>([]), [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [confirm, setConfirm] = useState(false);
  useEffect(() => { const reload = () => setRevision((value) => value + 1); window.addEventListener("officeflare:user-mail-changed", reload); return () => window.removeEventListener("officeflare:user-mail-changed", reload); }, []);
  const canAssign = access.permissions.includes("admin.users.roles.assign"), canRemove = access.permissions.includes("admin.users.roles.remove"), editable = canAssign || canRemove;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void Promise.all([api<{ roles: Role[]; version: number }>(`/api/users/${encodeURIComponent(user.id)}/roles`, { signal: controller.signal }), allRoles(api, controller.signal)]).then(([result, available]) => {
      if (controller.signal.aborted) return;
      setAssigned(result.roles); setSelected(result.roles.map((role) => role.id)); setRoles(available); setVersion(result.version);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(failure)); if (failure instanceof ApiError && failure.status === 403) access.refresh(); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user.id, revision, access.refresh]);
  const oldIds = assigned.map((role) => role.id), added = roles.filter((role) => selected.includes(role.id) && !oldIds.includes(role.id)), removed = assigned.filter((role) => !selected.includes(role.id));
  const resulting = [...new Set(roles.filter((role) => selected.includes(role.id)).flatMap((role) => role.permissions))];
  const changed = added.length > 0 || removed.length > 0;
  return <section id="user-roles" className="account-panel"><div className="account-panel-header"><h2>Workspace access</h2><p>Role permissions are combined. Changes apply immediately. You can assign up to 50 roles.</p></div><Notice error={error} />
    {loading ? <LoadingSkeleton label="Loading roles…" /> : error ? null : <>
      {editable ? <div className="console-role-options">{roles.map((role) => {
        const held = canGrant(access.permissions, role.permissions), allowed = oldIds.includes(role.id) ? canRemove && held : canAssign && held;
        return <Check key={role.id} checked={selected.includes(role.id)} disabled={!allowed || !selected.includes(role.id) && selected.length >= 50} onChange={(checked) => setSelected((current) => checked ? [...current, role.id] : current.filter((id) => id !== role.id))}>
          <strong>{role.label}</strong>{role.description && <small>{role.description}</small>}{!held && <small>You cannot change this role because it contains permissions you do not hold.</small>}
        </Check>;
      })}{!roles.length && <p className="console-empty">No roles available.</p>}</div> : <ul className="console-assigned-roles">{assigned.map((role) => <li key={role.id}><Icon name="shield" /><span>{role.label}</span></li>)}{!assigned.length && <li>No roles assigned.</li>}</ul>}
      <div className="console-role-diff">{!!added.length && <span>Add: {added.map((role) => role.label).join(", ")}</span>}{!!removed.length && <span>Remove: {removed.map((role) => role.label).join(", ")}</span>}</div>
      <details className="console-role-summary"><summary>Resulting access · {resulting.length} permissions</summary><PermissionPicker selected={resulting} /></details>
      {editable && <div className="account-actions"><Button variant="primary" disabled={!changed} onClick={() => setConfirm(true)}>Save roles</Button></div>}
    </>}
    <Confirm open={confirm} title="Update assigned roles?" description={<span>Update access for {user.email_address}?{added.length > 0 && <span className="console-subtext">Add: {added.map((role) => role.label).join(", ")}</span>}{removed.length > 0 && <span className="console-subtext">Remove: {removed.map((role) => role.label).join(", ")}</span>}<span className="console-subtext">Result: {resulting.length} permissions. Changes take effect immediately.</span></span>} label="Save roles" onClose={() => setConfirm(false)} onConfirm={async () => {
      await api(`/api/users/${encodeURIComponent(user.id)}/roles`, { method: "PUT", body: { role_ids: selected, version } }); notify.success("Assigned roles have been updated."); access.refresh(); window.dispatchEvent(new Event("officeflare:user-mail-changed"));
    }} />
  </section>;
}
