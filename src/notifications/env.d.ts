interface Env {
  /** Optional Firebase service-account JSON. Store as a Cloudflare secret. */
  FCM_SERVICE_ACCOUNT?: string;
  /** Public Firebase web app configuration JSON. */
  FCM_WEB_CONFIG?: string;
  /** Public Web Push certificate key from Firebase Cloud Messaging. */
  FCM_VAPID_KEY?: string;
}
