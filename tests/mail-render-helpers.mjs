import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'officeflare-mail-render-tests-'));
const output = join(directory, 'helpers.mjs');
try {
  await build({ stdin: { contents: `export * from './src/mail/render.ts';export * from './src/mail/remote.ts';`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', outfile: output, banner: { js: `import { createRequire as testRequire } from 'node:module';const require=testRequire(import.meta.url);` }, logLevel: 'silent' });
  const helpers = await import(pathToFileURL(output).href);
  var { remoteUrl, publicAddress, boundedBody, validatedImage, fetchRemoteAsset, safeMailCss, renderMailHtml, loadMailRenderImage, remoteAssetCacheRequest } = helpers;
} finally { await rm(directory, { recursive: true, force: true }); }
export { remoteUrl, publicAddress, boundedBody, validatedImage, fetchRemoteAsset, safeMailCss, renderMailHtml, loadMailRenderImage, remoteAssetCacheRequest };
export const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNQj15EU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAL74kD323sxUAAAAAElFTkSuQmCC','base64'));
export function memoryCache() {
  const values = new Map();
  return { values, async match(request) { return values.get(request.url)?.clone(); }, async put(request, response) { values.set(request.url, response.clone()); } };
}
export function remoteFixture(respond, records = () => ['93.184.216.34']) {
  const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, options });
    if (url.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? records(url.searchParams.get('name')).map(data => ({ type: 1, data })) : [] });
    return respond(url, options);
  };
  return { calls, fetcher };
}
