import { importPKCS8, SignJWT } from "jose";
import { t } from "../../shared/i18n/index.ts";
import type { PushWebConfig } from "../../shared/push";
import { now } from "../auth/types";

export function fcmCredentials(env: Env) {
  try {
    const value = JSON.parse(env.FCM_SERVICE_ACCOUNT ?? "") as Record<string, unknown>;
    if (
      typeof value.project_id !== "string" ||
      !/^[a-z0-9-]+$/.test(value.project_id) ||
      typeof value.client_email !== "string" ||
      !value.client_email.includes("@") ||
      typeof value.private_key !== "string" ||
      !value.private_key.includes("BEGIN PRIVATE KEY")
    )
      return null;
    return {
      projectId: value.project_id,
      email: value.client_email,
      privateKey: value.private_key,
    };
  } catch {
    return null;
  }
}

export function fcmWebConfig(env: Env) {
  const credentials = fcmCredentials(env);
  if (!credentials || !env.FCM_VAPID_KEY || !/^[A-Za-z0-9_-]{87}$/.test(env.FCM_VAPID_KEY))
    return null;
  try {
    const value = JSON.parse(env.FCM_WEB_CONFIG ?? "") as Record<string, unknown>;
    if (
      !["apiKey", "projectId", "messagingSenderId", "appId"].every(
        (key) => typeof value[key] === "string" && value[key].length > 0,
      ) ||
      value.projectId !== credentials.projectId
    )
      return null;
    // Explicit whitelist: service-account keys must never reach the browser.
    const firebase: PushWebConfig = {
      apiKey: value.apiKey as string,
      projectId: value.projectId as string,
      messagingSenderId: value.messagingSenderId as string,
      appId: value.appId as string,
    };
    return { firebase, vapid_key: env.FCM_VAPID_KEY };
  } catch {
    return null;
  }
}

let cached: { credentials: string; token: string; expires: number } | undefined;
let pending: { credentials: string; request: Promise<string> } | undefined;
async function accessToken(env: Env) {
  const key = env.FCM_SERVICE_ACCOUNT!;
  if (cached?.credentials === key && cached.expires > now() + 60) return cached.token;
  if (pending?.credentials === key) return pending.request;
  const request = (async () => {
    const credentials = fcmCredentials(env);
    if (!credentials) throw new Error(t("push.unavailable"));
    const timestamp = now();
    const assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(credentials.email)
      .setSubject(credentials.email)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(timestamp)
      .setExpirationTime(timestamp + 3600)
      .sign(await importPKCS8(credentials.privateKey, "RS256"));
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(t("push.failed"), { cause: { status: response.status } });
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token || typeof data.expires_in !== "number")
      throw new Error(t("push.failed"));
    cached = { credentials: key, token: data.access_token, expires: timestamp + data.expires_in };
    return data.access_token;
  })();
  pending = { credentials: key, request };
  try {
    return await request;
  } finally {
    if (pending?.request === request) pending = undefined;
  }
}

export async function sendFcm(
  env: Env,
  token: string,
  tokenType: string,
  data: Record<string, string>,
) {
  const credentials = fcmCredentials(env);
  if (!credentials) throw new Error(t("push.unavailable"));
  const { title, body, ...metadata } = data;
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${credentials.projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken(env)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          data: tokenType === "fcm_web" ? data : metadata,
          ...(tokenType === "fcm_web"
            ? { webpush: { headers: { TTL: "86400", Urgency: "normal" } } }
            : { notification: { title, body } }),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.ok) return "sent" as const;
  const error = (await response.json().catch(() => null)) as {
    error?: { details?: { "@type"?: string; errorCode?: string }[] };
  } | null;
  const code = error?.error?.details?.find(
    (detail) => detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError",
  )?.errorCode;
  if (code === "UNREGISTERED") return "unregistered" as const;
  if (response.status === 401) cached = undefined;
  // INVALID_ARGUMENT may describe the payload, so it must not delete a valid device.
  throw new Error(t("push.failed"), { cause: { status: response.status } });
}
