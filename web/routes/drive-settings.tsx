import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "../components/i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useDrive } from "../components/drive-context";
import { DriveSelect, useDriveResource } from "../components/drive-controls";
import { DriveSettingsLayout, DriveSettingsSection } from "../components/drive-settings-nav";
import { Button, Field, Meter, useNotifications } from "../components/ui";
import {
  driveDate,
  formatBytes,
  type DriveActivity,
  type DriveCapabilities,
  type DriveQuota,
} from "../lib/drive";
import { LoadingSkeleton } from "../components/loading-skeleton";
import { readDriveLayout, saveDriveLayout } from "../lib/drive-settings";
import "./drive-settings.css";

export function DriveSettingsPage({ page }: { page: string }) {
  const drive = useDrive(),
    writable = drive.can("create"),
    { setTarget } = drive;
  useEffect(() => setTarget({ parent: null, writable }), [setTarget, writable]);
  if (page === "integrations") return <Integrations />;
  if (page === "data") return <ImportBackup />;
  if (page === "activity") return <ActivityStorage />;
  return <General />;
}

function SettingsState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  return error ? (
    <div>
      <p className="settings-notice" role="alert">
        {error}
      </p>
      <Button onClick={retry}>{t("routesDriveSettings.tryAgain")}</Button>
    </div>
  ) : loading ? (
    <LoadingSkeleton label={t("routesDriveSettings.loadingDriveSettings")} rows={3} />
  ) : null;
}

