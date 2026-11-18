import type { FileEntry } from "@zip.js/zip.js";

const MAX_EXPANDED_BYTES = 80 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export async function openDriveDocumentZip(bytes: Uint8Array) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  const { Uint8ArrayReader, ZipReader } = await import("@zip.js/zip.js");
  const archive = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  const files = new Map<string, FileEntry>();
  let size = 0;
  try {
    for await (const entry of archive.getEntriesGenerator()) {
      if (entry.directory) continue;
      if (entry.encrypted || /(?:\.iwpv2|(?:^|\/)encryptedpackage)$/i.test(entry.filename))
        throw new Error("Encrypted document");
      size += entry.uncompressedSize;
      if (files.size >= MAX_ENTRIES || size > MAX_EXPANDED_BYTES || files.has(entry.filename))
        throw new Error("Invalid or oversized document archive");
      files.set(entry.filename, entry);
    }
  } finally {
    await archive.close();
  }
  return files;
}

export async function readDriveDocumentEntry(entry: FileEntry | undefined, limit: number) {
  if (!entry || entry.uncompressedSize > limit) return;
  const { Uint8ArrayWriter } = await import("@zip.js/zip.js");
  return entry.getData(new Uint8ArrayWriter(), { checkSignature: true, useWebWorkers: false });
}
