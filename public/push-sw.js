/* FCM data messages use the standard Push API. Keeping this worker independent
 * of the Firebase SDK also lets it display a notification while the app is closed. */
const database = () =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open("officeflare-push", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("settings");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
async function binding(value, write = false) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("settings", write ? "readwrite" : "readonly");
      const store = transaction.objectStore("settings");
      const request = write ? store.put(value, "binding") : store.get("binding");
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
const targetPath = (path) =>
  path === "/notifications" ||
  path === "/profile/sessions" ||
  path === "/mail" ||
  /^\/calendar\/invitations\/[A-Za-z0-9_-]+$/.test(path ?? "")
    ? path
    : "/notifications";
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (
    event.data?.kind !== "officeflare.push.bind" ||
    !event.source?.url ||
    new URL(event.source.url).origin !== self.location.origin
  )
    return;
  const next = event.data.binding;
  if (next !== null && (typeof next?.userId !== "string" || typeof next?.sessionId !== "string"))
    return;
  event.waitUntil(
    (async () => {
      const previous = await binding();
      await binding(next, true);
      if (!next || previous?.userId !== next.userId || previous?.sessionId !== next.sessionId)
        for (const notification of await self.registration.getNotifications()) notification.close();
      event.ports[0]?.postMessage({ ok: true });
    })().catch(() => event.ports[0]?.postMessage({ ok: false })),
  );
});
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data?.json()?.data;
      } catch {
        return;
      }
      const current = await binding();
      if (
        !current ||
        current.userId !== payload?.user_id ||
        current.sessionId !== payload?.session_id ||
        typeof payload.title !== "string" ||
        typeof payload.notification_id !== "string"
      )
        return;
      await self.registration.showNotification(payload.title, {
        body: typeof payload.body === "string" ? payload.body : "",
        icon: "/favicon.png",
        tag: `officeflare-${payload.notification_id}`,
        data: {
          target_path: targetPath(payload.target_path),
          user_id: current.userId,
          session_id: current.sessionId,
        },
      });
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const current = await binding();
      if (
        !current ||
        current.userId !== event.notification.data?.user_id ||
        current.sessionId !== event.notification.data?.session_id
      )
        return;
      const path = targetPath(event.notification.data?.target_path);
      for (const client of await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.navigate(path);
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(path);
    })(),
  );
});
