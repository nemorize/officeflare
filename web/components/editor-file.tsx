import { createContext, useContext, useState, type ReactNode } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { FileBlock, type FileReference } from "../../shared/file-block";
import { t } from "../../shared/i18n/index.ts";
import { errorMessage } from "../lib/api";
import { formatBytes } from "../lib/drive";
import { Button, Icon, useNotifications } from "./ui";
import "./editor-file.css";

export interface EditorFileActions {
  choose: () => Promise<FileReference | null>;
  open: (file: FileReference) => Promise<void>;
}
const Files = createContext<EditorFileActions | null>(null);
export const useEditorFiles = () => useContext(Files);
export function EditorFilesProvider({
  actions,
  children,
}: {
  actions: EditorFileActions;
  children: ReactNode;
}) {
  return <Files value={actions}>{children}</Files>;
}
function FileView({ node, selected }: NodeViewProps) {
  const actions = useEditorFiles(),
    notify = useNotifications(),
    [busy, setBusy] = useState(false);
  const file = node.attrs as FileReference;
  return (
    <NodeViewWrapper
      contentEditable={false}
      className={`editor-file-block${selected ? " is-selected" : ""}`}
    >
      <Button
        variant="ghost"
        className="editor-file-card"
        disabled={busy || !actions}
        onClick={() => {
          if (!actions || busy) return;
          setBusy(true);
          void actions
            .open(file)
            .catch((failure) => notify.error(errorMessage(failure)))
            .finally(() => setBusy(false));
        }}
      >
        <Icon name={file.source === "drive" ? "drive" : "file"} />
        <span className="editor-file-name">{file.name}</span>
        <small data-file-size="">{formatBytes(file.size)}</small>
      </Button>
    </NodeViewWrapper>
  );
}
export const EditorFileBlock = FileBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(FileView);
  },
});

export async function insertFileBlock(
  editor: Editor,
  range: { from: number; to: number },
  actions: EditorFileActions,
) {
  let { from, to } = range,
    removed = false;
  const original = editor.state.doc.textBetween(from, to);
  const map = ({ transaction }: { transaction: Transaction }) => {
    const start = transaction.mapping.mapResult(from, 1),
      end = transaction.mapping.mapResult(to, -1);
    removed ||= start.deletedAcross || end.deletedAcross;
    from = start.pos;
    to = end.pos;
  };
  editor.on("transaction", map);
  try {
    const file = await actions.choose();
    if (!file || editor.isDestroyed) return;
    if (
      !editor.isEditable ||
      removed ||
      from > to ||
      editor.state.doc.textBetween(from, to) !== original
    )
      throw new Error(t("editorFiles.positionChanged"));
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, [
        { type: "fileAttachment", attrs: file },
        { type: "paragraph" },
      ])
      .run();
  } finally {
    editor.off("transaction", map);
  }
}
