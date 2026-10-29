import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Button, Dialog, DialogPopup, Form, Icon, Slider, useNotifications } from "@/components/ui";
import { errorMessage } from "../lib/api";
import { photoCrop, profilePhotoSize, zoomPhotoCrop, type PhotoView } from "../lib/profile-image";

const previewSize = 512,
  cropSize = 360;
const initialView: PhotoView = { zoom: 1, x: 0, y: 0 };
type Point = { x: number; y: number };
type Gesture =
  | { kind: "drag"; origin: Point; view: PhotoView; scale: number }
  | {
      kind: "pinch";
      origin: Point;
      anchor: Point;
      distance: number;
      view: PhotoView;
      scale: number;
    };
const clamp = (value: number) => Math.min(1, Math.max(-1, value));

export function ProfileImageEditor({
  file,
  onClose,
  onSave,
}: {
  file: File | null;
  onClose: () => void;
  onSave: (photo: Blob) => Promise<void>;
}) {
  const notify = useNotifications();
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const viewRef = useRef(initialView);
  const inFlight = useRef(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState(initialView);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function updateView(next: PhotoView) {
    viewRef.current = next;
    setView(next);
  }
  function clearGesture() {
    pointers.current.clear();
    gesture.current = null;
    setDragging(false);
  }

  useEffect(() => {
    setImage(null);
    updateView(initialView);
    setError("");
    clearGesture();
    if (!file) return;
    setLoading(true);
    let cancelled = false;
    const url = URL.createObjectURL(file),
      source = new Image();
    source.onload = () => {
      if (cancelled) return;
      if (
        !source.naturalWidth ||
        !source.naturalHeight ||
        source.naturalWidth > 8192 ||
        source.naturalHeight > 8192
      )
        setError("Choose an image up to 8192 × 8192 pixels.");
      else setImage(source);
      setLoading(false);
    };
    source.onerror = () => {
      if (!cancelled) {
        setError("This image could not be opened. Choose a valid PNG, JPEG or WebP file.");
        setLoading(false);
      }
    };
    source.src = url;
    return () => {
      cancelled = true;
      source.onload = null;
      source.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!image || !context) return;
    const crop = photoCrop(
      image.naturalWidth,
      image.naturalHeight,
      view.zoom,
      view.x,
      view.y,
      cropSize,
    );
    const inset = (previewSize - cropSize) / 2;
    context.fillStyle = "#202124";
    context.fillRect(0, 0, previewSize, previewSize);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, inset + crop.left, inset + crop.top, crop.width, crop.height);
  }, [image, view]);

  useEffect(() => {
    const target = canvas.current;
    if (!target || !image || busy) return;
    let nativeGesture: PhotoView | null = null;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (pointers.current.size || nativeGesture) return;
      const bounds = target.getBoundingClientRect(),
        scale = previewSize / bounds.width;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      updateView(
        zoomPhotoCrop(
          image.naturalWidth,
          image.naturalHeight,
          viewRef.current,
          viewRef.current.zoom * Math.exp(-delta * 0.002),
          {
            size: cropSize,
            anchorX: (event.clientX - bounds.left - bounds.width / 2) * scale,
            anchorY: (event.clientY - bounds.top - bounds.height / 2) * scale,
          },
        ),
      );
    };
    // Safari trackpad pinches use gesture events; touch pinches use the pointer handlers below.
    const gestureStart = (event: Event) => {
      event.preventDefault();
      nativeGesture = pointers.current.size ? null : viewRef.current;
    };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const scale = (event as Event & { scale: number }).scale;
      if (!nativeGesture || pointers.current.size || !Number.isFinite(scale)) return;
      updateView(
        zoomPhotoCrop(
          image.naturalWidth,
          image.naturalHeight,
          nativeGesture,
          nativeGesture.zoom * scale,
        ),
      );
    };
    const gestureEnd = (event: Event) => {
      event.preventDefault();
      nativeGesture = null;
    };
    target.addEventListener("wheel", wheel, { passive: false });
    target.addEventListener("gesturestart", gestureStart, { passive: false });
    target.addEventListener("gesturechange", gestureChange, { passive: false });
    target.addEventListener("gestureend", gestureEnd, { passive: false });
    return () => {
      target.removeEventListener("wheel", wheel);
      target.removeEventListener("gesturestart", gestureStart);
      target.removeEventListener("gesturechange", gestureChange);
      target.removeEventListener("gestureend", gestureEnd);
    };
  }, [image, busy]);

  function startGesture(target: HTMLCanvasElement) {
    const points = [...pointers.current.values()],
      bounds = target.getBoundingClientRect();
    const scale = previewSize / bounds.width;
    if (points.length >= 2) {
      const [first, second] = points as [Point, Point];
      const origin = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      gesture.current = {
        kind: "pinch",
        origin,
        view: viewRef.current,
        scale,
        distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        anchor: {
          x: (origin.x - bounds.left - bounds.width / 2) * scale,
          y: (origin.y - bounds.top - bounds.height / 2) * scale,
        },
      };
    } else
      gesture.current = points[0]
        ? { kind: "drag", origin: points[0], view: viewRef.current, scale }
        : null;
    setDragging(points.length > 0);
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!pointers.current.has(event.pointerId) || !image || busy) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture.current,
      points = [...pointers.current.values()];
    if (!current) return;
    if (current.kind === "pinch" && points.length >= 2) {
      const [first, second] = points as [Point, Point];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      updateView(
        zoomPhotoCrop(
          image.naturalWidth,
          image.naturalHeight,
          current.view,
          (current.view.zoom * distance) / current.distance,
          {
            size: cropSize,
            anchorX: current.anchor.x,
            anchorY: current.anchor.y,
            deltaX: ((first.x + second.x) / 2 - current.origin.x) * current.scale,
            deltaY: ((first.y + second.y) / 2 - current.origin.y) * current.scale,
          },
        ),
      );
    } else if (current.kind === "drag" && points[0]) {
      const crop = photoCrop(
        image.naturalWidth,
        image.naturalHeight,
        current.view.zoom,
        current.view.x,
        current.view.y,
        cropSize,
      );
      updateView({
        ...current.view,
        x: crop.travelX
          ? clamp(
              current.view.x + ((points[0].x - current.origin.x) * current.scale) / crop.travelX,
            )
          : 0,
        y: crop.travelY
          ? clamp(
              current.view.y + ((points[0].y - current.origin.y) * current.scale) / crop.travelY,
            )
          : 0,
      });
    }
  }

  function endGesture(event: PointerEvent<HTMLCanvasElement>) {
    if (!pointers.current.delete(event.pointerId)) return;
    startGesture(event.currentTarget);
  }

  function zoom(next: number) {
    if (!image || busy) return;
    clearGesture();
    updateView(zoomPhotoCrop(image.naturalWidth, image.naturalHeight, viewRef.current, next));
  }

  function reposition(event: KeyboardEvent<HTMLCanvasElement>) {
    if (!image || busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
      return;
    event.preventDefault();
    const current = viewRef.current,
      crop = photoCrop(
        image.naturalWidth,
        image.naturalHeight,
        current.zoom,
        current.x,
        current.y,
        cropSize,
      );
    const step = event.shiftKey ? 24 : 8;
    updateView({
      ...current,
      x: crop.travelX
        ? clamp(
            current.x +
              (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0) /
                crop.travelX,
          )
        : 0,
      y: crop.travelY
        ? clamp(
            current.y +
              (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) /
                crop.travelY,
          )
        : 0,
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!image || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    clearGesture();
    let uploading = false;
    try {
      const output = document.createElement("canvas");
      output.width = output.height = profilePhotoSize;
      const context = output.getContext("2d");
      if (!context) throw new Error("Unable to crop this image.");
      const current = viewRef.current,
        crop = photoCrop(
          image.naturalWidth,
          image.naturalHeight,
          current.zoom,
          current.x,
          current.y,
        );
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, crop.left, crop.top, crop.width, crop.height);
      const photo = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Unable to resize this image."))),
          "image/webp",
          0.9,
        ),
      );
      uploading = true;
      await onSave(photo);
      onClose();
    } catch (failure) {
      if (uploading) notify.error(errorMessage(failure));
      else setError(failure instanceof Error ? failure.message : "Unable to resize this image.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={file !== null}
      onOpenChange={(open) => {
        if (!open && !inFlight.current) onClose();
      }}
    >
      <DialogPopup padding="none" className="account-photo-dialog">
        <div className="account-photo-dialog-header">
          <div>
            <Dialog.Title>Crop photo</Dialog.Title>
            <Dialog.Description>
              Drag to reposition. Pinch or use the slider to zoom.
            </Dialog.Description>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close photo editor"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </div>
        {loading && (
          <p className="account-photo-message" role="status">
            Opening image…
          </p>
        )}
        {error && (
          <p className="account-photo-message" data-error role="alert">
            {error}
          </p>
        )}
        <Form onSubmit={save} aria-busy={busy}>
          {image && (
            <>
              <div className="account-photo-stage" data-dragging={dragging}>
                <canvas
                  ref={canvas}
                  width={previewSize}
                  height={previewSize}
                  tabIndex={0}
                  role="img"
                  aria-label="Photo preview"
                  onKeyDown={reposition}
                  onPointerDown={(event) => {
                    if (busy || event.button !== 0) return;
                    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                    event.currentTarget.setPointerCapture(event.pointerId);
                    startGesture(event.currentTarget);
                  }}
                  onPointerMove={move}
                  onPointerUp={endGesture}
                  onPointerCancel={endGesture}
                  onLostPointerCapture={endGesture}
                />
                <div
                  className="account-photo-mask"
                  style={{
                    width: `${(cropSize / previewSize) * 100}%`,
                    height: `${(cropSize / previewSize) * 100}%`,
                  }}
                  aria-hidden="true"
                />
              </div>
              <Slider.Root
                className="account-photo-zoom"
                min={1}
                max={3}
                step={0.01}
                value={view.zoom}
                disabled={busy}
                onValueChange={(value) => zoom(Number(value))}
              >
                <div className="account-photo-zoom-label">
                  <Slider.Label>Zoom</Slider.Label>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      clearGesture();
                      updateView(initialView);
                    }}
                  >
                    Reset
                  </Button>
                </div>
                <div className="account-photo-zoom-controls">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Zoom out"
                    disabled={busy || view.zoom <= 1}
                    onClick={() => zoom(viewRef.current.zoom - 0.1)}
                  >
                    <Icon name="minimize" />
                  </Button>
                  <Slider.Control>
                    <Slider.Track>
                      <Slider.Indicator />
                      <Slider.Thumb
                        aria-label="Zoom"
                        aria-valuetext={`${Math.round(view.zoom * 100)}%`}
                      />
                    </Slider.Track>
                  </Slider.Control>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Zoom in"
                    disabled={busy || view.zoom >= 3}
                    onClick={() => zoom(viewRef.current.zoom + 0.1)}
                  >
                    <Icon name="plus" />
                  </Button>
                </div>
              </Slider.Root>
            </>
          )}
          <div className="account-photo-footer">
            <Button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!image || busy}>
              {busy ? "Saving…" : "Save photo"}
            </Button>
          </div>
        </Form>
      </DialogPopup>
    </Dialog.Root>
  );
}
