import type { createApiClient } from "./api-client";
import type { Session } from "./auth";

export interface ReauthenticationGrant {
  reauthentication_token: string;
  expires_at: number;
}

export interface AuthenticatorMethod {
  id: string;
  type: "totp";
  name: string | null;
  status: "active" | "pending" | "expired";
  created_at: number;
  verified_at: number | null;
  last_used_at: number | null;
  setup_expires_at: number | null;
}

export interface AuthenticatorSetup {
  method_id: string;
  provisioning_uri: string;
  setup_expires_at: number;
}

export function authenticatorKey(uri: string) {
  const parsed = new URL(uri);
  const key = parsed.searchParams.get("secret");
  if (
    parsed.protocol !== "otpauth:" ||
    parsed.hostname !== "totp" ||
    !key ||
    !/^[A-Z2-7]+$/.test(key)
  ) {
    throw new Error("The server returned an invalid authenticator setup. Start again.");
  }
  return key;
}

export function createMfaClient(deps: {
  api: ReturnType<typeof createApiClient>;
  acceptSession: (result: Session, email: string) => Promise<void>;
  email: () => string;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  function token(grant: ReauthenticationGrant) {
    if (grant.expires_at * 1000 <= now())
      throw new Error("Verification expired. Verify your identity again.");
    return grant.reauthentication_token;
  }
  async function replace<T extends Session>(result: T) {
    await deps.acceptSession(result, deps.email());
    return result;
  }
  return {
    async start(grant: ReauthenticationGrant, name: string) {
      const result = await deps.api<AuthenticatorSetup>("/api/me/mfa/totp", {
        method: "POST",
        token: token(grant),
        body: { name: name.trim() },
      });
      authenticatorKey(result.provisioning_uri);
      return result;
    },
    async activate(grant: ReauthenticationGrant, setup: AuthenticatorSetup, code: string) {
      if (setup.setup_expires_at * 1000 <= now())
        throw new Error(
          "This setup has expired. Remove the pending authenticator and start again.",
        );
      if (!/^[0-9]{6}$/.test(code.trim()))
        throw new Error("Enter the six-digit code from your new authenticator.");
      return replace(
        await deps.api<Session & { method_id: string }>(
          `/api/me/mfa/totp/${encodeURIComponent(setup.method_id)}/verify`,
          {
            method: "POST",
            token: token(grant),
            body: { code: code.trim() },
          },
        ),
      );
    },
    async remove(grant: ReauthenticationGrant, methodId: string) {
      return replace(
        await deps.api<Session>(`/api/me/mfa/methods/${encodeURIComponent(methodId)}`, {
          method: "DELETE",
          token: token(grant),
        }),
      );
    },
    async recoveryCodes(grant: ReauthenticationGrant) {
      return replace(
        await deps.api<Session & { recovery_codes: string[] }>("/api/me/mfa/recovery-codes", {
          method: "POST",
          token: token(grant),
        }),
      );
    },
  };
}
