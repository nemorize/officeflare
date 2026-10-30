import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "../components/i18n";
import { t } from "../../shared/i18n/index.ts";
import { MailSettingsLayout } from "../components/mail-settings-nav";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/api";
import {
  bytes,
  downloadMail,
  mailboxPath,
  mailDate,
  mailErrorDescription,
  type Job,
} from "../lib/mail";
import { useMail } from "../components/mail-context";
import { useAccess } from "../components/console-access";
import { MailReady } from "./mail";
import {
  MailField,
  MailModal,
  MailNotice,
  MailSection,
  MailState,
  useMailAction,
  useMailResource,
  MailForm,
  MailFieldset,
  MailSelect,
  MailFileInput,
} from "../components/mail-common";
import { Check, Confirm } from "../components/console-shared";
import { Button } from "../components/ui";
export function MailDataPage({ page }: { page: string }) {
  const mail = useMail();
  return (
    <MailReady>
      <div className="account-page mail-manage-page" key={mail.box?.id}>
        {page === "activity" ? <Activity /> : <DataJobs />}
      </div>
    </MailReady>
  );
}
function DataJobs() {
  const mail = useMail(),
    path = mailboxPath(mail.box!.id),
    navigate = useNavigate(),
    action = useMailAction(),
    [poll, setPoll] = useState(false),
    resource = useMailResource<{ jobs: Job[] }>(path + "/jobs", mail.revision, poll);
  const [file, setFile] = useState<File | null>(null),
    [format, setFormat] = useState("eml"),
    [selected, setSelected] = useState<Job | null>(null),
    [restore, setRestore] = useState<Job | null>(null),
    [target, setTarget] = useState(mail.box!.id),
    [restoreSettings, setRestoreSettings] = useState(false),
    [confirmRestore, setConfirmRestore] = useState(false);
  useEffect(
    () =>
      setPoll(!!resource.data?.jobs.some((job) => ["queued", "processing"].includes(job.status))),
    [resource.data],
  );
  const targetBox = mail.boxes.find((box) => box.id === target);
  async function start(kind: string) {
    await api(path + "/" + kind, { method: "POST" });
    resource.reload();
  }
  return (
    <MailSettingsLayout
      title={t("routesMailData.importBackup")}
      description={t("routesMailData.moveMailInAndOutOfThisMailboxAnd")}
      actions={
        <Button onClick={resource.reload} disabled={resource.loading}>
          {t("routesMailData.refreshJobs")}
        </Button>
      }
    >
      <MailSection
        title={t("routesMailData.importMail")}
        description={t("routesMailData.uploadAnEmlMessageOrAnMboxArchiveImported")}
      >
        <MailForm
          className="mail-form"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              if (!file?.size) throw new Error(t("routesMailData.chooseANonEmptyMailFile"));
              if (file.size > 26 * 1024 ** 2)
                throw new Error(t("routesMailData.splitImportsIntoFilesOfAtMost26Mib"));
              await api(`${path}/imports?format=${format}`, {
                method: "POST",
                body: file,
                signal: AbortSignal.timeout(120_000),
              });
              setFile(null);
              resource.reload();
            });
          }}
        >
          <MailFieldset disabled={!mail.box!.access?.write || action.busy}>
            <div className="mail-form-grid">
              <MailField label={t("routesMailData.importFormat")}>
                <MailSelect
                  value={format}
                  onValueChange={(nextValue) => {
                    setFormat(nextValue);
                    setFile(null);
                  }}
                  options={[
                    { value: "eml", label: t("routesMailData.emailMessageEml") },
                    { value: "mbox", label: t("routesMailData.mailboxArchiveMbox") },
                  ]}
                />
              </MailField>
              <MailField
                label={t("routesMailData.mailFile")}
                hint={t("routesMailData.maximum26MibPerImport")}
              >
                <MailFileInput
                  key={format}
                  accept={format === "eml" ? ".eml,message/rfc822" : ".mbox,application/mbox"}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </MailField>
            </div>
            {file && (
              <p className="mail-hint">
                {file.name}
                {t("routesMailData.text")}
                {bytes(file.size)}
              </p>
            )}
            <Button type="submit" disabled={!file || action.busy}>
              {t("routesMailData.startImport")}
            </Button>
          </MailFieldset>
        </MailForm>
        {!mail.box!.access?.write && (
          <p className="mail-hint">{t("routesMailData.importingRequiresMailboxEditPermission")}</p>
        )}
      </MailSection>
      <MailSection
        title={t("routesMailData.exportBackup")}
        description={t("routesMailData.exportsIncludeMessagesYouCanAccessOtherMembersPrivate")}
      >
        <div className="mail-data-options">
          <article>
            <h3>{t("routesMailData.exportToMbox")}</h3>
            <p>{t("routesMailData.downloadMessagesInAFormatThatOtherMailApplications")}</p>
            <Button
              disabled={action.busy}
              onClick={() => {
                void action.run(() => start("exports"));
              }}
            >
              {t("routesMailData.createExport")}
            </Button>
          </article>
          <article>
            <h3>{t("routesMailData.mailboxBackup")}</h3>
            <p>{t("routesMailData.saveMessagesAttachmentsFoldersRulesAndSettingsRestoreA")}</p>
            <Button
              disabled={action.busy}
              onClick={() => {
                void action.run(() => start("backups"));
              }}
            >
              {t("routesMailData.createBackup")}
            </Button>
          </article>
        </div>
      </MailSection>
      <MailNotice error={action.error} />
      <MailSection
        title={t("routesMailData.yourBackgroundJobs")}
        description={t("routesMailData.jobsAndDownloadableBackupsAreVisibleOnlyToThe")}
      >
        <MailState
          loading={resource.loading && !resource.data}
          error={resource.error}
          retry={resource.reload}
        />
        <div className="mail-table-wrap">
          <table className="mail-table">
            <thead>
              <tr>
                <th>{t("routesMailData.operation")}</th>
                <th>{t("common.status")}</th>
                <th>{t("routesMailData.processed")}</th>
                <th>{t("routesMailData.created")}</th>
                <th>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {resource.data?.jobs.map((job) => (
                <tr key={job.id}>
                  <td data-label={t("routesMailData.operation")}>{enumLabel(job.kind)}</td>
                  <td data-label={t("common.status")}>
                    <span className="mail-badge" data-status={job.status}>
                      {enumLabel(job.status)}
                    </span>
                    {job.error_code && (
                      <p className="mail-hint">{mailErrorDescription(job.error_code)}</p>
                    )}
                  </td>
                  <td data-label={t("routesMailData.processed")}>{job.progress}</td>
                  <td data-label={t("routesMailData.created")}>{mailDate(job.created_at)}</td>
                  <td data-label={t("common.actions")}>
                    <div className="mail-actions">
                      <Button size="sm" onClick={() => setSelected(job)}>
                        {t("routesMailData.details")}
                      </Button>
                      {job.status === "completed" && ["export", "backup"].includes(job.kind) && (
                        <Button
                          size="sm"
                          disabled={action.busy}
                          onClick={() => {
                            void action.run(() =>
                              downloadMail(
                                `${path}/jobs/${job.id}/download`,
                                job.kind === "export" ? "mailbox.mbox" : "manifest.json",
                              ),
                            );
                          }}
                        >
                          <LocalizedMessage
                            id="routesMailData.download"
                            values={{
                              value1:
                                job.kind === "backup"
                                  ? t("routesMailData.backupManifest")
                                  : t("routesMailData.mbox"),
                            }}
                          />
                        </Button>
                      )}
                      {job.kind === "backup" && job.status === "completed" && (
                        <Button
                          size="sm"
                          disabled={
                            !mail.boxes.some((box) => box.access?.read && box.access?.write)
                          }
                          onClick={() => {
                            setRestore(job);
                            setTarget(mail.box!.id);
                            setRestoreSettings(false);
                          }}
                        >
                          {t("routesMailData.restore")}
                        </Button>
                      )}
                      {job.status === "failed" && (
                        <Button
                          size="sm"
                          disabled={
                            action.busy ||
                            (["restore", "import_eml", "import_mbox", "reindex"].includes(
                              job.kind,
                            ) &&
                              !mail.box!.access?.write)
                          }
                          onClick={() => {
                            void action.run(async () => {
                              await api(`${path}/jobs/${job.id}/retry`, { method: "POST" });
                              resource.reload();
                            });
                          }}
                        >
                          {t("common.retry")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {resource.data && !resource.data.jobs.length && (
          <p className="mail-empty">{t("routesMailData.noBackgroundJobsYet")}</p>
        )}
      </MailSection>
      {selected && (
        <JobDetails
          key={selected.id}
          job={resource.data?.jobs.find((job) => job.id === selected.id) ?? selected}
          path={path}
          onClose={() => setSelected(null)}
        />
      )}
      <MailModal
        open={!!restore}
        title={t("routesMailData.restoreMailboxBackup")}
        description={t("routesMailData.chooseTheMailboxThatShouldReceiveTheBackedUp")}
        onClose={() => setRestore(null)}
      >
        <MailForm
          className="mail-form"
          onSubmit={(event) => {
            event.preventDefault();
            setConfirmRestore(true);
          }}
        >
          <MailField label={t("routesMailData.targetMailbox")}>
            <MailSelect
              required
              value={target}
              onValueChange={(nextValue) => {
                setTarget(nextValue);
                setRestoreSettings(false);
              }}
              options={[
                ...(mail.boxes
                  .filter((box) => box.access?.read && box.access?.write)
                  .map((box) => ({ value: box.id, label: box.name })) || []),
              ]}
            />
          </MailField>
          <Check
            checked={restoreSettings}
            disabled={!targetBox?.access?.manage}
            onChange={setRestoreSettings}
          >
            {t("routesMailData.alsoRestoreSettingsAndRules")}
          </Check>
          <p className="mail-hint">
            {t("routesMailData.restoringAddsMessagesToTheTargetMailboxStartingA")}
          </p>
          <Button type="submit" variant="primary" disabled={!targetBox?.access?.write}>
            {t("routesMailData.reviewRestore")}
          </Button>
        </MailForm>
      </MailModal>
      <Confirm
        open={confirmRestore}
        title={t("routesMailData.restoreInto", {
          value1: targetBox?.name ?? t("mail.fallbackName"),
        })}
        description={
          <>
            <LocalizedMessage
              id="routesMailData.messageSWillBeAddedToThisMailbox"
              values={{
                value1: restore?.progress ?? 0,
                value2:
                  restoreSettings &&
                  t("routesMailData.itsMailboxSettingsWillAlsoBeReplacedAndRules"),
              }}
            />
          </>
        }
        label={t("routesMailData.startRestore")}
        onClose={() => setConfirmRestore(false)}
        onConfirm={async () => {
          const result = await api<{ job: { mailbox_id: string } }>(
            `${path}/backups/${restore!.id}/restore`,
            {
              method: "POST",
              body: { target_mailbox_id: target, restore_settings: restoreSettings },
            },
          );
          setRestore(null);
          if (result.job.mailbox_id !== mail.box!.id)
            navigate(`/mail/data?mailbox=${encodeURIComponent(result.job.mailbox_id)}`);
          else resource.reload();
        }}
      />
    </MailSettingsLayout>
  );
}
function JobDetails({ job, path, onClose }: { job: Job; path: string; onClose: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null),
    resource = useMailResource<{
      job: Job;
      files?: { name: string; size: number }[];
      next_file_cursor?: string | null;
    }>(
      `${path}/jobs/${job.id}${cursor ? `?files_cursor=${encodeURIComponent(cursor)}` : ""}`,
      0,
      ["queued", "processing"].includes(job.status),
    ),
    action = useMailAction(),
    current = resource.data?.job ?? job;
  return (
    <MailModal
      open
      title={t("routesMailData.jobDetails")}
      description={`${enumLabel(current.kind)} · ${enumLabel(current.status)}`}
      onClose={onClose}
      busy={action.busy}
      wide
    >
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      <dl className="mail-message-details">
        <div>
          <dt>{t("routesMailData.jobId")}</dt>
          <dd>{current.id}</dd>
        </div>
        <div>
          <dt>{t("routesMailData.processedMessages")}</dt>
          <dd>{current.progress}</dd>
        </div>
        <div>
          <dt>{t("routesMailData.lastUpdated")}</dt>
          <dd>{mailDate(current.updated_at)}</dd>
        </div>
        {current.error_code && (
          <div>
            <dt>{t("routesMailData.error")}</dt>
            <dd>{mailErrorDescription(current.error_code)}</dd>
          </div>
        )}
      </dl>
      {resource.data?.files && (
        <>
          <h3>{t("routesMailData.backupFiles")}</h3>
          <p className="mail-hint">
            {t("routesMailData.theManifestDescribesTheBackupDownloadTheIndividualMessage")}
          </p>
          <div className="mail-backup-files">
            {resource.data.files.map((file) => (
              <div className="mail-record" key={file.name}>
                <div>
                  <strong>{file.name}</strong>
                  <p>{bytes(file.size)}</p>
                </div>
                <Button
                  size="sm"
                  disabled={action.busy}
                  onClick={() => {
                    void action.run(() =>
                      downloadMail(
                        `${path}/jobs/${job.id}/files/${encodeURIComponent(file.name)}`,
                        file.name,
                      ),
                    );
                  }}
                >
                  {t("routesMailData.download2")}
                </Button>
              </div>
            ))}
          </div>
          <div className="mail-actions">
            {cursor && (
              <Button onClick={() => setCursor(null)}>{t("routesMailData.firstPage")}</Button>
            )}
            {resource.data.next_file_cursor && (
              <Button onClick={() => setCursor(resource.data!.next_file_cursor!)}>
                {t("routesMailData.nextFiles")}
              </Button>
            )}
          </div>
        </>
      )}
      <MailNotice error={action.error} />
    </MailModal>
  );
}
interface AuditEvent {
  sequence: number;
  actor_id: string;
  operation: string;
  resource_path: string;
  created_at: number;
}
function Activity() {
  const mail = useMail(),
    access = useAccess(),
    canAudit = !!mail.box?.access?.manage && access.permissions.includes("admin.mail.audit.read"),
    path = mailboxPath(mail.box!.id),
    storage = useMailResource<{ partitions: { database_bytes: number }[] }>(
      path + "/storage",
      mail.revision,
    ),
    [before, setBefore] = useState<number | null>(null),
    audits = useMailResource<{ events: AuditEvent[] }>(
      canAudit ? path + "/audit-logs" + (before ? `?before=${before}` : "") : null,
    ),
    action = useMailAction(),
    [rebuild, setRebuild] = useState(false);
  return (
    <MailSettingsLayout
      title={t("routesMailData.activityStorage")}
      description={t("routesMailData.reviewMailboxActivityAndMetadataUsage")}
    >
      <MailSection
        title={t("routesMailData.metadataStorage")}
        description={t("routesMailData.includesMessageRecordsAndSearchIndexesEmailBodiesAnd")}
      >
        <MailState
          loading={storage.loading && !storage.data}
          error={storage.error}
          retry={storage.reload}
        />
        {storage.data && (
          <>
            <div className="mail-storage-overview">
              <strong>
                {bytes(
                  storage.data.partitions.reduce((total, part) => total + part.database_bytes, 0),
                )}
              </strong>
              <span>{t("routesMailData.ofMessageRecordsAndSearchIndexes")}</span>
            </div>
            <p className="mail-hint">
              {t("routesMailData.totalMailboxUsageIncludingBodiesAndAttachmentsIsNot")}
            </p>
          </>
        )}
      </MailSection>
      {mail.box!.access?.manage && mail.box!.access?.write && (
        <MailSection
          title={t("routesMailData.searchIndex")}
          description={t("routesMailData.rebuildTheMailboxSearchIndexFromStoredMessageBodies")}
        >
          <Button disabled={action.busy} onClick={() => setRebuild(true)}>
            {t("routesMailData.rebuildSearchIndex")}
          </Button>
          <MailNotice error={action.error} />
        </MailSection>
      )}
      {canAudit && (
        <MailSection
          title={t("routesMailData.auditHistory")}
          description={t("routesMailData.inspectRecentChangesToThisMailboxSResources")}
        >
          <MailState
            loading={audits.loading && !audits.data}
            error={audits.error}
            retry={audits.reload}
          />
          <div className="mail-table-wrap">
            <table className="mail-table">
              <thead>
                <tr>
                  <th>{t("routesMailData.time")}</th>
                  <th>{t("routesMailData.actor")}</th>
                  <th>{t("routesMailData.operation")}</th>
                  <th>{t("routesMailData.resource")}</th>
                </tr>
              </thead>
              <tbody>
                {audits.data?.events.map((event) => (
                  <tr key={event.sequence}>
                    <td data-label={t("routesMailData.time")}>{mailDate(event.created_at)}</td>
                    <td data-label={t("routesMailData.actor")}>{event.actor_id}</td>
                    <td data-label={t("routesMailData.operation")}>{enumLabel(event.operation)}</td>
                    <td data-label={t("routesMailData.resource")}>
                      <code>{event.resource_path}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audits.data && !audits.data.events.length && (
            <p className="mail-hint">{t("routesMailData.noAuditEventsOnThisPage")}</p>
          )}
          <div className="mail-actions">
            {before && (
              <Button onClick={() => setBefore(null)}>{t("routesMailData.latestEvents")}</Button>
            )}
            {audits.data?.events.length === 100 && (
              <Button onClick={() => setBefore(audits.data!.events.at(-1)!.sequence)}>
                {t("routesMailData.olderEvents")}
              </Button>
            )}
          </div>
        </MailSection>
      )}
      <Confirm
        open={rebuild}
        title={t("routesMailData.rebuildSearchIndex2")}
        description={t("routesMailData.aBackgroundJobWillRereadStoredMessageBodiesAnd")}
        label={t("routesMailData.startRebuild")}
        onClose={() => setRebuild(false)}
        onConfirm={async () => {
          await api(path + "/search/rebuild", { method: "POST" });
          mail.refresh();
        }}
      />
    </MailSettingsLayout>
  );
}
