import { ApiError, createApiClient } from "./api-client";
import { sessions } from "./session";

export { ApiError } from "./api-client";
export const api = createApiClient({
  accessToken: () => sessions.accessToken(), refresh: () => sessions.restore(true),
  fetch: (...args) => fetch(...args),
});

export interface AccountUser {
  id: string;
  email_address: string;
  display_name: string | null;
  profile_image_key: string | null;
  password_changed_at: number | null;
  created_at: number;
}
export const errorMessage = (failure: unknown) => failure instanceof ApiError ? failure.message :
  "Unable to connect to the server. Check your connection and try again.";
