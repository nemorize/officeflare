import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareMailRendering,
  embeddedMailRendering,
  preparedMailImage,
  mailRenderKey,
  memoryCache,
  remoteFixture,
  png,
} from "./mail-render-helpers.mjs";

function bucketFixture() {
  const values = new Map();
  return {
    values,
    async get(key) {
      const value = values.get(key);
      if (value === undefined) return null;
      const body = new Response(value);
      return {
        size: (await body.clone().arrayBuffer()).byteLength,
        json: () => body.json(),
        arrayBuffer: () => body.arrayBuffer(),
      };
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}
const message = { id: "message", body_r2_key: "bodies/box/message/inbound.json", attachments: [] },
  path = "/api/mail/mailboxes/box/messages/message/render",
  imageResponse = () => new Response(png, { headers: { "Content-Type": "image/png" } });

test("preparation embeds remote CSS backgrounds and validated CID images and survives cache eviction", async () => {
  const bucket = bucketFixture(),
    cache = memoryCache();
  const fixture = remoteFixture((url) =>
    url.pathname.endsWith(".css")
      ? new Response(".card{background:url(hero.png)}", { headers: { "Content-Type": "text/css" } })
      : imageResponse(),
  );
  await bucket.put("inline-logo", png);
  const input = {
    ...message,
    attachments: [
      { id: "logo", content_id: "logo@cid", content_type: "image/png", r2_key: "inline-logo" },
    ],
  };
  const prepared = await prepareMailRendering(bucket, input, "box", "office.test", {
    source:
      '<link rel="stylesheet" href="https://cdn.example.com/style.css"><div class="card"><img src="https://cdn.example.com/hero.png"><img src="cid:logo@cid"></div>',
    cache,
    fetcher: fixture.fetcher,
  });
  assert.equal(prepared.failures, 0);
  const html = embeddedMailRendering(prepared);
  assert.match(html, /background:url\(data:image\/png;base64,/);
  assert.equal(html.match(/src="data:image\/png;base64,/g).length, 2);
  assert.doesNotMatch(html, /cid:|cdn\.example|\/api\/mail/);
  assert.ok(bucket.values.has(mailRenderKey(input.body_r2_key)));
  cache.values.clear();
  bucket.values.delete("inline-logo");
  const saved = await prepareMailRendering(bucket, input, "box", "office.test", {
    fetcher: () => assert.fail("Prepared messages must not fetch remote resources again"),
  });
  assert.equal(embeddedMailRendering(saved), html);
  assert.deepEqual(new Uint8Array(await preparedMailImage(saved, path, "0").arrayBuffer()), png);
  assert.equal(preparedMailImage(saved, path, "00"), null);
});

test("partial failures persist, render safely and retry only missing images", async () => {
  const bucket = bucketFixture(),
    cache = memoryCache();
  let available = false;
  const fixture = remoteFixture((url) =>
    url.pathname === "/bad.png" && !available
      ? new Response(null, { status: 503 })
      : imageResponse(),
  );
  const options = {
    source:
      '<img src="https://cdn.example.com/good.png"><img src="https://cdn.example.com/bad.png"><p>Body still visible</p>',
    cache,
    fetcher: fixture.fetcher,
  };
  const partial = await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(partial.failures, 1);
  assert.match(embeddedMailRendering(partial), /Body still visible/);
  assert.doesNotMatch(embeddedMailRendering(partial), /\/api\/mail|https:/);
  const calls = fixture.calls.length;
  await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(fixture.calls.length, calls);
  assert.equal(preparedMailImage(partial, path, "1"), null);
  available = true;
  cache.values.clear();
  const retried = await prepareMailRendering(bucket, message, "box", "office.test", {
    ...options,
    retryFailures: true,
  });
  assert.equal(retried.failures, 0);
  assert.equal(fixture.calls.filter((call) => call.url.pathname === "/good.png").length, 1);
  assert.equal(fixture.calls.filter((call) => call.url.pathname === "/bad.png").length, 2);
});

test("embedding handles double digit asset IDs without corrupting data URLs", async () => {
  const bucket = bucketFixture(),
    fixture = remoteFixture(imageResponse);
  const result = await prepareMailRendering(bucket, message, "box", "office.test", {
    source: Array.from(
      { length: 13 },
      (_, index) => `<img src="https://cdn.example.com/${index}.png">`,
    ).join(""),
    cache: memoryCache(),
    fetcher: fixture.fetcher,
  });
  assert.equal(result.failures, 0);
  const sources = [...embeddedMailRendering(result).matchAll(/src="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.equal(sources.length, 13);
  assert.equal(new Set(sources).size, 1);
});

test("CID validation rejects spoofed bytes and the aggregate budget bounds embedded images", async () => {
  const bucket = bucketFixture(),
    files = [];
  for (let index = 0; index < 7; index++) {
    const bytes =
      index === 6 ? new TextEncoder().encode("not an image") : new Uint8Array(4 * 1024 ** 2);
    if (index !== 6) bytes.set(png);
    await bucket.put(`file-${index}`, bytes);
    files.push({
      id: String(index),
      content_id: String(index),
      content_type: "image/png",
      r2_key: `file-${index}`,
    });
  }
  const result = await prepareMailRendering(
    bucket,
    { ...message, attachments: files },
    "box",
    "office.test",
    {
      source: files.map((file) => `<img src="cid:${file.content_id}">`).join(""),
      cache: memoryCache(),
      fetcher: () => assert.fail("Inline images do not use the network"),
    },
  );
  assert.equal(result.failures, 2);
  assert.equal((embeddedMailRendering(result).match(/data:image\/png;base64,/g) ?? []).length, 5);
});

test("quoted content and changed body revisions use independent durable artifacts", async () => {
  const bucket = bucketFixture();
  await bucket.put(
    message.body_r2_key,
    JSON.stringify({ html: "<p>Body</p>", quoted_body: { html: "<p>Quote</p>" } }),
  );
  const options = { cache: memoryCache() };
  const body = await prepareMailRendering(bucket, message, "box", "office.test", options);
  const quote = await prepareMailRendering(bucket, message, "box", "office.test", {
    ...options,
    part: "quoted",
  });
  assert.match(body.html, />Body</);
  assert.match(quote.html, />Quote</);
  const changed = await prepareMailRendering(
    bucket,
    { ...message, body_r2_key: "bodies/box/message/new.json" },
    "box",
    "office.test",
    { ...options, source: "<p>Changed</p>" },
  );
  assert.match(changed.html, />Changed</);
  assert.equal(bucket.values.size, 4);
});

test("repeated large images cannot expand the HTML beyond the message budget", async () => {
  const bucket = bucketFixture(),
    body = new Uint8Array(4 * 1024 ** 2);
  body.set(png);
  await bucket.put("large-logo", body);
  const result = await prepareMailRendering(
    bucket,
    {
      ...message,
      attachments: [
        { id: "logo", content_id: "logo", content_type: "image/png", r2_key: "large-logo" },
      ],
    },
    "box",
    "office.test",
    {
      source: '<img src="cid:logo">'.repeat(100),
      cache: memoryCache(),
    },
  );
  assert.equal(result.failures, 1);
  assert.ok(embeddedMailRendering(result).length < 100_000);
});
