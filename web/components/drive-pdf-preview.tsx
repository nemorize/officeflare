import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import { DriveNotice } from "./drive-controls";
import {
  GlobalWorkerOptions,
  getDocument,
  version,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default function DrivePdfPreview({ url, name }: { url: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    pageArea = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [width, setWidth] = useState(800),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [text, setText] = useState("");
  useEffect(() => {
    const area = pageArea.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(180, Math.min(900, entry!.contentRect.width - 32))),
    );
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    setDocument(null);
    setPage(1);
    setBusy(true);
    setError("");
    const assetRoot = `/pdfjs/${version}/`;
    // Canvas rendering does not create PDF script, form, or external link handlers.
    const task = getDocument({
      url,
      cMapUrl: `${assetRoot}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetRoot}standard_fonts/`,
      wasmUrl: `${assetRoot}wasm/`,
      iccUrl: `${assetRoot}iccs/`,
      maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 64_000_000,
      enableXfa: false,
    });
    void task.promise
      .then((pdf) => {
        if (active) setDocument(pdf);
      })
      .catch((failure: Error) => {
        if (active) {
          setError(
            failure.name === "PasswordException"
              ? t("componentsDrivePdfPreview.thisPdfIsPasswordProtectedDownloadItToOpen")
              : t("componentsDrivePdfPreview.thisPdfCouldNotBePreviewedDownloadItTo"),
          );
          setBusy(false);
        }
      });
    return () => {
      active = false;
      void task.destroy().catch(() => {});
    };
  }, [url]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true,
      render: RenderTask | undefined;
    const target = canvas.current;
    setBusy(true);
    setError("");
    setText("");
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (!active) return;
        const initial = pdfPage.getViewport({ scale: 1 }),
          scale = width / initial.width,
          viewport = pdfPage.getViewport({ scale }),
          pixels = Math.min(
            window.devicePixelRatio || 1,
            2,
            Math.sqrt(4_000_000 / (viewport.width * viewport.height)),
          ),
          context = target.getContext("2d");
        if (!context) throw new Error(t("componentsDrivePdfPreview.canvasUnavailable"));
        target.width = Math.max(1, Math.floor(viewport.width * pixels));
        target.height = Math.max(1, Math.floor(viewport.height * pixels));
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        render = pdfPage.render({
          canvas: target,
          canvasContext: context,
          viewport,
          transform: pixels === 1 ? undefined : [pixels, 0, 0, pixels, 0, 0],
        });
        await render.promise;
        if (!active) return;
        setBusy(false);
        const content = await pdfPage.getTextContent();
        if (active) setText(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
      })
      .catch((failure: Error) => {
        if (active && failure.name !== "RenderingCancelledException") {
          setError(t("componentsDrivePdfPreview.thisPdfPageCouldNotBePreviewedYouCan"));
          setBusy(false);
        }
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [document, page, width]);
  return (
    <section
      className="drive-pdf-preview"
      aria-label={t("componentsDrivePdfPreview.pdfPreviewOf", { name: name })}
    >
      <div
        className="drive-pdf-controls"
        role="group"
        aria-label={t("componentsDrivePdfPreview.pdfPages")}
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={!document || page === 1}
          onClick={() => setPage((value) => value - 1)}
        >
          {t("common.previous")}
        </Button>
        <span aria-live="polite">
          <LocalizedMessage
            id="componentsDrivePdfPreview.pageOf"
            values={{ page: page, value2: document?.numPages ?? "…" }}
          />
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!document || page === document.numPages}
          onClick={() => setPage((value) => value + 1)}
        >
          {t("common.next")}
        </Button>
      </div>
      <div className="drive-pdf-page-area" ref={pageArea}>
        {error ? (
          <DriveNotice error={error} />
        ) : (
          <>
            {busy && (
              <div className="drive-pdf-loading" role="status">
                <span className="drive-spinner" />
                <span>{t("componentsDrivePdfPreview.renderingPage")}</span>
              </div>
            )}
            <canvas
              ref={canvas}
              role="img"
              aria-label={t("componentsDrivePdfPreview.page", { name: name, page: page })}
              aria-describedby="drive-pdf-page-text"
              hidden={!document || !!error}
            />
            <p id="drive-pdf-page-text" className="drive-pdf-accessible-text">
              {text}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
