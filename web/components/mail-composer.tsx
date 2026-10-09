import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { bytes, mailboxPath, MailOperation, parseRecipients, scheduledTime, submissionLabel, type Address, type Attachment, type MailSettings, type MessageDetail, type Submission } from "../lib/mail";
import { useMail } from "./mail-context";
import { MailField, MailInput, MailModal, MailNotice, MailState, useMailAction, useMailResource, MailForm, MailFieldset, MailSelect, MailTextarea, MailFileInput } from "./mail-common";
import { Button, useNotifications } from "./ui";
import { Confirm } from "./console-shared";
function editableHtml(value: string) {
  const doc = new DOMParser().parseFromString(value, "text/html");
  const tags = new Set(["P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "S", "UL", "OL", "LI", "BLOCKQUOTE", "A"]);
  for (const element of [...doc.body.querySelectorAll("*")]) {
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "SVG", "MATH"].includes(element.tagName)) { element.remove(); continue; }
    if (!tags.has(element.tagName)) { element.replaceWith(...element.childNodes); continue; }
    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (href && /^(https?:|mailto:)/i.test(href)) element.setAttribute("href", href);
  }
  return doc.body.innerHTML;
}
export function MailComposer({ mailboxId, draftId, onClose }: { mailboxId: string; draftId?: string; onClose: () => void }) {
  const mail = useMail(), notifications = useNotifications(), path = mailboxPath(mailboxId), action = useMailAction();
  const initial = useMailResource<{ message: MessageDetail }>(draftId ? `${path}/drafts/${draftId}` : null);
  const addresses = useMailResource<{ addresses: Address[] }>(path + "/addresses"), settings = useMailResource<{ settings: MailSettings }>(path + "/settings");
  const [draft, setDraft] = useState<MessageDetail | null>(null), [ready, setReady] = useState(false), [to, setTo] = useState(""), [cc, setCc] = useState(""), [bcc, setBcc] = useState(""), [subject, setSubject] = useState(""), [text, setText] = useState(""), [rich, setRich] = useState(false), [html, setHtml] = useState("");
  const [files, setFiles] = useState<(Attachment & { upload?: boolean })[]>([]), [sender, setSender] = useState(""), [mode, setMode] = useState("send_as"), [schedule, setSchedule] = useState(""), [dirty, setDirty] = useState(false), [discard, setDiscard] = useState(false), [includeCc, setIncludeCc] = useState(false), [unknown, setUnknown] = useState(false);
  const editor = useRef<HTMLDivElement>(null), createOperation = useRef(new MailOperation()), sendOperation = useRef(new MailOperation()), pendingCreate = useRef<object | null>(null), pendingSend = useRef<{ id: string; payload: object } | null>(null), editorHtml = useRef("");
  const pendingEdit = useRef<{ version: number; payload: object; matches: (message: MessageDetail) => boolean } | null>(null);
  const rights = mail.boxes.find((box) => box.id === mailboxId)?.access, canSend = rights?.send_as || rights?.send_on_behalf;
  useEffect(() => {
    if (ready || (draftId ? !initial.data : !settings.data)) return;
    const message = initial.data?.message;
    if (message) { setDraft(message); setTo(message.recipients.filter((r) => r.kind === "to").map((r) => r.email_address).join(", ")); setCc(message.recipients.filter((r) => r.kind === "cc").map((r) => r.email_address).join(", ")); setBcc(message.recipients.filter((r) => r.kind === "bcc").map((r) => r.email_address).join(", ")); setIncludeCc(message.recipients.some((r) => r.kind !== "to")); setSubject(message.subject); setText(message.body.text); const clean = editableHtml(message.body.html); editorHtml.current = clean; setHtml(clean); setRich(!!clean); setFiles(message.attachments); }
    else setText(settings.data!.settings.signature ? `\n\n${settings.data!.settings.signature}` : "");
    setReady(true);
  }, [draftId, initial.data, settings.data, ready]);
  useEffect(() => { if (editor.current && rich) editor.current.innerHTML = editorHtml.current || editableHtml(text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\n", "<br>")); }, [rich, ready]);
  useEffect(() => { const primary = addresses.data?.addresses.find((address) => address.send_enabled && address.is_primary) ?? addresses.data?.addresses.find((address) => address.send_enabled); if (!sender && primary) setSender(primary.id); }, [addresses.data, sender]);
  useEffect(() => { if (!rights?.send_as && rights?.send_on_behalf) setMode("send_on_behalf"); }, [rights?.send_as, rights?.send_on_behalf]);
  useEffect(() => { if (!dirty && !unknown) return; const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent); }, [dirty, unknown]);
  const mark = () => setDirty(true), close = () => { if (dirty || unknown) setDiscard(true); else onClose(); };
  const values = () => {
    const recipients = { to: parseRecipients(to), cc: parseRecipients(cc), bcc: parseRecipients(bcc) };
    if (Object.values(recipients).flat().length > 50) throw new Error("A message can have at most 50 recipients.");
    return { subject, text, html: rich ? html : "", ...recipients, attachment_ids: files.filter((file) => file.upload).map((file) => file.id) };
  };
  async function save(): Promise<MessageDetail> {
    if (!ready) throw new Error("Wait for the draft to finish loading.");
    if (draft && !dirty) return draft;
    const data = values(); let result: { message: MessageDetail };
    if (draft) {
      if (draft.draft?.state !== "editable") throw new Error("This draft has already been submitted. Cancel its pending send before editing.");
      if (pendingEdit.current) {
        const latest = (await api<{ message: MessageDetail }>(`${path}/drafts/${draft.id}`)).message;
        if (latest.draft?.version === pendingEdit.current.version + 1 && pendingEdit.current.matches(latest)) result = { message: latest };
        else if (latest.draft?.version !== pendingEdit.current.version) throw new Error("This draft changed in another request. Copy your changes and reopen the saved draft before continuing.");
        else result = await patchDraft(draft.id);
      } else {
        const expectedFiles = files.map((file) => `${file.filename}:${file.size_bytes}:${file.content_type}`).sort();
        const recipientKey = (entries: { kind: string; email_address: string }[]) => entries.map((entry) => `${entry.kind}:${entry.email_address}`).sort().join("\n");
        const expectedRecipients = recipientKey((["to", "cc", "bcc"] as const).flatMap((kind) => data[kind].map((email_address) => ({ kind, email_address }))));
        pendingEdit.current = { version: draft.draft.version, payload: { ...data, version: draft.draft.version, retained_attachment_ids: files.filter((file) => !file.upload).map((file) => file.id) }, matches: (latest) => latest.subject === data.subject && latest.body.text === data.text && editableHtml(latest.body.html) === editableHtml(data.html) && recipientKey(latest.recipients) === expectedRecipients && JSON.stringify(latest.attachments.map((file) => `${file.filename}:${file.size_bytes}:${file.content_type}`).sort()) === JSON.stringify(expectedFiles) };
        result = await patchDraft(draft.id);
      }
      pendingEdit.current = null;
    } else {
      pendingCreate.current ??= { ...data, include_signature: false };
      try { result = await api(`${path}/drafts`, { method: "POST", body: pendingCreate.current, headers: createOperation.current.headers(pendingCreate.current) }); }
      catch (failure) { setUnknown(true); if (failure instanceof ApiError && failure.status < 500) { pendingCreate.current = null; createOperation.current.complete(); setUnknown(false); } throw failure; }
      createOperation.current.complete(); pendingCreate.current = null;
    }
    setUnknown(false); setDraft(result.message); setFiles(result.message.attachments); setDirty(false); mail.refresh(); return result.message;
  }
  async function patchDraft(id: string): Promise<{ message: MessageDetail }> {
    try { return await api(`${path}/drafts/${id}`, { method: "PATCH", body: pendingEdit.current!.payload }); }
    catch (failure) { setUnknown(true); if (failure instanceof ApiError && failure.status < 500) { pendingEdit.current = null; setUnknown(false); } throw failure; }
  }
  async function send() {
    if (!pendingSend.current) {
      const recipients = values(); if (!recipients.to.length && !recipients.cc.length && !recipients.bcc.length) throw new Error("Add at least one recipient.");
      if (!sender || !canSend) throw new Error("Choose an available sending address. Your mailbox needs send permission.");
      const scheduledAt = scheduledTime(schedule), message = await save();
      pendingSend.current = { id: message.id, payload: { version: message.draft!.version, address_id: sender, send_mode: mode, ...(scheduledAt ? { scheduled_at: scheduledAt } : {}) } };
    }
    const pending = pendingSend.current;
    try {
      const result = await api<{ submission: Submission }>(`${path}/drafts/${pending.id}/submissions`, { method: "POST", body: pending.payload, headers: sendOperation.current.headers(pending.payload) });
      sendOperation.current.complete(); pendingSend.current = null; setUnknown(false); setDirty(false); mail.refresh(); notifications.success(submissionLabel(result.submission.status)); onClose();
    } catch (failure) {
      setUnknown(true);
      if (failure instanceof ApiError && failure.status < 500) { pendingSend.current = null; sendOperation.current.complete(); setUnknown(false); }
      throw failure;
    }
  }
  async function upload(selected: FileList | null) {
    if (!selected?.length) return;
    if (files.length + selected.length > 32) throw new Error("A draft can have at most 32 attachments.");
    for (const file of [...selected]) {
      const maximum = mail.capabilities?.limits.max_upload_bytes ?? 5 * 1024 ** 2;
      if (!file.size || file.size > maximum) throw new Error(`${file.name}: choose a non-empty file up to ${bytes(maximum)}.`);
      const result = await api<{ upload: Attachment }>(path + "/uploads", { method: "POST", body: file, headers: { "X-Filename-Encoded": encodeURIComponent(file.name) }, signal: AbortSignal.timeout(120_000) });
      setFiles((old) => [...old, { ...result.upload, upload: true }]); setDirty(true);
    }
  }
  function format(command: string) { editor.current?.focus(); document.execCommand(command); if (editor.current) { setText(editor.current.innerText); editorHtml.current = editableHtml(editor.current.innerHTML); setHtml(editorHtml.current); mark(); } }
  const locked = action.busy || unknown || !!draft && draft.draft?.state !== "editable";
  return <MailModal open title={draftId ? "Edit draft" : "New message"} description={mail.boxes.find((box) => box.id === mailboxId)?.name} busy={action.busy} onClose={close} wide>
    <MailState loading={!ready} error={initial.error || settings.error} retry={() => { initial.reload(); settings.reload(); }} />
    {ready && <MailForm className="mail-composer" onSubmit={(event) => { event.preventDefault(); void action.run(send); }}>
      <MailFieldset disabled={locked}>
        <div className="mail-form-grid"><MailField label="From"><MailSelect value={sender} onValueChange={(nextValue) => setSender(nextValue)} options={[{ value: "", label: "Select sending address" }, ...(addresses.data?.addresses.filter((address) => address.send_enabled).map((address) => ({ value: address.id, label: address.email_address })) || [])]} /></MailField>
          {rights?.send_as && rights?.send_on_behalf && <MailField label="Send mode"><MailSelect value={mode} onValueChange={(nextValue) => setMode(nextValue)} options={[{ value: "send_as", label: "Send as mailbox" }, { value: "send_on_behalf", label: "Send on behalf of mailbox" }]} /></MailField>}
        </div><MailNotice error={addresses.error} />{addresses.data && !addresses.data.addresses.some((address) => address.send_enabled) && <p className="mail-hint">No sending address is configured. You can save this message as a draft.</p>}
        <MailInput label="To" value={to} inputMode="email" autoComplete="off" placeholder="name@example.com, another@example.com" onChange={(event) => { setTo(event.target.value); mark(); }} />
        {includeCc ? <div className="mail-form-grid"><MailInput label="Cc" value={cc} inputMode="email" autoComplete="off" placeholder="name@example.com, another@example.com" onChange={(event) => { setCc(event.target.value); mark(); }} /><MailInput label="Bcc" value={bcc} inputMode="email" autoComplete="off" placeholder="name@example.com, another@example.com" onChange={(event) => { setBcc(event.target.value); mark(); }} /></div> : <Button size="sm" variant="ghost" onClick={() => setIncludeCc(true)}>Add Cc / Bcc</Button>}
        <MailInput label="Subject" value={subject} maxLength={998} onChange={(event) => { setSubject(event.target.value); mark(); }} />
        <div className="mail-editor-toolbar"><Button variant="ghost" size="sm" onClick={() => { if (rich) { editorHtml.current = ""; setHtml(""); } setRich(!rich); mark(); }}>{rich ? "Plain text" : "Formatting"}</Button></div>
        {rich ? <><div className="mail-format-actions" role="toolbar" aria-label="Message formatting">{([["bold", "Bold"], ["italic", "Italic"], ["underline", "Underline"], ["insertUnorderedList", "Bullet list"], ["removeFormat", "Clear format"]] as const).map(([command, label]) => <Button key={command} size="sm" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => format(command)}>{label}</Button>)}</div><div ref={editor} className="mail-rich-editor" contentEditable={!locked} role="textbox" aria-label="Message body" aria-multiline suppressContentEditableWarning onPaste={(event) => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); }} onInput={() => { if (editor.current) { setText(editor.current.innerText); editorHtml.current = editableHtml(editor.current.innerHTML); setHtml(editorHtml.current); mark(); } }} /></> : <MailField label="Message"><MailTextarea className="mail-compose-text" value={text} maxLength={2 * 1024 ** 2} onChange={(event) => { setText(event.target.value); mark(); }} /></MailField>}
        <div className="mail-attachments">{files.map((file) => <div key={file.id}><span>{file.filename} <small>{bytes(file.size_bytes)}</small></span><Button variant="ghost" size="sm" aria-label={`Remove ${file.filename}`} onClick={() => { setFiles(files.filter((item) => item.id !== file.id)); mark(); }}>×</Button></div>)}</div>
        <MailField label="Attach files" hint={`Up to ${bytes(mail.capabilities?.limits.max_upload_bytes ?? 5 * 1024 ** 2)} per file.`}><MailFileInput multiple onChange={(event) => { const selected = event.target.files; void action.run(() => upload(selected)); event.target.value = ""; }} /></MailField>
        <MailInput label="Schedule send (optional)" hint="Uses your local timezone." type="datetime-local" value={schedule} onChange={(event) => setSchedule(event.target.value)} />
      </MailFieldset>
      <MailNotice error={action.error} />{unknown && <p className="mail-hint" role="status">The server response was lost. Retry the same request to check its outcome.</p>}
      <div className="mail-compose-footer"><span className="mail-hint">{action.busy ? "Working…" : dirty ? "Unsaved changes" : draft ? "Draft saved" : "New draft"}</span><div className="mail-actions"><Button disabled={action.busy || !!pendingSend.current || !!draft && draft.draft?.state !== "editable"} onClick={() => { void action.run(async () => { await save(); notifications.success("Draft saved."); }); }}>Save draft</Button><Button variant="primary" type="submit" disabled={action.busy || !canSend || !sender || !!draft && draft.draft?.state !== "editable" && !pendingSend.current}>{pendingSend.current ? "Check send outcome" : schedule ? "Schedule send" : "Send message"}</Button></div></div>
    </MailForm>}
    <Confirm open={discard} title={unknown ? "Close with an unknown request outcome?" : "Discard unsaved changes?"} description={unknown ? "The request may already have succeeded. Check Drafts and the message’s send status before composing another send." : draft ? "Your last saved draft remains in Drafts. Changes since the last save will be lost." : "This message has not been saved."} label="Close composer" destructive onClose={() => setDiscard(false)} onConfirm={async () => onClose()} />
  </MailModal>;
}
