import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogPopup, Button, CheckboxControl, CheckboxLabel, Icon, useNotifications } from "./ui";
import { ApiError, api, errorMessage } from "../lib/api";
import { useAccess } from "./console-access";
import { LoadingSkeleton } from "./loading-skeleton";
import "./console-shared.css";

export const adminDate = (timestamp: number | null) => timestamp === null ? "Never" : new Date(timestamp * 1000).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
export function ConsolePageHeader({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return <header className="account-page-header console-page-header"><div><h1>{title}</h1><p>{description}</p></div>{children}</header>;
}
export function Notice({ error }: { error?: string }) {
  return error && <p className="account-notice" data-error role="alert"><Icon name="info" />{error}</p>;
}
export function Check({ children, checked, onChange, disabled }: { children: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <CheckboxLabel className="console-check"><CheckboxControl checked={checked} onCheckedChange={onChange} disabled={disabled} /><span>{children}</span></CheckboxLabel>;
}
export function useResource<T>(path: string | null) {
  const access = useAccess();
  const [state, setState] = useState<{ path?: string | null; data: T | null; loading: boolean; error: string }>({ data: null, loading: true, error: "" });
  useEffect(() => {
    const controller = new AbortController(); setState({ path, data: null, error: "", loading: !!path });
    if (!path) return;
    void api<T>(path, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setState({ path, data, loading: false, error: "" });
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        setState({ path, data: null, loading: false, error: errorMessage(failure) });
        if (failure instanceof ApiError && failure.status === 403) access.refresh();
      }
    });
    return () => controller.abort();
  }, [path, access.refresh]);
  const current = state.path === path ? state : { data: null, loading: !!path, error: "" };
  return { ...current, update: (data: T) => setState({ path, data, loading: false, error: "" }) };
}
export function ResourceState({ loading, error, kind = "section", label = "Loading…", rows = 3 }: { loading: boolean; error: string; kind?: "section" | "list" | "form"; label?: string; rows?: number }) {
  return loading ? <LoadingSkeleton kind={kind} label={label} rows={rows} /> : <Notice error={error} />;
}
export function Confirm({ open, title, description, children, className, label, onClose, onConfirm, destructive = false, theme }: { open: boolean; title: string; description: ReactNode; children?: ReactNode; className?: string; label: string; onClose: () => void; onConfirm: () => Promise<void>; destructive?: boolean; theme?: "neutral" }) {
  const access = useAccess(), notify = useNotifications(), running = useRef(false);
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (running.current) return;
    running.current = true; setBusy(true);
    try { await onConfirm(); onClose(); }
    catch (failure) { notify.error(errorMessage(failure)); if (failure instanceof ApiError && failure.status === 403) access.refresh(); }
    finally { running.current = false; setBusy(false); }
  }
  return <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next && !running.current) onClose(); }}><AlertDialogPopup className={className} data-ui-theme={theme}>
    <AlertDialog.Title>{title}</AlertDialog.Title><AlertDialog.Description render={<div />}>{description}</AlertDialog.Description>
    {children}
    <div className="account-actions"><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant={destructive ? "danger" : "primary"} disabled={busy} onClick={() => { void confirm(); }}>{busy ? "Saving…" : label}</Button></div>
  </AlertDialogPopup></AlertDialog.Root>;
}
