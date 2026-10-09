import { useLocation } from "react-router";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { bytes, mailboxPath, MailOperation, parseRecipients, scheduledTime, submissionLabel, type Address, type Attachment, type MailSettings, type MessageDetail, type Submission } from "../lib/mail";
import { useMail } from "./mail-context";
import { MailField, MailInput, MailNotice, MailState, useMailAction, useMailResource, MailForm, MailFieldset, MailSelect, MailTextarea, MailFileInput } from "./mail-common";
import { Button, Icon } from "./ui";
import { MailIconButton, MailMenu } from "./mail-controls";
import { RecipientField } from "./mail-recipients";
import { Menu } from "./ui";
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
export function MailComposer({ mailboxId, draftId, inline = false, onClose }: { mailboxId: string; draftId?: string; inline?: boolean; onClose: () => void }) {
  const mail = useMail(), location = useLocation(), path = mailboxPath(mailboxId), action = useMailAction();
  const initial = useMailResource<{ message: MessageDetail }>(draftId ? `${path}/drafts/${draftId}` : null);
  const addresses = useMailResource<{ addresses: Address[] }>(path + "/addresses"), settings = useMailResource<{ settings: MailSettings }>(path + "/settings");
  const [draft, setDraft] = useState<MessageDetail | null>(null), [ready, setReady] = useState(false), [to, setTo] = useState(""), [cc, setCc] = useState(""), [bcc, setBcc] = useState(""), [subject, setSubject] = useState(""), [text, setText] = useState(""), [rich, setRich] = useState(false), [html, setHtml] = useState("");
  const [files, setFiles] = useState<(Attachment & { upload?: boolean })[]>([]), [sender, setSender] = useState(""), [mode, setMode] = useState("send_as"), [schedule, setSchedule] = useState(""), [dirty, setDirty] = useState(false), [discard, setDiscard] = useState(false), [includeCc, setIncludeCc] = useState(false), [unknown, setUnknown] = useState(false);
  const [minimized,setMinimized] = useState(false), [expanded,setExpanded] = useState(false), [docked,setDocked] = useState(!inline), [autosaving,setAutosaving] = useState(false), [closing,setClosing] = useState(false), [deleteDraft,setDeleteDraft] = useState(false), [scheduleOpen,setScheduleOpen] = useState(false), [inlineHost,setInlineHost] = useState<HTMLElement | null>(null);
  const generation = useRef(0), draftRef = useRef<MessageDetail | null>(null);
  const surface = useRef<HTMLElement>(null);
  const editor = useRef<HTMLDivElement>(null), createOperation = useRef(new MailOperation()), sendOperation = useRef(new MailOperation()), pendingCreate = useRef<object | null>(null), pendingSend = useRef<{ id: string; payload: object } | null>(null), editorHtml = useRef("");
  const pendingEdit = useRef<{ version: number; payload: object; matches: (message: MessageDetail) => boolean } | null>(null);
  const rights = mail.boxes.find((box) => box.id === mailboxId)?.access, canSend = rights?.send_as || rights?.send_on_behalf;
  useEffect(() => {
    if (ready || (draftId ? !initial.data : !settings.data)) return;
    const message = initial.data?.message;
    if (message) { setDraft(message); setTo(message.recipients.filter((r) => r.kind === "to").map((r) => r.email_address).join(", ")); setCc(message.recipients.filter((r) => r.kind === "cc").map((r) => r.email_address).join(", ")); setBcc(message.recipients.filter((r) => r.kind === "bcc").map((r) => r.email_address).join(", ")); setIncludeCc(message.recipients.some((r) => r.kind !== "to")); setSubject(message.subject); setText(message.body.text); const clean = editableHtml(message.body.html); editorHtml.current = clean; setHtml(clean); setRich(!!clean); setFiles(message.attachments); }
    else setText(settings.data!.settings.signature ? `\n\n${settings.data!.settings.signature}` : "");
    const stored = message?.body.compose_state;
    if (stored) { setTo(stored.to); setCc(stored.cc); setBcc(stored.bcc); setIncludeCc(!!stored.cc || !!stored.bcc); if (stored.address_id) setSender(stored.address_id); if (stored.send_mode) setMode(stored.send_mode); if (stored.schedule) setSchedule(stored.schedule); }
    draftRef.current = message ?? null;
    setReady(true);
  }, [draftId, initial.data, settings.data, ready]);
  useEffect(() => { if (editor.current && rich) editor.current.innerHTML = editorHtml.current || editableHtml(text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\n", "<br>")); }, [rich, ready]);
  useEffect(() => { const primary = addresses.data?.addresses.find((address) => address.send_enabled && address.is_primary) ?? addresses.data?.addresses.find((address) => address.send_enabled); if (!sender && primary) setSender(primary.id); }, [addresses.data, sender]);
  useEffect(() => { if (!rights?.send_as && rights?.send_on_behalf) setMode("send_on_behalf"); }, [rights?.send_as, rights?.send_on_behalf]);
  useEffect(() => { if (!dirty && !unknown) return; const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent); }, [dirty, unknown]);
  useEffect(() => { const host = document.getElementById("mail-reply-host"); setInlineHost(host); if (inline && !host) setDocked(true); },[inline,docked,location.pathname,location.search]);
  useEffect(() => { const focus = () => { setMinimized(false); }; window.addEventListener("officeflare:focus-composer",focus); return () => window.removeEventListener("officeflare:focus-composer",focus); },[]);
  const mark = () => { generation.current++; setDirty(true); };
  const close = async () => { if (unknown) { setDiscard(true); return; } if (!dirty) { onClose(); return; } if (action.busy) return; setClosing(true); const success = await action.run(async () => { await save(); onClose(); }); if (!success) setClosing(false); };

  const values = (strict = false) => {
    const valid = (value: string) => strict ? parseRecipients(value) : value.split(/[,;\n]+/).flatMap((token) => { try { return parseRecipients(token); } catch { return []; } });
    const recipients = { to: valid(to), cc: valid(cc), bcc: valid(bcc) };
    if (Object.values(recipients).flat().length > 50) throw new Error("A message can have at most 50 recipients.");
    return { subject, text, html: rich ? html : "", compose_state: { to,cc,bcc,address_id:sender,send_mode:mode,schedule }, ...recipients, attachment_ids: files.filter((file) => file.upload).map((file) => file.id) };
  };
  async function save(): Promise<MessageDetail> {
    if (!ready) throw new Error("Wait for the draft to finish loading.");
    if (draft && !dirty) return draft;
    const savedGeneration = generation.current, savedFiles = files;
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
        pendingEdit.current = { version: draft.draft.version, payload: { ...data, version: draft.draft.version, retained_attachment_ids: files.filter((file) => !file.upload).map((file) => file.id) }, matches: (latest) => latest.subject === data.subject && latest.body.text === data.text && editableHtml(latest.body.html) === editableHtml(data.html) && JSON.stringify(latest.body.compose_state) === JSON.stringify(data.compose_state) && recipientKey(latest.recipients) === expectedRecipients && JSON.stringify(latest.attachments.map((file) => `${file.filename}:${file.size_bytes}:${file.content_type}`).sort()) === JSON.stringify(expectedFiles) };
        result = await patchDraft(draft.id);
      }
      pendingEdit.current = null;
    } else {
      pendingCreate.current ??= { ...data, include_signature: false };
      try { result = await api(`${path}/drafts`, { method: "POST", body: pendingCreate.current, headers: createOperation.current.headers(pendingCreate.current) }); }
      catch (failure) { setUnknown(true); if (failure instanceof ApiError && failure.status < 500) { pendingCreate.current = null; createOperation.current.complete(); setUnknown(false); } throw failure; }
      createOperation.current.complete(); pendingCreate.current = null;
    }
    setUnknown(false); setDraft(result.message); draftRef.current = result.message;
    if (generation.current === savedGeneration) { setFiles(result.message.attachments); setDirty(false); }
    else { const used = new Set<string>(); setFiles((current) => current.map((file) => { if (!file.upload || !savedFiles.some((old) => old.id === file.id)) return file; const replacement = result.message.attachments.find((next) => !used.has(next.id) && next.filename === file.filename && next.size_bytes === file.size_bytes && !savedFiles.some((old) => !old.upload && old.id === next.id)); if (replacement) { used.add(replacement.id); return replacement; } return file; })); }
    mail.refresh("summary"); return result.message;
  }
  async function patchDraft(id: string): Promise<{ message: MessageDetail }> {
    try { return await api(`${path}/drafts/${id}`, { method: "PATCH", body: pendingEdit.current!.payload }); }
    catch (failure) { setUnknown(true); if (failure instanceof ApiError && failure.status < 500) { pendingEdit.current = null; setUnknown(false); } throw failure; }
  }
  async function send() {
    if (!pendingSend.current) {
      const recipients = values(true); if (!recipients.to.length && !recipients.cc.length && !recipients.bcc.length) throw new Error("Add at least one recipient.");
      if (!sender || !canSend) throw new Error("Choose an available sending address. Your mailbox needs send permission.");
      const scheduledAt = scheduledTime(schedule), message = await save();
      pendingSend.current = { id: message.id, payload: { version: message.draft!.version, address_id: sender, send_mode: mode, ...(scheduledAt ? { scheduled_at: scheduledAt } : { undo_window: mail.preferences.undo_seconds }) } };
    }
    const pending = pendingSend.current;
    try {
      const result = await api<{ submission: Submission }>(`${path}/drafts/${pending.id}/submissions`, { method: "POST", body: pending.payload, headers: sendOperation.current.headers(pending.payload) });
      sendOperation.current.complete(); pendingSend.current = null; setUnknown(false); setDirty(false); mail.refresh(); if (result.submission.status === "scheduled" && !schedule) mail.feedback("Sending message…",async () => { await api(`${path}/submissions/${result.submission.id}/cancel`,{method:"POST"}); mail.refresh(); mail.compose(pending.id); },"Undo",Math.max(0,result.submission.scheduled_at*1000-Date.now())); else mail.feedback(schedule ? "Message scheduled" : submissionLabel(result.submission.status)); onClose();
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
      setFiles((old) => [...old, { ...result.upload, upload: true }]); mark();
    }
  }
  function format(command: string) { editor.current?.focus(); document.execCommand(command); if (editor.current) { setText(editor.current.innerText); editorHtml.current = editableHtml(editor.current.innerHTML); setHtml(editorHtml.current); mark(); } }
  useEffect(() => { if (!ready || !dirty || unknown || action.busy || closing || draft?.draft?.state === "submitted") return; const timer=setTimeout(() => { setAutosaving(true); void action.run(async () => { await save(); }).finally(() => setAutosaving(false)); },1500); return () => clearTimeout(timer); },[ready,dirty,unknown,action.busy,closing,to,cc,bcc,subject,text,html,files,sender,mode,schedule]);
  useEffect(() => { const key=(event:KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !action.busy) { event.preventDefault(); void action.run(send); } }; window.addEventListener("keydown",key); return () => window.removeEventListener("keydown",key); });
  useEffect(() => {
    if (!ready || minimized) return;
    if (!docked && inlineHost) {
      const container = inlineHost.closest<HTMLElement>(".mail-conversation-content");
      if (container && surface.current) container.scrollTo({ top: container.scrollTop + surface.current.getBoundingClientRect().top - container.getBoundingClientRect().top - 16 });
      surface.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({preventScroll:true});
    } else if (!draftId) surface.current?.querySelector<HTMLInputElement>('input[inputmode="email"]')?.focus({preventScroll:true});
  },[ready,docked,inlineHost,minimized]);
  const locked = closing || (action.busy && !autosaving) || unknown || !!draft && draft.draft?.state !== "editable";
  const content = <section ref={surface} className={`${!docked && inlineHost ? "mail-compose-inline" : "mail-compose-window"}${minimized ? " is-minimized" : ""}${expanded ? " is-expanded" : ""}`} aria-label="Compose message">
    <div className="mail-compose-titlebar"><Button variant="ghost" className="mail-compose-title" onClick={() => setMinimized(!minimized)}>{!docked ? "Reply" : draftId ? "Edit draft" : "New message"}</Button><span>{mail.boxes.find((box) => box.id === mailboxId)?.name}</span><MailIconButton icon="minimize" label={minimized ? "Restore composer" : "Minimize composer"} onClick={() => setMinimized(!minimized)}/><MailIconButton icon={expanded ? "minimize" : "expand"} label={expanded ? "Exit full screen" : !docked ? "Open in compose window" : "Expand composer"} onClick={() => { if (!docked) setDocked(true); else setExpanded(!expanded); setMinimized(false); }}/><MailIconButton icon="close" label="Save and close draft" disabled={action.busy || closing} onClick={() => { void close(); }}/></div>
    {!minimized && <div className="mail-compose-content">
    <MailState loading={!ready} error={initial.error || settings.error} retry={() => { initial.reload(); settings.reload(); }} />
    {ready && <MailForm className="mail-composer" onSubmit={(event) => { event.preventDefault(); void action.run(send); }}>
      <MailFieldset disabled={locked}>
        <div className="mail-form-grid"><MailField label="From"><MailSelect value={sender} onValueChange={(nextValue) => { setSender(nextValue); mark(); }} options={[{ value: "", label: "Select sending address" }, ...(addresses.data?.addresses.filter((address) => address.send_enabled).map((address) => ({ value: address.id, label: address.email_address })) || [])]} /></MailField>
          {rights?.send_as && rights?.send_on_behalf && <MailField label="Send mode"><MailSelect value={mode} onValueChange={(nextValue) => { setMode(nextValue); mark(); }} options={[{ value: "send_as", label: "Send as mailbox" }, { value: "send_on_behalf", label: "Send on behalf of mailbox" }]} /></MailField>}
        </div><MailNotice error={addresses.error} />{addresses.data && !addresses.data.addresses.some((address) => address.send_enabled) && <p className="mail-hint">No sending address is configured. You can save this message as a draft.</p>}
        <RecipientField label="To" value={to} onChange={(value) => { setTo(value); mark(); }} />
        {includeCc ? <><RecipientField label="Cc" value={cc} onChange={(value) => { setCc(value); mark(); }}/><RecipientField label="Bcc" value={bcc} onChange={(value) => { setBcc(value); mark(); }}/></> : <Button size="sm" className="mail-add-recipients" variant="ghost" onClick={() => setIncludeCc(true)}>Cc / Bcc</Button>}
        <MailInput label="Subject" value={subject} maxLength={998} onChange={(event) => { setSubject(event.target.value); mark(); }} />
        <div className="mail-editor-toolbar"><Button variant="ghost" size="sm" onClick={() => { if (rich) { editorHtml.current = ""; setHtml(""); } setRich(!rich); mark(); }}>{rich ? "Plain text" : "Formatting"}</Button></div>
        {rich ? <><div className="mail-format-actions" role="toolbar" aria-label="Message formatting">{([["bold", "Bold"], ["italic", "Italic"], ["underline", "Underline"], ["insertUnorderedList", "Bullet list"], ["removeFormat", "Clear format"]] as const).map(([command, label]) => <Button key={command} size="sm" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => format(command)}>{label}</Button>)}</div><div ref={editor} className="mail-rich-editor" contentEditable={!locked} role="textbox" aria-label="Message body" aria-multiline suppressContentEditableWarning onPaste={(event) => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); }} onInput={() => { if (editor.current) { setText(editor.current.innerText); editorHtml.current = editableHtml(editor.current.innerHTML); setHtml(editorHtml.current); mark(); } }} /></> : <MailField label="Message"><MailTextarea className="mail-compose-text" value={text} maxLength={2 * 1024 ** 2} onChange={(event) => { setText(event.target.value); mark(); }} /></MailField>}
        <div className="mail-attachments">{files.map((file) => <div key={file.id}><span>{file.filename} <small>{bytes(file.size_bytes)}</small></span><Button variant="ghost" size="sm" aria-label={`Remove ${file.filename}`} onClick={() => { setFiles(files.filter((item) => item.id !== file.id)); mark(); }}>×</Button></div>)}</div>
        <MailField label="Attach files" hint={`Up to ${bytes(mail.capabilities?.limits.max_upload_bytes ?? 5 * 1024 ** 2)} per file.`}><MailFileInput multiple onChange={(event) => { const selected = event.target.files; void action.run(() => upload(selected)); event.target.value = ""; }} /></MailField>
        {scheduleOpen && <div className="mail-schedule-panel"><div className="mail-schedule-presets">{[["Tomorrow",24],["Next week",168]].map(([label,hours]) => <Button key={label} size="sm" onClick={() => { const date=new Date(Date.now()+Number(hours)*3600000); setSchedule(new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)); mark(); }}>{label}</Button>)}</div><MailInput label="Send at" hint="Uses your local timezone." type="datetime-local" value={schedule} onChange={(event) => { setSchedule(event.target.value); mark(); }}/>{schedule && <Button variant="ghost" size="sm" onClick={() => { setSchedule(""); mark(); }}>Remove schedule</Button>}</div>}
      </MailFieldset>
      <MailNotice error={action.error} />{unknown && <p className="mail-hint" role="status">The server response was lost. Retry the same request to check its outcome.</p>}
      <div className="mail-compose-footer"><div className="mail-send-group"><Button variant="primary" type="submit" disabled={action.busy || !canSend || !sender || !!draft && draft.draft?.state !== "editable" && !pendingSend.current}>{pendingSend.current ? "Check send outcome" : schedule ? "Schedule send" : "Send"}<Icon name="arrow"/></Button><MailMenu icon="down" label="More send options"><Menu.Item disabled={locked || action.busy} onClick={() => setScheduleOpen(!scheduleOpen)}>Schedule send</Menu.Item></MailMenu></div><span className="mail-save-status" role="status">{autosaving ? "Saving…" : dirty ? "Unsaved changes" : draft ? "Draft saved" : ""}</span>{unknown && <Button size="sm" disabled={action.busy} onClick={() => { void action.run(async () => { await save(); }); }}>Retry save</Button>}<MailIconButton icon="trash" label="Discard draft" disabled={action.busy || draft?.draft?.state === "submitted"} onClick={() => setDeleteDraft(true)}/></div>
    </MailForm>}
    </div>}
    <Confirm open={deleteDraft} title="Discard this draft?" description="The draft and its attachments will be permanently removed." label="Discard draft" destructive onClose={() => setDeleteDraft(false)} onConfirm={async () => { if (draftRef.current) await api(`${path}/drafts/${draftRef.current.id}`,{method:"DELETE"}); mail.refresh(); onClose(); }}/>
    <Confirm open={discard} title={unknown ? "Close with an unknown request outcome?" : "Discard unsaved changes?"} description={unknown ? "The request may already have succeeded. Check Drafts and the message’s send status before composing another send." : draft ? "Your last saved draft remains in Drafts. Changes since the last save will be lost." : "This message has not been saved."} label="Close composer" destructive onClose={() => setDiscard(false)} onConfirm={async () => onClose()} />
  </section>;
  return !docked && inlineHost ? createPortal(content,inlineHost) : content;
}
