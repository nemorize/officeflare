import { t } from "../../shared/i18n/index.ts";
import { ApiError, createApiClient } from "./api-client";
import { sessions } from "./session";

export { ApiError } from "./api-client";
export const api = createApiClient({
  accessToken: () => sessions.accessToken(),
  refresh: () => sessions.restore(true),
  fetch: (...args) => fetch(...args),
});

import type { LanguagePreference } from "../../shared/i18n/locale.ts";

export interface AccountUser {
  language: LanguagePreference;
  id: string;
  email_address: string;
  display_name: string | null;
  profile_image_key: string | null;
  password_changed_at: number | null;
  created_at: number;
}
export const errorMessage = (failure: unknown) =>
  failure instanceof ApiError
    ? failure.message
    : t("libApi.unableToConnectToTheServerCheckYourConnection");
