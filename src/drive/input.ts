import { HTTPException } from "hono/http-exception";
import { invalid, string } from "../auth/input";
export function fail(status: 400 | 403 | 404 | 409 | 410 | 412 | 413 | 416 | 429 | 503, message: string): never { throw new HTTPException(status, { message }); }
export function integer(value: unknown, key: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(`Invalid ${key}`);
  return value;
}
export function name(value: unknown) {
  const result = string(value, "name", 255).normalize("NFC").trim();
  if (!result || result === "." || result === ".." || /[\x00-\x1f\x7f/\\]/.test(result)) invalid("Invalid name");
  return result;
}
export function text(value: unknown, key: string, max: number) {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) invalid(`Invalid ${key}`);
  return value;
}
export function bool(value: unknown, key: string) { if (typeof value !== "boolean") invalid(`Invalid ${key}`); return value; }
export function identifier(value: unknown, key = "id") { const result = string(value, key, 128); if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid(`Invalid ${key}`); return result; }
export function role(value: unknown) { if (value !== "viewer" && value !== "commenter" && value !== "editor") invalid("Invalid role"); return value; }
export function expiry(value: unknown) { return value == null ? null : integer(value, "expires_at", Math.floor(Date.now() / 1000) + 60); }
export function mime(value: unknown) { const result = value === undefined ? "application/octet-stream" : string(value, "content_type", 200); if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(result)) invalid("Invalid content_type"); return result.toLowerCase(); }
export function checksum(value: unknown) { if (value == null) return null; if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) invalid("Invalid sha256"); return value.toLowerCase(); }
