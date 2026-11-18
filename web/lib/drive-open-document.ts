import { parseDocument } from "htmlparser2";

const tags = new Map([
  ["p", "p"],
  ["h", "h2"],
  ["list", "ul"],
  ["unordered-list", "ul"],
  ["ordered-list", "ol"],
  ["list-item", "li"],
  ["table-row", "tr"],
  ["table-cell", "td"],
]);

const localName = (name: string) => name.split(":").at(-1);

// Some older OpenOffice packages and flat-XML files use the same body markup without
// the OpenDocument package structure expected by OfficeParser.
export function renderCompatibleOpenDocument(xml: string, escapeHtml: (text: string) => string) {
  const { children } = parseDocument(xml, { xmlMode: true });
  type XmlNode = (typeof children)[number];
  const document = children.find((node) => "attribs" in node);
  const body = document?.children.find(
    (node) => "attribs" in node && localName(node.name) === "body",
  );
  if (!body || !("attribs" in body)) return "";

  function render(node: XmlNode, depth: number): string {
    if (node.type === "text") return escapeHtml(node.data);
    if (depth > 96) return "";
    if (node.type === "cdata")
      return node.children.map((child) => render(child, depth + 1)).join("");
    if (node.type !== "tag") return "";
    const name = localName(node.name);
    if (!name || ["annotation", "binary-data", "scripts", "tracked-changes"].includes(name))
      return "";
    const inner = node.children.map((child) => render(child, depth + 1)).join("");
    if (name === "page" || name === "table") {
      const label = Object.entries(node.attribs).find(([key]) => localName(key) === "name")?.[1];
      const title = label ? `<h2>${escapeHtml(label)}</h2>` : "";
      return name === "table" ? `${title}<table>${inner}</table>` : `${title}${inner}`;
    }
    if (name === "line-break") return "<br>";
    if (name === "s" || name === "tab") return " ";
    const tag = tags.get(name);
    return tag ? `<${tag}>${inner}</${tag}>` : inner;
  }
  return body.children
    .map((child) => render(child, 0))
    .join("")
    .trim();
}
