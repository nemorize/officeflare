import { useMemo } from "react";
import * as Y from "yjs";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { decodeBytes } from "../../shared/collaboration";
import { richTextValue } from "../../shared/rich-text";
import { t } from "../../shared/i18n/index.ts";
import { EditorFileBlock } from "./editor-file";
export function WikiRevisionPreview({ state }: { state: string }) {
  const content = useMemo(() => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeBytes(state));
    const value = richTextValue(doc);
    doc.destroy();
    return value;
  }, [state]);
  const editor = useEditor(
    {
      extensions: [StarterKit, TableKit, EditorFileBlock],
      content: content.json,
      editable: false,
      editorProps: { attributes: { class: "collaborative-prose" } },
      immediatelyRender: false,
    },
    [content],
  );
  return (
    <section className="wiki-revision-preview" aria-label={t("wiki.versionPreview")}>
      <h1 className="wiki-title">{content.title || t("wiki.untitled")}</h1>
      <EditorContent editor={editor} />
    </section>
  );
}
