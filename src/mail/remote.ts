import ipaddr from "ipaddr.js";
import { imageSize } from "image-size";
import sanitizeHtml from "sanitize-html";

export type RemoteKind = "image" | "stylesheet";
export interface RemoteAsset { body: Uint8Array; contentType: string; url: string }
export type RemoteFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
// Worker runtime methods require their global receiver, unlike Node's fetch.
export const runtimeRemoteFetcher: RemoteFetcher = (input, init) => globalThis.fetch(input, init);
const maximumBytes = { image: 5 * 1024 ** 2, stylesheet: 256 * 1024 };
const privacyHeaders = {
  "User-Agent": "Officeflare-Mail-Proxy/1.0",
  "CF-Connecting-IP": "0.0.0.0", "CF-Connecting-IPv6": "::",
  "X-Real-IP": "0.0.0.0", "X-Forwarded-For": "0.0.0.0", "True-Client-IP": "0.0.0.0",
};

export function remoteUrl(value: string, base?: string): URL {
  if (value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error("Invalid remote URL");
  const url = new URL(value, base);
  if (url.protocol === "http:" && (!url.port || url.port === "80")) { url.protocol = "https:"; url.port = ""; }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
    !host.includes(".") || ipaddr.isValid(host.replace(/^\[|\]$/g, "")) ||
    !/^[a-z0-9.-]+$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|onion|arpa|invalid)$/.test(host))
    throw new Error("Remote resources require a public HTTPS hostname");
  url.hostname = host; url.hash = "";
  return url;
}
export function publicAddress(value: string): boolean {
  try { return ipaddr.parse(value).range() === "unicast"; } catch { return false; }
}
export async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  if (Number(response.headers.get("Content-Length")) > maximum) { await response.body?.cancel(); throw new Error("Remote resource is too large"); }
  if (!response.body) throw new Error("Empty remote resource");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error("Remote resource is too large");
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (!size) throw new Error("Empty remote resource");
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
async function publicDns(hostname: string, fetcher: RemoteFetcher, signal: AbortSignal) {
  const records = await Promise.all(["A", "AAAA"].map(async type => {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
    const response = await fetcher(url, { redirect: "error", signal, headers: { ...privacyHeaders, Accept: "application/dns-json" } });
    if (!response.ok) throw new Error("DNS lookup failed");
    const result = JSON.parse(new TextDecoder().decode(await boundedBody(response, 16 * 1024))) as { Status?: number; Answer?: { type: number; data: string }[] };
    if (result.Status !== 0) throw new Error("DNS lookup failed");
    return (result.Answer ?? []).filter(record => record.type === 1 || record.type === 28).map(record => record.data);
  }));
  const addresses = records.flat();
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error("Private network resources are blocked");
}
function safeSvg(body: Uint8Array): Uint8Array {
  const source = new TextDecoder().decode(body);
  const clean = sanitizeHtml(source, {
    allowedTags: ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc", "use", "symbol"],
    allowedAttributes: { "*": ["xmlns", "id", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "viewBox", "preserveAspectRatio", "d", "points", "r", "rx", "ry", "cx", "cy", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "opacity", "transform", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "clip-path", "mask", "font-size", "font-family", "text-anchor", "href"] },
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    allowedSchemes: [], allowProtocolRelative: false,
    transformTags: { "*": (tagName, attributes) => ({ tagName, attribs: { ...Object.fromEntries(Object.entries(attributes).filter(([key, value]) => {
      if (key === "href") return /^#[a-zA-Z_][\w.-]{0,127}$/.test(value);
      return !/[<>\\]|(?:url\s*\((?!\s*#[\w.-]+\s*\)))|expression|javascript:|(?:https?|data):/i.test(value);
    })), ...(tagName === "svg" ? { xmlns: "http://www.w3.org/2000/svg" } : {}) } }) },
  });
  if (!/^\s*<svg\b/.test(clean) || clean.length > 256 * 1024) throw new Error("Invalid SVG image");
  return new TextEncoder().encode(clean);
}
export function validatedImage(body: Uint8Array, contentType: string): { body: Uint8Array; contentType: string } {
  if (contentType === "image/svg+xml") body = safeSvg(body);
  const dimensions = imageSize(body);
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };
  const expected = dimensions.type ? types[dimensions.type] : undefined;
  if (!expected || expected !== contentType || !dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 40_000_000)
    throw new Error("Unsupported remote image");
  return { body, contentType: expected };
}
export async function fetchRemoteAsset(value: string, kind: RemoteKind, ownHost: string, fetcher: RemoteFetcher = runtimeRemoteFetcher): Promise<RemoteAsset> {
  let url = remoteUrl(value);
  const signal = AbortSignal.timeout(8000);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.hostname === ownHost.toLowerCase().replace(/\.$/, "")) throw new Error("Application resources cannot be proxied");
    await publicDns(url.hostname, fetcher, signal);
    const response = await fetcher(url.href, { signal, redirect: "manual", headers: { ...privacyHeaders, Accept: kind === "image" ? "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml" : "text/css" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location"); await response.body?.cancel();
      if (!location || hop === 3) throw new Error("Invalid remote redirect");
      url = remoteUrl(location, url.href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error("Remote resource unavailable"); }
    const contentType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (kind === "stylesheet" && contentType !== "text/css" || kind === "image" && !/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(contentType)) {
      await response.body?.cancel(); throw new Error("Unsupported remote resource type");
    }
    const body = await boundedBody(response, maximumBytes[kind]);
    return { ...(kind === "image" ? validatedImage(body, contentType) : { body, contentType }), url: url.href };
  }
  throw new Error("Invalid remote redirect");
}
