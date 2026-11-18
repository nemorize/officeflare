import { getLocale, t } from "../../shared/i18n/index.ts";
import { DRIVE_PREVIEW_LIMIT } from "../../shared/drive-preview.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Dialog, DialogPopup, Icon, useNotifications } from "./ui";
import { api } from "../lib/api";
import { driveSize, fileKind, formatBytes, itemPreviewSource, type DriveItem } from "../lib/drive";
import type { DriveViewerEvent, DriveViewerInput } from "../lib/drive-viewer-protocol";
import { DriveFileIcon, DriveIconButton, DriveNotice, driveFailure } from "./drive-controls";

export type DriveContentLoader = (path: string, signal: AbortSignal) => Promise<Response>;
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
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
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
    if (failure instanceof DOMException && failure.name === "AbortError") return;
    throw failure;
  }
}
export function DrivePreview({
  item,
  onClose,
  onShare,
  canDownload = true,
  canPreview = canDownload,
  loader = privateDriveContent,
  basePath = `/api/drive/items/${item.id}`,
}: {
  item: DriveItem;
  onClose: () => void;
  onShare?: () => void;
  canDownload?: boolean;
  canPreview?: boolean;
  loader?: DriveContentLoader;
  basePath?: string;
}) {
  const notify = useNotifications(),
    source = itemPreviewSource(item),
    format = source?.format,
    endpoint = source?.endpoint,
    version = item.current_version?.id ?? item.current_version_id;
  const frame = useRef<HTMLIFrameElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  const [file, setFile] = useState<File | null>(null),
    [loading, setLoading] = useState(!!format && canPreview),
    [viewerLoading, setViewerLoading] = useState(false),
    [error, setError] = useState(""),
    [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFile(null);
    setError("");
    setViewerLoading(false);
    setLoading(!!format && canPreview);
    if (format && canPreview)
      void loader(`${basePath}/${endpoint}`, controller.signal)
        .then(async (response) => {
          if (Number(response.headers.get("Content-Length")) > DRIVE_PREVIEW_LIMIT) {
            void response.body?.cancel().catch(() => {});
            throw new Error(t("componentsDrivePreview.thisFileIsLargerThanThe20MbPreview"));
          }
          const blob = await response.blob();
          controller.signal.throwIfAborted();
          if (blob.size > DRIVE_PREVIEW_LIMIT)
            throw new Error(t("componentsDrivePreview.thisFileIsLargerThanThe20MbPreview"));
          setViewerLoading(true);
          setFile(new File([blob], item.name, { type: blob.type }));
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setError(driveFailure(failure));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    return () => controller.abort();
  }, [basePath, version, format, endpoint, item.name, canPreview, loader]);

  useLayoutEffect(() => {
    if (!file || !format) return;
    const origin = window.location.origin;
    const message: DriveViewerInput = {
      kind: "drive-viewer:open",
      file,
      format,
      locale: getLocale(),
      theme: document.documentElement.dataset.colorScheme === "dark" ? "dark" : "light",
      noSearchMatches: t("componentsDrivePreview.noSearchMatches"),
    };
    const timeout = setTimeout(() => {
      setViewerLoading(false);
      setError(t("componentsDrivePreview.couldNotPreviewFile"));
    }, 45_000);
    function receive(event: MessageEvent<DriveViewerEvent>) {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      switch (event.data?.kind) {
        case "drive-viewer:ready":
          frame.current?.contentWindow?.postMessage(message, origin);
          break;
        case "drive-viewer:loaded":
          clearTimeout(timeout);
          setViewerLoading(false);
          break;
        case "drive-viewer:error":
          clearTimeout(timeout);
          setViewerLoading(false);
          setError(
            t(
              event.data.encrypted
                ? "componentsDrivePreview.filePasswordProtected"
                : "componentsDrivePreview.couldNotPreviewFile",
            ),
          );
          break;
        case "drive-viewer:close":
          close.current();
          break;
      }
    }
    window.addEventListener("message", receive);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
    };
  }, [file, format]);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup
        padding="none"
        data-ui-theme="neutral"
        className="drive-preview"
        viewportProps={{ className: "drive-preview-viewport" }}
      >
        <header>
          <div>
            <DriveFileIcon item={item} />
            <div>
              <Dialog.Title>{item.name}</Dialog.Title>
              <Dialog.Description>
                {fileKind(item).label}
                {t("componentsDrivePreview.text")}
                {formatBytes(driveSize(item))}
              </Dialog.Description>
            </div>
          </div>
          <div>
            {onShare && (
              <Button mobileIcon aria-label={t("componentsDrivePreview.share")} onClick={onShare}>
                <Icon name="users" />
                <span>{t("componentsDrivePreview.share")}</span>
              </Button>
            )}
            {canDownload && (
              <Button
                mobileIcon
                aria-label={t("componentsDrivePreview.download")}
                disabled={downloading}
                onClick={() => {
                  setDownloading(true);
                  void downloadDriveItem(item, `${basePath}/content`, loader)
                    .catch((failure) => notify.error(driveFailure(failure)))
                    .finally(() => setDownloading(false));
                }}
              >
                <Icon name="download" />
                <span>
                  {downloading
                    ? t("componentsDrivePreview.downloading")
                    : t("componentsDrivePreview.download")}
                </span>
              </Button>
            )}
            <DriveIconButton
              icon="close"
              label={t("componentsDrivePreview.closePreview")}
              onClick={onClose}
            />
          </div>
        </header>
        <div className={`drive-preview-body${file && !error ? " drive-preview-viewer-body" : ""}`}>
          {error ? (
            <DriveNotice error={error} />
          ) : file && !loading ? (
            <>
              <iframe
                ref={frame}
                className="drive-preview-viewer"
                title={item.name}
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
                src="/drive-viewer.html"
              />
              {viewerLoading && (
                <div className="drive-preview-viewer-loading" role="status">
                  <span className="drive-spinner" />
                  <p>{t("componentsDrivePreview.preparingPreview")}</p>
                </div>
              )}
            </>
          ) : loading ? (
            <div className="drive-state" role="status">
              <span className="drive-spinner" />
              <p>{t("componentsDrivePreview.preparingPreview")}</p>
            </div>
          ) : (
            <div className="drive-state">
              <DriveFileIcon item={item} large />
              <h2>
                {canDownload
                  ? t("componentsDrivePreview.noPreviewAvailable")
                  : t("componentsDrivePreview.previewAndDownloadsDisabled")}
              </h2>
              <p>
                {!canDownload
                  ? t("componentsDrivePreview.theOwnerHasSharedFileInformationOnly")
                  : driveSize(item) > DRIVE_PREVIEW_LIMIT
                    ? t("componentsDrivePreview.thisFileIsLargerThanThe20MbPreview")
                    : t("componentsDrivePreview.downloadThisFileToOpenItOnYourDevice")}
              </p>
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog.Root>
  );
}
