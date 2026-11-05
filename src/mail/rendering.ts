import {
  loadMailRenderImage,
  renderMailHtml,
  type MailRendering,
  type RenderCache,
} from "./render";
import { runtimeRemoteFetcher, validatedImage, type RemoteFetcher } from "./remote";
import { fail, type Attachment } from "./types";
import { t } from "../../shared/i18n/index.ts";

export type MailRenderPart = "body" | "quoted";
export const mailRenderKey = (bodyKey: string, part: MailRenderPart = "body") =>
  `${bodyKey}.render-v1${part === "quoted" ? "-quoted" : ""}.json`;

export interface PreparedMailRendering extends MailRendering {
  images: Record<string, string>;
}

const missingImage =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const imageBytes = 5 * 1024 ** 2,
  messageBytes = 20 * 1024 ** 2,
  imageLimit = 96;

function embeddedImage(body: Uint8Array, contentType: string) {
  let binary = "";
  for (let index = 0; index < body.length; index += 8192)
    binary += String.fromCharCode(...body.subarray(index, index + 8192));
  return `data:${contentType};base64,${btoa(binary)}`;
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

// Keep one durable, revision-specific artifact. Cache API entries alone can be evicted
// or live in a different region from the reader.
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
  } = {},
): Promise<PreparedMailRendering> {
  const part = options.part ?? "body",
    key = mailRenderKey(message.body_r2_key, part),
    object = await bucket.get(key),
    previous = object ? await object.json<PreparedMailRendering>() : undefined;
  if (previous && (!options.retryFailures || !previous.failures)) return previous;
  let source = options.source;
  if (source === undefined) {
    const bodyObject = await bucket.get(message.body_r2_key);
    if (!bodyObject) fail(503, t("mailService.mailBodyIsUnavailable"));
    const body = await bodyObject.json<{ html: string; quoted_body?: { html: string } }>();
    source = part === "quoted" ? (body.quoted_body?.html ?? "") : body.html;
  }
  const path = `/api/mail/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(message.id)}`,
    resourcePath = path + "/render",
    cid = Object.fromEntries(
      message.attachments
        .filter((file) => file.content_id && file.content_type.startsWith("image/"))
        .map((file) => [file.content_id!, `${path}/attachments/${file.id}`]),
    ),
    deadline = AbortSignal.timeout(12_000),
    fetcher = options.fetcher ?? runtimeRemoteFetcher,
    boundedFetch: RemoteFetcher = (input, init) =>
      fetcher(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      }),
    rendering = await renderMailHtml(
      source.slice(0, 2 * 1024 ** 2),
      cid,
      resourcePath,
      ownHost,
      options.cache,
      boundedFetch,
    );
  const resources = [
    ...rendering.assets.map((asset) => ({ source: `${resourcePath}/assets/${asset.id}`, asset })),
    ...message.attachments
      .filter(
        (file) => file.content_id && rendering.html.includes(`${path}/attachments/${file.id}`),
      )
      .map((file) => ({ source: `${path}/attachments/${file.id}`, file })),
  ];
  const images: Record<string, string> = {};
  const occurrences = new Map(resources.map((resource) => [resource.source, 0]));
  if (resources.length)
    for (const [source] of rendering.html.matchAll(imagePattern([...occurrences.keys()])))
      occurrences.set(source, occurrences.get(source)! + 1);
  let next = 0,
    bytes = 0,
    failures = rendering.failures + (source.length > 2 * 1024 ** 2 ? 1 : 0);
  await Promise.all(
    Array.from({ length: Math.min(4, resources.length) }, async () => {
      while (next < resources.length) {
        const index = next++,
          resource = resources[index]!,
          copies = occurrences.get(resource.source)!;
        images[resource.source] = missingImage;
        if (!copies) continue;
        try {
          if (index >= imageLimit || deadline.aborted || bytes >= messageBytes)
            throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
          const sameResource =
            "file" in resource ||
            previous?.assets.some(
              (asset) => asset.id === resource.asset.id && asset.url === resource.asset.url,
            );
          const saved = sameResource ? previous?.images[resource.source] : undefined;
          if (saved && saved !== missingImage) {
            const size =
              ((saved.length - saved.indexOf(",") - 1) * 0.75 -
                (saved.endsWith("==") ? 2 : saved.endsWith("=") ? 1 : 0)) *
              copies;
            if (bytes + size > messageBytes)
              throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
            bytes += size;
            images[resource.source] = saved;
            continue;
          }
          let body: Uint8Array, contentType: string;
          if ("file" in resource) {
            const object = await bucket.get(resource.file.r2_key);
            if (!object || object.size > imageBytes)
              throw new Error(t("mailRemote.unsupportedRemoteImage"));
            ({ body, contentType } = validatedImage(
              new Uint8Array(await object.arrayBuffer()),
              resource.file.content_type.toLowerCase(),
            ));
          } else {
            const response = await loadMailRenderImage(
              resource.asset,
              ownHost,
              options.cache,
              boundedFetch,
            );
            body = new Uint8Array(await response.arrayBuffer());
            contentType = response.headers.get("Content-Type")!;
          }
          // Count repeated uses as well: embedding one large image many times
          // must not expand a small message into an unbounded HTML response.
          const size = body.length * copies;
          if (bytes + size > messageBytes)
            throw new Error(t("mailRemote.remoteResourceIsTooLarge"));
          bytes += size;
          images[resource.source] = embeddedImage(body, contentType);
        } catch {
          failures++;
        }
      }
    }),
  );
  const prepared = { ...rendering, images, failures };
  await bucket.put(key, JSON.stringify(prepared), {
    httpMetadata: { contentType: "application/json" },
  });
  return prepared;
}

export function embeddedMailRendering(rendering: PreparedMailRendering) {
  const sources = Object.keys(rendering.images);
  if (!sources.length) return rendering.html;
  // One pass avoids matching /assets/1 inside /assets/10 or rewriting inserted data.
  return rendering.html.replace(imagePattern(sources), (source) => rendering.images[source]!);
}

export function preparedMailImage(
  rendering: PreparedMailRendering,
  resourcePath: string,
  id: string,
) {
  if (!rendering.assets.some((asset) => asset.id === id)) return null;
  const image = rendering.images[`${resourcePath}/assets/${id}`];
  if (!image || image === missingImage) return null;
  const [header, encoded] = image.split(","),
    body = Uint8Array.from(atob(encoded!), (character) => character.charCodeAt(0));
  return new Response(body, {
    headers: {
      "Content-Type": header!.slice(5, -7),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}
