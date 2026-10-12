import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Button,
  CheckboxControl,
  type CheckboxControlProps,
  Dialog,
  DialogPopup,
  Field,
  Icon,
  Input,
  SelectControl,
  Tooltip,
  TooltipPopup,
  type IconProps,
} from "./ui";
import { api, ApiError, errorMessage } from "../lib/api";
import type { DriveItem } from "../lib/drive";
import { fileKind } from "../lib/drive";
import "../routes/drive.css";

export const driveFailure = (failure: unknown) =>
  failure instanceof ApiError && failure.status === 409
    ? "This item changed. Refresh and try again."
    : failure instanceof Error &&
        !(failure instanceof ApiError) &&
        failure.name !== "TypeError"
      ? failure.message
      : errorMessage(failure);
export function useDriveResource<T>(path: string | null, revision = 0) {
  const [retry, setRetry] = useState(0),
    [state, setState] = useState<{
      path: string | null;
      data: T | null;
      loading: boolean;
      error: string;
    }>({ path: null, data: null, loading: false, error: "" });
  const reload = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState((old) => ({
      path,
      data: old.path === path ? old.data : null,
      loading: !!path,
      error: "",
    }));
    if (path)
      void api<T>(path, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted)
            setState({ path, data, loading: false, error: "" });
        })
        .catch((failure) => {
          if (!controller.signal.aborted)
            setState({
              path,
              data: null,
              loading: false,
              error: driveFailure(failure),
            });
        });
    return () => controller.abort();
  }, [path, revision, retry]);
  return {
    ...(state.path === path
      ? state
      : { path, data: null, loading: !!path, error: "" }),
    reload,
  };
}
export function useDriveAction() {
  const running = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (failure) {
      setError(driveFailure(failure));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
export function DriveCheckbox(props: CheckboxControlProps) {
  return <CheckboxControl {...props} />;
}
export function DriveIconButton({
  icon,
  label,
  ...props
}: ComponentProps<typeof Button> & { icon: IconProps["name"]; label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<Button size="icon" variant="ghost" {...props} />}
        aria-label={label}
      >
        <Icon name={icon} />
      </Tooltip.Trigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip.Root>
  );
}
export function DriveFileIcon({
  item,
  large = false,
}: {
  item: DriveItem;
  large?: boolean;
}) {
  const kind = fileKind(item);
  return (
    <span
      className={`drive-file-icon drive-tone-${kind.tone}${large ? " drive-file-icon-large" : ""}`}
    >
      <Icon name={kind.icon} width={large ? 42 : 20} height={large ? 42 : 20} />
    </span>
  );
}
export function DriveSelect({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  disabled?: boolean;
}) {
  return <SelectControl theme="neutral" value={value} onValueChange={onChange} options={options} aria-label={label} disabled={disabled} className="drive-select" />;
}
export function DriveField({
  label,
  hint,
  ...props
}: ComponentProps<typeof Input> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <Field.Root className="drive-field">
      <Field.Label htmlFor={id}>{label}</Field.Label>
      <Input {...props} id={id} />
      {hint && <Field.Description>{hint}</Field.Description>}
    </Field.Root>
  );
}
export function DriveModal({
  title,
  description,
  onClose,
  busy = false,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup
        data-ui-theme="neutral"
        className={`drive-modal${wide ? " drive-modal-wide" : ""}`}
        viewportProps={{ className: "drive-modal-viewport" }}
      >
        <div className="drive-modal-heading">
          <Dialog.Title>{title}</Dialog.Title>
          <DriveIconButton
            icon="close"
            label="Close dialog"
            onClick={onClose}
            disabled={busy}
          />
        </div>
        <Dialog.Description>{description ?? ""}</Dialog.Description>
        {children}
      </DialogPopup>
    </Dialog.Root>
  );
}
export function DriveNotice({ error }: { error: string }) {
  return error ? (
    <div className="drive-notice" role="alert">
      <Icon name="info" />
      <span>{error}</span>
    </div>
  ) : null;
}
export function DriveState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry?: () => void;
}) {
  return error ? (
    <div className="drive-state">
      <Icon name="info" width="32" height="32" />
      <h2>Unable to load this view</h2>
      <p role="alert">{error}</p>
      {retry && <Button onClick={retry}>Try again</Button>}
    </div>
  ) : loading ? (
    <div className="drive-state" role="status">
      <span className="drive-spinner" />
      <p>Loading your files…</p>
    </div>
  ) : null;
}
export function useDriveCollection<T>(
  path: string | null,
  key: string,
  revision = 0,
  cursorParam = "cursor",
) {
  const [retry, setRetry] = useState(0),
    [state, setState] = useState<{
      path: string | null;
      items: T[];
      next: string | null;
      loading: boolean;
      more: boolean;
      error: string;
    }>({
      path: null,
      items: [],
      next: null,
      loading: false,
      more: false,
      error: "",
    });
  const generation = useRef(0),
    controllerRef = useRef<AbortController | null>(null);
  const reload = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController(),
      generationId = ++generation.current;
    controllerRef.current = controller;
    setState({
      path,
      items: [],
      next: null,
      loading: !!path,
      more: false,
      error: "",
    });
    if (path)
      void api<Record<string, unknown>>(path, { signal: controller.signal })
        .then((data) => {
          if (generation.current === generationId && !controller.signal.aborted)
            setState({
              path,
              items: data[key] as T[],
              next: data.next_cursor as string | null,
              loading: false,
              more: false,
              error: "",
            });
        })
        .catch((failure) => {
          if (!controller.signal.aborted)
            setState({
              path,
              items: [],
              next: null,
              loading: false,
              more: false,
              error: driveFailure(failure),
            });
        });
    return () => controller.abort();
  }, [path, key, revision, retry]);
  const loadMore = async () => {
    if (!path || !state.next || state.more || state.loading) return;
    const generationId = generation.current;
    setState((old) => ({ ...old, more: true, error: "" }));
    try {
      const data = await api<Record<string, unknown>>(
        `${path}${path.includes("?") ? "&" : "?"}${cursorParam}=${encodeURIComponent(state.next)}`,
        { signal: controllerRef.current?.signal },
      );
      if (generation.current === generationId)
        setState((old) => ({
          ...old,
          items: [...old.items, ...(data[key] as T[])],
          next: data.next_cursor as string | null,
          more: false,
        }));
    } catch (failure) {
      if (
        generation.current === generationId &&
        !controllerRef.current?.signal.aborted
      )
        setState((old) => ({
          ...old,
          more: false,
          error: driveFailure(failure),
        }));
    }
  };
  return {
    ...(state.path === path
      ? state
      : {
          path,
          items: [] as T[],
          next: null,
          loading: !!path,
          more: false,
          error: "",
        }),
    reload,
    loadMore,
  };
}

const smallDriveQuery = "(max-width:900px)";
function subscribeDriveViewport(listener: () => void) {
  const query = window.matchMedia(smallDriveQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
export function useDriveSmallScreen() {
  return useSyncExternalStore(
    subscribeDriveViewport,
    () => window.matchMedia(smallDriveQuery).matches,
    () => false,
  );
}
