import sanitizeHtml from "sanitize-html";
import { fail } from "./types";

export function text(
  value: unknown,
  key: string,
  max = 200,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim())
  )
    fail(400, "Invalid " + key);
  return value;
}
export function flag(value: unknown, key: string): number {
  if (typeof value !== "boolean") fail(400, "Invalid " + key);
  return Number(value);
}
export function integer(
  value: unknown,
  key: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail(400, "Invalid " + key);
  return value as number;
}
export function email(value: unknown): string {
  const result = text(value, "email_address", 254).trim().toLowerCase();
  if (
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(
      result,
    ) ||
    result.split("@")[0]!.length > 64 ||
    result.startsWith(".") ||
    result.includes("..")
  )
    fail(400, "Invalid email_address");
  return result;
}
export function replyToAddress(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const address = text(value, "reply_to", 254, true).trim();
  return address ? email(address) : null;
}
export function recipients(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) fail(400, "Invalid " + key);
  return [...new Set(value.map(email))];
}
export function domain(value: unknown) {
  const name = text(value, "domain", 253).toLowerCase();
  if (
    name.split(".").length < 2 ||
    name
      .split(".")
      .some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    fail(400, "Invalid domain");
  return name;
}
export function localPart(value: unknown) {
  const local = text(value, "local_part", 64).toLowerCase();
  email(local + "@example.test");
  return local;
}
export function cleanHtml(
  html: string,
  attachmentUrls: Record<string, string> = {},
  preserveCid = false,
): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "div",
      "span",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
      "colgroup",
      "col",
      "a",
      "img",
    ],
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "title", "rel"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan", "width"],
      th: ["colspan", "rowspan", "width"],
      col: ["width"],
      table: ["width", "cellpadding", "cellspacing", "border"],
    },
    allowedSchemes: ["https", "http", "mailto", "cid"],
    allowedSchemesByTag: { a: ["https", "http", "mailto"], img: ["cid"] },
    allowProtocolRelative: false,
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]{1,24}$/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]{1,24}$/i],
        "font-family": [/^[a-z\d\s,'"_-]{1,120}$/i],
        "font-size": [/^(?:[1-9]\d?|100)(?:px|pt|%)$/i],
        "font-weight": [/^(?:normal|bold|[1-9]00)$/],
        "font-style": [/^(?:normal|italic)$/],
        "text-decoration": [/^(?:none|underline|line-through)(?: (?:underline|line-through))?$/],
        "text-align": [/^(?:left|center|right|justify)$/],
        "vertical-align": [/^(?:top|middle|bottom|baseline)$/],
        "line-height": [/^\d+(?:\.\d+)?(?:px|pt|em|%)?$/],
        width: [/^\d{1,4}(?:px|%)$/],
        height: [/^\d{1,4}(?:px|%)$/],
        "max-width": [/^\d{1,4}(?:px|%)$/],
        "border-collapse": [/^(?:collapse|separate)$/],
        border: [/^\d{1,2}px (?:solid|dashed|dotted) (?:#[0-9a-f]{3,8}|[a-z]{1,24}|rgba?\([\d\s.,%]+\))$/i],
        "border-left": [/^\d{1,2}px (?:solid|dashed|dotted) (?:#[0-9a-f]{3,8}|[a-z]{1,24}|rgba?\([\d\s.,%]+\))$/i],
        padding: [/^\d{1,3}px(?: \d{1,3}px){0,3}$/],
        "padding-left": [/^\d{1,3}px$/],
        margin: [/^(?:0|\d{1,3}px)(?: (?:0|\d{1,3}px)){0,3}$/],
      },
    },
    transformTags: {
      a: (_tag, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, rel: "noopener noreferrer" },
      }),
      img: (_tag, attributes) => {
        const cid = /^cid:([^\s<>]{1,254})$/i.exec(attributes.src ?? "")?.[1];
        return {
          tagName: "img",
          attribs: { ...attributes, src: (cid && (attachmentUrls[cid] || (preserveCid ? "cid:" + cid : ""))) || "" },
        };
      },
    },
  });
}
export function htmlText(html: string) {
  const plain = sanitizeHtml(html.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, "$&\n"), { allowedTags: [], allowedAttributes: {} });
  return plain.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (name[0] !== "#") return named[name.toLowerCase()] ?? entity;
    const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).replace(/\n{3,}/g, "\n\n").trim();
}
export async function jsonBody(request: Request, fields: string[]) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    fail(415, "Expected application/json");
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    fail(400, "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "Invalid JSON object");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !fields.includes(key)))
    fail(400, "Unknown field");
  return data;
}
export async function hash(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function rfcId(value?: string | null) {
  const result = value?.trim().replace(/^<|>$/g, "");
  return result && result.length <= 998 && !/[\s<>]/.test(result)
    ? result
    : null;
}
export function strictId(value: unknown, key = "id") {
  const result = text(value, key, 36);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      result,
    )
  )
    fail(400, "Invalid " + key);
  return result;
}

export function composeState(value: unknown): import("./types").ComposeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid compose_state");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["to", "cc", "bcc", "reply_to", "address_id", "send_mode", "schedule"].includes(key))) fail(400, "Invalid compose_state");
  const result: import("./types").ComposeState = { to: text(data.to ?? "", "to", 16384, true), cc: text(data.cc ?? "", "cc", 16384, true), bcc: text(data.bcc ?? "", "bcc", 16384, true) };
  for (const key of ["address_id", "send_mode", "schedule"] as const) if (data[key] !== undefined) result[key] = text(data[key], key, 100, true);
  if (data.reply_to !== undefined) result.reply_to = text(data.reply_to, "reply_to", 254, true);
  return result;
}
