import { Node, mergeAttributes } from "@tiptap/core";

export interface FileReference {
  source: "upload" | "drive";
  id: string;
  name: string;
  size: number;
  contentType: string;
}

export function validFileReference(
  value: Record<string, unknown>,
): value is Record<string, unknown> & FileReference {
  return (
    (value.source === "upload" || value.source === "drive") &&
    typeof value.id === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value.id) &&
    typeof value.name === "string" &&
    !!value.name.trim() &&
    value.name.length <= 255 &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    typeof value.contentType === "string" &&
    value.contentType.length <= 255 &&
    !/[\r\n]/.test(value.contentType)
  );
}

export const FileBlock = Node.create({
  name: "fileAttachment",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      source: { default: null },
      id: { default: null },
      name: { default: "" },
      size: { default: 0 },
      contentType: { default: "application/octet-stream" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-file-attachment]",
        getAttrs: (element) => {
          return {
            source: element.getAttribute("data-source"),
            id: element.getAttribute("data-id"),
            name: element.getAttribute("data-name"),
            size: Number(element.getAttribute("data-size")),
            contentType: element.getAttribute("data-content-type"),
          };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-file-attachment": "",
        "data-source": node.attrs.source,
        "data-id": node.attrs.id,
        "data-name": node.attrs.name,
        "data-size": node.attrs.size,
        "data-content-type": node.attrs.contentType,
      }),
      node.attrs.name,
    ];
  },
});
