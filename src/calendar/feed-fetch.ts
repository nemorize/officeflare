import { t } from "../../shared/i18n/index.ts";
import {
  boundedBody,
  publicDns,
  remoteUrl,
  runtimeRemoteFetcher,
  type RemoteFetcher,
} from "../mail/remote";

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const MAX_FEED_ENTRIES = 2000;
export const FEED_INTERVAL = 3600;
export class FeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function feedUrl(value: string, base?: string) {
  try {
    const normalized = value.replace(/^webcal:/i, "https:");
    return remoteUrl(normalized, base);
  } catch {
    throw new FeedError(
      "INVALID_URL",
      t("calendarFeedFetch.useAPublicHttpsOrWebcalCalendarUrlWithout"),
    );
  }
}
const header = (value: string | null) =>
  value && value.length <= 1024 && !/[\r\n]/.test(value) ? value : null;
export async function fetchCalendarFeed(
  value: string,
  validators: { etag: string | null; last_modified: string | null },
  fetcher: RemoteFetcher = runtimeRemoteFetcher,
) {
  let url = feedUrl(value);
  const signal = AbortSignal.timeout(15_000);
  const privacy = {
    "User-Agent": "Officeflare-Calendar/1.0",
    "CF-Connecting-IP": "0.0.0.0",
    "CF-Connecting-IPv6": "::",
    "X-Forwarded-For": "0.0.0.0",
    "X-Real-IP": "0.0.0.0",
    "True-Client-IP": "0.0.0.0",
  };
  for (let hop = 0; hop <= 3; hop++) {
    try {
      await publicDns(url.hostname, fetcher, signal);
    } catch {
      throw new FeedError(
        "UNREACHABLE",
        t("calendarFeedFetch.theCalendarHostCouldNotBeReachedOrDoes"),
      );
    }
    let response: Response;
    try {
      response = await fetcher(url.href, {
        signal,
        redirect: "manual",
        headers: {
          ...privacy,
          Accept: "text/calendar, application/ics, text/plain;q=0.8",
          ...(validators.etag ? { "If-None-Match": validators.etag } : {}),
          ...(validators.last_modified ? { "If-Modified-Since": validators.last_modified } : {}),
        },
      });
    } catch {
      throw new FeedError(
        "UNREACHABLE",
        t("calendarFeedFetch.unableToDownloadTheCalendarTheServerMayBe"),
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location || hop === 3)
        throw new FeedError(
          t("calendarFeedFetch.redirect"),
          t("calendarFeedFetch.theCalendarUrlRedirectsTooManyTimesOrHas"),
        );
      const next = feedUrl(location, url.href);
      // Validators belong to one resource and must not follow redirects.
      validators = { etag: null, last_modified: null };
      url = next;
      continue;
    }
    if (response.status === 304) {
      await response.body?.cancel();
      if (!validators.etag && !validators.last_modified)
        throw new FeedError(
          "INVALID_RESPONSE",
          t("calendarFeedFetch.theCalendarServerReturnedAnUnexpectedResponse"),
        );
      return {
        content: null,
        etag: header(response.headers.get("ETag")) ?? validators.etag,
        last_modified: header(response.headers.get("Last-Modified")) ?? validators.last_modified,
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 404, 410].includes(response.status))
        throw new FeedError(
          "ACCESS_DENIED",
          t("calendarFeedFetch.theCalendarLinkIsUnavailableOrAccessWasRevoked"),
        );
      throw new FeedError(
        "HTTP_ERROR",
        t("calendarFeedFetch.theCalendarServerReturnedAnErrorOfficeflareWillRetry"),
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await boundedBody(response, MAX_FEED_BYTES);
    } catch {
      throw new FeedError(
        "FEED_SIZE",
        t("calendarFeedFetch.theCalendarResponseIsEmptyIncompleteOrLargerThan"),
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new FeedError(
        t("calendarFeedFetch.encoding"),
        t("calendarFeedFetch.theCalendarMustUseUtf8Encoding"),
      );
    }
    return {
      content,
      etag: hop === 0 ? header(response.headers.get("ETag")) : null,
      last_modified: hop === 0 ? header(response.headers.get("Last-Modified")) : null,
    };
  }
  throw new FeedError(
    t("calendarFeedFetch.redirect"),
    t("calendarFeedFetch.invalidCalendarRedirect"),
  );
}
