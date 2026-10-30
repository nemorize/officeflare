import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "./i18n";
import { t, plural } from "../../shared/i18n/index.ts";
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
  { value: "viewer", label: t("componentsDriveDialogs.viewer") },
  { value: "commenter", label: t("componentsDriveDialogs.commenter") },
  { value: "editor", label: t("componentsDriveDialogs.editor") },
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
      title={t("componentsDriveDialogs.rename")}
      description={t("componentsDriveDialogs.chooseANameForThisFileOrFolder")}
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
            notify.success(t("componentsDriveDialogs.nameUpdated"));
          });
        }}
      >
        <DriveField
          label={t("common.name")}
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={255}
        />
        <DriveNotice error={action.error} />
        <div className="drive-modal-actions">
          <Button onClick={onClose} disabled={action.busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={action.busy || !name.trim()}>
            {action.busy ? t("common.saving") : t("common.save")}
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
    [name, setName] = useState(t("componentsDriveDialogs.copyOf", { name: items[0]!.name }));
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
                    name:
                      items.length === 1
                        ? name.trim()
                        : t("componentsDriveDialogs.copyOf", { name: item.name }),
                  }
                : {}),
            },
          });
          succeeded++;
        } catch (failure) {
          failures.push(
            `${item.name}: ${failure instanceof Error ? failure.message : t("componentsDriveDialogs.failed")}`,
          );
        }
      drive.refresh();
      if (succeeded) notify.success(plural(copy ? "drive.copied" : "drive.moved", succeeded));
      if (failures.length) throw new Error(failures.join("\n"));
      onClose();
    });
  return (
    <DriveModal
      title={copy ? t("componentsDriveDialogs.makeACopy") : t("componentsDriveDialogs.moveTo")}
      description={t("componentsDriveDialogs.chooseADestinationFolder", {
        value1:
          items.length === 1
            ? items[0]!.name
            : t("componentsDriveDialogs.selectedItems", { length: items.length }),
      })}
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
        <Tabs.List
          className="drive-picker-tabs"
          aria-label={t("componentsDriveDialogs.destinationDrive")}
        >
          <Tabs.Tab value="my">{t("componentsDriveDialogs.myDrive")}</Tabs.Tab>
          <Tabs.Tab value="shared">{t("componentsDriveDialogs.sharedFolders")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value={view}>
          <div className="drive-picker-path">
            <DriveIconButton
              icon="back"
              label={t("componentsDriveDialogs.parentFolder")}
              disabled={!trail.length}
              onClick={() => setTrail((old) => old.slice(0, -1))}
            />
            <Icon name="folder" />
            <strong>
              {parent?.name ??
                (view === "my"
                  ? t("componentsDriveDialogs.myDrive")
                  : t("componentsDriveDialogs.sharedWithMe"))}
            </strong>
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
                <p className="drive-muted">
                  {t("componentsDriveDialogs.noAvailableSubfoldersYouCanUseThisLocation")}
                </p>
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
                {t("componentsDriveDialogs.loadMoreFolders")}
              </Button>
            )}
          </div>
        </Tabs.Panel>
      </Tabs.Root>
      {copy && items.length === 1 && (
        <DriveField
          label={t("componentsDriveDialogs.copyName")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={255}
        />
      )}
      {!allowed && (
        <p className="drive-muted">
          {t("componentsDriveDialogs.chooseAFolderYouCanEdit", {
            value1: copy ? "" : t("componentsDriveDialogs.underTheSameOwner"),
          })}
        </p>
      )}
      <DriveNotice error={action.error} />
      <div className="drive-modal-actions">
        <Button onClick={onClose} disabled={action.busy}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={action.busy || !allowed || (copy && !name.trim())}
        >
          {action.busy
            ? t("componentsDriveDialogs.working")
            : copy
              ? t("componentsDriveDialogs.copyHere")
              : t("componentsDriveDialogs.moveHere")}
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
            {t("common.cancel")}
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
            {action.busy ? t("componentsDriveDialogs.working") : confirm}
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
            label={t("componentsDriveDialogs.removeSelectedAccount")}
            onClick={() => onSelect(null)}
          />
        </div>
      ) : (
        <>
          <DriveField
            label={t("componentsDriveDialogs.addPeople")}
            placeholder={t("componentsDriveDialogs.searchByNameOrEmail")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
          />
          <div className="drive-people-results" aria-live="polite">
            {result.loading ? (
              <p>{t("componentsDriveDialogs.searchingAccounts")}</p>
            ) : result.error ? (
              <DriveNotice error={result.error} />
            ) : result.data && !result.data.people.length ? (
              <p>{t("componentsDriveDialogs.noMatchingDriveAccounts")}</p>
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
    notify.success(t("componentsDriveDialogs.linkCopied"));
  };
  const owner = item.owner?.id === account.user?.id ? (account.user ?? item.owner) : item.owner;
  return (
    <DriveOwnerPhotosProvider>
      <DriveModal
        wide
        title={t("componentsDriveDialogs.share", { name: item.name })}
        description={
          item.kind === "folder"
            ? t("componentsDriveDialogs.folderAccessAlsoAppliesToFilesAndSubfoldersInside")
            : t("componentsDriveDialogs.chooseWhoCanAccessThisFile")
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
          <Tabs.List
            className="drive-share-tabs"
            aria-label={t("componentsDriveDialogs.sharingOptions")}
          >
            <Tabs.Tab value="people">{t("componentsDriveDialogs.peopleWithAccess")}</Tabs.Tab>
            <Tabs.Tab value="links">{t("componentsDriveDialogs.publicLinks")}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="people">
            {item.actions?.internal_share !== false && (
              <DrivePeoplePicker selected={person} onSelect={setPerson} />
            )}
            {item.actions?.internal_share === false && (
              <p className="drive-muted">
                {t("componentsDriveDialogs.addingOrChangingInternalAccessIsRestrictedByYour")}
              </p>
            )}
            {person && (
              <div className="drive-invite-options">
                <DriveSelect
                  label={t("componentsDriveDialogs.accessRole")}
                  value={role}
                  options={roles}
                  onChange={setRole}
                />
                <DriveField
                  label={t("componentsDriveDialogs.accessExpires")}
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
                      t("componentsDriveDialogs.accessGranted"),
                    )
                  }
                >
                  {t("componentsDriveDialogs.share2")}
                </Button>
              </div>
            )}
            <h3 className="drive-section-label">{t("componentsDriveDialogs.peopleWithAccess")}</h3>
            <div className="drive-access-person">
              <DrivePersonAvatar person={owner} />
              <div>
                <strong>
                  {owner?.display_name || owner?.email_address || t("componentsDriveDialogs.owner")}
                  {owner?.id === account.user?.id && t("componentsDriveDialogs.you")}
                </strong>
                <span>{owner?.email_address}</span>
              </div>
              <span className="drive-muted">{t("componentsDriveDialogs.owner")}</span>
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
                  {!!grant.inherited && (
                    <small>
                      <LocalizedMessage
                        id="componentsDriveDialogs.inheritedFrom"
                        values={{ source_name: grant.source_name }}
                      />
                    </small>
                  )}
                  {grant.expires_at && (
                    <small>
                      <LocalizedMessage
                        id="componentsDriveDialogs.expires"
                        values={{ driveDate: driveDate(grant.expires_at, true) }}
                      />
                    </small>
                  )}
                </div>
                {grant.inherited ? (
                  <span className="drive-role-label">{enumLabel(grant.role)}</span>
                ) : (
                  <>
                    <DriveSelect
                      label={t("componentsDriveDialogs.roleFor", {
                        value1: grant.display_name || grant.email_address,
                      })}
                      value={enumLabel(grant.role)}
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
                          t("componentsDriveDialogs.accessUpdated"),
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
                          t("componentsDriveDialogs.accessRemoved"),
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
                <h3 className="drive-section-label">
                  {t("componentsDriveDialogs.accessRequests")}
                </h3>
                {requests.data.requests.map((request) => (
                  <div className="drive-request" key={request.id}>
                    <strong>{request.display_name || request.email_address}</strong>
                    <span>
                      {request.email_address}
                      {t("componentsDriveDialogs.text")}
                      {enumLabel(request.role)}
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
                            t("componentsDriveDialogs.requestDeclined"),
                          )
                        }
                      >
                        {t("componentsDriveDialogs.decline")}
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
                            t("componentsDriveDialogs.requestApproved"),
                          )
                        }
                      >
                        {t("componentsDriveDialogs.approve")}
                      </Button>
                    </div>
                  </div>
                ))}
              </>
            )}
            <div className="drive-share-note">
              <Icon name="shield" />
              <span>
                {t("componentsDriveDialogs.accessIsRestrictedToTheseAccountsPublicLinksAre")}
              </span>
            </div>
          </Tabs.Panel>
          <Tabs.Panel value="links">
            <div className="drive-link-intro">
              <span className="drive-link-symbol">
                <Icon name="link" width="24" height="24" />
              </span>
              <div>
                <h3>{t("componentsDriveDialogs.shareOutsideYourWorkspace")}</h3>
                <p>
                  {t("componentsDriveDialogs.anyoneWithAnActiveLinkCanViewPublicAccess", {
                    value1:
                      item.kind === "folder"
                        ? t("componentsDriveDialogs.thisFolderAndItsContents")
                        : t("componentsDriveDialogs.thisFile"),
                  })}
                </p>
              </div>
            </div>
            {item.actions?.public_share === false && (
              <p className="drive-muted">
                {t("componentsDriveDialogs.creatingOrChangingPublicLinksIsRestrictedByYour")}
              </p>
            )}
            {drive.capabilities?.public_link_max_days ? (
              <p className="drive-muted">
                <LocalizedMessage
                  id="componentsDriveDialogs.linksMustExpireWithinDaysOfCreation"
                  values={{ public_link_max_days: drive.capabilities.public_link_max_days }}
                />
              </p>
            ) : null}
            <div className="drive-link-fields">
              <DriveField
                label={
                  drive.capabilities?.public_link_password_required
                    ? t("componentsDriveDialogs.linkPasswordRequired")
                    : t("componentsDriveDialogs.linkPasswordOptional")
                }
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                maxLength={128}
                hint={t("componentsDriveDialogs.useAtLeast8Characters")}
              />
              <DriveField
                label={
                  drive.capabilities?.public_link_max_days
                    ? t("componentsDriveDialogs.linkExpiresRequired")
                    : t("componentsDriveDialogs.linkExpiresOptional")
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
              {t("componentsDriveDialogs.allowFilePreviewAndDownload")}
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
                  }, t("componentsDriveDialogs.publicLinkCreated"))
                }
              >
                <Icon name="plus" />
                {t("componentsDriveDialogs.createPublicLink")}
              </Button>
            </div>
            {createdUrl && (
              <div className="drive-created-link">
                <DriveField
                  label={t("componentsDriveDialogs.newShareLink")}
                  value={createdUrl}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
                <Button onClick={() => void action.run(() => copyUrl(createdUrl))}>
                  <Icon name="copy" />
                  {t("componentsDriveDialogs.copyLink")}
                </Button>
              </div>
            )}
            <h3 className="drive-section-label">{t("componentsDriveDialogs.existingLinks")}</h3>
            <DriveState
              loading={links.loading && !links.data}
              error={links.error}
              retry={links.reload}
            />
            {links.data && !links.data.links.filter((link) => !link.revoked_at).length && (
              <p className="drive-muted">{t("componentsDriveDialogs.noActivePublicLinks")}</p>
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
                          ? t("componentsDriveDialogs.expiredLink")
                          : link.password_protected
                            ? t("componentsDriveDialogs.passwordProtectedLink")
                            : t("componentsDriveDialogs.anyoneWithTheLink")}
                      </strong>
                      <span>
                        {link.expires_at
                          ? t("componentsDriveDialogs.expires", {
                              driveDate: driveDate(link.expires_at, true),
                            })
                          : t("componentsDriveDialogs.noExpiration")}{" "}
                        {t("componentsDriveDialogs.text2")}
                        {link.allow_download
                          ? t("componentsDriveDialogs.downloadsAllowed")
                          : t("componentsDriveDialogs.metadataOnly")}
                      </span>
                      {!url && (
                        <small>
                          {t("componentsDriveDialogs.theUrlIsAvailableOnlyWhenALinkIs")}
                        </small>
                      )}
                    </div>
                    {url && !expired && (
                      <DriveIconButton
                        icon="copy"
                        label={t("componentsDriveDialogs.copyPublicLink")}
                        onClick={() => void action.run(() => copyUrl(url))}
                      />
                    )}
                    <DriveIconButton
                      icon="close"
                      label={t("componentsDriveDialogs.revokePublicLink")}
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
            {t("componentsDriveDialogs.copyWorkspaceLink")}
          </Button>
          <Button variant="primary" disabled={action.busy} onClick={onClose}>
            {t("common.done")}
          </Button>
        </div>
        {revoke && (
          <DriveConfirmDialog
            title={t("componentsDriveDialogs.revokeThisPublicLink")}
            description={t("componentsDriveDialogs.anyoneUsingThisLinkWillLoseAccessImmediately")}
            confirm={t("componentsDriveDialogs.revokeLink")}
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
              notify.success(t("componentsDriveDialogs.publicLinkRevoked"));
            }}
          />
        )}
        {transfer && (
          <DriveConfirmDialog
            title={t("componentsDriveDialogs.transferOwnership")}
            description={t("componentsDriveDialogs.andItsContentsWillBelongToYouWillBecome", {
              name: item.name,
              value2: transfer.display_name || transfer.email_address,
            })}
            confirm={t("componentsDriveDialogs.transferOwnership2")}
            onClose={() => setTransfer(null)}
            action={async () => {
              const current = await freshItem(item.id);
              await api(`/api/drive/items/${item.id}/transfer`, {
                method: "POST",
                body: { version: current.version, user_id: transfer.id },
              });
              drive.refresh();
              notify.success(t("componentsDriveDialogs.ownershipTransferred"));
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
        aria-label={t("componentsDriveDialogs.accessOptionsFor", {
          value1: grant.display_name || grant.email_address,
        })}
        disabled={disabled}
      >
        <Icon name="more" />
      </Menu.Trigger>
      <MenuPopup data-ui-theme="neutral" positionerProps={{ align: "end" }}>
        <Menu.Item disabled={!canTransfer} onClick={onTransfer}>
          <Icon name="user" />
          {t("componentsDriveDialogs.transferOwnership2")}
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item onClick={onRemove} data-variant="danger">
          <Icon name="close" />
          {t("componentsDriveDialogs.removeAccess")}
        </Menu.Item>
      </MenuPopup>
    </Menu.Root>
  );
}
