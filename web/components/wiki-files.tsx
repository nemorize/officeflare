import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { FileReference } from "../../shared/file-block";
import type { WikiPage } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { driveSize, formatBytes, type DriveItem } from "../lib/drive";
import { EditorFilesProvider } from "./editor-file";
import { DriveFilePicker } from "./drive-file-picker";
import { useAccess } from "./console-access";
import { useWiki } from "./wiki-context";
import { WikiDialog } from "./wiki-controls";
import { WorkspaceNotice } from "./workspace-dialog";
import { LoadingSkeleton } from "./loading-skeleton";
import { Button, Icon, Tabs } from "./ui";

interface PageAsset {
  id: string;
  filename: string;
  byte_size: number;
  content_type: string;
}
const BrowseFiles = createContext<() => void>(() => {});
export const useWikiFiles = () => useContext(BrowseFiles);

export function WikiFiles({ page, children }: { page: WikiPage; children: ReactNode }) {
  const navigate = useNavigate(),
    [mode, setMode] = useState<"insert" | "browse" | null>(null),
    resolver = useRef<((file: FileReference | null) => void) | null>(null);
  const choose = useCallback(
    () =>
      new Promise<FileReference | null>((resolve) => {
        resolver.current?.(null);
        resolver.current = resolve;
        setMode("insert");
      }),
    [],
  );
  const close = useCallback(() => {
    resolver.current?.(null);
    resolver.current = null;
    setMode(null);
  }, []);
  useEffect(
    () => () => {
      resolver.current?.(null);
    },
    [],
  );
  const open = useCallback(
    async (file: FileReference) => {
      if (file.source === "drive") {
        await api(`/api/drive/items/${encodeURIComponent(file.id)}`);
        navigate(`/drive/items/${encodeURIComponent(file.id)}`);
        return;
      }
      const blob = await api<Blob>(
        `/api/wiki/pages/${page.id}/assets/${encodeURIComponent(file.id)}`,
        { response: "blob" },
      );
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    [page.id, navigate],
  );
  const actions = useMemo(() => ({ choose, open }), [choose, open]);
  return (
    <BrowseFiles value={() => setMode("browse")}>
      <EditorFilesProvider actions={actions}>
        {children}
        {mode && (
          <FileDialog
            page={page}
            browsing={mode === "browse"}
            onClose={close}
            openFile={open}
            onChoose={(file) => {
              resolver.current?.(file);
              resolver.current = null;
              setMode(null);
            }}
          />
        )}
      </EditorFilesProvider>
    </BrowseFiles>
  );
}

function FileDialog({
  page,
  browsing,
  onClose,
  onChoose,
  openFile,
}: {
  page: WikiPage;
  browsing: boolean;
  onClose: () => void;
  onChoose: (file: FileReference) => void;
  openFile: (file: FileReference) => Promise<void>;
}) {
  const wiki = useWiki(),
    access = useAccess(),
    canUpload = page.role >= 3 && wiki.can("assets.upload"),
    canDrive = access.permissions.includes("drive.access");
  const [tab, setTab] = useState(browsing ? "page" : canUpload ? "upload" : "page"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [assets, setAssets] = useState<PageAsset[]>([]),
    [loading, setLoading] = useState(true);
  const input = useRef<HTMLInputElement>(null),
    running = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ assets: PageAsset[] }>(`/api/wiki/pages/${page.id}/assets`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setAssets(data.assets);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page.id]);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const upload = (file: File) =>
    void run(async () => {
      const { asset } = await api<{ asset: PageAsset }>(
        `/api/wiki/pages/${page.id}/assets?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file },
      );
      onChoose({
        source: "upload",
        id: asset.id,
        name: asset.filename,
        size: asset.byte_size,
        contentType: asset.content_type,
      });
    });
  const fromDrive = (item: DriveItem) =>
    void run(async () => {
      const { item: current } = await api<{ item: DriveItem }>(`/api/drive/items/${item.id}`);
      if (current.kind !== "file" || !current.current_version_id) {
        setError(t("editorFiles.unavailable"));
        return;
      }
      onChoose({
        source: "drive",
        id: current.id,
        name: current.name,
        size: driveSize(current),
        contentType:
          current.current_version?.content_type ??
          current.content_type ??
          "application/octet-stream",
      });
    });
  const pageFiles = (
    <div className="wiki-file-list">
      {loading && <LoadingSkeleton kind="list" rows={3} />}
      {assets.map((asset) => (
        <Button
          key={asset.id}
          variant="ghost"
          disabled={busy}
          onClick={() => {
            const file: FileReference = {
              source: "upload",
              id: asset.id,
              name: asset.filename,
              size: asset.byte_size,
              contentType: asset.content_type,
            };
            if (browsing) void run(() => openFile(file));
            else onChoose(file);
          }}
        >
          <Icon name="file" />
          <span>{asset.filename}</span>
          <small>{formatBytes(asset.byte_size)}</small>
        </Button>
      ))}
      {!loading && !assets.length && <p>{t("editorFiles.noFiles")}</p>}
    </div>
  );
  return (
    <WikiDialog
      open
      wide
      busy={busy}
      title={t(browsing ? "wiki.attachments" : "editorFiles.attachFile")}
      onClose={onClose}
    >
      {browsing ? (
        pageFiles
      ) : (
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            setTab(String(value));
            setError("");
          }}
        >
          <Tabs.List aria-label={t("editorFiles.source")}>
            <Tabs.Tab value="upload" disabled={busy || !canUpload}>
              {t("editorFiles.upload")}
            </Tabs.Tab>
            {canDrive && (
              <Tabs.Tab value="drive" disabled={busy}>
                {t("editorFiles.drive")}
              </Tabs.Tab>
            )}
            <Tabs.Tab value="page" disabled={busy}>
              {t("editorFiles.pageFiles")}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="upload">
            <div className="wiki-file-upload">
              <Button
                variant="primary"
                disabled={busy || !canUpload}
                onClick={() => input.current?.click()}
              >
                <Icon name="upload" />
                {t("editorFiles.chooseFile")}
              </Button>
              <input
                ref={input}
                type="file"
                hidden
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file);
                  event.target.value = "";
                }}
              />
              <p>{t("editorFiles.uploadLimit")}</p>
            </div>
          </Tabs.Panel>
          <Tabs.Panel value="drive">
            <p className="wiki-muted">{t("editorFiles.driveAccess")}</p>
            {canDrive && tab === "drive" && <DriveFilePicker busy={busy} onChoose={fromDrive} />}
          </Tabs.Panel>
          <Tabs.Panel value="page">{pageFiles}</Tabs.Panel>
        </Tabs.Root>
      )}
      <WorkspaceNotice error={error} />
      <div className="wiki-dialog-actions">
        <Button disabled={busy} onClick={onClose}>
          {t(browsing ? "common.done" : "common.cancel")}
        </Button>
      </div>
    </WikiDialog>
  );
}
