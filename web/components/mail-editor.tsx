import { lazy, Suspense, type RefObject } from "react";
import type { Attachment } from "../lib/mail";
import "./mail-editor.css";

export interface MailEditorProps {
  value: string;
  onDirty?: () => void;
  flushRef?: RefObject<(() => { html: string; text: string }) | null>;
  onChange: (html: string, text: string) => void;
  onUploadingChange?: (uploading: boolean) => void;
  maxImageBytes?: number;
  onImageUploaded?: (image: { content_id: string; size_bytes: number; filename: string; content_type: string }) => void;
  mailboxId: string;
  attachments?: Attachment[];
  disabled?: boolean;
  label?: string;
  className?: string;
}
const Editor = lazy(() => import("./mail-editor-content").then((module) => ({ default: module.MailEditor })));
export function MailEditor(props: MailEditorProps) {
  return <Suspense fallback={<div className={`mail-html-editor ${props.className ?? ""}`} aria-busy="true"><p className="mail-hint">Loading editor…</p></div>}><Editor {...props} /></Suspense>;
}
