import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogPopup, Button, Checkbox, Icon, useNotifications } from "./ui";
import { ApiError, api, errorMessage } from "../lib/api";
import { useAccess } from "./console-access";
import "./console-shared.css";

export const adminDate = (timestamp: number | null) => timestamp === null ? "Never" : new Date(timestamp * 1000).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
export function Notice({ error }: { error?: string }) {
  return error && <p className="account-notice" data-error role="alert"><Icon name="info" />{error}</p>;
}
export function Check({ children, checked, onChange, disabled }: { children: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="console-check"><Checkbox.Root checked={checked} onCheckedChange={onChange} disabled={disabled}><Checkbox.Indicator><Icon name="check" width="12" height="12" /></Checkbox.Indicator></Checkbox.Root><span>{children}</span></label>;
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
export function ResourceState({ loading, error }: { loading: boolean; error: string }) {
  return loading ? <p className="account-loading" role="status">Loading…</p> : <Notice error={error} />;
}
export function Confirm({ open, title, description, label, onClose, onConfirm, destructive = false }: { open: boolean; title: string; description: ReactNode; label: string; onClose: () => void; onConfirm: () => Promise<void>; destructive?: boolean }) {
  const access = useAccess(), notify = useNotifications(), running = useRef(false);
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (running.current) return;
    running.current = true; setBusy(true);
    try { await onConfirm(); onClose(); }
    catch (failure) { notify.error(errorMessage(failure)); if (failure instanceof ApiError && failure.status === 403) access.refresh(); }
    finally { running.current = false; setBusy(false); }
  }
  return <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next && !running.current) onClose(); }}><AlertDialogPopup>
    <AlertDialog.Title>{title}</AlertDialog.Title><AlertDialog.Description>{description}</AlertDialog.Description>
    <div className="account-actions"><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant={destructive ? "danger" : "primary"} disabled={busy} onClick={() => { void confirm(); }}>{busy ? "Saving…" : label}</Button></div>
  </AlertDialogPopup></AlertDialog.Root>;
}
