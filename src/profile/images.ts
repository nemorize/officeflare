import { t } from "../../shared/i18n/index.ts";
import { invalid } from "../auth/input";

export const profileImageLimit = 2 * 1024 * 1024;
export const profileImagePrefix = (userId: string) => `profiles/${encodeURIComponent(userId)}/`;

export function inspectProfileImage(bytes: Uint8Array, mime: string) {
  if (!bytes.length || bytes.length > profileImageLimit)
    invalid(t("profileImages.profileImagesMustBeAtMost2Mb"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  let width = 0,
    height = 0,
    extension = "";
  if (
    mime === "image/png" &&
    bytes.length >= 45 &&
    bytes
      .subarray(0, 8)
      .every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]) &&
    view.getUint32(8) === 13 &&
    text(12, 16) === "IHDR" &&
    text(bytes.length - 8, bytes.length - 4) === "IEND"
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
    extension = "png";
  } else if (
    mime === "image/webp" &&
    bytes.length >= 30 &&
    text(0, 4) === "RIFF" &&
    text(8, 12) === "WEBP" &&
    view.getUint32(4, true) + 8 === bytes.length
  ) {
    const kind = text(12, 16);
    if (kind === "VP8X") {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (kind === "VP8L" && bytes[20] === 0x2f) {
      const dimensions = view.getUint32(21, true);
      width = (dimensions & 0x3fff) + 1;
      height = ((dimensions >>> 14) & 0x3fff) + 1;
    } else if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
    extension = "webp";
  } else if (
    mime === "image/jpeg" &&
    bytes.length >= 12 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if (marker !== undefined && [0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += size;
    }
    extension = "jpg";
  }
  if (!extension || width < 1 || height < 1 || width > 4096 || height > 4096)
    invalid(t("profileImages.uploadAValidPngJpegOrWebpImageUp"));
  return { width, height, extension, mime };
}
