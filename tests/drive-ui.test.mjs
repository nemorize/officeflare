import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canEdit,
  canComment,
  driveLocation,
  formatBytes,
  folderPaths,
  previewKind,
  publicShareUrl,
  selectDriveItems,
  uploadDriveFile,
} from "../web/lib/drive.ts";
import { createApiClient } from "../web/lib/api-client.ts";
import { driveSearchParams, isDriveSearch, readDriveSearch } from "../web/lib/drive-search.ts";

test("Drive searches retain advanced constraints and reset without leaving hidden filters", () => {
  const fields = {
    q: " Annual & budget ",
    type: "image/*",
    owner: " Team% ",
    scope: "shared",
    after: "2026-10-01",
    before: "2026-10-14",
  };
  const params = driveSearchParams(fields);
  assert.equal(params.get("kind"), "file");
  assert.equal(params.get("content_type"), "image/*");
  assert.deepEqual(readDriveSearch(new URLSearchParams(params.toString())), {
    ...fields,
    q: "Annual & budget",
    owner: "Team%",
  });
  const clearedText = driveSearchParams({ ...readDriveSearch(params), q: "" });
  assert.equal(isDriveSearch(clearedText), true);
  assert.equal(clearedText.get("owner"), "Team%");
  const folders = driveSearchParams({ ...readDriveSearch(params), type: "folder" });
  assert.equal(folders.get("kind"), "folder");
  assert.equal(folders.has("content_type"), false);
  const reset = driveSearchParams(readDriveSearch(new URLSearchParams()));
  assert.equal(reset.size, 0);
  assert.equal(isDriveSearch(reset), false);
});

test("Drive selection supports single, additive and anchored range selection", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual([...selectDriveItems(ids, new Set(["d"]), "b", null, false, false)], ["b"]);
  assert.deepEqual([...selectDriveItems(ids, new Set(["a"]), "b", null, false, true)], ["a", "b"]);
  assert.deepEqual([...selectDriveItems(ids, new Set(["a", "b"]), "b", null, false, true)], ["a"]);
  assert.deepEqual([...selectDriveItems(ids, new Set(["d"]), "c", "a", true, false)].sort(), [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.deepEqual([...selectDriveItems(ids, new Set(), "a", "missing", true, false)], ["a"]);
});
test("Drive roles, route views and file previews reflect actual capabilities", () => {
  assert.equal(canEdit({ effective_role: "viewer" }), false);
  assert.equal(canComment({ effective_role: "commenter" }), true);
  assert.equal(canEdit({ effective_role: "editor" }), true);
  assert.deepEqual(driveLocation("/drive/folders/a-b"), {
    folder: "a-b",
    view: "all",
  });
  assert.deepEqual(driveLocation("/drive/recent"), {
    folder: null,
    view: "recent",
  });
  assert.equal(previewKind({ size: 12, content_type: "image/svg+xml" }), null);
  assert.equal(previewKind({ size: 12, content_type: "text/html" }), "text");
  assert.equal(previewKind({ size: 21 * 1024 * 1024, content_type: "image/png" }), null);
  assert.equal(previewKind({ size: 1, content_type: "application/pdf" }), "pdf");
  assert.equal(formatBytes(1024 ** 3), "1 GB");
});
test("Folder upload builds parent paths before children without path traversal", () => {
  assert.deepEqual(
    folderPaths([
      { webkitRelativePath: "Project/images/icons/a.png" },
      { webkitRelativePath: "Project/readme.txt" },
      { webkitRelativePath: "Project/images/b.png" },
    ]),
    ["Project", "Project/images", "Project/images/icons"],
  );
  assert.throws(() => folderPaths([{ webkitRelativePath: "Project/../a.txt" }]), /Invalid/);
  assert.deepEqual(folderPaths([{ webkitRelativePath: "" }]), []);
});
test("Public link URLs target the standalone viewer and never include passwords", () => {
  const token = "ofd_" + "a".repeat(43);
  assert.equal(
    publicShareUrl(token, "https://office.test"),
    `https://office.test/share/drive/${token}`,
  );
  assert.throws(() => publicShareUrl("bad/../../login", "https://office.test"));
});
test("New uploads transfer bytes and commit before reporting completion", async () => {
  const calls = [],
    patches = [],
    file = new File(["hello"], "hello.txt", { type: "text/plain" }),
    session = {
      id: "upload",
      item_id: "file",
      mode: "single",
      status: "open",
      part_bytes: 8 * 1024 * 1024,
    };
  const api = async (path, options) => {
    calls.push([path, options]);
    if (path === "/api/drive/uploads") return { upload: session };
    if (!options?.method) return { upload: session, parts: [] };
    if (path.endsWith("/complete")) return { item: { id: "file" } };
    return {};
  };
  const item = await uploadDriveFile(
    api,
    { file, parent: "folder" },
    new AbortController().signal,
    (patch) => patches.push(patch),
  );
  assert.equal(item.id, "file");
  assert.equal(calls[0][1].body.parent_id, "folder");
  assert.equal(calls[2][1].body, file);
  assert.equal(calls[3][0], "/api/drive/uploads/upload/complete");
  assert.equal(patches.at(-1).state, "done");
  assert.equal(patches.at(-1).sent, 5);
});
test("Multipart retry skips confirmed parts and preserves upload identity", async () => {
  const partBytes = 8 * 1024 * 1024,
    file = new File([new Uint8Array(partBytes + 3)], "large.bin"),
    session = {
      id: "existing",
      mode: "multipart",
      status: "open",
      part_bytes: partBytes,
    },
    paths = [],
    patches = [];
  const api = async (path, options) => {
    paths.push(path);
    if (!options?.method) return { upload: session, parts: [{ part_number: 1, size: partBytes }] };
    if (path.endsWith("/complete")) return { item: { id: "file" } };
    assert.equal(options.body.size, 3);
    return {};
  };
  await uploadDriveFile(
    api,
    { file, parent: null, upload: session },
    new AbortController().signal,
    (patch) => patches.push(patch),
  );
  assert.deepEqual(paths, [
    "/api/drive/uploads/existing",
    "/api/drive/uploads/existing/parts/2",
    "/api/drive/uploads/existing/complete",
  ]);
  assert.equal(patches[0].sent, partBytes);
});
test("Completed retry is idempotent and cancellation never commits", async () => {
  const file = new File(["a"], "a.txt"),
    session = { id: "ready", mode: "single", status: "completed" },
    paths = [];
  await uploadDriveFile(
    async (path, options) => {
      paths.push(path);
      return options?.method ? { item: { id: "file" } } : { upload: session, parts: [] };
    },
    { file, parent: null, upload: session },
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(paths, ["/api/drive/uploads/ready", "/api/drive/uploads/ready/complete"]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    uploadDriveFile(
      async (_path, options) => {
        options.signal.throwIfAborted();
      },
      { file, parent: null },
      controller.signal,
      () => {},
    ),
    { name: "AbortError" },
  );
});
test("API response mode returns authenticated streams and refreshes expired access", async () => {
  const tokens = [];
  let refreshes = 0;
  const client = createApiClient({
    accessToken: async () => (refreshes ? "fresh" : "old"),
    refresh: async () => {
      refreshes++;
    },
    fetch: async (_path, options) => {
      tokens.push(options.headers.Authorization);
      return refreshes ? new Response("stream") : new Response("{}", { status: 401 });
    },
  });
  const response = await client("/api/drive/items/file/content", {
    response: "response",
  });
  assert.ok(response.body);
  assert.equal(await response.text(), "stream");
  assert.deepEqual(tokens, ["Bearer old", "Bearer fresh"]);
});
