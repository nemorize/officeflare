import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "../components/i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { api, errorMessage } from "../lib/api";
import {
  accountAvailability,
  driveConsolePages,
  GIB,
  storageBytes,
  type AdminDriveItem,
  type AdminPage,
  type DriveAccount,
  type DriveAudit,
  type DriveSettings,
  type DriveSharing,
  type DriveTransfer,
} from "../lib/drive-admin";
import { formatBytes } from "../lib/drive";
import { driveUserPermissions } from "../lib/console";
import { AccessDenied, useAccess } from "../components/console-access";
import { adminDate, Check, Confirm, Notice, useResource } from "../components/console-shared";
import { PermissionPicker } from "../components/permission-picker";
import { Button, useNotifications } from "../components/ui";
import {
  ConsoleDialog,
  ConsoleDetail,
  ConsoleSettingsLayout,
  ConsoleSettingsHeader,
  ConsoleSection,
  ConsoleInput,
  ConsoleSelectField,
  ConsoleFilters,
  ConsoleTable,
  ConsoleMetrics,
  ConsoleState,
  ConsolePagination,
  ConsoleFormActions,
  ConsoleForm,
  ConsoleDateFilters,
} from "../components/console-settings";
import "./console.css";

const endpoint = "/api/drive/admin";
const localDate = (value: number | null) =>
  value
    ? new Date(value * 1000 - new Date(value * 1000).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
const expiration = (value: string) => (value ? Math.floor(new Date(value).getTime() / 1000) : null);
const allowed = (permissions: string[], key: string) => permissions.includes(`admin.drive.${key}`);

function useDirectory(value: string, exclude: string, writable: boolean) {
  const resource = useResource<AdminPage<DriveAccount>>(
    allowed(useAccess().permissions, "accounts.read")
      ? `${endpoint}/accounts?state=enabled&q=${encodeURIComponent(value)}&limit=100`
      : null,
  );
  return {
    ...resource,
    options: [
      { value: "", label: t("routesConsoleDrive.chooseAnAccount") },
      ...(resource.data?.items
        .filter((account) => account.user_id !== exclude)
        .map((account) => ({
          value: account.user_id,
          label: `${account.display_name ? `${account.display_name} · ` : ""}${account.email_address}`,
          disabled: writable && account.status !== "active",
        })) ?? []),
    ],
  };
}
function AccountPicker({
  value,
  onChange,
  exclude,
  writable = false,
}: {
  value: string;
  onChange: (value: string) => void;
  exclude: string;
  writable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const resource = useDirectory(query, exclude, writable);
  return (
    <div className="console-form-fields">
      <ConsoleInput
        type="search"
        label={t("consoleSettings.search")}
        name="account_search"
        value={query}
        onValueChange={(value) => {
          setQuery(value);
          onChange("");
        }}
        placeholder={t("routesConsoleDrive.searchNameOrEmail")}
      />
      <ConsoleSelectField
        label={t("routesConsoleDrive.destinationAccount")}
        value={value}
        onChange={onChange}
        options={resource.options}
        disabled={resource.loading}
      />
      <Notice error={resource.error} />
    </div>
  );
}
function AdminConfirm({
  open,
  title,
  description,
  children,
  label,
  destructive,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  label: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open, title]);
  return (
    <Confirm
      className="console-confirm"
      theme="neutral"
      open={open}
      title={title}
      label={label}
      destructive={destructive}
      onClose={onClose}
      description={description}
      onConfirm={async () => {
        if (!reason.trim())
          throw new Error(t("routesConsoleDrive.enterAReasonForThisAdministrativeAction"));
        await onConfirm(reason.trim());
      }}
    >
      <div className="console-confirm-fields">
        {children}
        <ConsoleInput
          label={t("routesConsoleDrive.reason")}
          name="admin_reason"
          required
          maxLength={1000}
          value={reason}
          onValueChange={setReason}
          placeholder={t("routesConsoleDrive.describeWhyThisChangeIsNeeded")}
        />
      </div>
    </Confirm>
  );
}
function usePaged<T>(path: string, filters: Record<string, string>) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]),
    [revision, setRevision] = useState(0);
  const signature = JSON.stringify(filters);
  const [previous, setPrevious] = useState(signature);
  if (previous !== signature) {
    setPrevious(signature);
    setCursors([null]);
  }
  const query = new URLSearchParams({
    ...filters,
    revision: String(revision),
    ...(cursors.at(-1) ? { cursor: cursors.at(-1)! } : {}),
  });
  const resource = useResource<AdminPage<T>>(`${endpoint}/${path}?${query}`);
  return {
    ...resource,
    page: cursors.length,
    previous: () => setCursors((current) => current.slice(0, -1)),
    next: () => {
      if (resource.data?.next_cursor)
        setCursors((current) => [...current, resource.data!.next_cursor]);
    },
    reload: () => setRevision((value) => value + 1),
  };
}

