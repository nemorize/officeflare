import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Checkbox, Dialog, DialogPopup, Field, Fieldset, Form, Icon, Input, Meter, Select, SelectPopup } from "./ui";
import { api, ApiError } from "../lib/api";
import { mailFailure } from "../lib/mail";
import { useAccess } from "./console-access";
export function useMailResource<T>(path: string | null, revision = 0, poll = false) {
  const access = useAccess(), [reloadCount, setReloadCount] = useState(0);
  const [state, setState] = useState<{ path: string | null; data: T | null; loading: boolean; error: string }>({ path: null, data: null, loading: false, error: "" });
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    let initialized = false;
    if (!path) { setState({ path, data: null, loading: false, error: "" }); return; }
    const load = async () => {
      if (initialized && poll && document.hidden) { timer = setTimeout(() => { void load(); }, 15_000); return; }
      setState((old) => ({ path, data: old.path === path ? old.data : null, loading: true, error: "" }));
      try { const data = await api<T>(path, { signal: controller.signal }); if (!controller.signal.aborted) setState({ path, data, loading: false, error: "" }); }
      catch (failure) { if (!controller.signal.aborted) { setState((old) => ({ ...old, data: failure instanceof ApiError && [403, 404].includes(failure.status) ? null : old.data, loading: false, error: mailFailure(failure) })); if (failure instanceof ApiError && failure.status === 403) { access.refresh(); window.dispatchEvent(new Event("officeflare:mail-access-changed")); } } }
      initialized = true;
      if (poll && !controller.signal.aborted) timer = setTimeout(() => { void load(); }, 5000);
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [path, revision, reloadCount, poll, access.refresh]);
  const current = state.path === path ? state : { path, data: null, loading: !!path, error: "" };
  return { ...current, reload };
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
export function MailState({ loading, error, retry }: { loading: boolean; error: string; retry?: () => void }) { return error ? <div><MailNotice error={error} />{retry && <Button onClick={retry}>Try again</Button>}</div> : loading ? <p className="mail-empty" role="status">Loading…</p> : null; }
export function MailField({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <Field.Root className={`mail-field ${className}`}><Field.Label>{label}</Field.Label>{children}{hint && <Field.Description>{hint}</Field.Description>}</Field.Root>;
}
export const MailForm = Form;
export const MailFieldset = Fieldset.Root;
const mobileQuery = "(max-width: 760px)";
function subscribeMobile(listener: () => void) {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
export function useMailMobile() {
  return useSyncExternalStore(subscribeMobile, () => window.matchMedia(mobileQuery).matches, () => false);
}
interface MailSelectOption { value: string; label: ReactNode; disabled?: boolean; }
export function MailSelect({ options, value = "", onValueChange, className = "", ...props }: {
  options: MailSelectOption[]; value?: string; onValueChange: (value: string) => void;
  className?: string; disabled?: boolean; required?: boolean; "aria-label"?: string;
}) {
  const { disabled, required, "aria-label": ariaLabel } = props;
  return <Select.Root items={options} value={value} onValueChange={(next) => onValueChange(next ?? "")} disabled={disabled} required={required}>
    <Select.Trigger className={`mail-select ${className}`} aria-label={ariaLabel}><Select.Value /></Select.Trigger>
    <SelectPopup><Select.List>{options.map((option) => <Select.Item key={option.value} value={option.value} disabled={option.disabled}><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator><Icon name="check" width="12" height="12" /></Select.ItemIndicator></Select.Item>)}</Select.List></SelectPopup>
  </Select.Root>;
}
export function MailCheckbox(props: React.ComponentProps<typeof Checkbox.Root>) {
  return <Checkbox.Root {...props}><Checkbox.Indicator><Icon name="check" width="12" height="12" /></Checkbox.Indicator></Checkbox.Root>;
}
export function MailTextarea({ value, disabled, ...props }: React.ComponentProps<"textarea">) {
  return <Field.Control data-ui="input" value={value} disabled={disabled} render={<textarea {...props} />} />;
}
export function MailFileInput({ onChange, multiple, disabled, ...props }: Omit<React.ComponentProps<"input">, "type" | "value" | "defaultValue">) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="mail-file-input"><Input {...props} ref={input} type="file" hidden multiple={multiple} disabled={disabled} onChange={onChange} /><Button disabled={disabled} onClick={() => input.current?.click()}><Icon name="file" />{multiple ? "Choose files" : "Choose file"}</Button></div>;
}
export function MailMeter({ value, max, label }: { value: number; max: number; label: string }) {
  return <Meter.Root value={value} min={0} max={max} aria-label={label}><Meter.Track><Meter.Indicator /></Meter.Track></Meter.Root>;
}
export function MailInput({ label, hint, fieldClassName, ...props }: React.ComponentProps<"input"> & { label: string; hint?: string; fieldClassName?: string }) {
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
