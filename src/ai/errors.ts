import { HTTPException } from "hono/http-exception";
import { t } from "../../shared/i18n/index.ts";

export const errorKeys = {
  AI_INVALID_INPUT: "ai.invalid",
  AI_NOT_FOUND: "ai.notFound",
  AI_FORBIDDEN: "ai.denied",
  AI_DISABLED: "ai.disabled",
  AI_QUOTA_EXCEEDED: "ai.quotaExceeded",
  AI_CONCURRENCY_EXCEEDED: "ai.concurrencyExceeded",
  AI_USAGE_BOUND_UNAVAILABLE: "ai.unbounded",
  AI_NO_AVAILABLE_ACCOUNT: "ai.noAccount",
  AI_REAUTH_REQUIRED: "ai.reauth",
  AI_CAPABILITY_UNSUPPORTED: "ai.unsupported",
  AI_APPROVAL_STALE: "ai.approvalStale",
  AI_RESULT_UNKNOWN: "ai.unknown",
  AI_CONFLICT: "ai.conflict",
  AI_BUSY: "ai.busy",
  AI_PROVIDER_ERROR: "ai.providerError",
  AI_ENCRYPTION_REQUIRED: "ai.encryptionRequired",
  AI_CANCELLED: "ai.cancelled",
  AI_LIMIT_REACHED: "ai.limitReached",
  AI_INVALID_SCHEMA: "ai.invalidSchema",
} as const;
export type AICode = keyof typeof errorKeys;
export function fail(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
  code: AICode,
  details?: Object,
): never {
  const message = t(errorKeys[code]);
  const error = new HTTPException(status, {
    message,
    res: Response.json(
      { error: message, code, ...(details ? { details } : {}) },
      {
        status,
        headers:
          status === 429
            ? {
                "Retry-After": String(
                  Math.max(
                    1,
                    Number(
                      (details as { resets_at?: number } | undefined)?.resets_at ??
                        Math.floor(Date.now() / 1000) + 1,
                    ) - Math.floor(Date.now() / 1000),
                  ),
                ),
              }
            : {},
      },
    ),
  });
  Object.assign(error, { aiCode: code });
  throw error;
}
export const errorCode = (error: unknown): AICode => {
  if (error instanceof HTTPException) {
    try {
      // Keep codes on exceptions without reading or logging a provider response body.
      const code = (error as HTTPException & { aiCode?: AICode }).aiCode;
      if (code) return code;
    } catch {
      /* normalized below */
    }
  }
  return "AI_PROVIDER_ERROR";
};