export function DriveConsoleLayout() {
  const { permissions } = useAccess(),
    navigate = useNavigate(),
    location = useLocation();
  const pages = driveConsolePages.filter((page) => permissions.includes(page.permission));
  const requested = location.pathname.split("/")[3];
  const selected = pages.find((page) => page.page === requested)?.page ?? pages[0]?.page ?? "";
  return (
    <ConsoleSettingsLayout
      title={t("routesConsoleDrive.drive")}
      description={t(
        "routesConsoleDrive.manageStorageSharingAndWorkspacePoliciesFileContentsRemain",
      )}
      pages={pages.map((page) => ({ path: page.page, name: page.label }))}
      selected={selected}
      onNavigate={(page) => navigate(`/console/drive/${page}`)}
      navigationLabel={t("routesConsoleDrive.driveNavigation")}
    >
      <Outlet />
    </ConsoleSettingsLayout>
  );
}
export function DriveConsolePage({ page }: { page: string }) {
  const permissions = useAccess().permissions;
  if (page === "home")
    return (
      <Navigate
        replace
        to={`/console/drive/${driveConsolePages.find((page) => permissions.includes(page.permission))?.page ?? "overview"}`}
      />
    );
  const config = driveConsolePages.find((entry) => entry.page === page);
  if (!config || !permissions.includes(config.permission)) return <AccessDenied />;
  return page === "overview" ? (
    <Overview />
  ) : page === "accounts" ? (
    <Accounts />
  ) : page === "items" ? (
    <Inventory />
  ) : page === "sharing" ? (
    <Sharing />
  ) : page === "settings" ? (
    <Policies />
  ) : (
    <AuditLog />
  );
}
function Overview() {
  const resource = useResource<{ summary: Record<string, number> }>(`${endpoint}/overview`);
  const summary = resource.data?.summary;
  return (
    <>
      <ConsoleSettingsHeader
        title={t("consoleSettings.overview")}
        description={t("routesConsoleDrive.storageTotalsIncludeEveryStoredFileVersionAndItems")}
      />
      <ConsoleState loading={resource.loading} error={resource.error} />
      {summary && (
        <ConsoleMetrics
          items={[
            [t("routesConsoleDrive.storageUsed"), formatBytes(summary.used_bytes ?? 0)],
            [t("routesConsoleDrive.reservedStorage"), formatBytes(summary.reserved_bytes ?? 0)],
            [t("routesConsoleDrive.allocatedLimits"), formatBytes(summary.quota_bytes ?? 0)],
            [t("routesConsoleDrive.driveAccounts"), summary.accounts],
            [
              t("routesConsoleDrive.filesFolders"),
              `${summary.files ?? 0} / ${summary.folders ?? 0}`,
            ],
            [t("routesConsoleDrive.overQuota"), summary.over_quota ?? 0],
            [t("routesConsoleDrive.itemsInTrash"), summary.trashed ?? 0],
            [t("routesConsoleDrive.activeUploads"), summary.uploads],
            [t("routesConsoleDrive.pendingCleanup"), summary.pending_cleanup],
            [t("routesConsoleDrive.ownershipTransfers"), summary.transfers ?? 0],
          ].map(([label, value]) => ({ label: String(label), value }))}
        />
      )}
    </>
  );
}
function Accounts() {
  const [query, setQuery] = useState(""),
    [state, setState] = useState("all"),
    resource = usePaged<DriveAccount>("accounts", { q: query, state });
  return (
    <>
      <ConsoleSettingsHeader
        title={t("routesConsoleDrive.accountsStorage")}
        description={t("routesConsoleDrive.inspectAllUsersIncludingAccountsWithoutADriveRole")}
      />
      <ConsoleFilters>
        <ConsoleInput
          label={t("consoleSettings.search")}
          name="drive_accounts_search"
          type="search"
          value={query}
          onValueChange={setQuery}
          placeholder={t("routesConsoleDrive.nameOrEmail")}
        />
        <ConsoleSelectField
          label={t("common.status")}
          value={state}
          onChange={setState}
          options={[
            { value: "all", label: t("routesConsoleDrive.allAccounts") },
            { value: "enabled", label: t("routesConsoleDrive.driveEnabled") },
            { value: "disabled", label: t("routesConsoleDrive.disabledOrSuspended") },
            { value: "deleted", label: t("routesConsoleDrive.deletedAccounts") },
            { value: "over_quota", label: t("routesConsoleDrive.overQuota") },
          ]}
        />
      </ConsoleFilters>
      <ConsoleTable
        resource={resource}
        headings={[
          t("routesConsoleDrive.user"),
          t("routesConsoleDrive.availability"),
          t("routesConsoleDrive.storageUsed"),
          t("routesConsoleDrive.reserved"),
          t("routesConsoleDrive.limit"),
          t("common.actions"),
        ]}
        empty={t("routesConsoleDrive.noMatchingAccounts")}
      >
        {resource.data?.items.map((account) => (
          <tr key={account.user_id}>
            <td>
              <strong>{account.display_name || account.email_address}</strong>
              <small className="console-subtext">{account.email_address}</small>
            </td>
            <td>{accountAvailability(account)}</td>
            <td>{formatBytes(account.used_bytes)}</td>
            <td>{formatBytes(account.reserved_bytes)}</td>
            <td>
              {formatBytes(account.quota_bytes)}
              <small className="console-subtext">
                {account.quota_override_bytes === null
                  ? t("routesConsoleDrive.workspaceDefault")
                  : t("routesConsoleDrive.individualLimit")}
                {account.used_bytes + account.reserved_bytes > account.quota_bytes &&
                  t("routesConsoleDrive.overQuota2")}
              </small>
            </td>
            <td>
              <Button
                nativeButton={false}
                render={<Link to={`/console/drive/accounts/${account.user_id}`} />}
                size="sm"
                aria-label={t("routesConsoleDrive.manageDriveFor", {
                  email_address: account.email_address,
                })}
              >
                {t("consoleSettings.manage")}
              </Button>
            </td>
          </tr>
        ))}
      </ConsoleTable>
    </>
  );
}
export function DriveAccountEditorPage() {
  const { id } = useParams(),
    [revision, setRevision] = useState(0),
    resource = useResource<{ account: DriveAccount }>(
      `${endpoint}/accounts/${encodeURIComponent(id ?? "")}?revision=${revision}`,
    ),
    account = resource.data?.account;
  return (
    <ConsoleDetail
      backTo="/console/drive/accounts"
      backLabel={t("routesConsoleDrive.accountsStorage")}
    >
      <ConsoleState loading={resource.loading} error={resource.error} kind="form" />
      {account && (
        <AccountDetails
          key={`${account.user_id}:${account.version}`}
          account={account}
          reload={() => setRevision((value) => value + 1)}
        />
      )}
    </ConsoleDetail>
  );
}
function AccountDetails({ account, reload }: { account: DriveAccount; reload: () => void }) {
  const permissions = useAccess().permissions,
    manage = allowed(permissions, "accounts.manage"),
    notify = useNotifications();
  const [inherit, setInherit] = useState(account.quota_override_bytes === null),
    [quota, setQuota] = useState(String(account.quota_bytes / GIB)),
    [status, setStatus] = useState(account.status),
    [confirm, setConfirm] = useState(false),
    [transfer, setTransfer] = useState(false),
    [cancelUploads, setCancelUploads] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <ConsoleSettingsHeader
        title={account.display_name || account.email_address}
        description={account.email_address}
      />
      <ConsoleSection>
        <dl className="console-facts">
          <div>
            <dt>{t("routesConsoleDrive.availability")}</dt>
            <dd>{accountAvailability(account)}</dd>
          </div>
          <div>
            <dt>{t("routesConsoleDrive.storageUsed")}</dt>
            <dd>{formatBytes(account.used_bytes)}</dd>
          </div>
          <div>
            <dt>{t("routesConsoleDrive.reservedStorage")}</dt>
            <dd>{formatBytes(account.reserved_bytes)}</dd>
          </div>
          <div>
            <dt>{t("routesConsoleDrive.filesFolders")}</dt>
            <dd>
              {account.files ?? 0}
              {t("routesConsoleDrive.text")}
              {account.folders ?? 0}
            </dd>
          </div>
          <div>
            <dt>{t("routesConsoleDrive.itemsInTrash")}</dt>
            <dd>{account.trashed ?? 0}</dd>
          </div>
        </dl>
        {allowed(permissions, "items.read") && (
          <p>
            <Link to={`/console/drive/items?owner=${account.user_id}&state=all`}>
              {t("routesConsoleDrive.browseOwnedFileMetadata")}
            </Link>
          </p>
        )}
        {allowed(permissions, "audit.read") && (
          <p>
            <Link to={`/console/drive/activity?owner=${account.user_id}`}>
              {t("routesConsoleDrive.viewFileActivity")}
            </Link>
          </p>
        )}
      </ConsoleSection>
      <ConsoleForm
        onSubmit={(event) => {
          event.preventDefault();
          try {
            if (!inherit) storageBytes(quota);
            setConfirm(true);
          } catch (failure) {
            setError(errorMessage(failure));
          }
        }}
      >
        <ConsoleSection
          title={t("routesConsoleDrive.storageAvailability")}
          description={t(
            "routesConsoleDrive.loweringALimitPreservesFilesAndBlocksAdditionalUploads",
          )}
        >
          <div className="console-form-fields">
            <Check checked={inherit} onChange={setInherit} disabled={!manage}>
              {t("routesConsoleDrive.useTheWorkspaceDefaultStorageLimit")}
            </Check>
            <ConsoleInput
              label={t("routesConsoleDrive.individualStorageLimitGib")}
              name="quota"
              type="number"
              min={0}
              step="any"
              value={quota}
              onValueChange={setQuota}
              disabled={inherit}
              readOnly={!manage}
            />
            <ConsoleSelectField
              label={t("routesConsoleDrive.driveAvailability")}
              value={status}
              onChange={(value) => setStatus(value as DriveAccount["status"])}
              disabled={!manage}
              options={[
                { value: "active", label: t("common.active") },
                { value: "read_only", label: t("routesConsoleDrive.readOnly") },
                { value: "suspended", label: t("routesConsoleDrive.suspended") },
              ]}
            />
          </div>
          <Notice error={error} />
          {manage && (
            <ConsoleFormActions>
              <Button variant="primary" type="submit">
                {t("consoleSettings.reviewChanges")}
              </Button>
            </ConsoleFormActions>
          )}
        </ConsoleSection>
      </ConsoleForm>
      <ConsoleSection
        title={t("routesConsoleDrive.roleAccess")}
        description={t(
          "routesConsoleDrive.theseDriveCapabilitiesComeFromAssignedWorkspaceRolesItem",
        )}
      >
        <PermissionPicker selected={account.permissions ?? []} keys={driveUserPermissions} />
        {permissions.includes("admin.users.read") && !account.deleted_at && (
          <p>
            <Link to={`/console/users/${account.user_id}#user-roles`}>
              {t("routesConsoleDrive.manageAssignedWorkspaceRoles")}
            </Link>
          </p>
        )}
      </ConsoleSection>
      {(account.active_uploads ?? 0) > 0 && (
        <ConsoleSection
          title={t("routesConsoleDrive.unfinishedUploads")}
          description={
            <>
              <LocalizedMessage
                id="routesConsoleDrive.unfinishedUploadsAreReservingStorageTheyMustFinishOr"
                values={{ active_uploads: account.active_uploads }}
              />
            </>
          }
        >
          {manage && (
            <Button onClick={() => setCancelUploads(true)}>
              {t("routesConsoleDrive.cancelUnfinishedUploads")}
            </Button>
          )}
        </ConsoleSection>
      )}
      {allowed(permissions, "ownership.transfer") && (
        <ConsoleSection
          title={t("routesConsoleDrive.ownershipHandover")}
          description={t("routesConsoleDrive.transferThisUserSFilesAndFoldersIncludingTrash")}
        >
          <Button onClick={() => setTransfer(true)} disabled={!account.total_items}>
            {t("routesConsoleDrive.transferAllOwnedItems")}
          </Button>
        </ConsoleSection>
      )}
      <AdminConfirm
        open={confirm}
        title={t("routesConsoleDrive.updateDriveAccount")}
        description={t("routesConsoleDrive.updateAvailability", {
          email_address: account.email_address,
          value2: inherit
            ? t("routesConsoleDrive.workspaceDefaultStorage")
            : t("routesConsoleDrive.gibIndividualStorage", { quota: quota }),
          enumLabel: enumLabel(status),
        })}
        label={t("common.saveChanges")}
        onClose={() => setConfirm(false)}
        onConfirm={async (reason) => {
          await api(`${endpoint}/accounts/${account.user_id}`, {
            method: "PATCH",
            body: {
              version: account.version,
              quota_override_bytes: inherit ? null : storageBytes(quota),
              status,
              reason,
            },
          });
          notify.success(t("routesConsoleDrive.driveAccountUpdated"));
          reload();
        }}
      />
      <AdminConfirm
        open={cancelUploads}
        title={t("routesConsoleDrive.cancelUnfinishedUploads2")}
        description={t(
          "routesConsoleDrive.cancelAllUnfinishedUploadsReservingStorageForStoredFile",
          { value1: account.active_uploads ?? 0, email_address: account.email_address },
        )}
        label={t("routesConsoleDrive.cancelUploads")}
        onClose={() => setCancelUploads(false)}
        onConfirm={async (reason) => {
          await api(`${endpoint}/accounts/${account.user_id}/cancel-uploads`, {
            method: "POST",
            body: { version: account.version, reason },
          });
          notify.success(t("routesConsoleDrive.unfinishedUploadsCancelled"));
          reload();
        }}
      />
      <TransferDialog
        open={transfer}
        onClose={() => setTransfer(false)}
        source={account.user_id}
        version={account.version}
        name={account.email_address}
        onSaved={reload}
      />
      <Transfers accountId={account.user_id} />
    </>
  );
}
function TransferDialog({
  open,
  onClose,
  source,
  version,
  item,
  name,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  source: string;
  version: number;
  item?: string;
  name: string;
  onSaved: () => void;
}) {
  const [target, setTarget] = useState(""),
    notify = useNotifications();
  useEffect(() => {
    if (open) setTarget("");
  }, [open]);
  return (
    <AdminConfirm
      open={open}
      title={t("routesConsoleDrive.transferDriveOwnership")}
      description={t("routesConsoleDrive.handOverIncludingItsStoredVersionsToTheDestination", {
        name: name,
      })}
      label={t("routesConsoleDrive.startTransfer")}
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!target) throw new Error(t("routesConsoleDrive.chooseADestinationAccount"));
        await api(`${endpoint}/transfers`, {
          method: "POST",
          body: {
            source_user_id: source,
            target_user_id: target,
            version,
            ...(item ? { item_id: item } : {}),
            reason,
          },
        });
        notify.success(t("routesConsoleDrive.ownershipTransferStarted"));
        onSaved();
      }}
    >
      <AccountPicker value={target} onChange={setTarget} exclude={source} writable />
    </AdminConfirm>
  );
}
function Transfers({ accountId = "" }: { accountId?: string }) {
  const permissions = useAccess().permissions,
    notify = useNotifications(),
    resource = usePaged<DriveTransfer>("transfers", { account: accountId }),
    [selected, setSelected] = useState<{ job: DriveTransfer; action: "retry" | "cancel" } | null>(
      null,
    );
  const reload = resource.reload,
    active = resource.data?.items.some((job) => ["queued", "running"].includes(job.status));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(reload, 5000);
    return () => window.clearInterval(timer);
  }, [active]);
  return (
    <ConsoleSection
      title={t("routesConsoleDrive.transferJobs")}
      description={t(
        "routesConsoleDrive.transferProgressIsRetainedAcrossSessionsFailedTransfersKeep",
      )}
    >
      <ConsoleState loading={resource.loading} error={resource.error} />
      {resource.data?.items.map((job) => (
        <article className="console-drive-job" key={job.id}>
          <div>
            <strong>
              {job.source_email}
              {t("routesConsoleDrive.text2")}
              {job.target_email}
            </strong>
            <p>
              <LocalizedMessage
                id="routesConsoleDrive.itemsReserved"
                values={{
                  status: enumLabel(job.status),
                  processed_items: job.processed_items,
                  total_items: job.total_items,
                  formatBytes: formatBytes(job.reserved_bytes),
                }}
              />
            </p>
            <small className="console-subtext">{job.reason}</small>
            {job.error && <Notice error={job.error} />}
          </div>
          {allowed(permissions, "ownership.transfer") &&
            !["completed", "cancelled"].includes(job.status) && (
              <div className="account-actions">
                <Button size="sm" onClick={() => setSelected({ job, action: "retry" })}>
                  {job.status === "failed"
                    ? t("routesConsoleDrive.retryTransfer")
                    : t("routesConsoleDrive.continueTransfer")}
                </Button>
                {job.processed_items === 0 && (
                  <Button size="sm" onClick={() => setSelected({ job, action: "cancel" })}>
                    {t("routesConsoleDrive.cancelTransfer")}
                  </Button>
                )}
              </div>
            )}
        </article>
      ))}
      {resource.data && !resource.data.items.length && (
        <p className="console-subtext">{t("routesConsoleDrive.noOwnershipTransfers")}</p>
      )}
      {resource.data && resource.data.items.length > 0 && (
        <ConsolePagination
          page={resource.page}
          count={resource.data.items.length}
          hasNext={!!resource.data.next_cursor}
          loading={resource.loading}
          previous={resource.previous}
          next={resource.next}
        />
      )}
      <AdminConfirm
        open={!!selected}
        title={
          selected?.action === "cancel"
            ? t("routesConsoleDrive.cancelTransfer2")
            : t("routesConsoleDrive.resumeTransfer")
        }
        description={
          selected
            ? `${selected.job.source_email} → ${selected.job.target_email}${selected.action === "cancel" ? t("routesConsoleDrive.publicLinksRemainRevoked") : ""}`
            : ""
        }
        label={
          selected?.action === "cancel"
            ? t("routesConsoleDrive.cancelTransfer")
            : t("routesConsoleDrive.resumeTransfer2")
        }
        onClose={() => setSelected(null)}
        onConfirm={async (reason) => {
          if (!selected) return;
          await api(`${endpoint}/transfers/${selected.job.id}/${selected.action}`, {
            method: "POST",
            body: { version: selected.job.version, reason },
          });
          notify.success(
            selected.action === "cancel"
              ? t("routesConsoleDrive.transferCancelled")
              : t("routesConsoleDrive.transferResumed"),
          );
          reload();
        }}
      />
    </ConsoleSection>
  );
}

