import { AsyncLocalStorage } from "node:async_hooks";
import { setLocaleResolver } from "../shared/i18n/index.ts";
import {
  acceptedLanguages,
  defaultLocale,
  resolveLocale,
  type Locale,
} from "../shared/i18n/locale.ts";

const language = new AsyncLocalStorage<Locale>();
setLocaleResolver(() => language.getStore() ?? defaultLocale);

/** Keep parallel requests isolated; background jobs retain the English default. */
export function withRequestLanguage<T>(request: Request, action: () => T): T {
  return language.run(
    resolveLocale("system", acceptedLanguages(request.headers.get("Accept-Language"))),
    action,
  );
}
