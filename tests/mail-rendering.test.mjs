import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareMailRendering,
  readMailRendering,
  linkedMailRendering,
  preparedMailImageId,
  loadPreparedMailImage,
  mailRenderKey,
  legacyMailRenderKey,
  mailRenderImageKey,
  signMailImageGrant,
  verifyMailImageGrant,
  memoryCache,
  remoteFixture,
  png,
  heic,
  webp,
  imageBindingFixture,
} from "./mail-render-helpers.mjs";
function bucketFixture() {
  const values = new Map(),
    metadata = new Map();
  return {
    values,
    async get(key, options) {
      const value = values.get(key);
      if (value === undefined) return null;
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      const etag = '"' + bytes.length + '"';
      const object = { size: bytes.length, httpEtag: etag, httpMetadata: metadata.get(key) };
      if (options?.onlyIf?.get("If-None-Match") === etag) return object;
      return {
        ...object,
        body: new Response(bytes).body,
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
        arrayBuffer: async () => bytes.buffer,
      };
    },
    async put(key, value, options) {
      values.set(key, value);
      metadata.set(key, options?.httpMetadata);
    },
    async delete(key) {
      values.delete(key);
      metadata.delete(key);
    },
  };
}
const message = { id: "message", body_r2_key: "bodies/box/message/inbound.json", attachments: [] },
  path = "/api/mail/mailboxes/box/messages/message/render",
  imageResponse = () => new Response(png, { headers: { "Content-Type": "image/png" } });
const linked = (result) => linkedMailRendering(result, path, "grant=test");

test(
  "readers return cached HTML before slow image repair finishes and share the repair task",
  { timeout: 3000 },
  async () => {
    const bucket = bucketFixture(),
      cache = memoryCache(),
      tasks = [];
    const options = {
      source:
        '<p>Visible now</p><img src="https://cdn.example.com/good.png"><img src="https://cdn.example.com/slow.png">',
      cache,
    };
    const first = await prepareMailRendering(bucket, message, "box", "office.test", {
      ...options,
      fetcher: remoteFixture((url) =>
        url.pathname === "/slow.png" ? new Response(null, { status: 503 }) : imageResponse(),
      ).fetcher,
    });
    let finish;
    const slow = new Promise((resolve) => {
      finish = resolve;
    });
    const readOptions = {
      ...options,
      retryFailures: true,
      defer: (task) => tasks.push(task),
      fetcher: remoteFixture((url) => {
        assert.equal(url.pathname, "/slow.png");
        return slow;
      }).fetcher,
    };
    const current = await readMailRendering(bucket, message, "box", "office.test", readOptions);
    assert.equal(current.pending, true);
    assert.equal(current.rendering.html, first.html);
    assert.equal(current.rendering.failures, 1);
    await readMailRendering(bucket, message, "box", "office.test", readOptions);
    assert.equal(tasks[0], tasks[1], "Concurrent readers must share one background job");
    finish(imageResponse());
    await tasks[0];
    const ready = await readMailRendering(bucket, message, "box", "office.test", {
      ...readOptions,
      retryFailures: false,
    });
    assert.equal(ready.pending, false);
    assert.equal(ready.rendering.failures, 0);
  },
);

test(
  "a first reader returns without waiting for preparation of old mail",
  { timeout: 3000 },
  async () => {
    const bucket = bucketFixture(),
      tasks = [];
    await bucket.put(
      message.body_r2_key,
      JSON.stringify({ html: '<p>Old mail</p><img src="https://cdn.example.com/photo.png">' }),
    );
    let finish;
    const slow = new Promise((resolve) => {
      finish = resolve;
    });
    const options = {
      cache: memoryCache(),
      fetcher: remoteFixture(() => slow).fetcher,
      defer: (task) => tasks.push(task),
    };
    const current = await readMailRendering(bucket, message, "box", "office.test", options);
    assert.equal(current.rendering, null);
    assert.equal(current.pending, true);
    finish(imageResponse());
    await tasks[0];
    const ready = await readMailRendering(bucket, message, "box", "office.test", options);
    assert.equal(ready.pending, false);
    assert.equal(ready.rendering.failures, 0);
  },
);

