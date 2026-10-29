import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button, Dialog, DialogPopup, Field, Input, type IconProps } from "./ui";
import { MailIconButton } from "./mail-controls";
import { calendarApi, calendarFailure } from "../lib/calendar";

// Share the same tooltip, target size and focus treatment as Mail's toolbar.
export const CalendarIconButton = MailIconButton;
export function CalendarField({
  label,
  hint,
  children,
  ...props
}: ComponentProps<typeof Input> & { label: string; hint?: string; children?: ReactNode }) {
  const id = useId();
  return (
    <Field.Root className="calendar-field">
      <Field.Label htmlFor={children ? undefined : id}>{label}</Field.Label>
      {children ?? <Input id={id} {...props} />}
      {hint && <Field.Description>{hint}</Field.Description>}
    </Field.Root>
  );
}
export function CalendarNotice({ error }: { error: string }) {
  return error ? (
    <p className="calendar-notice" role="alert">
      {error}
    </p>
  ) : null;
}
export function CalendarModal({
  title,
  description,
  children,
  onClose,
  busy = false,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup data-ui-theme="neutral" className={`calendar-modal ${className}`}>
        <div className="calendar-modal-heading">
          <Dialog.Title>{title}</Dialog.Title>
          <CalendarIconButton icon="close" label="Close dialog" onClick={onClose} disabled={busy} />
        </div>
        <Dialog.Description
          className={description ? "calendar-modal-description" : "visually-hidden"}
        >
          {description ?? title}
        </Dialog.Description>
        {children}
      </DialogPopup>
    </Dialog.Root>
  );
}
export function useCalendarResource<T>(path: string | null, revision = 0) {
  const [state, setState] = useState<{
    path: string | null;
    data: T | null;
    loading: boolean;
    error: string;
  }>({ path: null, data: null, loading: false, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    setState((old) => ({
      path,
      data: old.path === path ? old.data : null,
      loading: !!path,
      error: "",
    }));
    if (path)
      void calendarApi<T>(path, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setState({ path, data, loading: false, error: "" });
        })
        .catch((failure) => {
          if (!controller.signal.aborted)
            setState({ path, data: null, loading: false, error: calendarFailure(failure) });
        });
    return () => controller.abort();
  }, [path, revision]);
  return state.path === path ? state : { path, data: null, loading: !!path, error: "" };
}
export function useCalendarAction() {
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
      setError(calendarFailure(failure));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