function General() {
  const drive = useDrive(),
    notify = useNotifications(),
    [layout, setLayout] = useState(readDriveLayout);
  const policy = useDriveResource<DriveCapabilities>("/api/drive/capabilities", drive.revision);
  return (
    <DriveSettingsLayout
      title={t("routesDriveSettings.driveSettings")}
      description={t("routesDriveSettings.manageYourFilePreferencesIntegrationsDataAndStorageIn")}
    >
      <DriveSettingsSection
        title={t("routesDriveSettings.fileDisplay")}
        description={t("routesDriveSettings.chooseHowFilesAppearWhenYouOpenDriveThis")}
      >
        <div className="settings-form-grid">
          <Field.Root className="settings-field">
            <Field.Label>{t("routesDriveSettings.defaultView")}</Field.Label>
            <DriveSelect
              label={t("routesDriveSettings.defaultFileView")}
              value={layout}
              options={[
                { value: "list", label: t("routesDriveSettings.list") },
                { value: "grid", label: t("routesDriveSettings.grid") },
              ]}
              onChange={(value) => {
                if (value !== "list" && value !== "grid") return;
                try {
                  saveDriveLayout(value);
                  setLayout(value);
                  notify.success(t("routesDriveSettings.fileViewSaved"));
                } catch {
                  notify.error(t("routesDriveSettings.yourBrowserCouldNotSaveThisPreference"));
                }
              }}
            />
          </Field.Root>
        </div>
      </DriveSettingsSection>
      <DriveSettingsSection
        title={t("routesDriveSettings.workspacePolicies")}
        description={t(
          "routesDriveSettings.yourWorkspaceAdministratorManagesTheseLimitsAndSharingOptions",
        )}
      >
        <SettingsState
          loading={policy.loading && !policy.data}
          error={policy.error}
          retry={policy.reload}
        />
        {policy.data && (
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>{t("routesDriveSettings.policy")}</th>
                  <th>{t("routesDriveSettings.value")}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  [t("routesDriveSettings.accountStatus"), enumLabel(policy.data.account_status)],
                  [
                    t("routesDriveSettings.fileUploads"),
                    policy.data.write_locked
                      ? t("routesDriveSettings.restricted")
                      : t("routesDriveSettings.subjectToYourRolePermissions"),
                  ],
                  [
                    t("routesDriveSettings.maximumFileSize"),
                    formatBytes(policy.data.max_file_bytes),
                  ],
                  [
                    t("routesDriveSettings.trashRetention"),
                    t("routesDriveSettings.days", {
                      trash_retention_days: policy.data.trash_retention_days,
                    }),
                  ],
                  [
                    t("routesDriveSettings.internalSharing"),
                    policy.data.internal_sharing_enabled
                      ? t("common.enabled")
                      : t("common.disabled"),
                  ],
                  [
                    t("routesDriveSettings.publicLinks"),
                    policy.data.public_sharing_enabled ? t("common.enabled") : t("common.disabled"),
                  ],
                  ...(policy.data.public_sharing_enabled
                    ? [
                        [
                          t("routesDriveSettings.linkPasswords"),
                          policy.data.public_link_password_required
                            ? t("routesDriveSettings.required")
                            : t("routesDriveSettings.optional"),
                        ],
                        [
                          t("routesDriveSettings.maximumLinkLifetime"),
                          policy.data.public_link_max_days
                            ? t("routesDriveSettings.days2", {
                                public_link_max_days: policy.data.public_link_max_days,
                              })
                            : t("routesDriveSettings.noWorkspaceLimit"),
                        ],
                      ]
                    : []),
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td data-label={t("routesDriveSettings.policy")}>{label}</td>
                    <td data-label={t("routesDriveSettings.value")}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DriveSettingsSection>
    </DriveSettingsLayout>
  );
}

function Integrations() {
  return (
    <DriveSettingsLayout
      title={t("routesDriveSettings.integrations")}
      description={t("routesDriveSettings.reviewWaysToConnectOtherApplicationsToYourDrive")}
    >
      <DriveSettingsSection
        title={t("routesDriveSettings.webdav")}
        description={t("routesDriveSettings.accessDriveThroughAFileManagerOrAnotherWebdav")}
      >
        <div className="settings-record">
          <div>
            <strong>{t("routesDriveSettings.webdavAccess")}</strong>
            <p>{t("routesDriveSettings.webdavConnectionsAreNotSupportedYetAServerAddress")}</p>
          </div>
          <span className="settings-badge">{t("routesDriveSettings.notAvailable")}</span>
        </div>
      </DriveSettingsSection>
      <DriveSettingsSection
        title={t("routesDriveSettings.fileSharing")}
        description={t("routesDriveSettings.shareIndividualFilesAndFoldersUsingTheControlsAlready")}
      >
        <p className="settings-hint">
          {t("routesDriveSettings.openAFileOrFolderAndChooseShareTo")}
        </p>
        <Button nativeButton={false} render={<Link to="/drive" />}>
          {t("routesDriveSettings.openMyDrive")}
        </Button>
      </DriveSettingsSection>
    </DriveSettingsLayout>
  );
}

function ImportBackup() {
  const drive = useDrive();
  return (
    <DriveSettingsLayout
      title={t("routesDriveSettings.importBackup")}
      description={t("routesDriveSettings.bringFilesIntoDriveAndReviewTheAvailableWays")}
    >
      <DriveSettingsSection
        title={t("routesDriveSettings.importFiles")}
        description={t("routesDriveSettings.uploadFilesOrAFolderIntoMyDriveFolder")}
      >
        <div className="settings-options">
          <article>
            <h3>{t("routesDriveSettings.uploadFiles")}</h3>
            <p>{t("routesDriveSettings.chooseOneOrMoreFilesFromYourDevice")}</p>
            <Button disabled={!drive.can("create")} onClick={() => drive.chooseFiles()}>
              {t("routesDriveSettings.chooseFiles")}
            </Button>
          </article>
          <article>
            <h3>{t("routesDriveSettings.uploadAFolder")}</h3>
            <p>{t("routesDriveSettings.bringAFolderAndItsContentsIntoMyDrive")}</p>
            <Button disabled={!drive.can("create")} onClick={() => drive.chooseFiles(true)}>
              {t("routesDriveSettings.chooseFolder")}
            </Button>
          </article>
        </div>
        {!drive.can("create") && (
          <p className="settings-hint">
            {t("routesDriveSettings.uploadingRequiresFileCreationPermissionAndAWritableDrive")}
          </p>
        )}
        {drive.capabilities && (
          <p className="settings-hint">
            <LocalizedMessage
              id="routesDriveSettings.maximumPerFileUploadProgressAppearsInTheDrive"
              values={{ formatBytes: formatBytes(drive.capabilities.max_file_bytes) }}
            />
          </p>
        )}
      </DriveSettingsSection>
      <DriveSettingsSection
        title={t("routesDriveSettings.downloadBackup")}
        description={t("routesDriveSettings.downloadIndividualFilesToKeepALocalCopyOf")}
      >
        <div className="settings-options">
          <article>
            <h3>{t("routesDriveSettings.downloadFiles")}</h3>
            <p>{t("routesDriveSettings.inDriveOpenAFileSMenuAndChoose")}</p>
            <Button nativeButton={false} render={<Link to="/drive" />}>
              {t("routesDriveSettings.browseFilesToDownload")}
            </Button>
          </article>
          <article>
            <h3>{t("routesDriveSettings.fullDriveBackupRestore")}</h3>
            <p>{t("routesDriveSettings.fullBackupsScheduledBackupsAndArchiveRestorationAreNot")}</p>
            <span className="settings-badge">{t("routesDriveSettings.notAvailable")}</span>
          </article>
        </div>
      </DriveSettingsSection>
    </DriveSettingsLayout>
  );
}

interface ActivityPage {
  activity: (Pick<DriveActivity, "seq" | "actor_name" | "link_id" | "action" | "created_at"> & {
    item_id: string;
    item_name: string;
    available: boolean;
  })[];
  next_cursor: string | null;
}

function ActivityStorage() {
  const drive = useDrive(),
    [cursors, setCursors] = useState<string[]>([]),
    current = cursors.at(-1);
  const storage = useDriveResource<DriveQuota>("/api/drive/quota", drive.revision);
  const activity = useDriveResource<ActivityPage>(
    `/api/drive/activity?limit=25${current ? `&cursor=${encodeURIComponent(current)}` : ""}`,
    drive.revision,
  );
  const quota = storage.data;
  return (
    <DriveSettingsLayout
      title={t("routesDriveSettings.activityStorage")}
      description={t("routesDriveSettings.checkYourStorageAllowanceAndRecentActivityAcrossFiles")}
      actions={
        <Button disabled={storage.loading || activity.loading} onClick={drive.refresh}>
          {t("common.refresh")}
        </Button>
      }
    >
      <DriveSettingsSection
        title={t("routesDriveSettings.storageUsage")}
        description={t("routesDriveSettings.yourAllowanceIncludesStoredFileVersionsAndFilesIn")}
      >
        <SettingsState
          loading={storage.loading && !quota}
          error={storage.error}
          retry={storage.reload}
        />
        {quota && (
          <>
            <div className="settings-storage-overview">
              <strong>{formatBytes(quota.used_bytes)}</strong>
              <span>
                <LocalizedMessage
                  id="routesDriveSettings.ofUsed"
                  values={{ formatBytes: formatBytes(quota.quota_bytes) }}
                />
              </span>
            </div>
            <Meter.Root
              className="drive-settings-meter"
              value={Math.min(quota.quota_bytes, quota.used_bytes + quota.reserved_bytes)}
              min={0}
              max={Math.max(1, quota.quota_bytes)}
              aria-label={t("routesDriveSettings.driveStorageUsedAndReserved")}
            >
              <Meter.Track>
                <Meter.Indicator />
              </Meter.Track>
            </Meter.Root>
            <dl className="drive-settings-storage-grid">
              <div>
                <dt>{t("routesDriveSettings.used")}</dt>
                <dd>{formatBytes(quota.used_bytes)}</dd>
              </div>
              <div>
                <dt>{t("routesDriveSettings.reservedForUploads")}</dt>
                <dd>{formatBytes(quota.reserved_bytes)}</dd>
              </div>
              <div>
                <dt>{t("routesDriveSettings.available")}</dt>
                <dd>{formatBytes(quota.available_bytes)}</dd>
              </div>
            </dl>
            {quota.available_bytes === 0 && (
              <p className="settings-hint" role="status">
                {t("routesDriveSettings.noStorageIsAvailableForNewUploadsRemoveUnneeded")}
              </p>
            )}
            <Button nativeButton={false} render={<Link to="/drive/trash" />}>
              {t("routesDriveSettings.reviewTrash")}
            </Button>
          </>
        )}
      </DriveSettingsSection>
      <DriveSettingsSection
        title={t("routesDriveSettings.recentActivity")}
        description={t("routesDriveSettings.reviewFileChangesSharingAndCommentsActivityOnShared")}
      >
        <SettingsState
          loading={activity.loading && !activity.data}
          error={activity.error}
          retry={activity.reload}
        />
        {activity.data && (
          <>
            <div className="settings-table-wrap">
              <table className="settings-table">
                <thead>
                  <tr>
                    <th>{t("routesDriveSettings.time")}</th>
                    <th>{t("routesDriveSettings.actor")}</th>
                    <th>{t("routesDriveSettings.operation")}</th>
                    <th>{t("routesDriveSettings.file")}</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.data.activity.map((event) => (
                    <tr key={event.seq}>
                      <td data-label={t("routesDriveSettings.time")}>
                        <time dateTime={new Date(event.created_at * 1000).toISOString()}>
                          {driveDate(event.created_at, true)}
                        </time>
                      </td>
                      <td data-label={t("routesDriveSettings.actor")}>
                        {event.actor_name ??
                          (event.link_id
                            ? t("routesDriveSettings.publicLinkVisitor")
                            : t("routesDriveSettings.systemOrFormerAccount"))}
                      </td>
                      <td data-label={t("routesDriveSettings.operation")}>
                        {enumLabel(event.action)}
                      </td>
                      <td data-label={t("routesDriveSettings.file")}>
                        {event.available ? (
                          <Link to={`/drive/items/${event.item_id}`}>{event.item_name}</Link>
                        ) : (
                          event.item_name
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!activity.data.activity.length && (
              <p className="settings-hint">
                {current
                  ? t("routesDriveSettings.noActivityOnThisPage")
                  : t("routesDriveSettings.noActivityYet")}
              </p>
            )}
          </>
        )}
        <div className="settings-actions">
          {current && (
            <Button
              disabled={activity.loading}
              onClick={() => setCursors((old) => old.slice(0, -1))}
            >
              {t("routesDriveSettings.newerActivity")}
            </Button>
          )}
          {activity.data?.next_cursor && (
            <Button
              disabled={activity.loading}
              onClick={() => setCursors((old) => [...old, activity.data!.next_cursor!])}
            >
              {t("routesDriveSettings.olderActivity")}
            </Button>
          )}
        </div>
      </DriveSettingsSection>
    </DriveSettingsLayout>
  );
}
