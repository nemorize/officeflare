import { DEFAULT_RENDERER_DEFINITIONS, getExtension } from "@file-viewer/core/headless";

export const DRIVE_PREVIEW_LIMIT = 20 * 1024 * 1024;

// These renderer groups are also the source for the Vite asset plan.
export const driveViewerRenderers = [
  "archive",
  "binary",
  "bpmn",
  "chm",
  "data",
  "design",
  "dicom",
  "drawing",
  "ebook",
  "eda",
  "email",
  "geo",
  "hangul",
  "image",
  "iwork",
  "media",
  "mindmap",
  "model",
  "ofd",
  "pdf",
  "presentation",
  "signature",
  "spreadsheet",
  "text",
  "word",
  "wordperfect",
] as const;

const formats = new Set<string>(
  DEFAULT_RENDERER_DEFINITIONS.filter(({ id }) => id !== "cad" && id !== "typst").flatMap(
    ({ extensions }) => extensions,
  ),
);

export const compatibleOpenDocumentFormats = new Set([
  "odg",
  "ott",
  "ots",
  "otp",
  "otg",
  "fodt",
  "fodp",
  "fodg",
  "sxw",
  "sxc",
  "sxi",
  "sxd",
  "stw",
  "stc",
  "sti",
  "std",
]);
const aliases = new Map([
  ["mdown", "md"],
  ["mkd", "md"],
  ["text", "txt"],
  ["keynote", "key"],
  ["pps", "ppt"],
  // Playlist and PlantUML diagrams can reference a network service. Show their source.
  ["m3u8", "txt"],
  ["puml", "txt"],
  ["plantuml", "txt"],
  ["typ", "txt"],
  ["typst", "txt"],
]);
const inlineTypes = new Map([
  ["application/pdf", "pdf"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["text/plain", "txt"],
]);
const typeFormats = new Map([
  ["text/markdown", "md"],
  ["text/x-markdown", "md"],
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
  ["application/json", "json"],
  ["application/xml", "xml"],
  ["text/xml", "xml"],
  ["text/csv", "csv"],
  ["text/tab-separated-values", "tsv"],
  ["image/svg+xml", "svg"],
  ["image/tiff", "tiff"],
  ["image/bmp", "bmp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["image/jxl", "jxl"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/ogg", "ogg"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["application/zip", "zip"],
  ["application/x-7z-compressed", "7z"],
  ["application/vnd.rar", "rar"],
  ["application/x-rar-compressed", "rar"],
  ["application/gzip", "gz"],
  ["application/epub+zip", "epub"],
  ["message/rfc822", "eml"],
  ["application/vnd.ms-outlook", "msg"],
  ["application/msword", "doc"],
  ["application/vnd.ms-powerpoint", "ppt"],
  ["application/mspowerpoint", "ppt"],
  ["application/vnd.ms-excel", "xls"],
  ["application/rtf", "rtf"],
  ["text/rtf", "rtf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.template", "dotx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.slideshow", "ppsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.template", "potx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.template", "xltx"],
  ["application/vnd.ms-word.document.macroenabled.12", "docm"],
  ["application/vnd.ms-word.template.macroenabled.12", "dotm"],
  ["application/vnd.ms-powerpoint.presentation.macroenabled.12", "pptm"],
  ["application/vnd.ms-powerpoint.slideshow.macroenabled.12", "ppsm"],
  ["application/vnd.ms-powerpoint.template.macroenabled.12", "potm"],
  ["application/vnd.ms-excel.sheet.macroenabled.12", "xlsm"],
  ["application/vnd.ms-excel.sheet.binary.macroenabled.12", "xlsb"],
  ["application/vnd.ms-excel.template.macroenabled.12", "xltm"],
  ["application/vnd.apple.pages", "pages"],
  ["application/x-iwork-pages-sffpages", "pages"],
  ["application/vnd.apple.numbers", "numbers"],
  ["application/x-iwork-numbers-sffnumbers", "numbers"],
  ["application/vnd.apple.keynote", "key"],
  ["application/x-iwork-keynote-sffkey", "key"],
  ["application/x-hwp", "hwp"],
  ["application/hwp", "hwp"],
  ["application/vnd.hancom.hwp", "hwp"],
  ["application/vnd.hancom.hwpx", "hwpx"],
  ["application/vnd.hancom.hanword", "hwp"],
  ["application/haansofthwp", "hwp"],
  ["application/vnd.oasis.opendocument.text", "odt"],
  ["application/vnd.oasis.opendocument.text-template", "ott"],
  ["application/vnd.oasis.opendocument.presentation", "odp"],
  ["application/vnd.oasis.opendocument.presentation-template", "otp"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
  ["application/vnd.oasis.opendocument.spreadsheet-template", "ots"],
  ["application/vnd.oasis.opendocument.graphics", "odg"],
  ["application/vnd.oasis.opendocument.graphics-template", "otg"],
  ["application/vnd.sun.xml.writer", "sxw"],
  ["application/vnd.sun.xml.calc", "sxc"],
  ["application/vnd.sun.xml.impress", "sxi"],
  ["application/vnd.sun.xml.draw", "sxd"],
  ["application/vnd.sun.xml.writer.template", "stw"],
  ["application/vnd.sun.xml.calc.template", "stc"],
  ["application/vnd.sun.xml.impress.template", "sti"],
  ["application/vnd.sun.xml.draw.template", "std"],
]);

export function isDrivePreviewFormat(format: string) {
  return formats.has(format) || compatibleOpenDocumentFormats.has(format);
}

export function drivePreviewSource(
  name: string | undefined,
  contentType: string,
): { format: string; endpoint: "preview" | "content"; inline: boolean } | null {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const inline = inlineTypes.get(type);
  if (inline && inline !== "txt") return { format: inline, endpoint: "preview", inline: true };

  const extension = name ? getExtension(name) : "";
  const namedFormat = aliases.get(extension) ?? extension;
  const isHtml = type === "text/html" || type === "application/xhtml+xml";
  const fromType = typeFormats.get(type);
  const format = isHtml
    ? "html"
    : isDrivePreviewFormat(namedFormat)
      ? namedFormat
      : (fromType ?? inline);
  if (format) {
    return {
      format,
      endpoint: format === "html" && !inline ? "content" : "preview",
      inline: !!inline,
    };
  }
  return type.startsWith("text/") ? { format: "txt", endpoint: "content", inline: false } : null;
}