test("remote, CID and embedded HEIC images are converted on the server and stored as WebP in R2", async () => {
  const bucket = bucketFixture(),
    images = imageBindingFixture();
  await bucket.put("heic-attachment", heic);
  const input = {
    ...message,
    attachments: [
      { id: "photo", content_id: "photo", content_type: "image/heic", r2_key: "heic-attachment" },
    ],
  };
  const result = await prepareMailRendering(bucket, input, "box", "office.test", {
    source: `<img src="https://cdn.example.com/photo.heic"><img src="cid:photo"><img src="data:image/heif;base64,${Buffer.from(heic).toString("base64")}">`,
    cache: memoryCache(),
    fetcher: remoteFixture(() => new Response(heic, { headers: { "Content-Type": "image/heic" } }))
      .fetcher,
    images,
  });
  assert.equal(result.failures, 0);
  assert.equal(Object.keys(result.images).length, 3);
  assert.doesNotMatch(linked(result), /data:|base64|\.heic|\/attachments\//);
  const saved = Object.values(result.images)[0];
  assert.equal(saved.contentType, "image/webp");
  assert.deepEqual(
    new Uint8Array(
      await (await loadPreparedMailImage(bucket, input.body_r2_key, saved.id)).arrayBuffer(),
    ),
    webp,
  );
  const conversions = images.calls.length;
  await prepareMailRendering(bucket, input, "box", "office.test", {
    images,
    fetcher: () => assert.fail("Saved conversion must be reused"),
  });
  assert.equal(images.calls.length, conversions);
});

test("old failed renderings recover automatically on read while successful R2 images are reused", async () => {
  const bucket = bucketFixture(),
    cache = memoryCache();
  const options = {
    source:
      '<img src="https://cdn.example.com/good.png"><img src="https://cdn.example.com/photo.heic">',
    cache,
    fetcher: remoteFixture((url) =>
      url.pathname.endsWith(".heic")
        ? new Response(heic, { headers: { "Content-Type": "image/heic" } })
        : imageResponse(),
    ).fetcher,
  };
  const first = await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(first.failures, 1);
  const { retryAfter, retryAttempts, ...old } = first;
  await bucket.put(mailRenderKey(message.body_r2_key), JSON.stringify(old));
  const retry = await prepareMailRendering(bucket, message, "box", "office.test", {
    ...options,
    images: imageBindingFixture(),
    fetcher: remoteFixture((url) => {
      assert.equal(url.pathname, "/photo.heic", "Good image must remain in R2");
      return new Response(heic, { headers: { "Content-Type": "image/heic" } });
    }).fetcher,
  });
  assert.equal(retry.failures, 0);
  assert.equal(Object.values(retry.images).filter(Boolean).length, 2);
  assert.equal(retry.retryAfter, undefined);
});

test("automatic retries back off and recover temporary failures without a manual retry", async (t) => {
  const bucket = bucketFixture(),
    cache = memoryCache();
  let now = Date.now(),
    available = false;
  t.mock.method(Date, "now", () => now);
  const fixture = remoteFixture(() =>
    available ? imageResponse() : new Response(null, { status: 503 }),
  );
  const options = {
    source: '<img src="https://cdn.example.com/photo.png">',
    cache,
    fetcher: fixture.fetcher,
  };
  const first = await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(first.retryAfter, now + 60_000);
  const calls = fixture.calls.length;
  await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(fixture.calls.length, calls);
  now = first.retryAfter;
  const second = await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(second.retryAfter, now + 120_000);
  assert.equal(second.retryAttempts, 2);
  available = true;
  now = second.retryAfter;
  const recovered = await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.retryAfter, undefined);
});

test("remote backgrounds, CID and data images become small HTML URLs backed by binary R2 objects", async () => {
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
    source: `<link rel="stylesheet" href="https://cdn.example.com/style.css"><div class="card"><img src="https://cdn.example.com/hero.png"><img src="cid:logo@cid"><img src="data:image/png;base64,${Buffer.from(png).toString("base64")}"></div>`,
    cache,
    fetcher: fixture.fetcher,
  });
  assert.equal(prepared.failures, 0);
  assert.match(
    linked(prepared),
    /background:url\(\/api\/mail\/mailboxes\/box\/messages\/message\/render\/assets\/[a-f0-9]{64}\?grant=test\)/,
  );
  assert.equal(linked(prepared).match(/src="\/api\/mail\//g).length, 3);
  assert.doesNotMatch(linked(prepared), /data:|base64|cid:|cdn\.example|\/attachments\//);
  assert.doesNotMatch(bucket.values.get(mailRenderKey(input.body_r2_key)), /data:image|base64/);
  const id = preparedMailImageId(prepared, path, "0");
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    new Uint8Array(
      await (await loadPreparedMailImage(bucket, input.body_r2_key, id)).arrayBuffer(),
    ),
    png,
  );
  cache.values.clear();
  bucket.values.delete("inline-logo");
  const saved = await prepareMailRendering(bucket, input, "box", "office.test", {
    fetcher: () => assert.fail("Stored images must not be downloaded again"),
  });
  assert.equal(linked(saved), linked(prepared));
  assert.equal(preparedMailImageId(saved, path, "00"), null);
  assert.equal(
    fixture.calls.filter((call) => call.url.hostname === "cloudflare-dns.com").length,
    2,
  );
});

test("Base64 manifests upgrade on read without any upstream image requests", async () => {
  const bucket = bucketFixture();
  const data = "data:image/png;base64," + Buffer.from(png).toString("base64");
  await bucket.put(
    legacyMailRenderKey(message.body_r2_key),
    JSON.stringify({
      html: `<style>.x{background:url(${path}/assets/0)}</style><img src="${path}/assets/0"><img src="${data}">`,
      assets: [{ id: "0", url: "https://cdn.example.com/hero.png" }],
      failures: 0,
      images: { [path + "/assets/0"]: data },
    }),
  );
  const converted = await prepareMailRendering(bucket, message, "box", "office.test", {
    fetcher: () => assert.fail("Legacy conversion must reuse saved bytes"),
  });
  assert.equal(converted.format, 2);
  assert.doesNotMatch(linked(converted), /data:|base64/);
  assert.ok(bucket.values.has(mailRenderKey(message.body_r2_key)));
  assert.equal(bucket.values.has(legacyMailRenderKey(message.body_r2_key)), false);
  const id = preparedMailImageId(converted, path, "0");
  assert.deepEqual(
    new Uint8Array(
      await (await loadPreparedMailImage(bucket, message.body_r2_key, id)).arrayBuffer(),
    ),
    png,
  );
});

