import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteUrl, publicAddress, boundedBody, validatedImage, fetchRemoteAsset, safeMailCss, renderMailHtml, loadMailRenderImage, memoryCache, remoteFixture, png } from './mail-render-helpers.mjs';
const origin = 'office.test', path = '/api/mail/mailboxes/box/messages/message/render';
const imageResponse = () => new Response(png, { headers: { 'Content-Type': 'image/png' } });

test('remote resources accept public HTTPS names and reject local addresses, credentials and alternate ports', () => {
  assert.equal(remoteUrl('http://CDN.Example.com.:80/a#fragment').href, 'https://cdn.example.com/a');
  assert.equal(remoteUrl('../image.png', 'https://cdn.example.com/css/main.css').href, 'https://cdn.example.com/image.png');
  for (const url of ['https://localhost/a','https://printer.local/a','https://host.internal/a','https://127.0.0.1/a','https://2130706433/a','https://0x7f000001/a','https://[::1]/a','https://[::ffff:127.0.0.1]/a','https://user:secret@cdn.example.com/a','https://cdn.example.com:8443/a','file:///etc/passwd','data:image/png;base64,a','https://cdn.example.com/a\n','https://cdn.example.com/' + 'a'.repeat(4096)]) assert.throws(() => remoteUrl(url), url);
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','fe80::1','::ffff:93.184.216.34','2002:7f00:1::','invalid']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('93.184.216.34'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('proxy rejects mixed/private DNS, same-origin resources and private redirects before fetching them', async () => {
  const mixed = remoteFixture(imageResponse, () => ['93.184.216.34','10.0.0.1']);
  await assert.rejects(fetchRemoteAsset('https://cdn.example.com/a', 'image', origin, mixed.fetcher), /Private network/);
  assert.equal(mixed.calls.filter(call => call.url.hostname !== 'cloudflare-dns.com').length, 0);
  const own = remoteFixture(imageResponse);
  await assert.rejects(fetchRemoteAsset('https://office.test/private', 'image', origin, own.fetcher), /Application/);
  assert.equal(own.calls.length, 0);
  const redirected = remoteFixture(() => new Response(null, { status: 302, headers: { Location: 'https://private.example.com/image' } }), host => host === 'private.example.com' ? ['192.168.1.1'] : ['93.184.216.34']);
  await assert.rejects(fetchRemoteAsset('https://cdn.example.com/a', 'image', origin, redirected.fetcher), /Private network/);
  assert.equal(redirected.calls.filter(call => call.url.hostname === 'private.example.com').length, 0);
  const literal = remoteFixture(() => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } }));
  await assert.rejects(fetchRemoteAsset('https://cdn.example.com/a', 'image', origin, literal.fetcher), /public HTTPS/);
});

test('proxy uses fresh privacy headers, manually revalidates redirects and caps redirect loops', async () => {
  const fixture = remoteFixture(url => url.pathname === '/a' ? new Response(null, { status: 302, headers: { Location: 'https://images.example.com/b' } }) : imageResponse());
  const result = await fetchRemoteAsset('https://cdn.example.com/a', 'image', origin, fixture.fetcher);
  assert.equal(result.url, 'https://images.example.com/b');
  assert.deepEqual(result.body, png);
  for (const call of fixture.calls) {
    const headers = new Headers(call.options.headers);
    for (const name of ['cookie','authorization','referer','origin']) assert.equal(headers.has(name), false);
    for (const name of ['cf-connecting-ip','x-real-ip','x-forwarded-for','true-client-ip']) assert.equal(headers.get(name), '0.0.0.0');
    assert.equal(headers.get('user-agent'), 'Officeflare-Mail-Proxy/1.0');
    assert.ok(call.options.signal);
    assert.equal(call.options.redirect, 'manual');
  }
  assert.equal(fixture.calls.filter(call => call.url.hostname === 'cloudflare-dns.com').length, 4);
  const loop = remoteFixture(() => new Response(null, { status: 302, headers: { Location: '/a' } }));
  await assert.rejects(fetchRemoteAsset('https://cdn.example.com/a','image',origin,loop.fetcher), /redirect/);
  assert.equal(loop.calls.filter(call => call.url.hostname !== 'cloudflare-dns.com').length, 4);
});

