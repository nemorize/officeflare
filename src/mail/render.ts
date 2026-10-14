import { Parser } from "htmlparser2";
import parse from "css-tree/parser";
import generate from "css-tree/generator";
import walk from "css-tree/walker";
import type { CssNode, List, ListItem } from "css-tree";
import sanitizeHtml from "sanitize-html";
import { fetchRemoteAsset, remoteUrl, validatedImage, runtimeRemoteFetcher, type RemoteFetcher } from "./remote";
import { hash } from "./input";

export interface MailRenderAsset { id: string; url: string }
export interface MailRendering { html: string; assets: MailRenderAsset[]; failures: number }
export interface RenderCache { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> }
const version = "v1";
const stylesheetLimit = 4, assetLimit = 96;
const cacheRequest = (kind: string, key: string) => new Request(`https://mail-render-cache.invalid/${version}/${kind}/${key}`);
export const remoteAssetCacheRequest = async (url: string, kind: string) => cacheRequest(kind, await hash(url));
const cacheHeaders = (contentType: string, seconds = 3600) => ({ "Content-Type": contentType, "Cache-Control": `public, max-age=${seconds}` });
const frameCache = () => typeof caches === "undefined" ? undefined : caches.default;
const propertyAllowed = (property: string) => /^(?:--[\w-]+|color|background(?:-color|-image|-position|-size|-repeat|-clip|-origin)?|font(?:-family|-size|-style|-weight|-variant|-stretch)?|line-height|text-(?:align|decoration(?:-color|-line|-style)?|transform|indent|overflow|size-adjust)|letter-spacing|word-(?:spacing|break|wrap)|overflow(?:-x|-y|-wrap)?|white-space|display|visibility|opacity|float|clear|width|height|min-(?:width|height)|max-(?:width|height)|margin(?:-top|-right|-bottom|-left|-inline(?:-start|-end)?|-block(?:-start|-end)?)?|padding(?:-top|-right|-bottom|-left|-inline(?:-start|-end)?|-block(?:-start|-end)?)?|border(?:-top|-right|-bottom|-left)?(?:-width|-style|-color|-radius)?|border-(?:collapse|spacing)|border-(?:top|bottom)-(?:left|right)-radius|outline(?:-width|-style|-color|-offset)?|box-(?:sizing|shadow)|vertical-align|table-layout|list-style(?:-type|-position)?|direction|unicode-bidi|position|top|right|bottom|left|z-index|gap|row-gap|column-gap|flex(?:-direction|-wrap|-flow|-grow|-shrink|-basis)?|align-(?:items|self|content)|justify-(?:content|items|self)|order|object-(?:fit|position)|grid-template-(?:columns|rows)|grid-(?:column|row)(?:-start|-end)?|mso-(?:line-height-rule|table-lspace|table-rspace|padding-alt|hide))$/.test(property);
const functions = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "calc", "min", "max", "clamp", "var", "linear-gradient", "radial-gradient", "repeating-linear-gradient", "repeating-radial-gradient"]);

