import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
export const richTextSchema = getSchema([StarterKit.configure({ undoRedo: false }), TableKit]);
export function initialRichText() {
  const doc = prosemirrorJSONToYDoc(
    richTextSchema,
    { type: "doc", content: [{ type: "paragraph" }] },
    "content",
  );
  doc.getText("title");
  return doc;
}
export function richTextValue(doc: Y.Doc) {
  const title = doc.getText("title").toString();
  const json = yDocToProsemirrorJSON(doc, "content");
  const node = richTextSchema.nodeFromJSON(json);
  node.check();
  return { title, json, text: node.textBetween(0, node.content.size, "\n") };
}
export function validateRichText(doc: Y.Doc) {
  for (const key of doc.share.keys())
    if (key !== "title" && key !== "content") throw new Error("invalid_schema");
  const value = richTextValue(doc);
  if (
    value.title.length > 500 ||
    new TextEncoder().encode(JSON.stringify(value.json)).length > 262144
  )
    throw new Error("state_too_large");
  const walk = (node: Record<string, unknown>, depth = 0) => {
    if (depth > 32) throw new Error("invalid_schema");
    if (Array.isArray(node.marks))
      for (const mark of node.marks) {
        if (mark?.type === "link" && !/^(https?:\/\/|mailto:)/i.test(mark.attrs?.href ?? ""))
          throw new Error("invalid_link");
      }
    if (Array.isArray(node.content)) for (const child of node.content) walk(child, depth + 1);
  };
  walk(value.json);
  return value;
}
