import type { Attachment } from "./mail";

export function plainMailHtml(value: string) {
  if (!value) return "";
  return value
    .split(/\n\n/)
    .map(
      (part) =>
        `<p>${part.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>")}</p>`,
    )
    .join("");
}
export function displayEditorHtml(value: string, mailboxId: string) {
  const doc = new DOMParser().parseFromString(value, "text/html");
  for (const image of doc.body.querySelectorAll("img")) {
    const assetId = /^cid:([a-f0-9-]{36})@officeflare\.image$/.exec(
      image.getAttribute("src") ?? "",
    )?.[1];
    if (assetId) image.setAttribute("src", `/api/mail/mailboxes/${mailboxId}/images/${assetId}`);
  }
  return doc.body.innerHTML;
}
export function storedEditorHtml(value: string, mailboxId: string, attachments: Attachment[] = []) {
  const doc = new DOMParser().parseFromString(value, "text/html");
  for (const image of doc.body.querySelectorAll("img")) {
    const source = image.getAttribute("src") ?? "";
    const assetId = new RegExp(`^/api/mail/mailboxes/${mailboxId}/images/([a-f0-9-]{36})$`).exec(
      source,
    )?.[1];
    const file = attachments.find(
      (attachment) => attachment.content_id && source.endsWith(`/attachments/${attachment.id}`),
    );
    if (assetId) image.setAttribute("src", `cid:${assetId}@officeflare.image`);
    else if (file?.content_id) image.setAttribute("src", "cid:" + file.content_id);
  }
  for (const table of doc.body.querySelectorAll("table")) {
    table.style.borderCollapse = "collapse";
    table.style.width = "100%";
    table.style.margin = "12px 0";
  }
  return doc.body.innerHTML;
}
export function normalizedEditorHtml(
  value: string,
  mailboxId: string,
  attachments: Attachment[] = [],
) {
  const doc = new DOMParser().parseFromString(
    storedEditorHtml(value, mailboxId, attachments),
    "text/html",
  );
  for (const element of doc.body.querySelectorAll("*")) {
    element.removeAttribute("rel");
    element.removeAttribute("target");
    const styles = [...(element as HTMLElement).style]
      .sort()
      .map((key) => `${key}:${(element as HTMLElement).style.getPropertyValue(key).trim()}`)
      .join(";");
    if (styles) element.setAttribute("style", styles);
    else element.removeAttribute("style");
    const attributes = [...element.attributes]
      .map(({ name, value: attributeValue }) => [name, attributeValue] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    for (const [name, attributeValue] of attributes) element.setAttribute(name, attributeValue);
  }
  return doc.body.innerHTML;
}
