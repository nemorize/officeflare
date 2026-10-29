import { cleanHtml, htmlText, text } from "./input";
import { fail, id, type Attachment, type MailBody } from "./types";

export const imageAssetKey = (mailboxId: string, imageId: string) =>
  `images/${mailboxId}/${imageId}`;
export const imageContentId = (imageId: string) => `${imageId}@officeflare.image`;
export function textHtml(value: string) {
  return value
    .split(/\n\n/)
    .map(
      (part) =>
        `<p style="margin:0 0 12px">${part.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>")}</p>`,
    )
    .join("");
}
export function editorBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid editor_body");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "text" && key !== "html"))
    fail(400, "Invalid editor_body");
  const html = cleanHtml(text(input.html ?? "", "html", 2 * 1024 ** 2, true), {}, true);
  const plain = text(input.text ?? "", "text", 2 * 1024 ** 2, true);
  return { text: plain || htmlText(html), html };
}
export function composedBody(
  editor: { text: string; html: string },
  quoted?: MailBody["quoted_body"],
  includeQuote = true,
): MailBody {
  if (!quoted) return { ...editor };
  const enabled = includeQuote && !!(quoted.text || quoted.html);
  const text = editor.text + (enabled ? "\n\n" + (quoted.text || htmlText(quoted.html)) : "");
  const html = enabled
    ? (editor.html || textHtml(editor.text)) +
      `<blockquote style="border-left:2px solid #dddddd;padding-left:16px;margin:16px 0">${quoted.html || textHtml(quoted.text)}</blockquote>`
    : editor.html;
  if (text.length > 2 * 1024 ** 2 || html.length > 2 * 1024 ** 2)
    fail(413, "Message body is too large");
  return {
    text,
    html,
    editor_body: editor,
    quoted_body: quoted,
    include_quoted_body: includeQuote,
  };
}
export function inlineContentIds(html: string) {
  return new Set(
    [...cleanHtml(html, {}, true).matchAll(/<img\b[^>]*\bsrc="cid:([^"]+)"/g)].map((match) =>
      match[1]!.replaceAll("&amp;", "&"),
    ),
  );
}
export async function validateSignatureImages(env: Env, mailboxId: string, html: string) {
  for (const cid of inlineContentIds(html)) {
    const imageId = /^([a-f0-9-]{36})@officeflare\.image$/.exec(cid)?.[1];
    if (!imageId || !(await env.MAIL_BUCKET.head(imageAssetKey(mailboxId, imageId))))
      fail(400, "A signature image is unavailable in this mailbox");
  }
}
export async function attachEditorImages(
  env: Env,
  mailboxId: string,
  messageId: string,
  html: string,
  attachments: Attachment[],
  createdKeys: string[] = [],
) {
  const referenced = inlineContentIds(html);
  const files = attachments.filter(
    (file) =>
      file.disposition !== "inline" || (!!file.content_id && referenced.has(file.content_id)),
  );
  for (const cid of referenced) {
    if (files.some((file) => file.content_id === cid)) continue;
    const imageId = /^([a-f0-9-]{36})@officeflare\.image$/.exec(cid)?.[1];
    if (!imageId) fail(400, "An inline image is missing from the message");
    const asset = await env.MAIL_BUCKET.get(imageAssetKey(mailboxId, imageId));
    if (!asset) fail(400, "An inline image is unavailable in this mailbox");
    if (files.length >= 32) fail(400, "A draft can have at most 32 attachments");
    const fileId = id(),
      r2Key = `attachments/${mailboxId}/${messageId}/${fileId}`;
    createdKeys.push(r2Key);
    await env.MAIL_BUCKET.put(r2Key, asset.body, { httpMetadata: asset.httpMetadata });
    files.push({
      id: fileId,
      filename: asset.customMetadata?.filename ?? "image",
      content_type: asset.httpMetadata?.contentType ?? "image/png",
      size_bytes: asset.size,
      content_id: cid,
      disposition: "inline",
      r2_key: r2Key,
    });
  }
  return files;
}