function Inventory() {
  const [params] = useSearchParams(),
    [query, setQuery] = useState(""),
    [state, setState] = useState(params.get("state") ?? "active"),
    owner = params.get("owner") ?? "",
    permissions = useAccess().permissions,
    resource = usePaged<AdminDriveItem>("items", { q: query, state, owner }),
    notify = useNotifications();
  const [action, setAction] = useState<{ item: AdminDriveItem; kind: "restore" | "purge" } | null>(
      null,
    ),
    [transfer, setTransfer] = useState<AdminDriveItem | null>(null),
    [grant, setGrant] = useState<DriveSharing | null>(null);
  return (
    <>
      <ConsoleSettingsHeader
        title={t("routesConsoleDrive.filesTrash")}
        description={t("routesConsoleDrive.inspectFileMetadataWithoutOpeningFileContentsRestoreA")}
      />
      <ConsoleFilters>
        <ConsoleInput
          label={t("consoleSettings.search")}
          name="inventory_search"
          type="search"
          value={query}
          onValueChange={setQuery}
        />
        <ConsoleSelectField
          label={t("common.status")}
          value={state}
          onChange={setState}
          options={[
            { value: "active", label: t("routesConsoleDrive.activeItems") },
            { value: "trash", label: t("routesConsoleDrive.trash") },
            { value: "all", label: t("routesConsoleDrive.allRetainedItems") },
          ]}
        />
        {owner && (
          <Button nativeButton={false} render={<Link to="/console/drive/items" />} variant="ghost">
            {t("routesConsoleDrive.clearOwnerFilter")}
          </Button>
        )}
      </ConsoleFilters>
      <ConsoleTable
        resource={resource}
        headings={[
          t("routesConsoleDrive.item"),
          t("consoleSettings.owner"),
          t("routesConsoleDrive.currentVersions"),
          t("routesConsoleDrive.modified"),
          t("common.actions"),
        ]}
        empty={t("routesConsoleDrive.noMatchingFilesOrFolders")}
      >
        {resource.data?.items.map((item) => (
          <tr key={item.id}>
            <td>
              <strong>{item.name}</strong>
              <small className="console-subtext">
                {enumLabel(item.kind)}
                {item.trashed_at
                  ? t("routesConsoleDrive.inTrash")
                  : item.in_trash
                    ? t("routesConsoleDrive.insideTrashedFolder")
                    : ""}
              </small>
            </td>
            <td>{item.owner_email}</td>
            <td>
              {item.size === null ? "—" : formatBytes(item.size)}
              {t("routesConsoleDrive.text3")} {formatBytes(item.version_bytes)}
            </td>
            <td>{adminDate(item.updated_at)}</td>
            <td>
              <div className="console-row-actions">
                {item.trashed_at ? (
                  <>
                    {allowed(permissions, "trash.restore") && (
                      <Button size="sm" onClick={() => setAction({ item, kind: "restore" })}>
                        {t("routesConsoleDrive.restore")}
                      </Button>
                    )}
                    {allowed(permissions, "trash.purge") && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setAction({ item, kind: "purge" })}
                      >
                        {t("routesConsoleDrive.deleteForever")}
                      </Button>
                    )}
                  </>
                ) : (
                  !item.in_trash &&
                  allowed(permissions, "sharing.manage") &&
                  allowed(permissions, "accounts.read") && (
                    <Button
                      size="sm"
                      onClick={() =>
                        setGrant({
                          item_id: item.id,
                          name: item.name,
                          kind: item.kind,
                          version: item.version,
                          owner_email: item.owner_email,
                          expires_at: null,
                          created_at: 0,
                        })
                      }
                    >
                      {t("routesConsoleDrive.share")}
                    </Button>
                  )
                )}
                {allowed(permissions, "ownership.transfer") && (
                  <Button size="sm" onClick={() => setTransfer(item)}>
                    {t("routesConsoleDrive.transfer")}
                  </Button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </ConsoleTable>
      <AdminConfirm
        open={!!action}
        title={
          action?.kind === "purge"
            ? t("routesConsoleDrive.permanentlyDeleteThisItem")
            : t("routesConsoleDrive.restoreThisItem")
        }
        description={
          action
            ? `${action.item.name}${action.kind === "purge" ? t("routesConsoleDrive.andAllRetainedVersionsWillBePermanentlyRemoved") : t("routesConsoleDrive.willReturnToItsOriginalFolder")}`
            : ""
        }
        label={
          action?.kind === "purge"
            ? t("routesConsoleDrive.deleteForever")
            : t("routesConsoleDrive.restore")
        }
        destructive={action?.kind === "purge"}
        onClose={() => setAction(null)}
        onConfirm={async (reason) => {
          if (!action) return;
          await api(`${endpoint}/items/${action.item.id}/${action.kind}`, {
            method: "POST",
            body: { version: action.item.version, reason },
          });
          notify.success(
            action.kind === "purge"
              ? t("routesConsoleDrive.itemPermanentlyDeleted")
              : t("routesConsoleDrive.itemRestored"),
          );
          resource.reload();
        }}
      />
      {transfer && (
        <TransferDialog
          open
          onClose={() => setTransfer(null)}
          source={transfer.owner_user_id}
          item={transfer.id}
          version={transfer.version}
          name={transfer.name}
          onSaved={resource.reload}
        />
      )}
      {grant && (
        <GrantDialog item={grant} onClose={() => setGrant(null)} onSaved={resource.reload} />
      )}
    </>
  );
}
function GrantDialog({
  item,
  onClose,
  onSaved,
}: {
  item: DriveSharing;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [user, setUser] = useState(item.user_id ?? ""),
    [role, setRole] = useState(item.role ?? "viewer"),
    [expires, setExpires] = useState(localDate(item.expires_at)),
    notify = useNotifications();
  return (
    <AdminConfirm
      open
      title={t("routesConsoleDrive.updateInternalDriveSharing")}
      description={item.name}
      label={t("routesConsoleDrive.saveSharing")}
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!user) throw new Error(t("routesConsoleDrive.chooseARecipientAccount"));
        await api(`${endpoint}/items/${item.item_id}/permissions`, {
          method: "POST",
          body: {
            version: item.version,
            user_id: user,
            role,
            expires_at: expiration(expires),
            reason,
          },
        });
        notify.success(t("routesConsoleDrive.sharingUpdated"));
        onSaved();
      }}
    >
      {item.user_id ? (
        <p>{item.email_address}</p>
      ) : (
        <AccountPicker value={user} onChange={setUser} exclude="" />
      )}
      <ConsoleSelectField
        label={t("routesConsoleDrive.sharingRole")}
        value={role}
        onChange={setRole}
        options={[
          { value: "viewer", label: t("routesConsoleDrive.viewer") },
          { value: "commenter", label: t("routesConsoleDrive.commenter") },
          { value: "editor", label: t("routesConsoleDrive.editor") },
        ]}
      />
      <ConsoleInput
        label={t("routesConsoleDrive.sharingExpiresAtOptional")}
        name="grant_expiry"
        type="datetime-local"
        value={expires}
        onValueChange={setExpires}
      />
    </AdminConfirm>
  );
}
function Sharing() {
  const permissions = useAccess().permissions,
    notify = useNotifications(),
    [params] = useSearchParams(),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("links"),
    [state, setState] = useState("active"),
    resource = usePaged<DriveSharing>("sharing", {
      q: query,
      kind,
      state,
      owner: params.get("owner") ?? "",
    });
  const [selected, setSelected] = useState<DriveSharing | null>(null),
    [edit, setEdit] = useState<DriveSharing | null>(null);
  return (
    <>
      <ConsoleSettingsHeader
        title={t("routesConsoleDrive.sharing")}
        description={t("routesConsoleDrive.inspectDirectFolderGrantsAndPublicLinkMetadataFolder")}
      />
      <ConsoleFilters>
        <ConsoleInput
          type="search"
          label={t("consoleSettings.search")}
          name="sharing_search"
          value={query}
          onValueChange={setQuery}
          placeholder={t("routesConsoleDrive.itemNameOrOwnerSEmail")}
        />
        <ConsoleSelectField
          label={t("routesConsoleDrive.sharingType")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "links", label: t("routesConsoleDrive.publicLinks") },
            { value: "grants", label: t("routesConsoleDrive.internalGrants") },
          ]}
        />
        <ConsoleSelectField
          label={t("common.status")}
          value={state}
          onChange={setState}
          options={[
            { value: "active", label: t("routesConsoleDrive.unrevokedUnexpired") },
            { value: "all", label: t("routesConsoleDrive.allRecords") },
          ]}
        />
      </ConsoleFilters>
      <ConsoleTable
        resource={resource}
        headings={[
          t("routesConsoleDrive.item"),
          t("consoleSettings.owner"),
          kind === "links" ? t("routesConsoleDrive.linkAccess") : t("routesConsoleDrive.recipient"),
          t("routesConsoleDrive.expiry"),
          t("common.actions"),
        ]}
        empty={t("routesConsoleDrive.noMatchingSharingRecords")}
      >
        {resource.data?.items.map((entry) => (
          <tr key={entry.id ?? `${entry.item_id}:${entry.user_id}`}>
            <td>
              <strong>{entry.name}</strong>
              <small className="console-subtext">
                {enumLabel(entry.kind)}
                {kind === "grants" && entry.kind === "folder"
                  ? t("routesConsoleDrive.inheritedByDescendants")
                  : ""}
              </small>
            </td>
            <td>{entry.owner_email}</td>
            <td>
              {kind === "links" ? (
                <>
                  {entry.revoked_at
                    ? t("common.revoked")
                    : entry.expires_at && entry.expires_at <= Math.floor(Date.now() / 1000)
                      ? t("common.expired")
                      : !entry.policy_allowed
                        ? t("routesConsoleDrive.blockedByPolicyOrOwnerAvailability")
                        : t("routesConsoleDrive.allowed")}
                  <small className="console-subtext">
                    {entry.password_protected
                      ? t("routesConsoleDrive.passwordProtected")
                      : t("routesConsoleDrive.noPassword")}
                    {t("routesConsoleDrive.text4")}{" "}
                    {entry.allow_download
                      ? t("routesConsoleDrive.downloadsEnabled")
                      : t("routesConsoleDrive.downloadsDisabled")}
                  </small>
                </>
              ) : (
                <>
                  {entry.email_address}
                  <small className="console-subtext">{enumLabel(entry.role)}</small>
                </>
              )}
            </td>
            <td>
              {entry.expires_at ? adminDate(entry.expires_at) : t("routesConsoleDrive.noExpiry")}
            </td>
            <td>
              {allowed(permissions, "sharing.manage") && (
                <div className="console-row-actions">
                  {kind === "grants" && (
                    <Button size="sm" onClick={() => setEdit(entry)}>
                      {t("routesConsoleDrive.editRole")}
                    </Button>
                  )}
                  {!(kind === "links" && entry.revoked_at) && (
                    <Button size="sm" onClick={() => setSelected(entry)}>
                      {t("routesConsoleDrive.revoke")}
                    </Button>
                  )}
                </div>
              )}
            </td>
          </tr>
        ))}
      </ConsoleTable>
      <AdminConfirm
        open={!!selected}
        title={
          kind === "links"
            ? t("routesConsoleDrive.revokePublicLink")
            : t("routesConsoleDrive.revokeInternalGrant")
        }
        description={selected?.name ?? ""}
        label={t("routesConsoleDrive.revokeAccess")}
        onClose={() => setSelected(null)}
        onConfirm={async (reason) => {
          if (!selected) return;
          const path =
            kind === "links"
              ? `/items/${selected.item_id}/links/${selected.id}/revoke`
              : `/items/${selected.item_id}/permissions/${selected.user_id}`;
          await api(endpoint + path, {
            method: kind === "links" ? "POST" : "DELETE",
            body: { version: selected.version, reason },
          });
          notify.success(t("routesConsoleDrive.sharingAccessRevoked"));
          resource.reload();
        }}
      />
      {edit && <GrantDialog item={edit} onClose={() => setEdit(null)} onSaved={resource.reload} />}
    </>
  );
}

