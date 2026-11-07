import {
  loadMailRenderImage,
  renderMailHtml,
  type MailRendering,
  type RenderCache,
} from "./render";
import { runtimeRemoteFetcher, renderableImage, type RemoteFetcher } from "./remote";
import { fail, type Attachment } from "./types";
import { t } from "../../shared/i18n/index.ts";

export type MailRenderPart = "body" | "quoted";
export const mailRenderKey = (bodyKey: string, part: MailRenderPart = "body") =>
  `${bodyKey}.render-v2${part === "quoted" ? "-quoted" : ""}.json`;
export const legacyMailRenderKey = (bodyKey: string, part: MailRenderPart = "body") =>
  `${bodyKey}.render-v1${part === "quoted" ? "-quoted" : ""}.json`;
export const mailRenderImagePrefix = (bodyKey: string) => `${bodyKey}.render-images/`;
export const mailRenderImageKey = (bodyKey: string, id: string) =>
  mailRenderImagePrefix(bodyKey) + id;
export interface StoredMailImage {
  id: string;
  size: number;
  contentType: string;
}
export interface PreparedMailRendering extends MailRendering {
  format: 2;
  images: Record<string, StoredMailImage | null>;
  retryAfter?: number;
  retryAttempts?: number;
}
interface LegacyRendering extends MailRendering {
  images: Record<string, string>;
}
const missingImage =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const imageBytes = 5 * 1024 ** 2,
  messageBytes = 20 * 1024 ** 2,
  imageLimit = 96;
const dataImages =
  /data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|heic|heif);base64,[a-z\d+/=\r\n]+/gi;
function decodedImage(value: string, images?: ImagesBinding) {
  const comma = value.indexOf(","),
    contentType = value.slice(5, value.indexOf(";"));
  if (value.length > (imageBytes * 4) / 3 + 256)
    throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
  return renderableImage(
    Uint8Array.from(atob(value.slice(comma + 1)), (c) => c.charCodeAt(0)),
    contentType,
    images,
  );
}
function imagePattern(sources: string[]) {
  return new RegExp(
    sources
      .sort((a, b) => b.length - a.length)
      .map((source) => source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );
}
function createImageWriter(bucket: R2Bucket, bodyKey: string) {
  const pending = new Map<string, Promise<StoredMailImage>>();
  return async (body: Uint8Array, contentType: string): Promise<StoredMailImage> => {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>),
    );
    const id = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    let write = pending.get(id);
    if (!write) {
      write = bucket
        .put(mailRenderImageKey(bodyKey, id), body, { httpMetadata: { contentType } })
        .then(() => ({ id, size: body.length, contentType }));
      pending.set(id, write);
    }
    return write;
  };
}
function extractDataImages(html: string, resourcePath: string) {
  const embedded = new Map<string, string>();
  const sources = new Map<string, string>();
  return {
    html: html.replace(dataImages, (value) => {
      let source = sources.get(value);
      if (!source) {
        source = `${resourcePath}/inline/${sources.size}`;
        sources.set(value, source);
        embedded.set(source, value);
      }
      return source;
    }),
    embedded,
  };
}

// Old Base64 manifests are converted locally without fetching the sender again.
async function upgradeRendering(
  bucket: R2Bucket,
  bodyKey: string,
  resourcePath: string,
  legacy: LegacyRendering,
  imageBinding?: ImagesBinding,
) {
  const extracted = extractDataImages(legacy.html, resourcePath);
  const images: PreparedMailRendering["images"] = {};
  const saveImage = createImageWriter(bucket, bodyKey);
  let failures = legacy.failures,
    index = 0,
    bytes = 0;
  for (const [source, value] of [...Object.entries(legacy.images), ...extracted.embedded]) {
    images[source] = null;
    if (value === missingImage) continue;
    let image: Awaited<ReturnType<typeof decodedImage>>;
    try {
      if (index++ >= imageLimit) throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
      image = await decodedImage(value, imageBinding);
      bytes += image.body.length;
      if (bytes > messageBytes) throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
    } catch {
      failures++;
      continue;
    }
    // Storage failures must leave the old manifest intact for a safe retry.
    images[source] = await saveImage(image.body, image.contentType);
  }
  return { format: 2 as const, html: extracted.html, assets: legacy.assets, images, failures };
}

