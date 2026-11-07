import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const directory = await mkdtemp(join(tmpdir(), "officeflare-mail-render-tests-"));
const output = join(directory, "helpers.mjs");
try {
  await build({
    stdin: {
      contents: `export * from './src/mail/render.ts';export * from './src/mail/remote.ts';export * from './src/mail/rendering.ts';export * from './src/mail/render-access.ts';`,
      resolveDir: resolve("."),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    banner: {
      js: `import { createRequire as testRequire } from 'node:module';const require=testRequire(import.meta.url);`,
    },
    logLevel: "silent",
  });
  const helpers = await import(pathToFileURL(output).href);
  var {
    remoteUrl,
    publicAddress,
    boundedBody,
    validatedImage,
    renderableImage,
    fetchRemoteAsset,
    safeMailCss,
    renderMailHtml,
    loadMailRenderImage,
    remoteAssetCacheRequest,
    prepareMailRendering,
    readMailRendering,
    linkedMailRendering,
    preparedMailImageId,
    loadPreparedMailImage,
    legacyMailRenderKey,
    mailRenderImageKey,
    signMailImageGrant,
    verifyMailImageGrant,
    mailRenderKey,
  } = helpers;
} finally {
  await rm(directory, { recursive: true, force: true });
}
export {
  remoteUrl,
  publicAddress,
  boundedBody,
  validatedImage,
  renderableImage,
  fetchRemoteAsset,
  safeMailCss,
  renderMailHtml,
  loadMailRenderImage,
  remoteAssetCacheRequest,
  prepareMailRendering,
  readMailRendering,
  linkedMailRendering,
  preparedMailImageId,
  loadPreparedMailImage,
  legacyMailRenderKey,
  mailRenderImageKey,
  signMailImageGrant,
  verifyMailImageGrant,
  mailRenderKey,
};
export const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNQj15EU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAL74kD323sxUAAAAAElFTkSuQmCC",
    "base64",
  ),
);
export const webp = Uint8Array.from(
  Buffer.from(
    "UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoIAAgAAUAmJaACdLoB+AADsAD+8U2v/M0M8lHlw/8WcjEdl4AAAA==",
    "base64",
  ),
);
// The conversion unit tests assert that these opaque bytes reach Images intact.
export const heic = Uint8Array.from(
  Buffer.from("000000186674797068656963000000006d69663168656963", "hex"),
);
export function imageBindingFixture({ width = 8, height = 8, output = webp } = {}) {
  const calls = [];
  return {
    calls,
    async info(stream) {
      calls.push({ kind: "info", body: new Uint8Array(await new Response(stream).arrayBuffer()) });
      return { format: "image/heic", fileSize: heic.length, width, height };
    },
    input(stream) {
      return {
        async output(options) {
          calls.push({
            kind: "output",
            body: new Uint8Array(await new Response(stream).arrayBuffer()),
            options,
          });
          return {
            response: () => new Response(output, { headers: { "Content-Type": "image/webp" } }),
          };
        },
      };
    },
  };
}
export function memoryCache() {
  const values = new Map();
  return {
    values,
    async match(request) {
      return values.get(request.url)?.clone();
    },
    async put(request, response) {
      values.set(request.url, response.clone());
    },
  };
}
export function remoteFixture(respond, records = () => ["93.184.216.34"]) {
  const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, options });
    if (url.hostname === "cloudflare-dns.com")
      return Response.json({
        Status: 0,
        Answer:
          url.searchParams.get("type") === "A"
            ? records(url.searchParams.get("name")).map((data) => ({ type: 1, data }))
            : [],
      });
    return respond(url, options);
  };
  return { calls, fetcher };
}
