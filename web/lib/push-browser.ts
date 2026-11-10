import type { PushConfiguration } from "../../shared/push";
import { t } from "../../shared/i18n/index.ts";

export const pushSupported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  typeof window.Notification !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window.PushManager !== "undefined";

export const pushChoiceKey = (userId: string) => `officeflare.push.choice.${userId}`;
export function pushDeviceId() {
  let id = localStorage.getItem("officeflare.push.device");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("officeflare.push.device", id);
  }
  return id;
}

export async function pushWorker() {
  const registration = await navigator.serviceWorker.register("/push-sw.js", { scope: "/push/" });
  if (!registration.active) {
    await new Promise<void>((resolve, reject) => {
      const worker = registration.installing ?? registration.waiting;
      if (!worker) {
        reject(new Error(t("push.failed")));
        return;
      }
      const timeout = setTimeout(() => {
        worker.removeEventListener("statechange", changed);
        reject(new Error(t("push.failed")));
      }, 15_000);
      function changed() {
        if (worker!.state === "activated" || worker!.state === "redundant") {
          clearTimeout(timeout);
          worker!.removeEventListener("statechange", changed);
          if (worker!.state === "activated") resolve();
          else reject(new Error(t("push.failed")));
        }
      }
      worker.addEventListener("statechange", changed);
      changed();
    });
  }
  return registration;
}

export async function bindPushWorker(
  binding: { userId: string; sessionId: string } | null,
  create = false,
) {
  if (!pushSupported()) return;
  const registration = create
    ? await pushWorker()
    : await navigator.serviceWorker.getRegistration("/push/");
  if (!registration?.active) return;
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error(t("push.failed")));
    }, 5000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.ok) resolve();
      else reject(new Error(t("push.failed")));
    };
    registration.active!.postMessage({ kind: "officeflare.push.bind", binding }, [channel.port2]);
  });
}

export async function browserPushToken(config: PushConfiguration) {
  if (!config.available || !config.firebase || !config.vapid_key)
    throw new Error(t("push.unavailable"));
  const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
    import("firebase/app"),
    import("firebase/messaging"),
  ]);
  if (!(await isSupported())) throw new Error(t("push.unsupported"));
  // A named app allows configuration changes without reusing another Firebase project.
  const name = `officeflare-push-${config.firebase.appId}-${config.firebase.apiKey}`;
  const app = getApps().find((app) => app.name === name) ?? initializeApp(config.firebase, name);
  const registration = await pushWorker();
  const token = await getToken(getMessaging(app), {
    vapidKey: config.vapid_key,
    serviceWorkerRegistration: registration,
  });
  if (!token) throw new Error(t("push.failed"));
  return token;
}
