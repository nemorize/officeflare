import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Dialog, DialogPopup, Icon, useNotifications } from "./ui";
import { api } from "../lib/api";
import {
  driveSize,
  fileKind,
  formatBytes,
  previewKind,
  type DriveItem,
} from "../lib/drive";
import {
  DriveFileIcon,
  DriveIconButton,
  DriveNotice,
  driveFailure,
} from "./drive-controls";

const DrivePdfPreview = lazy(() => import("./drive-pdf-preview"));

export type DriveContentLoader = (
  path: string,
  signal: AbortSignal,
) => Promise<Response>;
export const privateDriveContent: DriveContentLoader = (path, signal) =>
  api<Response>(path, { response: "response", signal });
export async function downloadDriveItem(
  item: DriveItem,
  path = `/api/drive/items/${item.id}/content`,
  loader: DriveContentLoader = privateDriveContent,
) {
  const controller = new AbortController();
  type SavePicker = (options: {
    suggestedName: string;
  }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>;
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker })
    .showSaveFilePicker;
  let writable: WritableStream<Uint8Array> | null = null;
  try {
    // Open the picker before awaiting network I/O, while the click still has user activation.
    if (picker && driveSize(item) > 100 * 1024 * 1024)
      writable = await picker
        .call(window, { suggestedName: item.name })
        .then((handle) => handle.createWritable());
    const response = await loader(path, controller.signal);
    if (writable && response.body) {
      await response.body.pipeTo(writable);
      writable = null;
      return;
    }
    const blob = await response.blob(),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = item.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (failure) {
    if (writable) await writable.abort().catch(() => {});
    if (failure instanceof DOMException && failure.name === "AbortError")
      return;
    throw failure;
  }
}
export function DrivePreview({
  item,
  onClose,
  onShare,
  canDownload = true,
  loader = privateDriveContent,
  basePath = `/api/drive/items/${item.id}`,
}: {
  item: DriveItem;
  onClose: () => void;
  onShare?: () => void;
  canDownload?: boolean;
  loader?: DriveContentLoader;
  basePath?: string;
}) {
  const notify = useNotifications(),
    kind = previewKind(item);
  const [content, setContent] = useState<{ url?: string; text?: string }>({}),
    [loading, setLoading] = useState(!!kind && canDownload),
    [error, setError] = useState(""),
    [downloading, setDownloading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setContent({});
    setError("");
    setLoading(!!kind && canDownload);
    if (kind && canDownload)
      void loader(
        `${basePath}/${kind === "text" && !["text/plain"].includes(item.current_version?.content_type ?? item.content_type ?? "") ? "content" : "preview"}`,
        controller.signal,
      )
        .then(async (response) => {
          if (kind === "text") {
            const text = await response.text();
            if (!controller.signal.aborted) setContent({ text });
          } else {
            url = URL.createObjectURL(await response.blob());
            if (!controller.signal.aborted) setContent({ url });
            else URL.revokeObjectURL(url);
          }
          if (!controller.signal.aborted) setLoading(false);
        })
        .catch((failure) => {
          if (!controller.signal.aborted) {
            setError(driveFailure(failure));
            setLoading(false);
          }
        });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.id, basePath, kind, canDownload, loader]);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup padding="none" data-ui-theme="neutral"
        className="drive-preview"
        viewportProps={{ className: "drive-preview-viewport" }}
      >
        <header>
          <div>
            <DriveFileIcon item={item} />
            <div>
              <Dialog.Title>{item.name}</Dialog.Title>
              <Dialog.Description>
                {fileKind(item).label} · {formatBytes(driveSize(item))}
              </Dialog.Description>
            </div>
          </div>
          <div>
            {onShare && (
              <Button mobileIcon aria-label="Share" onClick={onShare}>
                <Icon name="users" />
                <span>Share</span>
              </Button>
            )}
            {canDownload && (
              <Button mobileIcon aria-label="Download"
                disabled={downloading}
                onClick={() => {
                  setDownloading(true);
                  void downloadDriveItem(item, `${basePath}/content`, loader)
                    .catch((failure) => notify.error(driveFailure(failure)))
                    .finally(() => setDownloading(false));
                }}
              >
                <Icon name="download" />
                <span>{downloading ? "Downloading…" : "Download"}</span>
              </Button>
            )}
            <DriveIconButton
              icon="close"
              label="Close preview"
              onClick={onClose}
            />
          </div>
        </header>
        <div
          className={`drive-preview-body${kind === "text" ? " drive-preview-text-body" : kind === "pdf" ? " drive-preview-pdf-body" : ""}`}
        >
          {loading ? (
            <div className="drive-state" role="status">
              <span className="drive-spinner" />
              <p>Preparing preview…</p>
            </div>
          ) : error ? (
            <DriveNotice error={error} />
          ) : content.text !== undefined ? (
            <pre className="drive-preview-text">{content.text}</pre>
          ) : content.url && kind === "image" ? (
            <img src={content.url} alt={item.name} />
          ) : content.url && kind === "pdf" ? (
            <Suspense
              fallback={
                <div className="drive-state" role="status">
                  Preparing PDF preview…
                </div>
              }
            >
              <DrivePdfPreview url={content.url} name={item.name} />
            </Suspense>
          ) : (
            <div className="drive-state">
              <DriveFileIcon item={item} large />
              <h2>
                {canDownload
                  ? "No preview available"
                  : "Preview and downloads disabled"}
              </h2>
              <p>
                {!canDownload
                  ? "The owner has shared file information only."
                  : driveSize(item) > 20 * 1024 * 1024
                    ? "This file is larger than the 20 MB preview limit."
                    : "Download this file to open it on your device."}
              </p>
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog.Root>
  );
}