export function safeMailCss(source: string, image: (url: string) => string | null, inline = false): string {
  if (source.length > 256 * 1024) return "";
  let ast: CssNode;
  try { ast = parse(source, { context: inline ? "declarationList" : "stylesheet" }); } catch { return ""; }
  try { walk(ast, {
    enter(node: CssNode, item: ListItem<CssNode> | null, list: List<CssNode> | null) {
      if (node.type === "Raw" || node.type === "Atrule" && !["media", "supports"].includes(node.name.toLowerCase()) || node.type === "Rule" && node.prelude.type !== "SelectorList") {
        if (item && list) list.remove(item); return walk.skip;
      }
      if (node.type !== "Declaration") return;
      const property = node.property.toLowerCase();
      let valid = propertyAllowed(property) && !/[\\<>]/.test(node.property);
      if (property === "position" && !/^(?:static|relative)$/.test(generate(node.value))) valid = false;
      walk(node.value, child => {
        if (child.type === "Raw" || child.type === "Function" && !functions.has(child.name.toLowerCase()) ||
          child.type === "Dimension" && /^(?:vh|vw|vmin|vmax|svh|lvh|dvh)$/i.test(child.unit) ||
          child.type === "Identifier" && /[\\<>]/.test(child.name)) valid = false;
      });
      if (!valid) { if (item && list) list.remove(item); return walk.skip; }
      // Resolve every URL before CSS reaches the browser, independent of selector matching.
      walk(node.value, child => {
        if (child.type === "Url") {
          const replacement = image(child.value);
          if (replacement) child.value = replacement; else valid = false;
        }
      });
      if (!valid && item && list) list.remove(item);
      return walk.skip;
    },
  });
  return generate(ast).replaceAll("<", "\\3c "); } catch { return ""; }
}
async function cachedRemote(url: string, kind: "image" | "stylesheet", ownHost: string, cache: RenderCache | undefined, fetcher: RemoteFetcher) {
  const request = await remoteAssetCacheRequest(url, kind), existing = await cache?.match(request);
  if (existing) return { body: new Uint8Array(await existing.arrayBuffer()), contentType: existing.headers.get("Content-Type")!, url: existing.headers.get("X-Mail-Resource-Url") ?? url };
  const result = await fetchRemoteAsset(url, kind, ownHost, fetcher);
  await cache?.put(request, new Response(result.body, { headers: { ...cacheHeaders(result.contentType), "X-Mail-Resource-Url": result.url } })).catch(() => {});
  return result;
}
export async function renderMailHtml(source: string, cid: Record<string, string>, resourcePath: string, ownHost: string, cache: RenderCache | undefined = frameCache(), fetcher: RemoteFetcher = runtimeRemoteFetcher): Promise<MailRendering> {
  if (source.length > 2 * 1024 ** 2) throw new Error("Mail body is too large to render");
  const fingerprint = await hash(resourcePath + "\n" + source);
  const key = cacheRequest("html", fingerprint), existing = await cache?.match(key);
  if (existing) return existing.json<MailRendering>();
  const sheets: ({ text: string; base?: string; media?: string } | { url: string; media?: string })[] = [];
  let inStyle = false, styleText = "", styleMedia: string | undefined, base: string | undefined;
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === "base" && !base) { try { base = remoteUrl(attributes.href ?? "").href; } catch {} }
      if (name === "style") { inStyle = true; styleText = ""; styleMedia = attributes.media; }
      if (name === "link" && /(?:^|\s)stylesheet(?:\s|$)/i.test(attributes.rel ?? "") && sheets.length < 64) {
        try { sheets.push({ url: remoteUrl(attributes.href ?? "", base).href, media: attributes.media }); } catch {}
      }
    },
    ontext(value) { if (inStyle && styleText.length < 256 * 1024) styleText += value; },
    onclosetag(name) { if (name === "style") { inStyle = false; if (sheets.length < 64) sheets.push({ text: styleText, base, media: styleMedia }); } },
  }, { decodeEntities: true });
  parser.write(source); parser.end();
  const assets: MailRenderAsset[] = [], registered = new Map<string, string>();
  let failures = 0, stylesheetCount = 0, cssBytes = 0;
  const renderDeadline = AbortSignal.timeout(12_000);
  const resourceFetch: RemoteFetcher = (input, init) => fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, renderDeadline]) : renderDeadline });
  const image = (value: string, cssBase?: string): string | null => {
    const contentId = /^cid:([^\s<>]+)$/i.exec(value)?.[1];
    if (contentId) return cid[contentId] ?? null;
    if (value.startsWith("data:")) {
      try {
        const match = /^data:(image\/(?:png|jpeg|gif|webp|avif|svg\+xml));base64,([a-z\d+/=\r\n]+)$/i.exec(value);
        if (!match || match[2]!.length > 700_000) return null;
        const bytes = Uint8Array.from(atob(match[2]!), character => character.charCodeAt(0));
        const valid = validatedImage(bytes, match[1]!.toLowerCase());
        let encoded = "";
        for (let index = 0; index < valid.body.length; index += 8192) encoded += String.fromCharCode(...valid.body.subarray(index, index + 8192));
        return `data:${valid.contentType};base64,${btoa(encoded)}`;
      } catch { return null; }
    }
    let url: string;
    try { url = remoteUrl(value.startsWith("//") ? "https:" + value : value, cssBase ?? base).href; } catch { return null; }
    if (new URL(url).hostname === ownHost.toLowerCase()) return null;
    const prior = registered.get(url); if (prior) return prior;
    if (assets.length >= assetLimit) return null;
    const id = String(assets.length), path = `${resourcePath}/assets/${id}`;
    registered.set(url, path); assets.push({ id, url }); return path;
  };
  const css = async (sheet: { text: string; base?: string; media?: string }, depth = 0, ancestry = new Set<string>()): Promise<string> => {
    cssBytes += sheet.text.length; if (cssBytes > 512 * 1024) return "";
    let imports = "";
    if (depth < 2) {
      try {
        const ast = parse(sheet.text);
        if (ast.type === "StyleSheet") for (const node of ast.children) {
          if (node.type !== "Atrule" || node.name.toLowerCase() !== "import" || node.prelude?.type !== "AtrulePrelude") continue;
          const first = node.prelude.children.first;
          if (first?.type !== "Url" && first?.type !== "String") continue;
          const imported = await stylesheet(first.value, sheet.base, depth + 1, ancestry);
          const media = generate(node.prelude).slice(generate(first).length).trim();
          if (!media) imports += imported;
          else if (/^[\w\s():.,%/\-]{1,500}$/.test(media)) imports += `@media ${media}{${imported}}`;
        }
      } catch {}
    }
    const result = imports + safeMailCss(sheet.text, value => image(value, sheet.base));
    return sheet.media && /^[\w\s():.,%/\-]{1,500}$/.test(sheet.media) ? `@media ${sheet.media}{${result}}` : result;
  };
  const loadedSheets = new Map<string, ReturnType<typeof cachedRemote>>();
  async function stylesheet(value: string, cssBase?: string, depth = 0, ancestry = new Set<string>()): Promise<string> {
    let url: string;
    try { url = remoteUrl(value, cssBase ?? base).href; } catch { return ""; }
    if (ancestry.has(url)) return "";
    let pending = loadedSheets.get(url);
    if (!pending) {
      if (stylesheetCount >= stylesheetLimit) return "";
      stylesheetCount++;
      pending = cachedRemote(url, "stylesheet", ownHost, cache, resourceFetch);
      loadedSheets.set(url, pending);
    }
    try {
      const loaded = await pending;
      return await css({ text: new TextDecoder().decode(loaded.body), base: loaded.url }, depth, new Set([...ancestry, url]));
    } catch { failures++; return ""; }
  }
  const formattedCss = (await Promise.all(sheets.map(async sheet => {
    if ("text" in sheet) return css(sheet);
    else {
      const loaded = await stylesheet(sheet.url);
      return sheet.media && /^[\w\s():.,%/\-]{1,500}$/.test(sheet.media) ? `@media ${sheet.media}{${loaded}}` : loaded;
    }
  }))).join("");
  const html = sanitizeHtml(source, {
    allowedTags: ["p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "blockquote", "pre", "code", "ul", "ol", "li", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "a", "img", "center", "font", "section", "article", "header", "footer", "main", "figure", "figcaption", "sup", "sub", "small", "del"],
    allowedAttributes: {
      "*": ["class", "id", "style", "dir", "lang", "align", "valign", "bgcolor", "background"],
      a: ["href", "title", "rel", "target"], img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan", "width", "height"], th: ["colspan", "rowspan", "width", "height"],
      table: ["width", "height", "cellpadding", "cellspacing", "border", "role"], col: ["width"], font: ["color", "face", "size"],
    },
    allowedSchemes: ["https", "http", "mailto"], allowedSchemesByTag: { a: ["https", "http", "mailto"], img: ["https", "http", "data"] },
    allowProtocolRelative: false, parseStyleAttributes: false,
    nonTextTags: ["style", "script", "textarea", "option", "title", "noscript", "head", "iframe", "object", "embed", "template"],
    transformTags: {
      "*": (name, attributes) => {
        const background = attributes.background ? image(attributes.background) : null;
        const style = (background ? `background-image:url(${background});` : "") + safeMailCss(attributes.style ?? "", value => image(value), true);
        const attribs = { ...attributes };
        delete attribs.background; delete attribs.style;
        if (background) attribs.background = background;
        if (style) attribs.style = style;
        return { tagName: name === "body" ? "div" : name, attribs };
      },
      a: (_name, attributes) => {
        let href = attributes.href ?? "";
        if (!/^mailto:/i.test(href)) { try { const url = new URL(href, base); href = ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { href = ""; } }
        return { tagName: "a", attribs: { ...attributes, href, target: "_blank", rel: "noopener noreferrer" } };
      },
      img: (_name, attributes) => {
        const tracking = Number(attributes.width) > 0 && Number(attributes.width) <= 2 && Number(attributes.height) > 0 && Number(attributes.height) <= 2;
        return { tagName: "img", attribs: { ...attributes, src: tracking ? "" : image(attributes.src ?? "") ?? "" } };
      },
    },
  });
  const result = { html: `<style>${formattedCss}</style>${html}`, assets, failures };
  if (!failures) await cache?.put(key, Response.json(result, { headers: cacheHeaders("application/json") })).catch(() => {});
  return result;
}
export async function loadMailRenderImage(asset: MailRenderAsset, ownHost: string, cache: RenderCache | undefined = frameCache(), fetcher: RemoteFetcher = runtimeRemoteFetcher): Promise<Response> {
  const result = await cachedRemote(asset.url, "image", ownHost, cache, fetcher);
  return new Response(result.body, { headers: { "Content-Type": result.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" } });
}
