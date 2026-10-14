import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, CheckboxControl, Dialog, DialogPopup, Field, Fieldset, Form, Icon, Input, SelectControl, Textarea, type InputProps, type CheckboxControlProps, type TextareaProps } from "./ui";
import { api, ApiError } from "../lib/api";
import { mailFailure } from "../lib/mail";
import { useAccess } from "./console-access";
import { useMailCache } from "./mail-resource-context";
import { LoadingSkeleton } from "./loading-skeleton";
export function useMailResource<T>(path: string | null, revision = 0, poll = false) {
  const access = useAccess(), cache = useMailCache();
  const subscribe = useCallback((listener: () => void) => cache.subscribe(path, listener), [cache, path]);
  const snapshot = useCallback(() => cache.snapshot(path), [cache, path]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const previous = useRef({ cache, path, revision });
  const reload = useCallback(() => { if (path) cache.invalidate(path); }, [cache, path]);
  useEffect(() => {
    if (path) {
      if (previous.current.cache === cache && previous.current.path === path && previous.current.revision !== revision) cache.revalidate(path, revision);
      else void cache.load(path);
    }
    previous.current = { cache, path, revision };
  }, [cache, path, revision]);
  useEffect(() => {
    if (!poll || !path) return;
    const timer = setInterval(() => { if (!document.hidden) void cache.load(path, true); }, 5000);
    return () => clearInterval(timer);
  }, [cache, path, poll]);
  useEffect(() => {
    if (state.error instanceof ApiError && state.error.status === 403) {
      access.refresh();
      window.dispatchEvent(new Event("officeflare:mail-access-changed"));
    }
  }, [state.error, access.refresh]);
  return { path, data: state.data as T | null, loading: state.loading, error: state.error ? mailFailure(state.error) : "", reload };
}
export function useMailAction() {
  const access = useAccess(), running = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    if (running.current) return false;
    running.current = true; setBusy(true); setError("");
    try { await action(); return true; }
    catch (failure) { setError(mailFailure(failure)); if (failure instanceof ApiError && failure.status === 403) { access.refresh(); window.dispatchEvent(new Event("officeflare:mail-access-changed")); } return false; }
    finally { running.current = false; setBusy(false); }
  };
  return { busy, error, setError, run };
}
export function MailNotice({ error }: { error: string }) { return error ? <p className="mail-notice" role="alert">{error}</p> : null; }
export function MailState({ loading, error, retry, kind = "section" }: { loading: boolean; error: string; retry?: () => void; kind?: "section" | "list" | "reader" | "form" }) { return error ? <div><MailNotice error={error} />{retry && <Button onClick={retry}>Try again</Button>}</div> : loading ? <LoadingSkeleton kind={kind} label="Loading mail…" rows={kind === "list" ? 6 : 3} /> : null; }
export function MailField({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <Field.Root className={`mail-field ${className}`}><Field.Label>{label}</Field.Label>{children}{hint && <Field.Description>{hint}</Field.Description>}</Field.Root>;
}
export const MailForm = Form;
export const MailFieldset = Fieldset.Root;
export { useWorkspaceMobile as useMailMobile } from "../lib/workspace-responsive";
interface MailSelectOption { value: string; label: ReactNode; disabled?: boolean; }
export function MailSelect({ options, value = "", onValueChange, className = "", ...props }: {
  options: MailSelectOption[]; value?: string; onValueChange: (value: string) => void;
  className?: string; disabled?: boolean; required?: boolean; "aria-label"?: string; variant?: "outline" | "integrated";
}) {
  return <SelectControl className={`mail-select ${className}`} options={options} value={value} onValueChange={onValueChange} {...props} />;
}
export function MailCheckbox(props: CheckboxControlProps) {
  return <CheckboxControl {...props} />;
}
export function MailTextarea(props: TextareaProps) {
  return <Textarea {...props} />;
}
export function MailFileInput({ onChange, multiple, disabled, ...props }: Omit<React.ComponentProps<"input">, "type" | "value" | "defaultValue">) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="mail-file-input"><Input {...props} ref={input} type="file" hidden multiple={multiple} disabled={disabled} onChange={onChange} /><Button disabled={disabled} onClick={() => input.current?.click()}><Icon name="file" />{multiple ? "Choose files" : "Choose file"}</Button></div>;
}
export function MailInput({ label, hint, fieldClassName, ...props }: Omit<InputProps, "onChange"> & { onChange?: React.ChangeEventHandler<HTMLInputElement>; label: string; hint?: string; fieldClassName?: string }) {
  const id = useId();
  const dateInput = props.type === "date" || props.type === "datetime-local";
  return <MailField label={label} hint={hint} className={fieldClassName}><Input id={id} {...props} onInput={dateInput ? (event) => { props.onInput?.(event); props.onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>); } : props.onInput} /></MailField>;
}
export function MailModal({ open, title, description, children, onClose, busy, wide }: { open: boolean; title: string; description?: ReactNode; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}><DialogPopup className={`mail-modal${wide ? " mail-modal-wide" : ""}`}>
    <div className="mail-modal-heading"><Dialog.Title>{title}</Dialog.Title><Button size="icon" variant="ghost" aria-label="Close dialog" disabled={busy} onClick={onClose}><Icon name="close" /></Button></div>
    <Dialog.Description>{description ?? ""}</Dialog.Description>{children}
  </DialogPopup></Dialog.Root>;
}
export function MailSection({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) { return <section className="mail-section"><header><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>{children}</section>; }
export function MailPageHeader({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) { return <header className="mail-page-heading"><div><h1>{title}</h1><p>{description}</p></div>{children}</header>; }
