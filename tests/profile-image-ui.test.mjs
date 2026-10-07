import { test } from "node:test";
import assert from "node:assert/strict";
import { photoCrop, zoomPhotoCrop } from "../web/lib/profile-image.ts";
import { createApiClient } from "../web/lib/api-client.ts";

test("photo resizing keeps the square covered for wide, tall and square images", () => {
  for (const [width, height] of [[1200, 600], [600, 1200], [800, 800]]) {
    for (const zoom of [.5, 1, 1.5, 3, 4]) for (const x of [-2, -1, 0, 1, 2]) for (const y of [-2, -1, 0, 1, 2]) {
      const crop = photoCrop(width, height, zoom, x, y);
      assert.ok(crop.left <= 0 && crop.top <= 0);
      assert.ok(crop.left + crop.width >= 512 && crop.top + crop.height >= 512);
    }
  }
  assert.deepEqual(photoCrop(1200, 600, 1, 0, 0), { width: 1024, height: 512, travelX: 256, travelY: 0, left: -256, top: 0 });
  assert.throws(() => photoCrop(0, 100, 1, 0, 0), /invalid dimensions/);
});

test("pinch zoom keeps the source point under the moving two-finger midpoint", () => {
  const width = 1200, height = 800, size = 360;
  const view = { zoom: 1.5, x: .2, y: -.1 };
  const anchor = { x: 40, y: -30 }, movement = { x: 12, y: -8 };
  const sourcePoint = (crop, point) => ({
    x: (size / 2 + point.x - crop.left) / crop.width,
    y: (size / 2 + point.y - crop.top) / crop.height,
  });
  const before = sourcePoint(photoCrop(width, height, view.zoom, view.x, view.y, size), anchor);
  const next = zoomPhotoCrop(width, height, view, 2.2, {
    size, anchorX: anchor.x, anchorY: anchor.y, deltaX: movement.x, deltaY: movement.y,
  });
  const after = sourcePoint(photoCrop(width, height, next.zoom, next.x, next.y, size), {
    x: anchor.x + movement.x, y: anchor.y + movement.y,
  });
  assert.ok(Math.abs(before.x - after.x) < 1e-10);
  assert.ok(Math.abs(before.y - after.y) < 1e-10);
  const restored = zoomPhotoCrop(width, height, next, view.zoom, {
    size, anchorX: anchor.x + movement.x, anchorY: anchor.y + movement.y, deltaX: -movement.x, deltaY: -movement.y,
  });
  assert.ok(Math.abs(restored.x - view.x) < 1e-10);
  assert.ok(Math.abs(restored.y - view.y) < 1e-10);
});

test("extreme pinch gestures clamp zoom and position without exposing empty crop space", () => {
  for (const [width, height] of [[1200, 600], [600, 1200], [800, 800]]) {
    for (const zoom of [.01, 1, 2, 100]) for (const anchor of [-500, 0, 500]) {
      const next = zoomPhotoCrop(width, height, { zoom: 2, x: 1, y: -1 }, zoom, {
        size: 360, anchorX: anchor, anchorY: -anchor, deltaX: 2000, deltaY: -2000,
      });
      assert.ok(next.zoom >= 1 && next.zoom <= 3);
      assert.ok(next.x >= -1 && next.x <= 1 && next.y >= -1 && next.y <= 1);
      const crop = photoCrop(width, height, next.zoom, next.x, next.y, 360);
      assert.ok(crop.left <= 0 && crop.top <= 0);
      assert.ok(crop.left + crop.width >= 360 && crop.top + crop.height >= 360);
    }
  }
  assert.deepEqual(zoomPhotoCrop(800, 800, { zoom: 2, x: .4, y: -.5 }, .1), { zoom: 1, x: 0, y: 0 });
});

test("the masked preview and exported profile photo select the same source region", () => {
  for (const [width, height] of [[1200, 600], [600, 1200], [800, 800]]) {
    const view = zoomPhotoCrop(width, height, { zoom: 1.3, x: .3, y: -.2 }, 2.4, { size: 360, anchorX: 50, anchorY: -25 });
    const preview = photoCrop(width, height, view.zoom, view.x, view.y, 360);
    const output = photoCrop(width, height, view.zoom, view.x, view.y, 512);
    for (const [previewValue, outputValue] of [
      [preview.left / preview.width, output.left / output.width],
      [preview.top / preview.height, output.top / output.height],
      [360 / preview.width, 512 / output.width],
      [360 / preview.height, 512 / output.height],
    ]) assert.ok(Math.abs(previewValue - outputValue) < 1e-10);
  }
});

test("photo upload sends a raw binary body with bearer authentication and omits cookies", async () => {
  const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
  let token = "expired", refreshes = 0;
  const requests = [];
  const api = createApiClient({ accessToken: async () => token, refresh: async () => { token = "renewed"; refreshes++; },
    fetch: async (_path, options) => {
      requests.push(options);
      return requests.length === 1 ? Response.json({ error: "Expired" }, { status: 401 }) : Response.json({ user: { profile_image_key: "photo" } });
    } });
  await api("/api/me/profile-image", { method: "PUT", body: image });
  assert.equal(refreshes, 1);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.body, image); assert.equal(request.headers["Content-Type"], "image/webp"); assert.equal(request.credentials, "omit");
  }
  assert.deepEqual(requests.map((request) => request.headers.Authorization), ["Bearer expired", "Bearer renewed"]);
});

test("private avatar images are read as blobs with the session bearer token", async () => {
  const api = createApiClient({ accessToken: async () => "access", refresh: async () => {}, fetch: async (_path, options) => {
    assert.equal(options.headers.Authorization, "Bearer access"); assert.equal(options.credentials, "omit");
    return new Response(new Uint8Array([9, 8, 7]), { headers: { "Content-Type": "image/png" } });
  } });
  const image = await api("/api/me/profile-image", { response: "blob" });
  assert.ok(image instanceof Blob); assert.equal(image.type, "image/png");
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [9, 8, 7]);
});
