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
    <aside className="drive-details" aria-label={`Details for ${item.name}`}>
      <header>
        <h2>File information</h2>
        <DriveIconButton icon="close" label="Close file information" onClick={onClose} />
      </header>
      <div className="drive-details-identity">
        <DriveFileIcon item={item} large />
        <h3 title={item.name}>{item.name}</h3>
        <span>{fileKind(item).label}</span>
      </div>
      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))}>
        <Tabs.List className="drive-details-tabs" aria-label="File information sections">
          <Tabs.Tab value="details">Details</Tabs.Tab>
          <Tabs.Tab value="activity">Activity</Tabs.Tab>
          {!item.trashed_at && <Tabs.Tab value="comments">Comments</Tabs.Tab>}
          {item.kind === "file" && !item.trashed_at && (
            <Tabs.Tab value="versions">Versions</Tabs.Tab>
          )}
        </Tabs.List>
        <Tabs.Panel value="details">
          <div className="drive-details-actions">
            {!item.trashed_at && (
              <Button size="sm" onClick={onOpen}>
                <Icon name={item.kind === "folder" ? "folder" : "eye"} />
                {item.kind === "folder" ? "Open folder" : "Preview"}
              </Button>
            )}
            {item.effective_role === "owner" && !item.trashed_at && (
              <Button size="sm" onClick={onShare}>
                <Icon name="users" />
                Share
              </Button>
            )}
          </div>
          <dl className="drive-metadata">
            <dt>Owner</dt>
            <dd>{item.owner?.display_name || item.owner?.email_address || "—"}</dd>
            <dt>Your access</dt>
            <dd className="drive-capitalize">{item.effective_role ?? "Viewer"}</dd>
            <dt>Type</dt>
            <dd>{fileKind(item).label}</dd>
            {item.kind === "file" && (
              <>
                <dt>Size</dt>
                <dd>{formatBytes(driveSize(item))}</dd>
              </>
            )}
            <dt>Created</dt>
            <dd>{driveDate(item.created_at, true)}</dd>
            <dt>Modified</dt>
            <dd>{driveDate(item.updated_at, true)}</dd>
            {item.trashed_at && (
              <>
                <dt>Trashed</dt>
                <dd>{driveDate(item.trashed_at, true)}</dd>
              </>
            )}
          </dl>
          <Field.Root className="drive-field">
            <Field.Label>Description</Field.Label>
            <Textarea
              rows={4}
              maxLength={2000}
              value={description}
              readOnly={!canEdit(item) || !!item.trashed_at}
              placeholder="Add a description"
              onChange={(event) => setDescription(event.target.value)}
            />
            <Field.Description>
              {canEdit(item) && !item.trashed_at
                ? "Visible to people who can access this item."
                : "Provided by the owner."}
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
                  notify.success("Description saved.");
                })
              }
            >
              Save description
            </Button>
          )}
          <DriveNotice error={action.error} />
          <p className="drive-details-note">
            <Icon name="shield" />
            {item.kind === "folder"
              ? "Sharing a folder grants access to its contents."
              : "Activity and previous versions stay with this file."}
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
        <Dialog.Title className="visually-hidden">File information</Dialog.Title>
        <Dialog.Description className="visually-hidden">
          Details, activity, comments and previous file versions.
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
    folder_created: "Created a folder",
    file_created: "Uploaded a file",
    metadata_updated: "Updated file information",
    moved: "Moved this item",
    trashed: "Moved this item to trash",
    restored: "Restored this item",
    content_updated: "Uploaded a new version",
    version_restored: "Restored a previous version",
    version_deleted: "Deleted a previous version",
    permission_granted: "Granted account access",
    permission_revoked: "Removed account access",
    link_created: "Created a public link",
    link_updated: "Updated a public link",
    link_revoked: "Revoked a public link",
    previewed: "Previewed this file",
    downloaded: "Downloaded this file",
    public_download: "Accessed a file through a public link",
    comment_created: "Added a comment",
    comment_updated: "Edited a comment",
    comment_resolved: "Changed comment resolution",
    comment_deleted: "Deleted a comment",
    copied: "Copied this item",
    ownership_transferred: "Transferred ownership",
    access_requested: "Requested access",
    access_approved: "Approved an access request",
    access_denied: "Declined an access request",
  };
  return (
    <div className="drive-activity">
      <DriveState loading={events.loading} error={events.error} retry={events.reload} />
      {!events.loading && !events.error && !events.items.length && (
        <p className="drive-muted">No activity yet.</p>
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
              {event.actor_name || (event.link_id ? "Public link visitor" : "Workspace account")}
            </strong>
            <p>{labels[event.action] || event.action.replaceAll("_", " ")}</p>
            <time dateTime={new Date(event.created_at * 1000).toISOString()}>
              {driveDate(event.created_at, true)}
            </time>
          </div>
        </div>
      ))}
      {events.next && (
        <Button size="sm" disabled={events.more} onClick={() => void events.loadMore()}>
          {events.more ? "Loading…" : "Load earlier activity"}
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
        label="Comment filter"
        options={[
          { value: "all", label: "All comments" },
          { value: "open", label: "Open threads" },
          { value: "resolved", label: "Resolved threads" },
        ]}
        onChange={setFilter}
      />
      <DriveState loading={comments.loading} error={comments.error} retry={comments.reload} />
      {!comments.loading && !roots.length && (
        <div className="drive-panel-empty">
          <Icon name="mail" width="28" height="28" />
          <p>No comments here yet.</p>
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
                  <strong>{comment.author_name || "Workspace account"}</strong>
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
                      Reply
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
                      {comment.resolved ? "Reopen" : "Resolve"}
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
                        Edit
                      </Button>
                      <DriveIconButton
                        icon="trash"
                        label="Delete comment"
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
                      Resolved
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
          Load more comments
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
              {edit ? "Edit comment" : parent ? "Reply to thread" : "Add a comment"}
            </Field.Label>
            <Textarea
              rows={3}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={5000}
              required
              placeholder="Write a comment…"
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
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={action.busy || !body.trim()}
            >
              {edit ? "Save" : "Post"}
            </Button>
          </div>
        </form>
      )}
      {!canComment(item) && (
        <p className="drive-muted">You need commenter access to join the conversation.</p>
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
          Upload new version
        </Button>
      )}
      <p className="drive-muted">Previous versions use your storage quota.</p>
      <DriveState loading={versions.loading} error={versions.error} retry={versions.reload} />
      {versions.items.map((version) => (
        <div className="drive-version" key={version.id}>
          <Icon name="file" />
          <div>
            <strong>{version.current ? "Current version" : "Previous version"}</strong>
            <span>
              {driveDate(version.created_at, true)} · {formatBytes(version.size)}
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
                Download
              </Button>
              {!version.current && canEdit(item) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirm({ version, deleting: false })}
                >
                  Restore
                </Button>
              )}
              {!version.current && item.effective_role === "owner" && canEdit(item) && (
                <DriveIconButton
                  icon="trash"
                  label="Delete previous version"
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
          Load more versions
        </Button>
      )}
      <DriveNotice error={action.error} />
      {confirm && (
        <DriveConfirmDialog
          title={confirm.deleting ? "Delete this version?" : "Restore this version?"}
          description={
            confirm.deleting
              ? "This previous file version will be permanently deleted."
              : "This version becomes the current file content. The existing version is kept in history."
          }
          confirm={confirm.deleting ? "Delete version" : "Restore version"}
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
            notify.success(confirm.deleting ? "Version deleted." : "Version restored.");
          }}
        />
      )}
    </div>
  );
}