test('proxy validates actual image bytes and enforces streaming byte and pixel limits', async () => {
  assert.deepEqual(validatedImage(png, 'image/png').body, png);
  assert.throws(() => validatedImage(new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'image/png'));
  assert.throws(() => validatedImage(png, 'image/jpeg'), /Unsupported/);
  const huge = png.slice(); new DataView(huge.buffer).setUint32(16, 100_000); new DataView(huge.buffer).setUint32(20, 100_000);
  assert.throws(() => validatedImage(huge, 'image/png'), /Unsupported/);
  await assert.rejects(boundedBody(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(6)); controller.close(); } }), { headers: { 'Content-Length': '1' } }), 10), /too large/);
  await assert.rejects(boundedBody(new Response(new Uint8Array(1), { headers: { 'Content-Length': '999' } }), 10), /too large/);
  const html = remoteFixture(() => new Response('<html>no</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(fetchRemoteAsset('https://cdn.example.com/a','image',origin,html.fetcher), /Unsupported/);
});

test('SVG images retain artwork while dropping executable and remote content', () => {
  const source = `<svg width="100" height="50" viewBox="0 0 100 50" onload="alert(1)"><script>alert(1)</script><foreignObject><iframe src="https://evil.example.com"></iframe></foreignObject><defs><linearGradient id="paint"><stop stop-color="#00f"/></linearGradient></defs><rect width="100" height="50" fill="url(#paint)"/><use href="https://evil.example.com/svg#x"/><use href="#paint"/><path d="M0 0" fill="url(https://evil.example.com)"/></svg>`;
  const result = new TextDecoder().decode(validatedImage(new TextEncoder().encode(source), 'image/svg+xml').body);
  assert.match(result, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(result, /viewBox="0 0 100 50"/);
  assert.match(result, /linearGradient/);
  assert.match(result, /fill="url\(#paint\)"/);
  assert.match(result, /href="#paint"/);
  assert.doesNotMatch(result, /onload|script|foreignObject|iframe|evil\.example/);
});

test('CSS AST sanitizer retains newsletter layout and removes unsafe functions, rules and viewport feedback', () => {
  const urls = [];
  const css = safeMailCss(`@import "https://evil.example.com/a";@font-face{src:url(https://evil.example.com/font)}.card{display:flex;gap:12px;color:rgb(1,2,3);background-image:url(https://cdn.example.com/a);width:calc(100% - 2px);height:100vh;position:fixed;behavior:url(x);font-size:expression(alert(1));--x:attr(secret);background:image-set("https://evil.example.com/a" 1x)}@media(max-width:600px){.card{display:block}}`, url => { urls.push(url); return '/safe/image'; });
  assert.match(css, /display:flex;gap:12px/); assert.match(css, /background-image:url\(\/safe\/image\)/);
  assert.match(css, /@media\s*\(max-width:600px\)/); assert.match(css, /width:calc/);
  assert.doesNotMatch(css, /@import|@font-face|evil|expression|attr|image-set|100vh|fixed|behavior/);
  assert.deepEqual(urls, ['https://cdn.example.com/a']);
  const escaped = safeMailCss('color:red;background:u\\72l(https://evil.example.com);font-size:e\\78pression(alert(1));', () => null, true);
  assert.equal(escaped, 'color:red');
  assert.doesNotMatch(safeMailCss('.x{font-family:"</style><img src=x>"}', () => null), /<\/style/);
});

test('reading restores class styles, ordered external styles, imports, relative backgrounds and responsive rules', async () => {
  const fixture = remoteFixture(url => new Response(url.pathname.endsWith('base.css') ? '.card{color:blue}' : '@import "base.css" screen;.card{background:url(../hero.png);color:green}@media(max-width:600px){.card{width:100%}}', { headers: { 'Content-Type': 'text/css' } }));
  const result = await renderMailHtml(`<html><head><style>.card{color:red}</style><link rel="stylesheet" href="https://cdn.example.com/css/main.css"><style>.card{color:purple}</style></head><body><table class="card" id="newsletter" style="border-spacing:0"><tr><td>Hello<img src="https://cdn.example.com/hero.png" width="200" height="100"></td></tr></table></body></html>`, {}, path, origin, memoryCache(), fixture.fetcher);
  assert.equal(result.failures, 0);
  assert.match(result.html, /class="card" id="newsletter"/);
  assert.match(result.html, /@media screen\{\.card\{color:blue\}\}/);
  assert.match(result.html, /@media\s*\(max-width:600px\)/);
  assert.ok(result.html.indexOf('color:red') < result.html.indexOf('color:green'));
  assert.ok(result.html.indexOf('color:green') < result.html.indexOf('color:purple'));
  assert.deepEqual(result.assets, [{ id: '0', url: 'https://cdn.example.com/hero.png' }]);
  assert.match(result.html, /background:url\(\/api\/mail\/mailboxes\/box\/messages\/message\/render\/assets\/0\)/);
  assert.match(result.html, /src="\/api\/mail\/mailboxes\/box\/messages\/message\/render\/assets\/0"/);
});

test('reading preserves valid embedded and CID images, hides tracking pixels, and strips executable markup', async () => {
  const cid = '/api/mail/mailboxes/box/messages/message/attachments/cid';
  const result = await renderMailHtml(`<base href="https://cdn.example.com/news/"><script>alert('pwn')</script><form action="https://evil.example.com"><input name=x></form><iframe src="https://evil.example.com"></iframe><img src="https://track.example.com/open" width="1" height="1"><img src="cid:photo"><img src="data:image/png;base64,${Buffer.from(png).toString('base64')}"><img src="javascript:alert(1)"><img src="https://office.test/api/private"><img src="../large.png"><a href="../post" onclick="alert(1)">Read</a><div background="https://cdn.example.com/large.png" style="color:blue;background-image:url(http://127.0.0.1/x)">Body</div>`, { photo: cid }, path, origin, memoryCache());
  assert.equal(result.failures, 0);
  assert.deepEqual(result.assets, [{ id: '0', url: 'https://cdn.example.com/large.png' }]);
  assert.match(result.html, new RegExp(cid));
  assert.match(result.html, /src="data:image\/png;base64,/);
  assert.match(result.html, /href="https:\/\/cdn.example.com\/post" target="_blank" rel="noopener noreferrer"/);
  assert.match(result.html, /background-image:url\(\/api\/mail/);
  assert.doesNotMatch(result.html, /script|form|input|iframe|onclick|javascript:|evil\.example|127\.0\.0\.1|office\.test|track\.example/);
});

test('shared cache avoids repeat origin fetches; partial failures remain retryable and images are private', async () => {
  const cache = memoryCache(); let failed = true;
  const fixture = remoteFixture(url => url.pathname === '/main.css' ? failed ? new Response(null, { status: 503 }) : new Response('.card{color:blue}', { headers: { 'Content-Type': 'text/css' } }) : imageResponse());
  const source = '<link rel="stylesheet" href="https://cdn.example.com/main.css"><div class="card"><img src="https://cdn.example.com/a.png"></div>';
  const first = await renderMailHtml(source, {}, path, origin, cache, fixture.fetcher);
  assert.equal(first.failures, 1); failed = false;
  const retry = await renderMailHtml(source, {}, path, origin, cache, fixture.fetcher);
  assert.equal(retry.failures, 0); assert.match(retry.html, /color:blue/);
  const count = fixture.calls.length;
  assert.deepEqual(await renderMailHtml(source, {}, path, origin, cache, fixture.fetcher), retry);
  assert.equal(fixture.calls.length, count);
  const image = await loadMailRenderImage(retry.assets[0], origin, cache, fixture.fetcher);
  assert.equal(image.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(image.headers.get('Content-Security-Policy'), 'sandbox');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  const afterImage = fixture.calls.length;
  await loadMailRenderImage(retry.assets[0], origin, cache, fixture.fetcher);
  assert.equal(fixture.calls.length, afterImage);
});

test('rendering caps resource count and stylesheet import cycles', async () => {
  const fixture = remoteFixture(() => new Response('@import "https://cdn.example.com/loop.css";.x{color:red}', { headers: { 'Content-Type': 'text/css' } }));
  const result = await renderMailHtml('<link rel="stylesheet" href="https://cdn.example.com/loop.css">' + Array.from({ length: 120 }, (_, n) => `<img src="https://cdn.example.com/${n}.png">`).join(''), {}, path, origin, memoryCache(), fixture.fetcher);
  assert.equal(result.assets.length, 96);
  assert.equal(fixture.calls.filter(call => call.url.hostname !== 'cloudflare-dns.com').length, 1);
  await assert.rejects(renderMailHtml('a'.repeat(2 * 1024 ** 2 + 1), {}, path, origin), /too large/);
});
test('repeated stylesheet references retain their cascade position without repeat downloads', async () => {
  const fixture = remoteFixture(() => new Response('.x{color:blue}', { headers: { 'Content-Type': 'text/css' } }));
  const result = await renderMailHtml('<link rel="stylesheet" href="https://cdn.example.com/main.css"><style>.x{color:red}</style><link rel="stylesheet" href="https://cdn.example.com/main.css"><p class="x">Mail</p>', {}, path, origin, memoryCache(), fixture.fetcher);
  assert.match(result.html, /\.x\{color:blue\}\.x\{color:red\}\.x\{color:blue\}/);
  assert.equal(fixture.calls.filter(call => call.url.hostname !== 'cloudflare-dns.com').length, 1);
});
test('inline link and image styles rewrite each background URL once', async () => {
  const result = await renderMailHtml('<base href="https://cdn.example.com"><a style="background-image:url(https://cdn.example.com/bg.png)" href="https://example.com">Link</a><img src="https://cdn.example.com/a.png" style="background-image:url(https://cdn.example.com/bg.png)">', {}, path, origin, memoryCache());
  assert.deepEqual(result.assets, [{ id: '0', url: 'https://cdn.example.com/bg.png' }, { id: '1', url: 'https://cdn.example.com/a.png' }]);
  assert.equal(result.html.match(/background-image:url\(\/api\/mail\/mailboxes\/box\/messages\/message\/render\/assets\/0\)/g).length, 2);
  assert.doesNotMatch(result.html, /background(?:=""|>)/);
});

test('default remote fetching preserves the Worker global receiver for DNS, CSS and images', async t => {
  const fixture = remoteFixture(url => url.pathname.endsWith('.css') ? new Response('.body{color:#123456}', { headers: { 'Content-Type': 'text/css' } }) : imageResponse());
  t.mock.method(globalThis, 'fetch', function(input, init) { assert.equal(this, globalThis, 'Worker fetch must retain its global receiver'); assert.notEqual(init.redirect, 'error', 'Workers do not implement redirect:error'); return fixture.fetcher(input, init); });
  const image = await fetchRemoteAsset('https://cdn.example.com/image.png', 'image', origin);
  assert.equal(image.contentType, 'image/png');
  const rendered = await renderMailHtml('<link rel="stylesheet" href="https://cdn.example.com/style.css"><p class="body">Body</p><img src="https://cdn.example.com/image.png">', {}, path, origin, memoryCache());
  assert.equal(rendered.failures, 0); assert.match(rendered.html, /#123456/);
  const response = await loadMailRenderImage(rendered.assets[0], origin, memoryCache());
  assert.equal(response.headers.get('Content-Type'), 'image/png');
});

test('DNS verification refuses redirects instead of following a potentially private target', async () => {
  const calls = [];
  await assert.rejects(fetchRemoteAsset('https://cdn.example.com/image.png', 'image', origin, async (input, options) => {
    calls.push(String(input)); assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://internal.example.com/' } });
  }), /DNS lookup failed/);
  assert.ok(calls.every(url => url.startsWith('https://cloudflare-dns.com/')));
});
