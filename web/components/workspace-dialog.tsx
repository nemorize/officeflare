import { useRef, useState, type ReactNode } from "react";
import { t } from "../../shared/i18n/index.ts";
import { errorMessage } from "../lib/api";
import { AlertDialog, AlertDialogPopup, Button, Dialog, DialogPopup, Icon } from "./ui";
import { WorkspaceIconButton } from "./workspace-controls";
import "./workspace-dialog.css";

export function WorkspaceDialog({
  title,
  description,
  children,
  onClose,
  busy = false,
  wide = false,
  className = "",
  closeLabel = t("common.close"),
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  className?: string;
  closeLabel?: string;
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
        className={`workspace-dialog ${wide ? "workspace-dialog-wide" : ""} ${className}`}
        viewportProps={{ className: "workspace-dialog-viewport" }}
      >
        <div className="workspace-dialog-heading" data-description={!!description}>
          <Dialog.Title>{title}</Dialog.Title>
          <WorkspaceIconButton icon="close" label={closeLabel} onClick={onClose} disabled={busy} />
        </div>
        <Dialog.Description className={description ? undefined : "visually-hidden"}>
          {description ?? title}
        </Dialog.Description>
        {children}
      </DialogPopup>
    </Dialog.Root>
  );
}

export function WorkspaceNotice({ error }: { error: string }) {
  return error ? (
    <div className="workspace-dialog-notice" role="alert">
      <Icon name="info" />
      <span>{error}</span>
    </div>
  ) : null;
}

export function WorkspaceConfirm({
  title,
  description,
  confirm,
  onClose,
  action,
  destructive = false,
  failureMessage = errorMessage,
  workingLabel = t("common.saving"),
}: {
  title: string;
  description: string;
  confirm: string;
  onClose: () => void;
  action: () => Promise<void>;
  destructive?: boolean;
  failureMessage?: (failure: unknown) => string;
  workingLabel?: string;
}) {
  const running = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      onClose();
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !running.current) onClose();
      }}
    >
      <AlertDialogPopup
        data-ui-theme="neutral"
        className="workspace-dialog"
        viewportProps={{ className: "workspace-dialog-viewport" }}
      >
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>{description}</AlertDialog.Description>
        <WorkspaceNotice error={error} />
        <div className="workspace-dialog-actions">
          <Button disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? workingLabel : confirm}
          </Button>
        </div>
      </AlertDialogPopup>
    </AlertDialog.Root>
  );
}