test("R2 image responses support browser caching and conditional reads", async () => {
  const bucket = bucketFixture();
  const result = await prepareMailRendering(bucket, message, "box", "office.test", {
    source: '<img src="https://cdn.example.com/a.png">',
    cache: memoryCache(),
    fetcher: remoteFixture(imageResponse).fetcher,
  });
  const id = preparedMailImageId(result, path, "0");
  const response = await loadPreparedMailImage(bucket, message.body_r2_key, id);
  assert.equal(response.headers.get("Cache-Control"), "private, max-age=300, immutable");
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const unchanged = await loadPreparedMailImage(
    bucket,
    message.body_r2_key,
    id,
    response.headers.get("ETag"),
  );
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  assert.equal(await loadPreparedMailImage(bucket, message.body_r2_key, "00"), null);
});

test("failed R2 writes preserve the legacy rendering and do not commit a broken upgrade", async () => {
  const bucket = bucketFixture();
  const legacyKey = legacyMailRenderKey(message.body_r2_key);
  await bucket.put(
    legacyKey,
    JSON.stringify({
      html: `<img src="${path}/assets/0">`,
      assets: [{ id: "0", url: "https://cdn.example.com/image.png" }],
      failures: 0,
      images: {
        [path + "/assets/0"]: "data:image/png;base64," + Buffer.from(png).toString("base64"),
      },
    }),
  );
  const put = bucket.put;
  bucket.put = async (key, ...args) => {
    if (key.includes(".render-images/")) throw new Error("R2 write failed");
    return put(key, ...args);
  };
  await assert.rejects(
    prepareMailRendering(bucket, message, "box", "office.test"),
    /R2 write failed/,
  );
  assert.ok(bucket.values.has(legacyKey));
  assert.equal(bucket.values.has(mailRenderKey(message.body_r2_key)), false);
});

test("partial failures persist and retries reuse successful R2 files", async () => {
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
      '<img src="https://cdn.example.com/good.png"><img src="https://cdn.example.com/bad.png"><p>Body</p>',
    cache,
    fetcher: fixture.fetcher,
  };
  const first = await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(first.failures, 1);
  assert.match(linked(first), /src=""/);
  assert.doesNotMatch(linked(first), /data:|https:/);
  const calls = fixture.calls.length;
  await prepareMailRendering(bucket, message, "box", "office.test", options);
  assert.equal(fixture.calls.length, calls);
  available = true;
  cache.values.clear();
  const retry = await prepareMailRendering(bucket, message, "box", "office.test", {
    ...options,
    retryFailures: true,
  });
  assert.equal(retry.failures, 0);
  assert.equal(fixture.calls.filter((call) => call.url.pathname === "/good.png").length, 1);
  assert.equal(fixture.calls.filter((call) => call.url.pathname === "/bad.png").length, 2);
});

test("repeating a large image uses one R2 file and keeps the HTML small", async () => {
  const bucket = bucketFixture(),
    bytes = new Uint8Array(4 * 1024 ** 2);
  bytes.set(png);
  await bucket.put("large-logo", bytes);
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
    { source: '<img src="cid:logo">'.repeat(100), cache: memoryCache() },
  );
  assert.equal(result.failures, 0);
  assert.ok(linked(result).length < 20_000);
  assert.equal(
    [...bucket.values.keys()].filter((key) => key.includes(".render-images/")).length,
    1,
  );
});

test("mail image grants are stable, scoped, expiring and cannot authorize other resources", async (t) => {
  const env = { AUTH_SIGNING_KEYS: "private-test-signing-ring" },
    grant = {
      actor: { user_id: "user", auth_version: 1, api_key_id: null },
      bodyKey: message.body_r2_key,
      sessionId: "session",
      part: "body",
    };
  const token = await signMailImageGrant(env, "https://office.test" + path, grant);
  assert.equal(await signMailImageGrant(env, "https://office.test" + path, grant), token);
  const verified = await verifyMailImageGrant(env, "https://office.test" + path, token);
  assert.deepEqual(verified.actor, grant.actor);
  await assert.rejects(
    verifyMailImageGrant(env, "https://office.test" + path + "-other", token),
    /MAIL:401/,
  );
  await assert.rejects(
    verifyMailImageGrant({ AUTH_SIGNING_KEYS: "another-key" }, "https://office.test" + path, token),
    /MAIL:401/,
  );
  await assert.rejects(
    verifyMailImageGrant(env, "https://office.test" + path, token + "x"),
    /MAIL:401/,
  );
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 901_000);
  await assert.rejects(verifyMailImageGrant(env, "https://office.test" + path, token), /MAIL:401/);
});
