import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createColorThemeStore } from "../web/lib/color-theme.ts";

function fixture({ saved = null, dark = false, blocked = false } = {}) {
  const systemListeners = new Set(),
    storageListeners = new Set(),
    applied = [];
  const store = createColorThemeStore({
    read: () => {
      if (blocked) throw new Error("Storage unavailable");
      return saved;
    },
    write: (value) => {
      if (blocked) throw new Error("Storage unavailable");
      saved = value;
    },
    systemDark: () => dark,
    apply: (scheme) => applied.push(scheme),
    onSystemChange: (listener) => {
      systemListeners.add(listener);
      return () => systemListeners.delete(listener);
    },
    onStorageChange: (listener) => {
      storageListeners.add(listener);
      return () => storageListeners.delete(listener);
    },
  });
  return {
    store,
    applied,
    system(value) {
      dark = value;
      for (const listener of systemListeners) listener();
    },
    storage(value) {
      saved = value;
      for (const listener of storageListeners) listener();
    },
    saved: () => saved,
    listeners: () => systemListeners.size + storageListeners.size,
  };
}

test("explicit dark mode applies even when the browser reports light", () => {
  const f = fixture({ saved: "dark", dark: false });
  assert.equal(f.applied.at(-1), "dark");
  f.system(true);
  f.system(false);
  assert.deepEqual(f.applied, ["dark"]);
  f.store.setPreference("light");
  f.system(true);
  assert.equal(f.applied.at(-1), "light");
  assert.equal(f.saved(), "light");
});

test("system mode follows device changes and resumes after a manual choice", () => {
  const f = fixture();
  f.system(true);
  f.store.setPreference("light");
  f.system(false);
  f.system(true);
  f.store.setPreference("system");
  f.system(false);
  assert.deepEqual(f.applied, ["light", "dark", "light", "dark", "light"]);
});

test("theme selection still works when browser storage is blocked", () => {
  const f = fixture({ blocked: true, dark: true });
  let changes = 0;
  const unsubscribe = f.store.subscribe(() => changes++);
  assert.equal(f.store.getSnapshot(), "system");
  f.store.setPreference("light");
  assert.equal(f.store.getSnapshot(), "light");
  assert.equal(f.applied.at(-1), "light");
  assert.equal(changes, 1);
  unsubscribe();
  f.store.setPreference("dark");
  assert.equal(changes, 1);
});

test("other tabs synchronize theme changes and clearing storage restores system mode", () => {
  const f = fixture();
  f.storage("dark");
  assert.equal(f.store.getSnapshot(), "dark");
  assert.equal(f.applied.at(-1), "dark");
  f.storage(null);
  assert.equal(f.store.getSnapshot(), "system");
  assert.equal(f.applied.at(-1), "light");
  f.system(true);
  f.storage("unrecognized-value");
  assert.equal(f.store.getSnapshot(), "system");
  assert.equal(f.applied.at(-1), "dark");
});

test("disposed theme controllers release browser listeners", () => {
  const f = fixture();
  assert.equal(f.listeners(), 2);
  f.store.dispose();
  assert.equal(f.listeners(), 0);
  f.system(true);
  f.storage("dark");
  assert.deepEqual(f.applied, ["light"]);
});

test("saved themes are applied before the app loads, including when storage is unavailable", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const [saved, dark, blocked, expected] of [
    ["dark", false, false, "dark"],
    ["light", true, false, "light"],
    [null, true, false, "dark"],
    ["invalid", true, false, "dark"],
    [null, true, true, "dark"],
    [null, false, true, "light"],
  ]) {
    const root = { dataset: {}, style: {} },
      meta = {};
    runInNewContext(script, {
      localStorage: {
        getItem: () => {
          if (blocked) throw new Error("Blocked");
          return saved;
        },
      },
      window: { matchMedia: () => ({ matches: dark }) },
      document: {
        documentElement: root,
        querySelector: () => ({
          setAttribute: (key, value) => {
            meta[key] = value;
          },
        }),
      },
    });
    assert.equal(root.dataset.colorScheme, expected);
    assert.equal(root.style.colorScheme, `only ${expected}`);
    assert.equal(meta.content, expected);
  }
});
