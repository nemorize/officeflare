import { useLocation } from "react-router";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { bytes, mailboxPath, MailOperation, parseRecipients, scheduledTime, submissionLabel, type Address, type Attachment, type MailSettings, type MessageDetail, type Submission } from "../lib/mail";
import { useMail } from "./mail-context";
import { MailField, MailInput, MailNotice, MailState, useMailAction, useMailResource, MailForm, MailFieldset, MailSelect, MailFileInput } from "./mail-common";
import { ButtonGroup, Button, Icon, Tooltip, TooltipPopup } from "./ui";
import { MailIconButton, MailMenu } from "./mail-controls";
import { RecipientField } from "./mail-recipients";
import { Menu } from "./ui";
import { Confirm } from "./console-shared";
import { MailEditor } from "./mail-editor";
import { MailHtml } from "./mail-body";
import { normalizedEditorHtml, plainMailHtml, storedEditorHtml } from "../lib/mail-editor";
export function MailComposer({ mailboxId, draftId, inline = false, onClose }: { mailboxId: string; draftId?: string; inline?: boolean; onClose: () => void }) {
  const mail = useMail(), location = useLocation(), path = mailboxPath(mailboxId), action = useMailAction();
  const initial = useMailResource<{ message: MessageDetail }>(draftId ? `${path}/drafts/${draftId}` : null);
  const addresses = useMailResource<{ addresses: Address[] }>(path + "/addresses"), settings = useMailResource<{ settings: MailSettings }>(path + "/settings");
  const [draft, setDraft] = useState<MessageDetail | null>(null), [ready, setReady] = useState(false), [to, setTo] = useState(""), [cc, setCc] = useState(""), [bcc, setBcc] = useState(""), [subject, setSubject] = useState(""), [text, setText] = useState(""), [html, setHtml] = useState("");
  const [files, setFiles] = useState<(Attachment & { upload?: boolean })[]>([]), [sender, setSender] = useState(""), [replyTo, setReplyTo] = useState(""), [schedule, setSchedule] = useState(""), [dirty, setDirty] = useState(false), [discard, setDiscard] = useState(false), [includeCc, setIncludeCc] = useState(false), [unknown, setUnknown] = useState(false);
  const [minimized,setMinimized] = useState(false), [expanded,setExpanded] = useState(false), [docked,setDocked] = useState(!inline), [autosaving,setAutosaving] = useState(false), [closing,setClosing] = useState(false), [deleteDraft,setDeleteDraft] = useState(false), [scheduleOpen,setScheduleOpen] = useState(false), [inlineHost,setInlineHost] = useState<HTMLElement | null>(null);
  const [includeQuote, setIncludeQuote] = useState(true), [imageUploading, setImageUploading] = useState(false);
  const generation = useRef(0), draftRef = useRef<MessageDetail | null>(null);
  const surface = useRef<HTMLElement>(null);
  const createOperation = useRef(new MailOperation()), sendOperation = useRef(new MailOperation()), pendingCreate = useRef<object | null>(null), pendingSend = useRef<{ id: string; payload: object } | null>(null);
  const pendingEdit = useRef<{ version: number; payload: object; matches: (message: MessageDetail) => boolean } | null>(null);
  const rights = mail.boxes.find((box) => box.id === mailboxId)?.access, canSend = rights?.send_as || rights?.send_on_behalf;
  const mode = rights?.send_as ? "send_as" : "send_on_behalf";
  useEffect(() => {
    if (ready || (draftId ? !initial.data : !settings.data)) return;
    const message = initial.data?.message;
    if (message) { setDraft(message); setTo(message.recipients.filter((r) => r.kind === "to").map((r) => r.email_address).join(", ")); setCc(message.recipients.filter((r) => r.kind === "cc").map((r) => r.email_address).join(", ")); setBcc(message.recipients.filter((r) => r.kind === "bcc").map((r) => r.email_address).join(", ")); setReplyTo(message.reply_to_address ?? ""); setIncludeCc(message.recipients.some((r) => r.kind !== "to") || !!message.reply_to_address); setSubject(message.subject); const editable = message.body.editor_body ?? message.body; setText(editable.text); setHtml(editable.html || plainMailHtml(editable.text)); setIncludeQuote(message.body.include_quoted_body !== false); setFiles(message.attachments); }
    else { const signature = settings.data!.settings; setText(signature.signature ? `\n\n${signature.signature}` : ""); setHtml(signature.signature_html || signature.signature ? "<p></p>" + (signature.signature_html || plainMailHtml(signature.signature)) : ""); }
    const stored = message?.body.compose_state;
    if (stored) { setTo(stored.to); setCc(stored.cc); setBcc(stored.bcc); setIncludeCc(!!stored.cc || !!stored.bcc || !!(stored.reply_to ?? message?.reply_to_address)); if (stored.reply_to !== undefined) setReplyTo(stored.reply_to); if (stored.address_id) setSender(stored.address_id); if (stored.schedule) setSchedule(stored.schedule); }
    draftRef.current = message ?? null;
    setReady(true);
  }, [draftId, initial.data, settings.data, ready]);
  useEffect(() => { const primary = addresses.data?.addresses.find((address) => address.send_enabled && address.is_primary) ?? addresses.data?.addresses.find((address) => address.send_enabled); if (!sender && primary) setSender(primary.id); }, [addresses.data, sender]);
  useEffect(() => { if (!dirty && !unknown) return; const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent); }, [dirty, unknown]);
  useEffect(() => { const host = document.getElementById("mail-reply-host"); setInlineHost(host); if (inline && !host) setDocked(true); },[inline,docked,location.pathname,location.search]);
  useEffect(() => { const focus = () => { setMinimized(false); }; window.addEventListener("officeflare:focus-composer",focus); return () => window.removeEventListener("officeflare:focus-composer",focus); },[]);
  const mark = () => { generation.current++; setDirty(true); };
  const close = async () => { if (imageUploading) return; if (unknown) { setDiscard(true); return; } if (!dirty) { onClose(); return; } if (action.busy) return; setClosing(true); const success = await action.run(async () => { await save(); onClose(); }); if (!success) setClosing(false); };

  const values = (strict = false) => {
    const valid = (value: string) => strict ? parseRecipients(value) : value.split(/[,;\n]+/).flatMap((token) => { try { return parseRecipients(token); } catch { return []; } });
    const recipients = { to: valid(to), cc: valid(cc), bcc: valid(bcc) };
    if (Object.values(recipients).flat().length > 50) throw new Error("A message can have at most 50 recipients.");
    let replyToAddress: string | null = null;
    if (replyTo.trim()) {
      try {
        const addresses = parseRecipients(replyTo);
        if (addresses.length !== 1 || /[,;\r\n]/.test(replyTo)) throw new Error();
        replyToAddress = addresses[0]!;
      } catch { if (strict) throw new Error("Enter a single valid Reply-To email address."); }
    }
    return { subject, reply_to: replyToAddress, editor_body: { text, html: storedEditorHtml(html, mailboxId, files) }, include_quoted_body: includeQuote, compose_state: { to,cc,bcc,reply_to:replyTo,address_id:sender,schedule }, ...recipients, attachment_ids: files.filter((file) => file.upload).map((file) => file.id) };
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
        const expectedFiles = files.filter((file) => file.disposition !== "inline").map((file) => `${file.filename}:${file.size_bytes}:${file.content_type}`).sort();
        const recipientKey = (entries: { kind: string; email_address: string }[]) => entries.map((entry) => `${entry.kind}:${entry.email_address}`).sort().join("\n");
        const expectedRecipients = recipientKey((["to", "cc", "bcc"] as const).flatMap((kind) => data[kind].map((email_address) => ({ kind, email_address }))));
        pendingEdit.current = { version: draft.draft.version, payload: { ...data, version: draft.draft.version, retained_attachment_ids: files.filter((file) => !file.upload).map((file) => file.id) }, matches: (latest) => latest.subject === data.subject && latest.reply_to_address === data.reply_to && (latest.body.editor_body ?? latest.body).text === data.editor_body.text && normalizedEditorHtml((latest.body.editor_body ?? latest.body).html, mailboxId, latest.attachments) === normalizedEditorHtml(data.editor_body.html, mailboxId, files) && (latest.body.include_quoted_body !== false) === data.include_quoted_body && JSON.stringify(latest.body.compose_state) === JSON.stringify(data.compose_state) && recipientKey(latest.recipients) === expectedRecipients && JSON.stringify(latest.attachments.filter((file) => file.disposition !== "inline").map((file) => `${file.filename}:${file.size_bytes}:${file.content_type}`).sort()) === JSON.stringify(expectedFiles) };
        result = await patchDraft(draft.id);
      }
      pendingEdit.current = null;
    } else {
      const { include_quoted_body: _includeQuote, ...creation } = data;
      pendingCreate.current ??= { ...creation, include_signature: false };
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
    if (imageUploading) throw new Error("Wait for the image upload to finish.");
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
  useEffect(() => { if (!ready || !dirty || unknown || action.busy || closing || draft?.draft?.state === "submitted") return; const timer=setTimeout(() => { setAutosaving(true); void action.run(async () => { await save(); }).finally(() => setAutosaving(false)); },1500); return () => clearTimeout(timer); },[ready,dirty,unknown,action.busy,closing,to,cc,bcc,replyTo,subject,text,html,files,sender,schedule,includeQuote]);
  useEffect(() => { const key=(event:KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !action.busy) { event.preventDefault(); void action.run(send); } }; window.addEventListener("keydown",key); return () => window.removeEventListener("keydown",key); });
  useEffect(() => {
    if (!ready || minimized) return;
    if (!docked && inlineHost) {
      const container = inlineHost.closest<HTMLElement>(".mail-conversation-content");
      if (container && surface.current) container.scrollTo({ top: container.scrollTop + surface.current.getBoundingClientRect().top - container.getBoundingClientRect().top - 16 });
      surface.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus({preventScroll:true});
    } else if (!draftId) surface.current?.querySelector<HTMLInputElement>('input[inputmode="email"]')?.focus({preventScroll:true});
  },[ready,docked,inlineHost,minimized]);
  const locked = closing || (action.busy && !autosaving) || unknown || !!draft && draft.draft?.state !== "editable";
  const fullSize = expanded && !minimized;
  const collapseLabel = minimized ? "Restore composer" : "Minimize composer";
  const content = <section ref={surface} className={`${!docked && inlineHost ? "mail-compose-inline" : "mail-compose-window"}${minimized ? " is-minimized" : ""}${fullSize ? " is-expanded" : ""}`} aria-label="Compose message">
    <div className="mail-compose-titlebar">
      <Tooltip.Root>
        <Tooltip.Trigger render={<Button variant="ghost" className="mail-compose-title" aria-label={collapseLabel} aria-expanded={!minimized} disabled={imageUploading} onClick={() => setMinimized(!minimized)} />}>
          <Icon name="down" className="mail-compose-chevron"/><span>{!docked ? "Reply" : draftId ? "Edit draft" : "New message"}</span>
        </Tooltip.Trigger>
        <TooltipPopup>{collapseLabel}</TooltipPopup>
      </Tooltip.Root>
      <span>{mail.boxes.find((box) => box.id === mailboxId)?.name}</span>
      <MailIconButton icon={fullSize ? "shrink" : "expand"} label={fullSize ? "Restore default size" : !docked ? "Open in compose window" : "Expand composer"} disabled={imageUploading} onClick={() => { if (!docked) setDocked(true); else setExpanded(!fullSize); setMinimized(false); }}/>
      <MailIconButton icon="close" label="Save and close draft" disabled={action.busy || closing || imageUploading} onClick={() => { void close(); }}/>
    </div>
    {!minimized && <div className="mail-compose-content">
    <MailState loading={!ready} error={initial.error || settings.error} retry={() => { initial.reload(); settings.reload(); }} />
    {ready && <MailForm className="mail-composer" onSubmit={(event) => { event.preventDefault(); void action.run(send); }}>
      <MailFieldset disabled={locked}>
        {mail.boxes.length > 1 && <div className="mail-compose-sender"><MailField label="From"><MailSelect variant="integrated" value={sender} onValueChange={(nextValue) => { setSender(nextValue); mark(); }} options={[{ value: "", label: "Select sending address" }, ...(addresses.data?.addresses.filter((address) => address.send_enabled).map((address) => ({ value: address.id, label: address.email_address })) || [])]} /></MailField></div>}<MailNotice error={addresses.error} />{addresses.data && !addresses.data.addresses.some((address) => address.send_enabled) && <p className="mail-hint">No sending address is configured. You can save this message as a draft.</p>}
        <RecipientField label="To" value={to} onChange={(value) => { setTo(value); mark(); }} action={!includeCc ? <Button size="sm" className="mail-add-recipients" variant="ghost" onClick={() => setIncludeCc(true)}>Cc / Bcc</Button> : undefined} />
        {includeCc ? <><RecipientField label="Cc" value={cc} onChange={(value) => { setCc(value); mark(); }}/><RecipientField label="Bcc" value={bcc} onChange={(value) => { setBcc(value); mark(); }}/><MailInput variant="integrated" label="Reply-To" type="email" inputMode="email" autoComplete="off" maxLength={254} placeholder="Same as From" value={replyTo} onChange={(event) => { setReplyTo(event.target.value); mark(); }} /></> : null}
        <MailInput variant="integrated" label="Subject" value={subject} maxLength={998} onChange={(event) => { setSubject(event.target.value); mark(); }} />
        <MailEditor className="mail-compose-body" value={html} mailboxId={mailboxId} attachments={files} onUploadingChange={setImageUploading} disabled={locked} onChange={(nextHtml, nextText) => { setHtml(nextHtml); setText(nextText); mark(); }} />
        {draft?.body.quoted_body && <div className="mail-quote-section"><Button size="sm" variant="ghost" disabled={locked} aria-pressed={includeQuote} onClick={() => { setIncludeQuote(!includeQuote); mark(); }}>{includeQuote ? "Remove quoted message" : "Include quoted message"}</Button>{includeQuote && <details className="mail-quoted-body"><summary>Quoted message</summary>{draft.body.quoted_body.html ? <MailHtml message={draft} path={path} content={draft.body.quoted_body.html} /> : <pre>{draft.body.quoted_body.text}</pre>}</details>}</div>}
        <div className="mail-attachments">{files.filter((file) => file.disposition !== "inline").map((file) => <div key={file.id}><span>{file.filename} <small>{bytes(file.size_bytes)}</small></span><Button variant="ghost" size="sm" aria-label={`Remove ${file.filename}`} onClick={() => { setFiles(files.filter((item) => item.id !== file.id)); mark(); }}>×</Button></div>)}</div>
        <MailField label="Attach files" hint={`Up to ${bytes(mail.capabilities?.limits.max_upload_bytes ?? 5 * 1024 ** 2)} per file.`}><MailFileInput multiple onChange={(event) => { const selected = event.target.files; void action.run(() => upload(selected)); event.target.value = ""; }} /></MailField>
        {scheduleOpen && <div className="mail-schedule-panel"><div className="mail-schedule-presets">{[["Tomorrow",24],["Next week",168]].map(([label,hours]) => <Button key={label} size="sm" onClick={() => { const date=new Date(Date.now()+Number(hours)*3600000); setSchedule(new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)); mark(); }}>{label}</Button>)}</div><MailInput label="Send at" hint="Uses your local timezone." type="datetime-local" value={schedule} onChange={(event) => { setSchedule(event.target.value); mark(); }}/>{schedule && <Button variant="ghost" size="sm" onClick={() => { setSchedule(""); mark(); }}>Remove schedule</Button>}</div>}
      </MailFieldset>
      <MailNotice error={action.error} />{unknown && <p className="mail-hint" role="status">The server response was lost. Retry the same request to check its outcome.</p>}
      <div className="mail-compose-footer"><ButtonGroup className="mail-send-group"><Button variant="primary" type="submit" disabled={action.busy || imageUploading || !canSend || !sender || !!draft && draft.draft?.state !== "editable" && !pendingSend.current}>{pendingSend.current ? "Check send outcome" : schedule ? "Schedule send" : "Send"}<Icon name="arrow"/></Button><MailMenu variant="primary" icon="down" label="More send options"><Menu.Item disabled={locked || action.busy} onClick={() => setScheduleOpen(!scheduleOpen)}>Schedule send</Menu.Item></MailMenu></ButtonGroup><span className="mail-save-status" role="status">{autosaving ? "Saving…" : dirty ? "Unsaved changes" : draft ? "Draft saved" : ""}</span>{unknown && <Button className="mail-retry-save" size="sm" disabled={action.busy} onClick={() => { void action.run(async () => { await save(); }); }}>Retry save</Button>}<MailIconButton icon="trash" label="Discard draft" disabled={action.busy || imageUploading || draft?.draft?.state === "submitted"} onClick={() => setDeleteDraft(true)}/></div>
    </MailForm>}
    </div>}
    <Confirm open={deleteDraft} title="Discard this draft?" description="The draft and its attachments will be permanently removed." label="Discard draft" destructive onClose={() => setDeleteDraft(false)} onConfirm={async () => { if (draftRef.current) await api(`${path}/drafts/${draftRef.current.id}`,{method:"DELETE"}); mail.refresh(); onClose(); }}/>
    <Confirm open={discard} title={unknown ? "Close with an unknown request outcome?" : "Discard unsaved changes?"} description={unknown ? "The request may already have succeeded. Check Drafts and the message’s send status before composing another send." : draft ? "Your last saved draft remains in Drafts. Changes since the last save will be lost." : "This message has not been saved."} label="Close composer" destructive onClose={() => setDiscard(false)} onConfirm={async () => onClose()} />
  </section>;
  return !docked && inlineHost ? createPortal(content,inlineHost) : content;
}
