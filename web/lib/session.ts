import { t } from "../../shared/i18n/index.ts";
import { useEffect, useSyncExternalStore } from "react";
import { currentUser, logout, refresh } from "./auth";
import { SESSION_KEY, SessionManager } from "./session-manager";

let database: Promise<IDBDatabase> | undefined;
function lock<T>(action: () => T): Promise<T> {
  // IndexedDB read/write transactions serialize this short localStorage operation across tabs,
  // including HTTP Tailscale origins where the Web Locks API is unavailable. No tokens go into IDB.
  database ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("officeflare-auth-lock", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("mutex");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => {
      database = undefined;
      reject(open.error);
    };
    open.onblocked = () => {
      database = undefined;
      reject(new Error(t("libSession.sessionStorageIsBlocked")));
    };
  });
  return database.then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction("mutex", "readwrite");
        const store = transaction.objectStore("mutex");
        let result: T;
        let failure: unknown;
        const read = store.get("session");
        read.onsuccess = () => {
          try {
            result = action();
            store.put(1, "session");
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () =>
          reject(failure ?? transaction.error ?? new Error(t("libSession.sessionStorageFailed")));
      }),
  );
}

export const sessions = new SessionManager({
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  },
  lock,
  currentUser,
  logout,
  refresh,
  now: Date.now,
  requestId: () =>
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  schedule: (action, delay) => window.setTimeout(action, delay),
  cancel: (handle) => window.clearTimeout(handle as number),
});

window.addEventListener("storage", (event) => {
  if (event.storageArea === localStorage && (event.key === SESSION_KEY || event.key === null))
    sessions.synchronize();
});
window.addEventListener("online", sessions.synchronize);
window.addEventListener("focus", sessions.synchronize);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sessions.synchronize();
});

export function useSession() {
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  useEffect(() => {
    sessions.start();
  }, []);
  return snapshot;
}
