import { t } from "../../shared/i18n/index.ts";
import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Dialog, DialogPopup, Icon, useNotifications } from "./ui";
import { api } from "../lib/api";
import { driveSize, fileKind, formatBytes, previewKind, type DriveItem } from "../lib/drive";
import { DriveFileIcon, DriveIconButton, DriveNotice, driveFailure } from "./drive-controls";

const DrivePdfPreview = lazy(() => import("./drive-pdf-preview"));

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
    kind = previewKind(item);
  const [content, setContent] = useState<{ url?: string; text?: string }>({}),
    [loading, setLoading] = useState(!!kind && canPreview),
    [error, setError] = useState(""),
    [downloading, setDownloading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setContent({});
    setError("");
    setLoading(!!kind && canPreview);
    if (kind && canPreview)
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
  }, [item.id, basePath, kind, canPreview, loader]);
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
        <div
          className={`drive-preview-body${kind === "text" ? " drive-preview-text-body" : kind === "pdf" ? " drive-preview-pdf-body" : ""}`}
        >
          {loading ? (
            <div className="drive-state" role="status">
              <span className="drive-spinner" />
              <p>{t("componentsDrivePreview.preparingPreview")}</p>
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
                  {t("componentsDrivePreview.preparingPdfPreview")}
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
                  ? t("componentsDrivePreview.noPreviewAvailable")
                  : t("componentsDrivePreview.previewAndDownloadsDisabled")}
              </h2>
              <p>
                {!canDownload
                  ? t("componentsDrivePreview.theOwnerHasSharedFileInformationOnly")
                  : driveSize(item) > 20 * 1024 * 1024
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