export async function prepareMailRendering(
  bucket: R2Bucket,
  message: { id: string; body_r2_key: string; attachments: Attachment[] },
  mailboxId: string,
  ownHost: string,
  options: {
    part?: MailRenderPart;
    retryFailures?: boolean;
    source?: string;
    cache?: RenderCache;
    fetcher?: RemoteFetcher;
    images?: ImagesBinding;
  } = {},
): Promise<PreparedMailRendering> {
  const part = options.part ?? "body",
    key = mailRenderKey(message.body_r2_key, part);
  const path = `/api/mail/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(message.id)}`,
    resourcePath = path + "/render";
  const object = await bucket.get(key);
  let previous = object ? await object.json<PreparedMailRendering>() : undefined;
  if (!previous) {
    const legacyKey = legacyMailRenderKey(message.body_r2_key, part),
      legacy = await bucket.get(legacyKey);
    if (legacy) {
      previous = await upgradeRendering(
        bucket,
        message.body_r2_key,
        resourcePath,
        await legacy.json<LegacyRendering>(),
        options.images,
      );
      await bucket.put(key, JSON.stringify(previous), {
        httpMetadata: { contentType: "application/json" },
      });
      await bucket.delete(legacyKey);
    }
  }
  if (
    previous &&
    (!previous.failures || (!options.retryFailures && (previous.retryAfter ?? 0) > Date.now()))
  )
    return previous;
  let source = options.source;
  if (source === undefined) {
    const bodyObject = await bucket.get(message.body_r2_key);
    if (!bodyObject) fail(503, t("mailService.mailBodyIsUnavailable"));
    const body = await bodyObject.json<{ html: string; quoted_body?: { html: string } }>();
    source = part === "quoted" ? (body.quoted_body?.html ?? "") : body.html;
  }
  const cid = Object.fromEntries(
    message.attachments
      .filter((file) => file.content_id && file.content_type.startsWith("image/"))
      .map((file) => [file.content_id!, `${path}/attachments/${file.id}`]),
  );
  const deadline = AbortSignal.timeout(12_000),
    fetcher = options.fetcher ?? runtimeRemoteFetcher;
  const dns = new Map<string, Promise<Response>>();
  const boundedFetch: RemoteFetcher = async (input, init) => {
    const url = String(input),
      signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    if (url.startsWith("https://cloudflare-dns.com/dns-query?")) {
      let pending = dns.get(url);
      if (!pending) {
        pending = fetcher(input, { ...init, signal });
        dns.set(url, pending);
      }
      return (await pending).clone();
    }
    return fetcher(input, { ...init, signal });
  };
  const rendering = await renderMailHtml(
    source.slice(0, 2 * 1024 ** 2),
    cid,
    resourcePath,
    ownHost,
    options.cache,
    boundedFetch,
  );
  const extracted = extractDataImages(rendering.html, resourcePath);
  type Resource = {
    source: string;
    asset?: MailRendering["assets"][number];
    file?: Attachment;
    embedded?: string;
  };
  const resources: Resource[] = [
    ...rendering.assets.map((asset) => ({ source: `${resourcePath}/assets/${asset.id}`, asset })),
    ...message.attachments
      .filter(
        (file) => file.content_id && rendering.html.includes(`${path}/attachments/${file.id}`),
      )
      .map((file) => ({ source: `${path}/attachments/${file.id}`, file })),
    ...[...extracted.embedded].map(([source, embedded]) => ({ source, embedded })),
  ];
  const images: PreparedMailRendering["images"] = {};
  const saveImage = createImageWriter(bucket, message.body_r2_key);
  let next = 0,
    bytes = 0,
    failures = rendering.failures + (source.length > 2 * 1024 ** 2 ? 1 : 0);
  await Promise.all(
    Array.from({ length: Math.min(4, resources.length) }, async () => {
      while (next < resources.length) {
        const index = next++,
          resource = resources[index]!;
        images[resource.source] = null;
        let body: Uint8Array, contentType: string;
        try {
          if (index >= imageLimit || bytes >= messageBytes)
            throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
          const sameResource =
            !resource.asset ||
            previous?.assets.some(
              (asset) => asset.id === resource.asset!.id && asset.url === resource.asset!.url,
            );
          const saved = sameResource ? previous?.images[resource.source] : undefined;
          if (saved) {
            bytes += saved.size;
            if (bytes > messageBytes) throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
            images[resource.source] = saved;
            continue;
          }
          if (deadline.aborted) throw deadline.reason;
          if (resource.embedded)
            ({ body, contentType } = await decodedImage(resource.embedded, options.images));
          else if (resource.file) {
            const object = await bucket.get(resource.file.r2_key);
            if (!object || object.size > imageBytes)
              throw new Error(t("mailRemote.unsupportedRemoteImage"));
            ({ body, contentType } = await renderableImage(
              new Uint8Array(await object.arrayBuffer()),
              resource.file.content_type.toLowerCase(),
              options.images,
            ));
          } else {
            const response = await loadMailRenderImage(
              resource.asset!,
              ownHost,
              options.cache,
              boundedFetch,
              options.images,
            );
            body = new Uint8Array(await response.arrayBuffer());
            contentType = response.headers.get("Content-Type")!;
          }
          if (bytes + body.length > messageBytes)
            throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
          bytes += body.length;
        } catch (error) {
          failures++;
          console.warn("Mail image preparation failed", {
            messageId: message.id,
            source: resource.source,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        images[resource.source] = await saveImage(body, contentType);
      }
    }),
  );
  const prepared: PreparedMailRendering = {
    ...rendering,
    format: 2,
    html: extracted.html,
    images,
    failures,
    ...(failures
      ? {
          retryAttempts: Math.min((previous?.retryAttempts ?? 0) + 1, 7),
          retryAfter:
            Date.now() +
            Math.min(60_000 * 2 ** Math.min(previous?.retryAttempts ?? 0, 6), 3600_000),
        }
      : {}),
  };
  await bucket.put(key, JSON.stringify(prepared), {
    httpMetadata: { contentType: "application/json" },
  });
  return prepared;
}

const preparing = new Map<string, Promise<void>>();
/** A reader only waits for the stored manifest; downloads and conversions run after the response. */
export async function readMailRendering(
  bucket: R2Bucket,
  message: { id: string; body_r2_key: string; attachments: Attachment[] },
  mailboxId: string,
  ownHost: string,
  options: NonNullable<Parameters<typeof prepareMailRendering>[4]> & {
    defer: (task: Promise<void>) => void;
  },
) {
  const part = options.part ?? "body";
  const key = mailRenderKey(message.body_r2_key, part);
  const object = await bucket.get(key);
  const rendering = object ? await object.json<PreparedMailRendering>() : null;
  const taskKey = `${mailboxId}/${message.id}/${key}`;
  let task = preparing.get(taskKey);
  if (
    !task &&
    (!rendering ||
      (rendering.failures && (options.retryFailures || (rendering.retryAfter ?? 0) <= Date.now())))
  ) {
    task = prepareMailRendering(bucket, message, mailboxId, ownHost, options)
      .then(() => {})
      .catch((error: unknown) =>
        console.warn("Mail rendering preparation failed", { messageId: message.id, error }),
      )
      .finally(() => {
        preparing.delete(taskKey);
      });
    preparing.set(taskKey, task);
  }
  if (task) options.defer(task);
  return { rendering, pending: !!task };
}

export function linkedMailRendering(
  rendering: PreparedMailRendering,
  resourcePath: string,
  query: string,
) {
  const sources = Object.keys(rendering.images);
  if (!sources.length) return rendering.html;
  return rendering.html.replace(imagePattern(sources), (source) => {
    const image = rendering.images[source];
    return image ? `${resourcePath}/assets/${image.id}?${query}` : "";
  });
}
export function preparedMailImageId(
  rendering: PreparedMailRendering,
  resourcePath: string,
  id: string,
) {
  if (/^[a-f0-9]{64}$/.test(id))
    return Object.values(rendering.images).some((image) => image?.id === id) ? id : null;
  return rendering.images[`${resourcePath}/assets/${id}`]?.id ?? null;
}
export async function loadPreparedMailImage(
  bucket: R2Bucket,
  bodyKey: string,
  id: string,
  etag?: string,
) {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const object = await bucket.get(
    mailRenderImageKey(bodyKey, id),
    etag ? { onlyIf: new Headers({ "If-None-Match": etag }) } : undefined,
  );
  if (!object) return null;
  return new Response("body" in object ? object.body : null, {
    status: "body" in object ? 200 : 304,
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      ETag: object.httpEtag,
      "Cache-Control": "private, max-age=300, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Referrer-Policy": "no-referrer",
    },
  });
}
