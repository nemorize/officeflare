import { enumLabel } from "../../shared/i18n/labels.ts";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogPopup,
  Textarea,
  Field,
  Icon,
  Input,
  Tabs,
  useNotifications,
} from "./ui";
import {
  DriveField,
  DriveFileIcon,
  DriveIconButton,
  DriveNotice,
  DriveSelect,
  DriveState,
  useDriveAction,
  useDriveCollection,
  useDriveSmallScreen,
} from "./drive-controls";
import { DriveConfirmDialog, freshItem } from "./drive-dialogs";
import { useDrive } from "./drive-context";
import { useAccount } from "./account-context";
import { api } from "../lib/api";
import { downloadDriveItem } from "./drive-preview";
import {
  canComment,
  canEdit,
  driveDate,
  driveSize,
  fileKind,
  formatBytes,
  type DriveActivity,
  type DriveComment,
  type DriveItem,
  type DriveVersion,
} from "../lib/drive";

export function DriveDetails({
  item,
  onClose,
  onShare,
  onOpen,
}: {
  item: DriveItem;
  onClose: () => void;
  onShare: () => void;
  onOpen: () => void;
}) {
  const [tab, setTab] = useState("details"),
    [description, setDescription] = useState(item.description),
    drive = useDrive(),
    action = useDriveAction(),
    notify = useNotifications();
  useEffect(() => {
    setDescription(item.description);
    action.setError("");
  }, [item.id, item.description]);
  const small = useDriveSmallScreen();
  const content = (
    <aside
      className="drive-details"
      aria-label={t("componentsDriveDetails.detailsFor", { name: item.name })}
    >
      <header>
        <h2>{t("componentsDriveDetails.fileInformation")}</h2>
        <DriveIconButton
          icon="close"
          label={t("componentsDriveDetails.closeFileInformation")}
          onClick={onClose}
        />
      </header>
      <div className="drive-details-identity">
        <DriveFileIcon item={item} large />
        <h3 title={item.name}>{item.name}</h3>
        <span>{fileKind(item).label}</span>
      </div>
      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))}>
        <Tabs.List
          className="drive-details-tabs"
          aria-label={t("componentsDriveDetails.fileInformationSections")}
        >
          <Tabs.Tab value="details">{t("componentsDriveDetails.details")}</Tabs.Tab>
          <Tabs.Tab value="activity">{t("componentsDriveDetails.activity")}</Tabs.Tab>
          {!item.trashed_at && (
            <Tabs.Tab value="comments">{t("componentsDriveDetails.comments")}</Tabs.Tab>
          )}
          {item.kind === "file" && !item.trashed_at && (
            <Tabs.Tab value="versions">{t("componentsDriveDetails.versions")}</Tabs.Tab>
          )}
        </Tabs.List>
        <Tabs.Panel value="details">
          <div className="drive-details-actions">
            {!item.trashed_at && (
              <Button size="sm" onClick={onOpen}>
                <Icon name={item.kind === "folder" ? "folder" : "eye"} />
                {item.kind === "folder"
                  ? t("componentsDriveDetails.openFolder")
                  : t("componentsDriveDetails.preview")}
              </Button>
            )}
            {item.effective_role === "owner" && !item.trashed_at && (
              <Button size="sm" onClick={onShare}>
                <Icon name="users" />
                {t("componentsDriveDetails.share")}
              </Button>
            )}
          </div>
          <dl className="drive-metadata">
            <dt>{t("componentsDriveDetails.owner")}</dt>
            <dd>{item.owner?.display_name || item.owner?.email_address || "—"}</dd>
            <dt>{t("componentsDriveDetails.yourAccess")}</dt>
            <dd className="drive-capitalize">
              {item.effective_role ?? t("componentsDriveDetails.viewer")}
            </dd>
            <dt>{t("componentsDriveDetails.type")}</dt>
            <dd>{fileKind(item).label}</dd>
            {item.kind === "file" && (
              <>
                <dt>{t("componentsDriveDetails.size")}</dt>
                <dd>{formatBytes(driveSize(item))}</dd>
              </>
            )}
            <dt>{t("componentsDriveDetails.created")}</dt>
            <dd>{driveDate(item.created_at, true)}</dd>
            <dt>{t("componentsDriveDetails.modified")}</dt>
            <dd>{driveDate(item.updated_at, true)}</dd>
            {item.trashed_at && (
              <>
                <dt>{t("componentsDriveDetails.trashed")}</dt>
                <dd>{driveDate(item.trashed_at, true)}</dd>
              </>
            )}
          </dl>
          <Field.Root className="drive-field">
            <Field.Label>{t("componentsDriveDetails.description")}</Field.Label>
            <Textarea
              rows={4}
              maxLength={2000}
              value={description}
              readOnly={!canEdit(item) || !!item.trashed_at}
              placeholder={t("componentsDriveDetails.addADescription")}
              onChange={(event) => setDescription(event.target.value)}
            />
            <Field.Description>
              {canEdit(item) && !item.trashed_at
                ? t("componentsDriveDetails.visibleToPeopleWhoCanAccessThisItem")
                : t("componentsDriveDetails.providedByTheOwner")}
            </Field.Description>
          </Field.Root>
          {canEdit(item) && !item.trashed_at && description !== item.description && (
            <Button
              size="sm"
              variant="primary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(`/api/drive/items/${item.id}`, {
                    method: "PATCH",
                    body: { version: item.version, description },
                  });
                  drive.refresh();
                  notify.success(t("componentsDriveDetails.descriptionSaved"));
                })
              }
            >
              {t("componentsDriveDetails.saveDescription")}
            </Button>
          )}
          <DriveNotice error={action.error} />
          <p className="drive-details-note">
            <Icon name="shield" />
            {item.kind === "folder"
              ? t("componentsDriveDetails.sharingAFolderGrantsAccessToItsContents")
              : t("componentsDriveDetails.activityAndPreviousVersionsStayWithThisFile")}
          </p>
        </Tabs.Panel>
        <Tabs.Panel value="activity">
          <DriveActivityPanel item={item} />
        </Tabs.Panel>
        {!item.trashed_at && (
          <Tabs.Panel value="comments">
            <DriveCommentsPanel item={item} />
          </Tabs.Panel>
        )}
        {item.kind === "file" && !item.trashed_at && (
          <Tabs.Panel value="versions">
            <DriveVersionsPanel item={item} />
          </Tabs.Panel>
        )}
      </Tabs.Root>
    </aside>
  );
  return small ? (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup
        layout="side-panel"
        padding="none"
        data-ui-theme="neutral"
        className="drive-details-mobile"
        viewportProps={{ className: "drive-details-viewport" }}
      >
        <Dialog.Title className="visually-hidden">
          {t("componentsDriveDetails.fileInformation")}
        </Dialog.Title>
        <Dialog.Description className="visually-hidden">
          {t("componentsDriveDetails.detailsActivityCommentsAndPreviousFileVersions")}
        </Dialog.Description>
        {content}
      </DialogPopup>
    </Dialog.Root>
  ) : (
    content
  );
}
function DriveActivityPanel({ item }: { item: DriveItem }) {
  const drive = useDrive(),
    events = useDriveCollection<DriveActivity>(
      `/api/drive/items/${item.id}/activity?recursive=${item.kind === "folder"}&limit=50`,
      "activity",
      drive.revision,
    );
  const labels: Record<string, string> = {
    folder_created: t("componentsDriveDetails.createdAFolder"),
    file_created: t("componentsDriveDetails.uploadedAFile"),
    metadata_updated: t("componentsDriveDetails.updatedFileInformation"),
    moved: t("componentsDriveDetails.movedThisItem"),
    trashed: t("componentsDriveDetails.movedThisItemToTrash"),
    restored: t("componentsDriveDetails.restoredThisItem"),
    content_updated: t("componentsDriveDetails.uploadedANewVersion"),
    version_restored: t("componentsDriveDetails.restoredAPreviousVersion"),
    version_deleted: t("componentsDriveDetails.deletedAPreviousVersion"),
    permission_granted: t("componentsDriveDetails.grantedAccountAccess"),
    permission_revoked: t("componentsDriveDetails.removedAccountAccess"),
    link_created: t("componentsDriveDetails.createdAPublicLink"),
    link_updated: t("componentsDriveDetails.updatedAPublicLink"),
    link_revoked: t("componentsDriveDetails.revokedAPublicLink"),
    previewed: t("componentsDriveDetails.previewedThisFile"),
    downloaded: t("componentsDriveDetails.downloadedThisFile"),
    public_download: t("componentsDriveDetails.accessedAFileThroughAPublicLink"),
    comment_created: t("componentsDriveDetails.addedAComment"),
    comment_updated: t("componentsDriveDetails.editedAComment"),
    comment_resolved: t("componentsDriveDetails.changedCommentResolution"),
    comment_deleted: t("componentsDriveDetails.deletedAComment"),
    copied: t("componentsDriveDetails.copiedThisItem"),
    ownership_transferred: t("componentsDriveDetails.transferredOwnership"),
    access_requested: t("componentsDriveDetails.requestedAccess"),
    access_approved: t("componentsDriveDetails.approvedAnAccessRequest"),
    access_denied: t("componentsDriveDetails.declinedAnAccessRequest"),
  };
  return (
    <div className="drive-activity">
      <DriveState loading={events.loading} error={events.error} retry={events.reload} />
      {!events.loading && !events.error && !events.items.length && (
        <p className="drive-muted">{t("componentsDriveDetails.noActivityYet")}</p>
      )}
      {events.items.map((event) => (
        <div className="drive-activity-event" key={event.seq}>
          <span className="drive-event-icon">
            <Icon
              name={
                event.action.includes("permission") || event.action.includes("link")
                  ? "users"
                  : event.action.includes("comment")
                    ? "mail"
                    : event.action.includes("trash")
                      ? "trash"
                      : "clock"
              }
            />
          </span>
          <div>
            <strong>
              {event.actor_name ||
                (event.link_id
                  ? t("componentsDriveDetails.publicLinkVisitor")
                  : t("componentsDriveDetails.workspaceAccount"))}
            </strong>
            <p>{labels[event.action] || enumLabel(event.action)}</p>
            <time dateTime={new Date(event.created_at * 1000).toISOString()}>
              {driveDate(event.created_at, true)}
            </time>
          </div>
        </div>
      ))}
      {events.next && (
        <Button size="sm" disabled={events.more} onClick={() => void events.loadMore()}>
          {events.more ? t("common.loading") : t("componentsDriveDetails.loadEarlierActivity")}
        </Button>
      )}
    </div>
  );
}
function DriveCommentsPanel({ item }: { item: DriveItem }) {
  const drive = useDrive(),
    account = useAccount(),
    action = useDriveAction();
  const comments = useDriveCollection<DriveComment>(
    `/api/drive/items/${item.id}/comments?limit=100`,
    "comments",
    drive.revision,
    "after",
  );
  const [body, setBody] = useState(""),
    [parent, setParent] = useState<string | null>(null),
    [edit, setEdit] = useState<DriveComment | null>(null),
    [filter, setFilter] = useState("all");
  const mutate = (callback: () => Promise<unknown>) =>
    void action.run(async () => {
      await callback();
      drive.refresh();
    });
  const roots = comments.items.filter(
    (comment) =>
      !comment.parent_id &&
      (filter === "all" ||
        (filter === "open" && !comment.resolved) ||
        (filter === "resolved" && comment.resolved)),
  );
  return (
    <div className="drive-comments">
      <DriveSelect
        value={filter}
        label={t("componentsDriveDetails.commentFilter")}
        options={[
          { value: "all", label: t("componentsDriveDetails.allComments") },
          { value: "open", label: t("componentsDriveDetails.openThreads") },
          { value: "resolved", label: t("componentsDriveDetails.resolvedThreads") },
        ]}
        onChange={setFilter}
      />
      <DriveState loading={comments.loading} error={comments.error} retry={comments.reload} />
      {!comments.loading && !roots.length && (
        <div className="drive-panel-empty">
          <Icon name="mail" width="28" height="28" />
          <p>{t("componentsDriveDetails.noCommentsHereYet")}</p>
        </div>
      )}
      {roots.map((root) => (
        <div className={`drive-comment-thread${root.resolved ? " is-resolved" : ""}`} key={root.id}>
          {[root, ...comments.items.filter((comment) => comment.parent_id === root.id)].map(
            (comment) => (
              <div
                className={`drive-comment${comment.parent_id ? " drive-comment-reply" : ""}`}
                key={comment.id}
              >
                <div>
                  <strong>
                    {comment.author_name || t("componentsDriveDetails.workspaceAccount")}
                  </strong>
                  <time>{driveDate(comment.created_at, true)}</time>
                </div>
                <p>{comment.body}</p>
                <div className="drive-comment-actions">
                  {!comment.parent_id && canComment(item) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setParent(comment.id);
                        setEdit(null);
                        setBody("");
                      }}
                    >
                      {t("componentsDriveDetails.reply")}
                    </Button>
                  )}
                  {!comment.parent_id && canEdit(item) && canComment(item) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.busy}
                      onClick={() =>
                        mutate(() =>
                          api(`/api/drive/items/${item.id}/comments/${comment.id}`, {
                            method: "PATCH",
                            body: {
                              version: comment.version,
                              resolved: !comment.resolved,
                            },
                          }),
                        )
                      }
                    >
                      {comment.resolved
                        ? t("componentsDriveDetails.reopen")
                        : t("componentsDriveDetails.resolve")}
                    </Button>
                  )}
                  {comment.author_user_id === account.user?.id && canComment(item) && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEdit(comment);
                          setParent(comment.parent_id);
                          setBody(comment.body);
                        }}
                      >
                        {t("common.edit")}
                      </Button>
                      <DriveIconButton
                        icon="trash"
                        label={t("componentsDriveDetails.deleteComment")}
                        disabled={action.busy}
                        onClick={() =>
                          mutate(() =>
                            api(`/api/drive/items/${item.id}/comments/${comment.id}`, {
                              method: "PATCH",
                              body: { version: comment.version, deleted: true },
                            }),
                          )
                        }
                      />
                    </>
                  )}
                  {comment.resolved && (
                    <span>
                      <Icon name="check" />
                      {t("componentsDriveDetails.resolved")}
                    </span>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      ))}
      {comments.next && (
        <Button disabled={comments.more} onClick={() => void comments.loadMore()}>
          {t("componentsDriveDetails.loadMoreComments")}
        </Button>
      )}
      {canComment(item) && (
        <form
          className="drive-comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            mutate(async () => {
              await api(`/api/drive/items/${item.id}/comments${edit ? `/${edit.id}` : ""}`, {
                method: edit ? "PATCH" : "POST",
                body: edit ? { version: edit.version, body } : { body, parent_id: parent },
              });
              setBody("");
              setParent(null);
              setEdit(null);
            });
          }}
        >
          <Field.Root className="drive-field">
            <Field.Label>
              {edit
                ? t("componentsDriveDetails.editComment")
                : parent
                  ? t("componentsDriveDetails.replyToThread")
                  : t("componentsDriveDetails.addAComment")}
            </Field.Label>
            <Textarea
              rows={3}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={5000}
              required
              placeholder={t("componentsDriveDetails.writeAComment")}
            />
          </Field.Root>
          <div>
            {(parent || edit) && (
              <Button
                size="sm"
                onClick={() => {
                  setParent(null);
                  setEdit(null);
                  setBody("");
                }}
              >
                {t("common.cancel")}
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={action.busy || !body.trim()}
            >
              {edit ? t("common.save") : t("componentsDriveDetails.post")}
            </Button>
          </div>
        </form>
      )}
      {!canComment(item) && (
        <p className="drive-muted">
          {t("componentsDriveDetails.youNeedCommenterAccessToJoinTheConversation")}
        </p>
      )}
      <DriveNotice error={action.error} />
    </div>
  );
}
function DriveVersionsPanel({ item }: { item: DriveItem }) {
  const drive = useDrive(),
    action = useDriveAction(),
    notify = useNotifications(),
    versions = useDriveCollection<DriveVersion>(
      `/api/drive/items/${item.id}/versions?limit=50`,
      "versions",
      drive.revision,
    );
  const [confirm, setConfirm] = useState<{
    version: DriveVersion;
    deleting: boolean;
  } | null>(null);
  return (
    <div className="drive-versions">
      {canEdit(item) && (
        <Button onClick={() => drive.chooseFiles(false, item)}>
          <Icon name="upload" />
          {t("componentsDriveDetails.uploadNewVersion")}
        </Button>
      )}
      <p className="drive-muted">
        {t("componentsDriveDetails.previousVersionsUseYourStorageQuota")}
      </p>
      <DriveState loading={versions.loading} error={versions.error} retry={versions.reload} />
      {versions.items.map((version) => (
        <div className="drive-version" key={version.id}>
          <Icon name="file" />
          <div>
            <strong>
              {version.current
                ? t("componentsDriveDetails.currentVersion")
                : t("componentsDriveDetails.previousVersion")}
            </strong>
            <span>
              {driveDate(version.created_at, true)}
              {t("componentsDriveDetails.text")}
              {formatBytes(version.size)}
            </span>
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={action.busy || item.actions?.download === false}
                onClick={() =>
                  void action.run(() =>
                    downloadDriveItem(
                      { ...item, current_version: null, size: version.size },
                      `/api/drive/items/${item.id}/content?version_id=${version.id}`,
                    ),
                  )
                }
              >
                {t("componentsDriveDetails.download")}
              </Button>
              {!version.current && canEdit(item) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirm({ version, deleting: false })}
                >
                  {t("componentsDriveDetails.restore")}
                </Button>
              )}
              {!version.current && item.effective_role === "owner" && canEdit(item) && (
                <DriveIconButton
                  icon="trash"
                  label={t("componentsDriveDetails.deletePreviousVersion")}
                  onClick={() => setConfirm({ version, deleting: true })}
                />
              )}
            </div>
          </div>
          {version.current && <Icon name="check" />}
        </div>
      ))}
      {versions.next && (
        <Button disabled={versions.more} onClick={() => void versions.loadMore()}>
          {t("componentsDriveDetails.loadMoreVersions")}
        </Button>
      )}
      <DriveNotice error={action.error} />
      {confirm && (
        <DriveConfirmDialog
          title={
            confirm.deleting
              ? t("componentsDriveDetails.deleteThisVersion")
              : t("componentsDriveDetails.restoreThisVersion")
          }
          description={
            confirm.deleting
              ? t("componentsDriveDetails.thisPreviousFileVersionWillBePermanentlyDeleted")
              : t("componentsDriveDetails.thisVersionBecomesTheCurrentFileContentTheExisting")
          }
          confirm={
            confirm.deleting
              ? t("componentsDriveDetails.deleteVersion")
              : t("componentsDriveDetails.restoreVersion")
          }
          destructive={confirm.deleting}
          onClose={() => setConfirm(null)}
          action={async () => {
            const current = await freshItem(item.id);
            await api(
              `/api/drive/items/${item.id}/versions/${confirm.version.id}${confirm.deleting ? `?version=${current.version}` : "/restore"}`,
              {
                method: confirm.deleting ? "DELETE" : "POST",
                ...(confirm.deleting ? {} : { body: { version: current.version } }),
              },
            );
            drive.refresh();
            notify.success(
              confirm.deleting
                ? t("componentsDriveDetails.versionDeleted")
                : t("componentsDriveDetails.versionRestored"),
            );
          }}
        />
      )}
    </div>
  );
}
