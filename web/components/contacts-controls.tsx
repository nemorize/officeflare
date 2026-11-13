import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { t } from "../../shared/i18n/index.ts";
import { api, ApiError, errorMessage } from "../lib/api";
import { useAccess } from "./console-access";
import { Button, Dialog, DialogPopup, Field, Icon, Input } from "./ui";
import { WorkspaceIconButton as ContactIconButton } from "./workspace-controls";

export { ContactIconButton };
export function ContactField({
  label,
  children,
  ...props
}: ComponentProps<typeof Input> & { label: string; children?: ReactNode }) {
  const id = useId();
  return (
    <Field.Root className="contact-field">
      <Field.Label htmlFor={children ? undefined : id}>{label}</Field.Label>
      {children ?? <Input id={id} {...props} />}
    </Field.Root>
  );
}
export function ContactModal({
  title,
  children,
  onClose,
  busy = false,
  className = "",
}: {
  title: string;
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
      <DialogPopup
        className={`contacts-dialog ${className}`}
        padding="none"
        data-ui-theme="neutral"
        viewportProps={{ className: "contacts-dialog-viewport" }}
      >
        <header>
          <Dialog.Title>{title}</Dialog.Title>
          <ContactIconButton
            icon="close"
            label={t("common.close")}
            disabled={busy}
            onClick={onClose}
          />
        </header>
        <Dialog.Description className="visually-hidden">{title}</Dialog.Description>
        {children}
      </DialogPopup>
    </Dialog.Root>
  );
}
export function ContactNotice({ error, retry }: { error: string; retry?: () => void }) {
  return error ? (
    <div className="contacts-notice" role="alert">
      <Icon name="info" />
      <span>{error}</span>
      {retry && (
        <Button variant="ghost" size="sm" onClick={retry}>
          {t("contacts.retry")}
        </Button>
      )}
    </div>
  ) : null;
}
export function useContactResource<T>(path: string | null, revision = 0) {
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
      void api<T>(path, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setState({ path, data, loading: false, error: "" });
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted)
            setState({ path, data: null, loading: false, error: errorMessage(failure) });
        });
    return () => controller.abort();
  }, [path, revision]);
  return state.path === path ? state : { path, data: null, loading: !!path, error: "" };
}
export function useContactAction() {
  const running = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    access = useAccess();
  const run = async (action: () => Promise<void>) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && failure.status === 403) access.refresh();
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}