function Policies() {
  const [revision, setRevision] = useState(0),
    resource = useResource<{ settings: DriveSettings }>(
      `${endpoint}/settings?revision=${revision}`,
    );
  return (
    <>
      <ConsoleSettingsHeader
        title={t("consoleSettings.policies")}
        description={t(
          "routesConsoleDrive.settingsAreStoredInTheDatabaseIndividualStorageOverrides",
        )}
      />
      <ConsoleState loading={resource.loading} error={resource.error} kind="form" />
      {resource.data && (
        <PolicyForm
          key={resource.data.settings.version}
          settings={resource.data.settings}
          reload={() => setRevision((value) => value + 1)}
        />
      )}
    </>
  );
}
type PolicyReview = Pick<
  DriveSettings,
  "default_quota_bytes" | "max_file_bytes" | "trash_retention_days" | "public_link_max_days"
> & {
  internal_sharing_enabled: boolean;
  public_sharing_enabled: boolean;
  public_link_password_required: boolean;
};

function PolicyForm({ settings, reload }: { settings: DriveSettings; reload: () => void }) {
  const manage = allowed(useAccess().permissions, "settings.manage"),
    notify = useNotifications(),
    [quota, setQuota] = useState(String(settings.default_quota_bytes / GIB)),
    [maxFile, setMaxFile] = useState(String(settings.max_file_bytes / GIB)),
    [retention, setRetention] = useState(String(settings.trash_retention_days)),
    [maxDays, setMaxDays] = useState(String(settings.public_link_max_days));
  const [internal, setInternal] = useState(!!settings.internal_sharing_enabled),
    [external, setExternal] = useState(!!settings.public_sharing_enabled),
    [password, setPassword] = useState(!!settings.public_link_password_required),
    [review, setReview] = useState<PolicyReview | null>(null),
    [error, setError] = useState("");
  return (
    <>
      <ConsoleForm
        onSubmit={(event) => {
          event.preventDefault();
          try {
            setReview({
              default_quota_bytes: storageBytes(quota),
              max_file_bytes: storageBytes(maxFile),
              trash_retention_days: Number(retention),
              public_link_max_days: Number(maxDays),
              internal_sharing_enabled: internal,
              public_sharing_enabled: external,
              public_link_password_required: password,
            });
            setError("");
          } catch (failure) {
            setError(errorMessage(failure));
          }
        }}
      >
        <ConsoleSection
          title={t("routesConsoleDrive.storageRetention")}
          description={t("routesConsoleDrive.filesRemainIntactWhenAStorageLimitIsReduced")}
        >
          <div className="console-form-fields">
            <ConsoleInput
              label={t("routesConsoleDrive.defaultStoragePerUserGib")}
              name="default_quota"
              type="number"
              min={0}
              step="any"
              required
              value={quota}
              onValueChange={setQuota}
              readOnly={!manage}
            />
            <ConsoleInput
              label={t("routesConsoleDrive.maximumFileSizeGib")}
              name="max_file"
              type="number"
              min={1 / GIB}
              max={5}
              step="any"
              required
              value={maxFile}
              onValueChange={setMaxFile}
              readOnly={!manage}
            />
            <ConsoleInput
              label={t("routesConsoleDrive.trashRetentionDays")}
              name="retention_days"
              type="number"
              min={1}
              max={3650}
              required
              value={retention}
              onValueChange={setRetention}
              readOnly={!manage}
            />
          </div>
        </ConsoleSection>
        <ConsoleSection
          title={t("routesConsoleDrive.sharingPolicies")}
          description={t(
            "routesConsoleDrive.disablingInternalSharingBlocksExistingRecipientGrantsDisablingPublic",
          )}
        >
          <div className="console-form-fields">
            <Check checked={internal} onChange={setInternal} disabled={!manage}>
              {t("routesConsoleDrive.allowInternalSharing")}
            </Check>
            <Check checked={external} onChange={setExternal} disabled={!manage}>
              {t("routesConsoleDrive.allowPublicShareLinks")}
            </Check>
            <Check checked={password} onChange={setPassword} disabled={!manage}>
              {t("routesConsoleDrive.requireAPasswordOnPublicShareLinks")}
            </Check>
            <ConsoleInput
              label={t("routesConsoleDrive.maximumPublicLinkLifetimeDays")}
              name="public_link_days"
              type="number"
              min={0}
              max={3650}
              required
              value={maxDays}
              onValueChange={setMaxDays}
              readOnly={!manage}
              hint={t("routesConsoleDrive.0AllowsNoExpiryAPositiveValueLimitsExpiry")}
            />
          </div>
        </ConsoleSection>
        <Notice error={error} />
        <ConsoleFormActions
          meta={t("consoleSettings.lastUpdated", { date: adminDate(settings.updated_at) })}
        >
          {manage && (
            <Button variant="primary" type="submit">
              {t("consoleSettings.reviewChanges")}
            </Button>
          )}
        </ConsoleFormActions>
      </ConsoleForm>
      <AdminConfirm
        open={!!review}
        title={t("routesConsoleDrive.applyDrivePolicies")}
        description={
          <>
            <span>{t("routesConsoleDrive.thesePoliciesApplyToExistingLinksAndAccountsThat")}</span>
            {review && (
              <dl className="console-facts console-drive-policy-review">
                <div>
                  <dt>{t("routesConsoleDrive.defaultUserStorage")}</dt>
                  <dd>
                    <LocalizedMessage
                      id="routesConsoleDrive.gib"
                      values={{ value1: Number(review.default_quota_bytes) / GIB }}
                    />
                  </dd>
                </div>
                <div>
                  <dt>{t("routesConsoleDrive.maximumFileSize")}</dt>
                  <dd>
                    <LocalizedMessage
                      id="routesConsoleDrive.gib"
                      values={{ value1: Number(review.max_file_bytes) / GIB }}
                    />
                  </dd>
                </div>
                <div>
                  <dt>{t("routesConsoleDrive.internalSharing")}</dt>
                  <dd>
                    {review.internal_sharing_enabled
                      ? t("routesConsoleDrive.allowed")
                      : t("routesConsoleDrive.blocked")}
                  </dd>
                </div>
                <div>
                  <dt>{t("routesConsoleDrive.publicLinks")}</dt>
                  <dd>
                    {review.public_sharing_enabled
                      ? t("routesConsoleDrive.allowed")
                      : t("routesConsoleDrive.blocked")}
                  </dd>
                </div>
                <div>
                  <dt>{t("routesConsoleDrive.linkPassword")}</dt>
                  <dd>
                    {review.public_link_password_required
                      ? t("routesConsoleDrive.required")
                      : t("routesConsoleDrive.optional")}
                  </dd>
                </div>
                <div>
                  <dt>{t("routesConsoleDrive.linkLifetime")}</dt>
                  <dd>
                    {review.public_link_max_days
                      ? t("routesConsoleDrive.days", {
                          public_link_max_days: review.public_link_max_days,
                        })
                      : t("routesConsoleDrive.noLimit")}
                  </dd>
                </div>
                <div>
                  <dt>{t("routesConsoleDrive.trashRetention")}</dt>
                  <dd>
                    <LocalizedMessage
                      id="routesConsoleDrive.days2"
                      values={{ trash_retention_days: review.trash_retention_days }}
                    />
                  </dd>
                </div>
              </dl>
            )}
            {review && Number(review.trash_retention_days) < settings.trash_retention_days && (
              <p>{t("routesConsoleDrive.olderTrashBeyondTheNewRetentionPeriodWillBe")}</p>
            )}
          </>
        }
        label={t("routesConsoleDrive.applyPolicies")}
        onClose={() => setReview(null)}
        onConfirm={async (reason) => {
          await api(`${endpoint}/settings`, {
            method: "PATCH",
            body: { ...review, version: settings.version, reason },
          });
          notify.success(t("routesConsoleDrive.drivePoliciesUpdated"));
          reload();
        }}
      />
    </>
  );
}
function AuditLog() {
  const [detail, setDetail] = useState<DriveAudit | null>(null);
  const [params] = useSearchParams(),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [action, setAction] = useState("");
  const resource = usePaged<DriveAudit>("activity", {
    owner: params.get("owner") ?? "",
    q: query,
    kind,
    action,
    from: from ? String(Math.floor(new Date(`${from}T00:00:00`).getTime() / 1000)) : "",
    to: to ? String(Math.floor(new Date(`${to}T23:59:59`).getTime() / 1000)) : "",
  });
  return (
    <>
      <ConsoleSettingsHeader
        title={t("consoleSettings.audit")}
        description={t(
          "routesConsoleDrive.immutableFileActivityAndAdministratorActionsAdministrativeChangesInclude",
        )}
      />
      <ConsoleFilters>
        <ConsoleInput
          type="search"
          label={t("consoleSettings.search")}
          name="audit_search"
          value={query}
          onValueChange={setQuery}
          placeholder={t("routesConsoleDrive.fileNameOrActorEmail")}
        />
        <ConsoleSelectField
          label={t("routesConsoleDrive.activitySource")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: t("routesConsoleDrive.allActivity") },
            { value: "admin", label: t("routesConsoleDrive.administratorActions") },
            { value: "items", label: t("routesConsoleDrive.fileActivity") },
          ]}
        />
        <ConsoleSelectField
          label={t("consoleSettings.action")}
          value={action}
          onChange={setAction}
          options={[
            { value: "", label: t("routesConsoleDrive.allActions") },
            { value: "file_created", label: t("routesConsoleDrive.fileCreated") },
            { value: "content_updated", label: t("routesConsoleDrive.contentUpdated") },
            { value: "permission_granted", label: t("routesConsoleDrive.sharingGranted") },
            { value: "permission_revoked", label: t("routesConsoleDrive.sharingRevoked") },
            { value: "public_download", label: t("routesConsoleDrive.publicDownload") },
            { value: "settings_updated", label: t("routesConsoleDrive.policiesUpdated") },
            { value: "account_updated", label: t("routesConsoleDrive.accountUpdated") },
            {
              value: "transfer_completed",
              label: t("routesConsoleDrive.ownershipTransferCompleted"),
            },
          ]}
        />
        <ConsoleDateFilters after={from} before={to} onAfter={setFrom} onBefore={setTo} />
      </ConsoleFilters>
      <ConsoleTable
        resource={resource}
        headings={[
          t("consoleSettings.time"),
          t("consoleSettings.actor"),
          t("consoleSettings.action"),
          t("routesConsoleDrive.itemTarget"),
          t("routesConsoleDrive.details"),
        ]}
        empty={t("routesConsoleDrive.noMatchingActivity")}
      >
        {resource.data?.items.map((entry) => (
          <tr key={entry.page_id}>
            <td>{adminDate(entry.created_at)}</td>
            <td>
              {entry.actor_name || entry.actor_email || t("routesConsoleDrive.publicLinkSystem")}
              <small className="console-subtext">{entry.actor_name ? entry.actor_email : ""}</small>
            </td>
            <td>
              {enumLabel(entry.action)}
              <small className="console-subtext">
                {entry.source === "admin"
                  ? t("routesConsoleDrive.administrator")
                  : t("routesConsoleDrive.fileActivity")}
              </small>
            </td>
            <td>{entry.item_name || entry.target_type}</td>
            <td>
              <Button size="sm" onClick={() => setDetail(entry)}>
                {t("routesConsoleDrive.details")}
              </Button>
            </td>
          </tr>
        ))}
      </ConsoleTable>
      <ConsoleDialog
        open={!!detail}
        title={t("routesConsoleDrive.driveActivityDetails")}
        onClose={() => setDetail(null)}
        description={
          <>
            {detail && enumLabel(detail.action)}
            {t("routesConsoleDrive.text5")}
            {detail ? adminDate(detail.created_at) : ""}
          </>
        }
      >
        {detail && (
          <>
            <dl className="console-facts">
              <div>
                <dt>{t("consoleSettings.actor")}</dt>
                <dd>
                  {detail.actor_name ||
                    detail.actor_email ||
                    t("routesConsoleDrive.publicLinkSystem")}
                </dd>
              </div>
              <div>
                <dt>{t("routesConsoleDrive.itemTarget")}</dt>
                <dd>{detail.item_name || detail.target_type}</dd>
              </div>
            </dl>
            <pre
              className="console-drive-audit-json"
              tabIndex={0}
              role="region"
              aria-label={t("routesConsoleDrive.auditRecordValues")}
            >
              {JSON.stringify(detail.details, null, 2)}
            </pre>
          </>
        )}
        <div className="account-actions">
          <Button onClick={() => setDetail(null)}>{t("common.close")}</Button>
        </div>
      </ConsoleDialog>
    </>
  );
}
