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
      "a",
      "img",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    transformTags: {
      a: (_tag, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, rel: "noopener noreferrer" },
      }),
      img: (_tag, attributes) => {
        const cid = attributes.src?.replace(/^cid:/i, "");
        return {
          tagName: "img",
          attribs: { ...attributes, src: (cid && attachmentUrls[cid]) || "" },
        };
      },
    },
  });
}
export function htmlText(html: string) {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
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
