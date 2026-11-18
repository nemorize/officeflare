import { decodeFileViewerTextBuffer } from "@file-viewer/core/headless";

export async function prepareDriveViewerFile(file: File, format: string, locale: string) {
  if (locale !== "ko" || (format !== "txt" && format !== "md")) return file;
  const bytes = await file.arrayBuffer();
  if (decodeFileViewerTextBuffer(bytes).encoding.startsWith("utf-")) return file;
  try {
    const text = new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
    if (/[가-힣]/.test(text)) return new File([text], file.name, { type: file.type });
  } catch {
    // Let the viewer apply its normal detection for other source encodings.
  }
  return file;
}
