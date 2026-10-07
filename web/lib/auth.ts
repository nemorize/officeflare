export interface Session {
  token_type: "Bearer";
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: number;
  session_id: string;
}

export interface MfaChallenge {
  next: "mfa";
  challenge_token: string;
  expires_at: number;
  methods: { id: string; type: string; name: string | null }[];
}

export interface PasswordChallenge {
  next: "password_reset";
  challenge_token: string;
  expires_at: number;
}

export type LoginResult = Session | MfaChallenge | PasswordChallenge;

export class AuthError extends Error {
  constructor(public readonly status: number) {
    super("Authentication request failed");
  }
}

async function request<T>(path: string, data?: object, token?: string, method = "POST"): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "omit",
    cache: "no-store",
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!response.ok) throw new AuthError(response.status);
  return response.status === 204 ? undefined as T : response.json();
}

export const login = (email: string, password: string) =>
  request<LoginResult>("/api/auth/login", { email_address: email.trim().toLowerCase(), password });

export const verifyMfa = (challenge: string, method: string, code: string) =>
  request<LoginResult>("/api/auth/mfa/verify", { method_id: method, code }, challenge);

export const recoverMfa = (challenge: string, code: string) =>
  request<LoginResult>("/api/auth/mfa/recovery", { recovery_code: code.trim() }, challenge);

export const changePassword = (challenge: string, password: string) =>
  request<Session>("/api/me/password", { new_password: password }, challenge, "PUT");

export const logout = (access: string) => request<void>("/api/auth/logout", undefined, access);
