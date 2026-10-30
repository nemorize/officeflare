import { t } from "../../shared/i18n/index.ts";
export const profilePhotoSize = 512;
export const profilePhotoFileLimit = 10 * 1024 * 1024;
export interface PhotoView {
  zoom: number;
  x: number;
  y: number;
}

export function photoCrop(
  width: number,
  height: number,
  zoom: number,
  x: number,
  y: number,
  size = profilePhotoSize,
) {
  if (width <= 0 || height <= 0) throw new Error(t("libProfileImage.theImageHasInvalidDimensions"));
  const scale = Math.max(size / width, size / height) * Math.min(3, Math.max(1, zoom));
  const scaledWidth = width * scale,
    scaledHeight = height * scale;
  const travelX = (scaledWidth - size) / 2,
    travelY = (scaledHeight - size) / 2;
  return {
    width: scaledWidth,
    height: scaledHeight,
    travelX,
    travelY,
    left: -travelX + Math.min(1, Math.max(-1, x)) * travelX,
    top: -travelY + Math.min(1, Math.max(-1, y)) * travelY,
  };
}

export function zoomPhotoCrop(
  width: number,
  height: number,
  view: PhotoView,
  zoom: number,
  options: {
    size?: number;
    anchorX?: number;
    anchorY?: number;
    deltaX?: number;
    deltaY?: number;
  } = {},
): PhotoView {
  const nextZoom = Math.min(3, Math.max(1, zoom));
  const before = photoCrop(width, height, view.zoom, view.x, view.y, options.size);
  const after = photoCrop(width, height, nextZoom, view.x, view.y, options.size);
  const ratio = after.width / before.width;
  const offsetX =
    view.x * before.travelX * ratio + (options.anchorX ?? 0) * (1 - ratio) + (options.deltaX ?? 0);
  const offsetY =
    view.y * before.travelY * ratio + (options.anchorY ?? 0) * (1 - ratio) + (options.deltaY ?? 0);
  return {
    zoom: nextZoom,
    x: after.travelX ? Math.min(1, Math.max(-1, offsetX / after.travelX)) : 0,
    y: after.travelY ? Math.min(1, Math.max(-1, offsetY / after.travelY)) : 0,
  };
}
