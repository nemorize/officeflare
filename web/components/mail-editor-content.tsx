import { useEffect, useRef, useState } from "react";
import { Extension, type Editor } from "@tiptap/core";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyleKit } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { Button, Icon, Input, Menu, MenuPopup, Popover, PopoverPopup, Toggle } from "./ui";
import { MailInput, MailNotice, MailSelect, useMailResource } from "./mail-common";
import { api } from "../lib/api";
import { mailboxPath, type Attachment } from "../lib/mail";
import { displayEditorHtml, storedEditorHtml } from "../lib/mail-editor";
import type { MailEditorProps } from "./mail-editor";

const fonts = [{ value: "", label: "Default font" }, { value: "Arial, sans-serif", label: "Arial" }, { value: "Georgia, serif", label: "Georgia" }, { value: "'Times New Roman', serif", label: "Times New Roman" }, { value: "'Courier New', monospace", label: "Courier New" }];
const sizes = [{ value: "", label: "Normal" }, ...[10,12,14,16,18,24,32].map((size) => ({ value: `${size}px`, label: String(size) }))];
const colors = ["#222222", "#6b7280", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#7c3aed", "#db2777"];
const emptyAttachments: Attachment[] = [];
const emailStyles: Record<string, string> = { paragraph: "margin:0 0 12px", blockquote: "border-left:2px solid #dddddd;padding-left:16px;margin:16px 0", table: "border-collapse:collapse;width:100%", tableCell: "border:1px solid #dddddd;padding:8px", tableHeader: "border:1px solid #dddddd;padding:8px;background-color:#f5f5f5" };
const EmailStyles = Extension.create({ name: "emailStyles", addGlobalAttributes() { return Object.entries(emailStyles).map(([type, style]) => ({ types: [type], attributes: { emailStyle: { default: style, rendered: true, parseHTML: () => style, renderHTML: () => ({ style }) } } })); } });

function editorFormatting(instance: Editor | null) { return instance ? { bold: instance.isActive("bold"), italic: instance.isActive("italic"), underline: instance.isActive("underline"), strike: instance.isActive("strike"), bullet: instance.isActive("bulletList"), ordered: instance.isActive("orderedList"), quote: instance.isActive("blockquote"), align: instance.getAttributes("paragraph").textAlign ?? "left", font: instance.getAttributes("textStyle").fontFamily ?? "", size: instance.getAttributes("textStyle").fontSize ?? "", link: instance.isActive("link"), href: instance.getAttributes("link").href ?? "", table: instance.isActive("table"), image: instance.isActive("image"), undo: instance.can().undo(), redo: instance.can().redo() } : null; }

export function MailEditor({ value, onChange, onDirty, flushRef, onUploadingChange, maxImageBytes, onImageUploaded, mailboxId, attachments = emptyAttachments, disabled = false, label = "Message body", className = "" }: MailEditorProps) {
  const limits = useMailResource<{ limits: { max_upload_bytes: number } }>(maxImageBytes === undefined ? mailboxPath(mailboxId) + "/addresses" : null);
  const imageMaximum = maxImageBytes ?? limits.data?.limits.max_upload_bytes ?? 0;
  const current = useRef({ onChange, onDirty, attachments, disabled, imageMaximum, onImageUploaded }); current.current = { onChange, onDirty, attachments, disabled, imageMaximum, onImageUploaded };
  const serialization = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), published = useRef(value);
  const fileInput = useRef<HTMLInputElement>(null), uploadCount = useRef(0);
  const [uploading, setUploading] = useState(false), [error, setError] = useState("");
  useEffect(() => { onUploadingChange?.(uploading); }, [uploading, onUploadingChange]);
  const mailboxImage = new RegExp(`^/api/mail/mailboxes/${mailboxId}/(?:images/[a-f0-9-]{36}|messages/[a-f0-9.-]+/attachments/[a-f0-9-]{36})$`);
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, code: false, horizontalRule: false, link: { openOnClick: false, autolink: true, protocols: ["mailto"], HTMLAttributes: { target: null, rel: "noopener noreferrer" } } }), TextStyleKit, TextAlign.configure({ types: ["paragraph"] }), TableKit.configure({ table: { resizable: false } }), EmailStyles, Image.extend({ addNodeView() { return ReactNodeViewRenderer(AuthenticatedImage); }, parseHTML() { return [{ tag: "img[src]", getAttrs: (element) => mailboxImage.test((element as HTMLElement).getAttribute("src") ?? "") ? null : false }]; } }).configure({ inline: true, allowBase64: false })],
    content: displayEditorHtml(value, mailboxId), editable: !disabled, immediatelyRender: false,
    editorProps: { attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", spellcheck: "true" }, handlePaste: (_view, event) => {
      const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (!images.length) return false;
      event.preventDefault(); void uploadImages(images); return true;
    }, handleDrop: (_view, event, _slice, moved) => {
      if (moved) return false;
      const images = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (!images.length) return false;
      event.preventDefault(); void uploadImages(images); return true;
    } },
    onUpdate: () => {
      current.current.onDirty?.();
      clearTimeout(serialization.current);
      serialization.current = setTimeout(() => { const next = flush(); current.current.onChange(next.html, next.text); }, 200);
    },
  }, [mailboxId]);
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  function flush() {
    clearTimeout(serialization.current);
    const result = { html: !editor || editor.isEmpty ? "" : storedEditorHtml(editor.getHTML(), mailboxId, current.current.attachments), text: editor?.getText({ blockSeparator: "\n\n" }).replace(/\n{3,}/g, "\n\n") ?? "" };
    published.current = result.html;
    return result;
  }
  useEffect(() => { if (flushRef) flushRef.current = () => { const result = flush(); current.current.onChange(result.html, result.text); return result; }; return () => { clearTimeout(serialization.current); if (flushRef) flushRef.current = null; }; }, [editor, flushRef, mailboxId]);
  useEffect(() => {
    if (!editor || value === published.current) return;
    clearTimeout(serialization.current);
    published.current = value;
    editor.commands.setContent(displayEditorHtml(value, mailboxId), { emitUpdate: false });
  }, [editor, value, mailboxId]);
  const state = useEditorState({ editor, selector: ({ editor: instance }) => editorFormatting(instance) }) ?? editorFormatting(editor);
  async function uploadImages(files: File[]) {
    if (current.current.disabled || !editor || editor.isDestroyed) return;
    uploadCount.current++; setUploading(true); setError("");
    try {
      for (const file of files) {
        const maximum = current.current.imageMaximum;
        if (!maximum) throw new Error("Wait for the image size limit to load.");
        if (!["image/png","image/jpeg","image/gif","image/webp"].includes(file.type) || !file.size || file.size > maximum) throw new Error(`Choose a PNG, JPEG, GIF or WebP image up to ${Math.floor(maximum / 1024)} KiB.`);
        const result = await api<{ image: { id: string; content_id: string; size_bytes: number; filename: string } }>(mailboxPath(mailboxId) + "/images", { method: "POST", body: file, headers: { "X-Filename-Encoded": encodeURIComponent(file.name) }, signal: AbortSignal.timeout(120000) });
        current.current.onImageUploaded?.({ ...result.image, content_type: file.type });
        if (!editor.isDestroyed && !current.current.disabled) editor.chain().focus().setImage({ src: mailboxPath(mailboxId) + "/images/" + result.image.id, alt: file.name }).run();
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Image upload failed."); }
    finally { uploadCount.current--; setUploading(uploadCount.current > 0); }
  }
  if (!editor || !state) return <div className={`mail-html-editor ${className}`} aria-busy="true" />;
  const run = (command: (instance: Editor) => void) => { if (!disabled) command(editor); };
  const toggle = (name: string, active: boolean, children: React.ReactNode, command: (instance: Editor) => void) => <Toggle data-size="icon" data-variant="ghost" aria-label={name} title={name} pressed={active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onPressedChange={() => run(command)}>{children}</Toggle>;
  return <div className={`mail-html-editor ${className}`} data-disabled={disabled || undefined}>
    <div className="mail-html-toolbar" role="group" aria-label={`${label} formatting`}>
      <div className="mail-html-format-row">
        <MailSelect aria-label="Font family" value={state.font} disabled={disabled} className="mail-editor-font" options={fonts} onValueChange={(font) => run((instance) => { const chain = instance.chain().focus(); (font ? chain.setFontFamily(font) : chain.unsetFontFamily()).run(); })} />
        <MailSelect aria-label="Font size" value={state.size} disabled={disabled} className="mail-editor-size" options={sizes} onValueChange={(size) => run((instance) => { const chain = instance.chain().focus(); (size ? chain.setFontSize(size) : chain.unsetFontSize()).run(); })} />
        <Popover.Root><Popover.Trigger render={<Button size="icon" variant="ghost" disabled={disabled} aria-label="Text color" title="Text color" />}><span className="mail-color-letter">A</span></Popover.Trigger><PopoverPopup className="mail-editor-popover"><p>Text color</p><div className="mail-editor-colors">{colors.map((color) => <Button variant="swatch" key={color} size="icon" aria-label={`Text color ${color}`} style={{ backgroundColor: color }} onClick={() => run((instance) => { instance.chain().focus().setColor(color).run(); })} />)}</div><Button variant="ghost" size="sm" onClick={() => run((instance) => { instance.chain().focus().unsetColor().run(); })}>Default color</Button></PopoverPopup></Popover.Root>
      </div>
      <div className="mail-html-format-row">
        {toggle("Bold", state.bold, <strong>B</strong>, (instance) => { instance.chain().focus().toggleBold().run(); })}
        {toggle("Italic", state.italic, <em>I</em>, (instance) => { instance.chain().focus().toggleItalic().run(); })}
        {toggle("Underline", state.underline, <u>U</u>, (instance) => { instance.chain().focus().toggleUnderline().run(); })}
        {toggle("Strikethrough", state.strike, <s>S</s>, (instance) => { instance.chain().focus().toggleStrike().run(); })}
        <Menu.Root><Menu.Trigger render={<Button size="icon" variant="ghost" disabled={disabled} aria-label="Text alignment" title="Text alignment" />}><Icon name="align" /></Menu.Trigger><MenuPopup className="mail-action-menu">{["left","center","right","justify"].map((alignment) => <Menu.Item key={alignment} onClick={() => editor.chain().focus().setTextAlign(alignment).run()}>{state.align === alignment && <Icon name="check" />}{alignment[0]!.toUpperCase() + alignment.slice(1)}</Menu.Item>)}</MenuPopup></Menu.Root>
        {toggle("Bullet list", state.bullet, <Icon name="bulletList" />, (instance) => { instance.chain().focus().toggleBulletList().run(); })}
        {toggle("Numbered list", state.ordered, <Icon name="numberedList" />, (instance) => { instance.chain().focus().toggleOrderedList().run(); })}
        {toggle("Blockquote", state.quote, <Icon name="quote" />, (instance) => { instance.chain().focus().toggleBlockquote().run(); })}
        <LinkControl editor={editor} href={state.href} disabled={disabled} active={state.link} />
        <Input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={disabled || uploading} onChange={(event) => { void uploadImages([...(event.target.files ?? [])]); event.target.value = ""; }} />
        <Button size="icon" variant="ghost" aria-label="Insert image" title="Insert image" disabled={disabled || uploading} onClick={() => fileInput.current?.click()}><Icon name="image" /></Button>
        {state.image && <Menu.Root><Menu.Trigger render={<Button size="sm" variant="ghost" disabled={disabled} aria-label="Image size" />}>Image size</Menu.Trigger><MenuPopup className="mail-action-menu">{[120,240,360].map((width) => <Menu.Item key={width} onClick={() => editor.chain().focus().updateAttributes("image", { width, height: null }).run()}>{width} px wide</Menu.Item>)}<Menu.Item onClick={() => editor.chain().focus().deleteSelection().run()}>Remove image</Menu.Item></MenuPopup></Menu.Root>}
        <Menu.Root><Menu.Trigger render={<Button size="icon" variant="ghost" disabled={disabled} aria-label="Table" title="Table" />}><Icon name="table" /></Menu.Trigger><MenuPopup className="mail-action-menu"><Menu.Item onClick={() => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run()}>Insert 2 × 2 table</Menu.Item><Menu.Item onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Insert 3 × 3 table</Menu.Item>{state.table && <><Menu.Separator /><Menu.Item onClick={() => editor.chain().focus().addRowAfter().run()}>Add row</Menu.Item><Menu.Item onClick={() => editor.chain().focus().addColumnAfter().run()}>Add column</Menu.Item><Menu.Item onClick={() => editor.chain().focus().deleteRow().run()}>Delete row</Menu.Item><Menu.Item onClick={() => editor.chain().focus().deleteColumn().run()}>Delete column</Menu.Item><Menu.Item onClick={() => editor.chain().focus().deleteTable().run()}>Delete table</Menu.Item></>}</MenuPopup></Menu.Root>
        <Button size="icon" variant="ghost" aria-label="Clear formatting" title="Clear formatting" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><Icon name="clearFormat" /></Button>
        <Button size="icon" variant="ghost" aria-label="Undo" title="Undo" disabled={disabled || !state.undo} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().undo().run()}><Icon name="undo" /></Button>
        <Button size="icon" variant="ghost" aria-label="Redo" title="Redo" disabled={disabled || !state.redo} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().redo().run()}><Icon name="redo" /></Button>
      </div>
    </div>
    <EditorContent editor={editor} className="mail-html-content" />
    {uploading && <p className="mail-hint" role="status">Uploading image…</p>}<MailNotice error={error} />
  </div>;
}
function LinkControl({ editor, href, active, disabled }: { editor: Editor; href: string; active: boolean; disabled: boolean }) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState(""), [error, setError] = useState("");
  return <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setUrl(href); setError(""); } }}><Popover.Trigger render={<Button size="icon" variant="ghost" aria-label="Insert or edit link" title="Insert or edit link" disabled={disabled} aria-pressed={active} />}><Icon name="link" /></Popover.Trigger><PopoverPopup className="mail-editor-popover"><MailInput label="Link address" value={url} placeholder="https://example.com" onChange={(event) => setUrl(event.target.value)} /><MailNotice error={error} /><div className="mail-actions"><Button variant="primary" onClick={() => {
    const value = url.trim();
    if (!/^(?:https?:\/\/|mailto:)/i.test(value)) { setError("Enter an HTTP, HTTPS or mailto link."); return; }
    if (editor.state.selection.empty && !active) editor.chain().focus().insertContent({ type: "text", text: value, marks: [{ type: "link", attrs: { href: value } }] }).run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: value }).run(); setOpen(false);
  }}>Apply link</Button><Button variant="ghost" disabled={!active} onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setOpen(false); }}>Remove link</Button></div></PopoverPopup></Popover.Root>;
}

function AuthenticatedImage({ node, selected }: NodeViewProps) {
  const source = String(node.attrs.src ?? ""), [preview, setPreview] = useState(""), [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = "";
    setPreview(""); setError(false);
    void api<Blob>(source, { response: "blob", signal: controller.signal }).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setPreview(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source]);
  return <NodeViewWrapper as="span" className="mail-editor-image" data-selected={selected || undefined} contentEditable={false}>{preview ? <img src={preview} alt={node.attrs.alt ?? ""} width={node.attrs.width ?? undefined} height={node.attrs.height ?? undefined} draggable="false" /> : <span className="mail-hint" role="status">{error ? "Image unavailable" : "Loading image…"}</span>}</NodeViewWrapper>;
}
