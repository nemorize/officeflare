import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogPopup,
  CheckboxLabel,
  Button,
  Icon,
  Tabs,
  useNotifications,
} from "./ui";
import { useDrive } from "./drive-context";
import {
  DriveCheckbox,
  DriveField,
  DriveFileIcon,
  DriveIconButton,
  DriveModal,
  DriveNotice,
  DriveSelect,
  DriveState,
  useDriveAction,
  useDriveResource,
} from "./drive-controls";
import { api } from "../lib/api";
import {
  canEdit,
  driveDate,
  publicShareUrl,
  type DriveGrant,
  type DriveItem,
  type DriveLink,
  type DrivePage,
  type DrivePerson,
  type DriveRole,
} from "../lib/drive";
import { useAccount } from "./account-context";
import { DriveOwnerPhotosProvider, DrivePersonAvatar } from "./drive-owner";

export const roles = [
  { value: "viewer", label: "Viewer" },
  { value: "commenter", label: "Commenter" },
  { value: "editor", label: "Editor" },
];
export async function freshItem(id: string, trash = false) {
  return (
    await api<{ item: DriveItem }>(`/api/drive/items/${id}${trash ? "?include_trashed=true" : ""}`)
  ).item;
}
export function DriveRenameDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const [name, setName] = useState(item.name),
    action = useDriveAction(),
    drive = useDrive(),
    notify = useNotifications();
  return (
    <DriveModal
      title="Rename"
      description="Choose a name for this file or folder."
      onClose={onClose}
      busy={action.busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await api(`/api/drive/items/${item.id}`, {
              method: "PATCH",
              body: { version: item.version, name: name.trim() },
            });
            drive.refresh();
            onClose();
            notify.success("Name updated.");
          });
        }}
      >
        <DriveField
          label="Name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={255}
        />
        <DriveNotice error={action.error} />
        <div className="drive-modal-actions">
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={action.busy || !name.trim()}>
            {action.busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </DriveModal>
  );
}
export function DriveDestinationDialog({
  items,
  copy,
  onClose,
}: {
  items: DriveItem[];
  copy: boolean;
  onClose: () => void;
}) {
  const drive = useDrive(),
    notify = useNotifications(),
    action = useDriveAction();
  const [trail, setTrail] = useState<DriveItem[]>([]),
    [view, setView] = useState("my"),
    [name, setName] = useState(`Copy of ${items[0]!.name}`);
  const parent = trail.at(-1),
    query = new URLSearchParams({
      view: parent ? "all" : view,
      kind: "folder",
      limit: "100",
      sort: "name",
      order: "asc",
      parent_id: parent?.id ?? (view === "shared" ? "all" : "root"),
    });
  const folders = useDriveResource<DrivePage>(`/api/drive/items?${query}`, drive.revision),
    [more, setMore] = useState<DriveItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    setMore([]);
    setCursor(folders.data?.next_cursor ?? null);
  }, [folders.data]);
  const eligible = (folder: DriveItem) =>
    canEdit(folder) &&
    !items.some((item) => item.id === folder.id) &&
    (copy || folder.owner_user_id === items[0]?.owner_user_id);
  const rootAllowed =
    view === "my" && (copy || items.every((item) => item.effective_role === "owner"));
  const allowed = parent ? eligible(parent) : rootAllowed;
  const submit = () =>
    void action.run(async () => {
      let succeeded = 0;
      const failures: string[] = [];
      for (const item of items)
        try {
          const current = await freshItem(item.id);
          await api(`/api/drive/items/${item.id}${copy ? "/copy" : ""}`, {
            method: copy ? "POST" : "PATCH",
            body: {
              version: current.version,
              parent_id: parent?.id ?? null,
              ...(copy
                ? {
                    name: items.length === 1 ? name.trim() : `Copy of ${item.name}`,
                  }
                : {}),
            },
          });
          succeeded++;
        } catch (failure) {
          failures.push(`${item.name}: ${failure instanceof Error ? failure.message : "Failed"}`);
        }
      drive.refresh();
      if (succeeded)
        notify.success(
          `${succeeded} ${succeeded === 1 ? "item" : "items"} ${copy ? "copied" : "moved"}.`,
        );
      if (failures.length) throw new Error(failures.join("\n"));
      onClose();
    });
  return (
    <DriveModal
      title={copy ? "Make a copy" : "Move to"}
      description={`${items.length === 1 ? items[0]!.name : `${items.length} selected items`} · Choose a destination folder.`}
      onClose={onClose}
      busy={action.busy}
    >
      <Tabs.Root
        value={view}
        onValueChange={(value) => {
          if (value !== "my" && value !== "shared") return;
          setView(value);
          setTrail([]);
        }}
      >
        <Tabs.List className="drive-picker-tabs" aria-label="Destination drive">
          <Tabs.Tab value="my">My drive</Tabs.Tab>
          <Tabs.Tab value="shared">Shared folders</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value={view}>
          <div className="drive-picker-path">
            <DriveIconButton
              icon="back"
              label="Parent folder"
              disabled={!trail.length}
              onClick={() => setTrail((old) => old.slice(0, -1))}
            />
            <Icon name="folder" />
            <strong>{parent?.name ?? (view === "my" ? "My drive" : "Shared with me")}</strong>
          </div>
          <div className="drive-folder-picker">
            <DriveState loading={folders.loading} error={folders.error} retry={folders.reload} />
            {!folders.loading &&
              !folders.error &&
              [...(folders.data?.items ?? []), ...more].filter(eligible).map((folder) => (
                <Button
                  key={folder.id}
                  variant="ghost"
                  className="drive-picker-folder"
                  onClick={() => setTrail((old) => [...old, folder])}
                >
                  <Icon name="folder" />
                  <span>{folder.name}</span>
                  <Icon name="chevron" />
                </Button>
              ))}
            {!folders.loading &&
              !folders.error &&
              ![...(folders.data?.items ?? []), ...more].filter(eligible).length && (
                <p className="drive-muted">No available subfolders. You can use this location.</p>
              )}
            {cursor && (
              <Button
                variant="ghost"
                onClick={() =>
                  void action.run(async () => {
                    const next = await api<DrivePage>(
                      `/api/drive/items?${query}&cursor=${encodeURIComponent(cursor)}`,
                    );
                    setMore((old) => [...old, ...next.items]);
                    setCursor(next.next_cursor);
                  })
                }
              >
                Load more folders
              </Button>
            )}
          </div>
        </Tabs.Panel>
      </Tabs.Root>
      {copy && items.length === 1 && (
        <DriveField
          label="Copy name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={255}
        />
      )}
      {!allowed && (
        <p className="drive-muted">
          Choose a folder you can edit{!copy && " under the same owner"}.
        </p>
      )}
      <DriveNotice error={action.error} />
      <div className="drive-modal-actions">
        <Button onClick={onClose} disabled={action.busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={action.busy || !allowed || (copy && !name.trim())}
        >
          {action.busy ? "Working…" : copy ? "Copy here" : "Move here"}
        </Button>
      </div>
    </DriveModal>
  );
}
export function DriveConfirmDialog({
  title,
  description,
  confirm,
  onClose,
  action: callback,
  destructive = false,
}: {
  title: string;
  description: string;
  confirm: string;
  onClose: () => void;
  action: () => Promise<void>;
  destructive?: boolean;
}) {
  const action = useDriveAction();
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose();
      }}
    >
      <AlertDialogPopup
        data-ui-theme="neutral"
        className="drive-modal"
        viewportProps={{ className: "drive-modal-viewport" }}
      >
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>{description}</AlertDialog.Description>
        <DriveNotice error={action.error} />
        <div className="drive-modal-actions">
          <Button disabled={action.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await callback();
                onClose();
              })
            }
          >
            {action.busy ? "Working…" : confirm}
          </Button>
        </div>
      </AlertDialogPopup>
    </AlertDialog.Root>
  );
}
function DrivePeoplePicker({
  selected,
  onSelect,
}: {
  selected: DrivePerson | null;
  onSelect: (person: DrivePerson | null) => void;
}) {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const result = useDriveResource<{ people: DrivePerson[] }>(
    search.length >= 2 ? `/api/drive/people?q=${encodeURIComponent(search)}` : null,
  );
  return (
    <div className="drive-people-picker">
      {selected ? (
        <div className="drive-person-chip">
          <span className="drive-person-avatar">
            {(selected.display_name || selected.email_address).slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{selected.display_name || selected.email_address}</strong>
            <span>{selected.email_address}</span>
          </div>
          <DriveIconButton
            icon="close"
            label="Remove selected account"
            onClick={() => onSelect(null)}
          />
        </div>
      ) : (
        <>
          <DriveField
            label="Add people"
            placeholder="Search by name or email"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
          />
          <div className="drive-people-results" aria-live="polite">
            {result.loading ? (
              <p>Searching accounts…</p>
            ) : result.error ? (
              <DriveNotice error={result.error} />
            ) : result.data && !result.data.people.length ? (
              <p>No matching Drive accounts.</p>
            ) : (
              result.data?.people.map((person) => (
                <Button
                  variant="ghost"
                  key={person.id}
                  onClick={() => {
                    onSelect(person);
                    setQuery("");
                  }}
                >
                  <span className="drive-person-avatar">
                    {(person.display_name || person.email_address).slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{person.display_name || person.email_address}</strong>
                    <small>{person.email_address}</small>
                  </span>
                  <Icon name="plus" />
                </Button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
export function DriveShareDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const drive = useDrive(),
    account = useAccount(),
    notify = useNotifications(),
    action = useDriveAction();
  const [tab, setTab] = useState("people"),
    [person, setPerson] = useState<DrivePerson | null>(null),
    [role, setRole] = useState("viewer"),
    [expiry, setExpiry] = useState("");
  const [password, setPassword] = useState(""),
    [linkExpiry, setLinkExpiry] = useState(""),
    [allowDownload, setAllowDownload] = useState(true),
    [createdUrl, setCreatedUrl] = useState(""),
    [createdLinkId, setCreatedLinkId] = useState("");
  const [transfer, setTransfer] = useState<DrivePerson | null>(null),
    [revoke, setRevoke] = useState<DriveLink | null>(null);
  const permissions = useDriveResource<{ permissions: DriveGrant[] }>(
    `/api/drive/items/${item.id}/permissions`,
    drive.revision,
  );
  const links = useDriveResource<{ links: DriveLink[] }>(
    `/api/drive/items/${item.id}/links`,
    drive.revision,
  );
  const requests = useDriveResource<{
    requests: {
      id: string;
      user_id: string;
      role: string;
      message: string;
      display_name: string;
      email_address: string;
    }[];
  }>(`/api/drive/items/${item.id}/access-requests`, drive.revision);
  const expiration = (value: string) =>
    value ? Math.floor(new Date(value).getTime() / 1000) : null;
  const mutate = (callback: (current: DriveItem) => Promise<unknown>, message: string) =>
    void action.run(async () => {
      await callback(await freshItem(item.id));
      drive.refresh();
      notify.success(message);
    });
  const storageKey = (id: string) => `officeflare.drive.link.${account.user?.id}.${id}`;
  const copyUrl = async (url: string) => {
    await navigator.clipboard.writeText(url);
    notify.success("Link copied.");
  };
  const owner = item.owner?.id === account.user?.id ? (account.user ?? item.owner) : item.owner;
  return (
    <DriveOwnerPhotosProvider>
      <DriveModal
        wide
        title={`Share “${item.name}”`}
        description={
          item.kind === "folder"
            ? "Folder access also applies to files and subfolders inside it."
            : "Choose who can access this file."
        }
        onClose={onClose}
        busy={action.busy}
      >
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            setTab(String(value));
            action.setError("");
          }}
        >
          <Tabs.List className="drive-share-tabs" aria-label="Sharing options">
            <Tabs.Tab value="people">People with access</Tabs.Tab>
            <Tabs.Tab value="links">Public links</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="people">
            {item.actions?.internal_share !== false && (
              <DrivePeoplePicker selected={person} onSelect={setPerson} />
            )}
            {item.actions?.internal_share === false && (
              <p className="drive-muted">
                Adding or changing internal access is restricted by your role or workspace policy.
                You can still remove direct grants.
              </p>
            )}
            {person && (
              <div className="drive-invite-options">
                <DriveSelect label="Access role" value={role} options={roles} onChange={setRole} />
                <DriveField
                  label="Access expires"
                  type="datetime-local"
                  value={expiry}
                  onChange={(event) => setExpiry(event.target.value)}
                />
                <Button
                  variant="primary"
                  disabled={action.busy || item.actions?.internal_share === false}
                  onClick={() =>
                    mutate(
                      (current) =>
                        api(`/api/drive/items/${item.id}/permissions/${person.id}`, {
                          method: "PUT",
                          body: {
                            version: current.version,
                            role,
                            expires_at: expiration(expiry),
                          },
                        }).then(() => {
                          setPerson(null);
                          setExpiry("");
                        }),
                      "Access granted.",
                    )
                  }
                >
                  Share
                </Button>
              </div>
            )}
            <h3 className="drive-section-label">People with access</h3>
            <div className="drive-access-person">
              <DrivePersonAvatar person={owner} />
              <div>
                <strong>
                  {owner?.display_name || owner?.email_address || "Owner"}
                  {owner?.id === account.user?.id && " (you)"}
                </strong>
                <span>{owner?.email_address}</span>
              </div>
              <span className="drive-muted">Owner</span>
            </div>
            <DriveState
              loading={permissions.loading && !permissions.data}
              error={permissions.error}
              retry={permissions.reload}
            />
            {permissions.data?.permissions.map((grant) => (
              <div className="drive-access-person" key={`${grant.item_id}:${grant.user_id}`}>
                <DrivePersonAvatar
                  person={{
                    id: grant.user_id,
                    display_name: grant.display_name,
                    email_address: grant.email_address,
                    has_profile_image: grant.has_profile_image,
                    profile_image_version: grant.profile_image_version,
                  }}
                />
                <div>
                  <strong>{grant.display_name || grant.email_address}</strong>
                  <span>{grant.email_address}</span>
                  {!!grant.inherited && <small>Inherited from {grant.source_name}</small>}
                  {grant.expires_at && <small>Expires {driveDate(grant.expires_at, true)}</small>}
                </div>
                {grant.inherited ? (
                  <span className="drive-role-label">{grant.role}</span>
                ) : (
                  <>
                    <DriveSelect
                      label={`Role for ${grant.display_name || grant.email_address}`}
                      value={grant.role}
                      options={roles}
                      disabled={action.busy || item.actions?.internal_share === false}
                      onChange={(next) =>
                        mutate(
                          (current) =>
                            api(`/api/drive/items/${item.id}/permissions/${grant.user_id}`, {
                              method: "PUT",
                              body: {
                                version: current.version,
                                role: next,
                                expires_at: grant.expires_at,
                              },
                            }),
                          "Access updated.",
                        )
                      }
                    />
                    <MenuForPerson
                      canTransfer={item.actions?.internal_share !== false}
                      grant={grant}
                      disabled={action.busy}
                      onRemove={() =>
                        mutate(
                          (current) =>
                            api(
                              `/api/drive/items/${item.id}/permissions/${grant.user_id}?version=${current.version}`,
                              { method: "DELETE" },
                            ),
                          "Access removed.",
                        )
                      }
                      onTransfer={() =>
                        setTransfer({
                          id: grant.user_id,
                          display_name: grant.display_name,
                          email_address: grant.email_address,
                        })
                      }
                    />
                  </>
                )}
              </div>
            ))}
            {!!requests.data?.requests.length && (
              <>
                <h3 className="drive-section-label">Access requests</h3>
                {requests.data.requests.map((request) => (
                  <div className="drive-request" key={request.id}>
                    <strong>{request.display_name || request.email_address}</strong>
                    <span>
                      {request.email_address} · {request.role}
                    </span>
                    {request.message && <p>{request.message}</p>}
                    <div>
                      <Button
                        size="sm"
                        disabled={action.busy || item.actions?.internal_share === false}
                        onClick={() =>
                          mutate(
                            (current) =>
                              api(`/api/drive/items/${item.id}/access-requests/${request.id}`, {
                                method: "PATCH",
                                body: {
                                  version: current.version,
                                  approved: false,
                                },
                              }),
                            "Request declined.",
                          )
                        }
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={action.busy || item.actions?.internal_share === false}
                        onClick={() =>
                          mutate(
                            (current) =>
                              api(`/api/drive/items/${item.id}/access-requests/${request.id}`, {
                                method: "PATCH",
                                body: {
                                  version: current.version,
                                  approved: true,
                                  role: request.role,
                                },
                              }),
                            "Request approved.",
                          )
                        }
                      >
                        Approve
                      </Button>
                    </div>
                  </div>
                ))}
              </>
            )}
            <div className="drive-share-note">
              <Icon name="shield" />
              <span>
                Access is restricted to these accounts. Public links are managed separately.
              </span>
            </div>
          </Tabs.Panel>
          <Tabs.Panel value="links">
            <div className="drive-link-intro">
              <span className="drive-link-symbol">
                <Icon name="link" width="24" height="24" />
              </span>
              <div>
                <h3>Share outside your workspace</h3>
                <p>
                  Anyone with an active link can view{" "}
                  {item.kind === "folder" ? "this folder and its contents" : "this file"}. Public
                  access is read only.
                </p>
              </div>
            </div>
            {item.actions?.public_share === false && (
              <p className="drive-muted">
                Creating or changing public links is restricted by your role or workspace policy.
                Existing links can still be revoked.
              </p>
            )}
            {drive.capabilities?.public_link_max_days ? (
              <p className="drive-muted">
                Links must expire within {drive.capabilities.public_link_max_days} days of creation.
              </p>
            ) : null}
            <div className="drive-link-fields">
              <DriveField
                label={
                  drive.capabilities?.public_link_password_required
                    ? "Link password (required)"
                    : "Link password (optional)"
                }
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                maxLength={128}
                hint="Use at least 8 characters."
              />
              <DriveField
                label={
                  drive.capabilities?.public_link_max_days
                    ? "Link expires (required)"
                    : "Link expires (optional)"
                }
                type="datetime-local"
                value={linkExpiry}
                onChange={(event) => setLinkExpiry(event.target.value)}
              />
            </div>
            <CheckboxLabel className="drive-check-label">
              <DriveCheckbox
                checked={allowDownload}
                onCheckedChange={(value) => setAllowDownload(!!value)}
              />
              Allow file preview and download
            </CheckboxLabel>
            <div className="drive-modal-actions drive-link-create-actions">
              <Button
                variant="primary"
                disabled={
                  action.busy ||
                  item.actions?.public_share === false ||
                  (!!password && password.length < 8) ||
                  (!!drive.capabilities?.public_link_password_required && password.length < 8) ||
                  (!!drive.capabilities?.public_link_max_days && !linkExpiry)
                }
                onClick={() =>
                  mutate(async (current) => {
                    const result = await api<{
                      link: DriveLink & { token: string };
                    }>(`/api/drive/items/${item.id}/links`, {
                      method: "POST",
                      body: {
                        version: current.version,
                        password: password || null,
                        expires_at: expiration(linkExpiry),
                        allow_download: allowDownload,
                      },
                    });
                    const url = publicShareUrl(result.link.token, window.location.origin);
                    try {
                      sessionStorage.setItem(storageKey(result.link.id), url);
                    } catch {
                      /* Copyable URL remains in the dialog. */
                    }
                    setCreatedUrl(url);
                    setCreatedLinkId(result.link.id);
                    setPassword("");
                  }, "Public link created.")
                }
              >
                <Icon name="plus" />
                Create public link
              </Button>
            </div>
            {createdUrl && (
              <div className="drive-created-link">
                <DriveField
                  label="New share link"
                  value={createdUrl}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
                <Button onClick={() => void action.run(() => copyUrl(createdUrl))}>
                  <Icon name="copy" />
                  Copy link
                </Button>
              </div>
            )}
            <h3 className="drive-section-label">Existing links</h3>
            <DriveState
              loading={links.loading && !links.data}
              error={links.error}
              retry={links.reload}
            />
            {links.data && !links.data.links.filter((link) => !link.revoked_at).length && (
              <p className="drive-muted">No active public links.</p>
            )}
            {links.data?.links
              .filter((link) => !link.revoked_at)
              .map((link) => {
                let url = "";
                try {
                  url = sessionStorage.getItem(storageKey(link.id)) ?? "";
                } catch {
                  /* Storage unavailable. */
                }
                const expired = !!link.expires_at && link.expires_at * 1000 <= Date.now();
                return (
                  <div className="drive-link-row" key={link.id}>
                    <Icon name={link.password_protected ? "shield" : "link"} />
                    <div>
                      <strong>
                        {expired
                          ? "Expired link"
                          : link.password_protected
                            ? "Password protected link"
                            : "Anyone with the link"}
                      </strong>
                      <span>
                        {link.expires_at
                          ? `Expires ${driveDate(link.expires_at, true)}`
                          : "No expiration"}{" "}
                        · {link.allow_download ? "Downloads allowed" : "Metadata only"}
                      </span>
                      {!url && (
                        <small>
                          The URL is available only when a link is created. Create a new link to
                          share again.
                        </small>
                      )}
                    </div>
                    {url && !expired && (
                      <DriveIconButton
                        icon="copy"
                        label="Copy public link"
                        onClick={() => void action.run(() => copyUrl(url))}
                      />
                    )}
                    <DriveIconButton
                      icon="close"
                      label="Revoke public link"
                      onClick={() => setRevoke(link)}
                    />
                  </div>
                );
              })}
          </Tabs.Panel>
        </Tabs.Root>
        <DriveNotice error={action.error} />
        <div className="drive-modal-actions drive-share-footer">
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(() => copyUrl(`${window.location.origin}/drive/items/${item.id}`))
            }
          >
            <Icon name="link" />
            Copy workspace link
          </Button>
          <Button variant="primary" disabled={action.busy} onClick={onClose}>
            Done
          </Button>
        </div>
        {revoke && (
          <DriveConfirmDialog
            title="Revoke this public link?"
            description="Anyone using this link will lose access immediately."
            confirm="Revoke link"
            destructive
            onClose={() => setRevoke(null)}
            action={async () => {
              const current = await freshItem(item.id);
              await api(`/api/drive/items/${item.id}/links/${revoke.id}`, {
                method: "PATCH",
                body: { version: current.version, revoked: true },
              });
              if (revoke.id === createdLinkId) setCreatedUrl("");
              try {
                sessionStorage.removeItem(storageKey(revoke.id));
              } catch {
                /* Storage unavailable. */
              }
              drive.refresh();
              notify.success("Public link revoked.");
            }}
          />
        )}
        {transfer && (
          <DriveConfirmDialog
            title="Transfer ownership?"
            description={`“${item.name}” and its contents will belong to ${transfer.display_name || transfer.email_address}. You will become an editor. Existing public links will be revoked.`}
            confirm="Transfer ownership"
            onClose={() => setTransfer(null)}
            action={async () => {
              const current = await freshItem(item.id);
              await api(`/api/drive/items/${item.id}/transfer`, {
                method: "POST",
                body: { version: current.version, user_id: transfer.id },
              });
              drive.refresh();
              notify.success("Ownership transferred.");
              onClose();
            }}
          />
        )}
      </DriveModal>
    </DriveOwnerPhotosProvider>
  );
}
import { Menu, MenuPopup } from "./ui";
function MenuForPerson({
  canTransfer,
  grant,
  disabled,
  onRemove,
  onTransfer,
}: {
  grant: DriveGrant;
  disabled: boolean;
  onRemove: () => void;
  onTransfer: () => void;
  canTransfer: boolean;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={<Button size="icon" variant="ghost" />}
        aria-label={`Access options for ${grant.display_name || grant.email_address}`}
        disabled={disabled}
      >
        <Icon name="more" />
      </Menu.Trigger>
      <MenuPopup data-ui-theme="neutral" positionerProps={{ align: "end" }}>
        <Menu.Item disabled={!canTransfer} onClick={onTransfer}>
          <Icon name="user" />
          Transfer ownership
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item onClick={onRemove} data-variant="danger">
          <Icon name="close" />
          Remove access
        </Menu.Item>
      </MenuPopup>
    </Menu.Root>
  );
}
