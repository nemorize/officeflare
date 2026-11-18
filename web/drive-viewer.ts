/// <reference types="@file-viewer/vite-plugin/client" />
import { mountViewer, type ViewerController, type ViewerState } from "@file-viewer/core/browser";
import { enableFileViewerMidi } from "@file-viewer/capability-midi";
import { enableFileViewerRtf } from "@file-viewer/capability-rtf";
import "virtual:file-viewer-renderers";
import {
  compatibleOpenDocumentFormats,
  DRIVE_PREVIEW_LIMIT,
  isDrivePreviewFormat,
} from "../shared/drive-preview.ts";
import type { DriveViewerEvent, DriveViewerInput } from "./lib/drive-viewer-protocol.ts";
import { configureDriveViewerMarkdown } from "./lib/drive-viewer-markdown.ts";
import { prepareDriveViewerFile } from "./lib/drive-viewer-text.ts";
import viewerChrome from "./drive-viewer-chrome.css?inline";
import "./drive-viewer.css";

const origin = window.location.origin;
const send = (event: DriveViewerEvent) => window.parent.postMessage(event, origin);
const container = document.getElementById("drive-viewer")!;
const error = (failure: unknown) =>
  send({
    kind: "drive-viewer:error",
    encrypted: /encrypt|password|암호화|암호로/i.test(String(failure)),
  });

async function showCompatibleOpenDocument(file: File) {
  const { openDriveDocumentZip, readDriveDocumentEntry } = await import("./lib/drive-document-zip");
  const { renderCompatibleOpenDocument } = await import("./lib/drive-open-document");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const archive = await openDriveDocumentZip(bytes);
  const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
  const manifest = decode(
    await readDriveDocumentEntry(archive?.get("META-INF/manifest.xml"), 1024 * 1024),
  );
  if (/<(?:[\w.-]+:)?encryption-data\b/i.test(manifest)) throw new Error("Encrypted document");
  const content = archive
    ? await readDriveDocumentEntry(archive.get("content.xml"), 12 * 1024 * 1024)
    : bytes;
  const html = renderCompatibleOpenDocument(decode(content), (text) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
  if (!html) throw new Error("Document body is unavailable");
  container.classList.add("drive-compatible-document");
  container.innerHTML = html;
  send({ kind: "drive-viewer:loaded" });
}

function bindPreviewSearch(
  root: ShadowRoot | HTMLElement,
  viewer: ViewerController,
  noMatches: string,
) {
  const searchInput = () =>
    root.querySelector<HTMLInputElement>('[part~="toolbar"] input[type="search"]');
  function updateSearch(search: ViewerState["search"]) {
    const input = searchInput();
    if (!input?.form) return;
    const { form } = input;
    const active = !!search?.query && search.query === input.value.trim();
    form.toggleAttribute("data-search-active", active);
    form.toggleAttribute("data-search-navigation", active && search.total > 1);
    const clear = form.querySelector<HTMLButtonElement>('[data-viewer-toolbar-key="search-clear"]');
    if (clear) clear.disabled = input.disabled || (!input.value && !search?.query);
    if (active && search.total === 0) {
      const status = form.querySelector('[part~="toolbar-status"]');
      if (status) status.textContent = noMatches;
    }
  }

  root.addEventListener("input", (event) => {
    if (event.target === searchInput()) updateSearch(viewer.getSearchState());
  });
  root.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>(
        '[part~="toolbar"] [role="search"] button',
      );
      if (button?.type === "submit" && button.form) {
        // Run the search handler without asking the sandbox to submit a form.
        event.preventDefault();
        button.form.dispatchEvent(new Event("submit", { cancelable: true }));
      } else if (button?.dataset.viewerToolbarKey === "search-clear") {
        // Set focus before clearing, since Flyfish rebuilds the controls on state changes.
        searchInput()?.focus();
      }
    },
    { capture: true },
  );
  return updateSearch;
}

enableFileViewerRtf();
enableFileViewerMidi();
configureDriveViewerMarkdown();

let viewer: ReturnType<typeof mountViewer> | undefined;
let opened = false;
window.addEventListener("message", async (event: MessageEvent<DriveViewerInput>) => {
  if (opened || event.source !== window.parent || event.origin !== origin) return;
  const { kind, file, format, theme, locale, noSearchMatches } = event.data ?? {};
  if (
    kind !== "drive-viewer:open" ||
    !(file instanceof File) ||
    file.size > DRIVE_PREVIEW_LIMIT ||
    !isDrivePreviewFormat(format)
  )
    return;
  opened = true;
  document.documentElement.lang = locale;
  document.documentElement.dataset.colorScheme = theme;

  try {
    if (compatibleOpenDocumentFormats.has(format)) {
      await showCompatibleOpenDocument(file);
      return;
    }
    viewer = mountViewer(container, { options: { styleIsolation: "shadow" } });
    const root = container.shadowRoot ?? container;
    const style = document.createElement("style");
    style.textContent = viewerChrome;
    root.append(style);
    const updateSearch = bindPreviewSearch(root, viewer, noSearchMatches);
    await viewer.load({
      file: await prepareDriveViewerFile(file, format, locale),
      type: format,
      onStateChange(state) {
        updateSearch(state.search);
        if (state.error) error(state.error);
        else if (state.ready) send({ kind: "drive-viewer:loaded" });
      },
      options: {
        rendererMode: "replace",
        autoRenderers: true,
        theme,
        locale,
        ui: { surfaceBackground: "var(--ui-chrome)" },
        toolbar: {
          download: false,
          print: false,
          exportHtml: false,
          theme: false,
          zoom: format !== "pdf",
          position: "top",
        },
        beforeOperation: ({ operation }) => operation.startsWith("zoom-"),
        ai: false,
        docx: {
          renderAltChunks: false,
          externalLinkPolicy: "block",
          externalResourcePolicy: "block",
        },
        text: { htmlView: "source", toolbar: false },
        archive: {
          cache: false,
          maxArchiveSize: DRIVE_PREVIEW_LIMIT,
          maxEntryPreviewSize: DRIVE_PREVIEW_LIMIT,
          entryActions: { download: false },
        },
        presentation: {
          pptModuleUrl: "/file-viewer/vendor/ppt/dist/pptjs.mjs",
          pptWorkerUrl: "/file-viewer/vendor/ppt/dist/pptjs.worker.js",
          pptCache: false,
        },
        geo: { basemap: false },
        drawing: { preferOfficial: false },
      },
    });
    if (viewer.getState().error) error(viewer.getState().error);
    else send({ kind: "drive-viewer:loaded" });
  } catch (failure) {
    error(failure);
  }
});

document.addEventListener(
  "click",
  (event) => {
    const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    const href = link?.getAttribute("href");
    if (href && !href.startsWith("#")) event.preventDefault();
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented) send({ kind: "drive-viewer:close" });
});
window.addEventListener("pagehide", () => viewer?.destroy(), { once: true });

if (window.parent !== window) send({ kind: "drive-viewer:ready" });
