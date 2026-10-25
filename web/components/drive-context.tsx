import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import {
  Button,
  Icon,
  Menu,
  MenuPopup,
  Progress,
  useNotifications,
} from "./ui";
import { api, ApiError } from "../lib/api";
import { useSharedDriveCache } from "./drive-resource-context";
import { useAccess } from "./console-access";
import {
  useDriveAction,
  useDriveResource,
  DriveField,
  DriveIconButton,
  DriveModal,
  DriveNotice,
  driveFailure,
} from "./drive-controls";
import {
  folderPaths,
  formatBytes,
  uploadDriveFile,
  type DriveItem,
  type DriveQuota,
  type DriveCapabilities,
  type UploadEntry,
} from "../lib/drive";

interface DriveContextValue {
  revision: number;
  refresh: () => void;
  quota: DriveQuota | null;
  capabilities: DriveCapabilities | null;
  can: (action: "create" | "update" | "delete" | "download" | "comment" | "internal_share" | "public_share") => boolean;
  target: { parent: string | null; writable: boolean };
  setTarget: (target: { parent: string | null; writable: boolean }) => void;
  chooseFiles: (folder?: boolean, item?: DriveItem) => void;
  enqueue: (files: File[], parent: string | null, item?: DriveItem) => void;
  newFolder: () => void;
}
const DriveContext = createContext<DriveContextValue | null>(null);
export function useDrive() {
  const value = useContext(DriveContext);
  if (!value) throw new Error("DriveProvider is required");
  return value;
}
export function DriveNewMenu() {
  const drive = useDrive();
  return (
    <Menu.Root>
      <Menu.Trigger
        render={<Button variant="primary" size="lg" className="workspace-create-button drive-new-button" />}
        disabled={!drive.target.writable}
      >
        <Icon name="plus" width="18" height="18" />
        New
        <Icon name="down" width="12" height="12" />
      </Menu.Trigger>
      <MenuPopup data-ui-theme="neutral">
        <Menu.Item onClick={drive.newFolder}>
          <Icon name="folder" />
          New folder
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item onClick={() => drive.chooseFiles()}>
          <Icon name="upload" />
          File upload
        </Menu.Item>
        <Menu.Item onClick={() => drive.chooseFiles(true)}>
          <Icon name="folder" />
          Folder upload
        </Menu.Item>
      </MenuPopup>
    </Menu.Root>
  );
}
export function DriveProvider({ children }: { children: ReactNode }) {
  const location = useLocation(),
    access = useAccess(),
    navigate = useNavigate(),
    notify = useNotifications();
  const [revision, setRevision] = useState(0),
    [target, setTarget] = useState({
      parent: null as string | null,
      writable: true,
    });
  const cache = useSharedDriveCache();
  const refresh = useCallback(() => { cache?.invalidate(); setRevision((value) => value + 1); }, [cache]);
  const active =
    location.pathname.startsWith("/drive") &&
    access.permissions.includes("drive.access");
  const bootstrap = useDriveResource<{ quota: DriveQuota; capabilities: DriveCapabilities }>(active ? "/api/drive/bootstrap" : null, revision);
  const quota = { data: bootstrap.data?.quota ?? null }, capabilities = { data: bootstrap.data?.capabilities ?? null };
  const can: DriveContextValue["can"] = (action) => {
    const value = capabilities.data;
    if (!value || value.account_status === "suspended") return false;
    const keys = { create: "drive.files.create", update: "drive.files.update", delete: "drive.files.delete", download: "drive.files.download", comment: "drive.comments.create", internal_share: "drive.sharing.internal", public_share: "drive.sharing.public" };
    return value.permissions.includes(keys[action]) && (action === "download" || value.account_status === "active" && !value.write_locked) && (action !== "internal_share" || value.internal_sharing_enabled) && (action !== "public_share" || value.public_sharing_enabled);
  };
  const filesInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null),
    replacement = useRef<DriveItem | undefined>(undefined),
    inputParent = useRef<string | null>(null);
  const [folderOpen, setFolderOpen] = useState(false),
    [folderName, setFolderName] = useState(""),
    [folderParent, setFolderParent] = useState<string | null>(null),
    folderAction = useDriveAction();
  const [entries, setEntries] = useState<UploadEntry[]>([]),
    controllers = useRef(new Map<string, AbortController>()),
    live = useRef(true);
  const [collapsed, setCollapsed] = useState(false);
  const update = useCallback((id: string, patch: Partial<UploadEntry>) => {
    if (live.current)
      setEntries((old) =>
        old.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      );
  }, []);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const controller of controllers.current.values()) controller.abort();
    };
  }, []);
  useEffect(() => {
    for (const entry of entries.filter((entry) => entry.state === "queued")) {
      if (controllers.current.size >= 2) break;
      const controller = new AbortController();
      controllers.current.set(entry.id, controller);
      update(entry.id, { state: "uploading", error: "" });
      let session = entry.upload;
      void uploadDriveFile(api, entry, controller.signal, (patch) => {
        if (patch.upload) session = patch.upload;
        update(entry.id, patch);
      })
        .then(() => {
          refresh();
        })
        .catch(async (failure) => {
          if (controller.signal.aborted) {
            if (session && live.current) {
              try {
                const result = await api<{ upload: { status: string } }>(
                  `/api/drive/uploads/${session.id}`,
                );
                if (result.upload.status === "completed") {
                  update(entry.id, { state: "done", sent: entry.file.size });
                  return;
                }
                await api(`/api/drive/uploads/${session.id}`, {
                  method: "DELETE",
                });
              } catch (cleanupFailure) {
                if (
                  !(
                    cleanupFailure instanceof ApiError &&
                    [404, 410].includes(cleanupFailure.status)
                  )
                ) {
                  update(entry.id, {
                    state: "error",
                    error:
                      "Upload could not be cancelled. Retry to check its status.",
                  });
                  return;
                }
              }
            }
            update(entry.id, { state: "cancelled" });
          } else
            update(entry.id, {
              state: "error",
              error: driveFailure(failure),
              ...(failure instanceof ApiError && failure.status === 410
                ? { upload: undefined, sent: 0 }
                : {}),
            });
          refresh();
        })
        .finally(() => {
          controllers.current.delete(entry.id);
          if (live.current) setEntries((old) => [...old]);
        });
    }
  }, [entries, refresh, update]);
  const enqueue = (files: File[], parent: string | null, item?: DriveItem) => {
    if (!can(item ? "update" : "create")) { notify.error("Your role or Drive policy does not allow this upload."); return; }
    const maximum = capabilities.data?.max_file_bytes ?? 0;
    const accepted = files.filter((file) => file.size <= maximum);
    if (accepted.length !== files.length)
      notify.error(`Files must be ${formatBytes(maximum)} or smaller.`);
    if (item && files.length !== 1) {
      notify.error("Choose one file to replace this version.");
      return;
    }
    setEntries((old) => [
      ...old,
      ...accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        parent,
        item,
        state: "queued" as const,
        sent: 0,
      })),
    ]);
    setCollapsed(false);
  };
  const chooseFiles = (folder = false, item?: DriveItem) => {
    if (!can(item ? "update" : "create")) return;
    replacement.current = item;
    inputParent.current = target.parent;
    (folder ? folderInput : filesInput).current?.click();
  };
  const folderUpload = async (files: File[]) => {
    if (!files.length) return;
    const parent = inputParent.current;
    try {
      const folders = new Map<string, string>();
      for (const path of folderPaths(files)) {
        const segments = path.split("/"),
          name = segments.pop()!,
          parentPath = segments.join("/");
        const created = await api<{ item: DriveItem }>("/api/drive/folders", {
          method: "POST",
          body: { name, parent_id: folders.get(parentPath) ?? parent },
        });
        folders.set(path, created.item.id);
      }
      setEntries((old) => [
        ...old,
        ...files.map((file) => ({
          id: crypto.randomUUID(),
          file,
          parent:
            folders.get(
              file.webkitRelativePath.split("/").slice(0, -1).join("/"),
            ) ?? parent,
          state: "queued" as const,
          sent: 0,
        })),
      ]);
      setCollapsed(false);
      refresh();
    } catch (failure) {
      notify.error(driveFailure(failure));
      refresh();
    }
  };
  const cancel = (entry: UploadEntry) => {
    const controller = controllers.current.get(entry.id);
    if (controller) controller.abort();
    else {
      update(entry.id, { state: "cancelled" });
      if (entry.upload)
        void api(`/api/drive/uploads/${entry.upload.id}`, { method: "DELETE" })
          .catch((failure) => notify.error(driveFailure(failure)))
          .finally(refresh);
    }
  };
  const running = entries.filter(
    (entry) => entry.state === "queued" || entry.state === "uploading",
  ).length;
  return (
    <DriveContext.Provider
      value={{
        revision,
        refresh,
        quota: quota.data,
        capabilities: capabilities.data,
        can,
        target: { ...target, writable: target.writable && can("create") },
        setTarget,
        chooseFiles,
        enqueue,
        newFolder: () => {
          if (!can("create")) return;
          setFolderParent(target.parent);
          setFolderName("");
          folderAction.setError("");
          setFolderOpen(true);
        },
      }}
    >
      {children}
      <input
        type="file"
        ref={filesInput}
        multiple
        hidden
        onChange={(event) => {
          enqueue(
            Array.from(event.target.files ?? []),
            inputParent.current,
            replacement.current,
          );
          event.target.value = "";
        }}
      />
      <input
        type="file"
        ref={folderInput}
        multiple
        hidden
        {...{ webkitdirectory: "" }}
        onChange={(event) => {
          void folderUpload(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {folderOpen && (
        <DriveModal
          title="New folder"
          description="Organize your files in a folder."
          busy={folderAction.busy}
          onClose={() => setFolderOpen(false)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void folderAction.run(async () => {
                await api("/api/drive/folders", {
                  method: "POST",
                  body: { name: folderName.trim(), parent_id: folderParent },
                });
                refresh();
                setFolderOpen(false);
                notify.success("Folder created.");
              });
            }}
          >
            <DriveField
              label="Folder name"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              autoFocus
              required
              maxLength={255}
              disabled={folderAction.busy}
            />
            <DriveNotice error={folderAction.error} />
            <div className="drive-modal-actions">
              <Button
                disabled={folderAction.busy}
                onClick={() => setFolderOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={folderAction.busy || !folderName.trim()}
              >
                {folderAction.busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </DriveModal>
      )}
      {!!entries.length && (
        <section data-ui-theme="neutral"
          className={`drive-upload-tray${collapsed ? " is-collapsed" : ""}`}
          aria-label="Uploads"
        >
          <header>
            <span>
              <Icon name="upload" />
              {running
                ? `Uploading ${running} ${running === 1 ? "file" : "files"}`
                : entries.some((entry) => entry.state === "error")
                  ? "Some uploads need attention"
                  : "Uploads complete"}
            </span>
            <div>
              <DriveIconButton
                icon={collapsed ? "expand" : "minimize"}
                label={collapsed ? "Expand uploads" : "Minimize uploads"}
                onClick={() => setCollapsed(!collapsed)}
              />
              <DriveIconButton
                icon="close"
                label="Dismiss completed uploads"
                disabled={!!running}
                onClick={() => setEntries([])}
              />
            </div>
          </header>
          {!collapsed && (
            <div className="drive-upload-entries">
              {entries.map((entry) => (
                <div className="drive-upload-entry" key={entry.id}>
                  <Icon name="file" />
                  <div>
                    <strong title={entry.file.name}>{entry.file.name}</strong>
                    <span>
                      {entry.state === "done"
                        ? "Uploaded"
                        : entry.state === "cancelled"
                          ? "Cancelled"
                          : entry.state === "error"
                            ? entry.error
                            : `${formatBytes(entry.sent)} of ${formatBytes(entry.file.size)}${entry.state === "queued" ? " · Waiting" : ""}`}
                    </span>
                    {entry.state === "uploading" && (
                      <Progress.Root
                        value={
                          entry.file.size
                            ? (entry.sent / entry.file.size) * 100
                            : 100
                        }
                        aria-label={`Uploading ${entry.file.name}`}
                      >
                        <Progress.Track>
                          <Progress.Indicator />
                        </Progress.Track>
                      </Progress.Root>
                    )}
                  </div>
                  {entry.state === "done" ? (
                    <Icon name="check" className="drive-upload-done" />
                  ) : entry.state === "error" ? (
                    <DriveIconButton
                      icon="refresh"
                      label={`Retry ${entry.file.name}`}
                      onClick={() => update(entry.id, { state: "queued" })}
                    />
                  ) : ["queued", "uploading"].includes(entry.state) ? (
                    <DriveIconButton
                      icon="close"
                      label={`Cancel ${entry.file.name}`}
                      onClick={() => cancel(entry)}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {!running && entries.some((entry) => entry.state === "done") && (
            <footer>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("/drive/recent")}
              >
                View recent files
                <Icon name="arrow" />
              </Button>
            </footer>
          )}
        </section>
      )}
    </DriveContext.Provider>
  );
}
