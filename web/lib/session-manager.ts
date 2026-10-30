import { t } from "../../shared/i18n/index.ts";
import type { Session } from "./auth";

export const SESSION_KEY = "officeflare.auth.session.v1";

export interface StoredSession {
  version: 1;
  tokens: Session;
  expiresAt: number;
  email: string;
  refreshRequestId: string | null;
}

export interface SessionSnapshot {
  status: "loading" | "signed_out" | "signed_in" | "unavailable";
  session: StoredSession | null;
  error: string;
}

export class SessionStorageError extends Error {
  constructor() {
    super(t("libSessionManager.unableToSaveYourSessionEnableBrowserStorageAnd"));
  }
}

export interface SessionDependencies {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  // The callback is synchronous so an IndexedDB transaction can serialize it across tabs.
  lock: <T>(action: () => T) => Promise<T>;
  refresh: (token: string, requestId: string) => Promise<Session>;
  currentUser: (access: string) => Promise<{ user: { email_address: string } }>;
  logout: (access: string) => Promise<void>;
  now: () => number;
  requestId: () => string;
  schedule: (action: () => void, delay: number) => unknown;
  cancel: (handle: unknown) => void;
}

const status = (error: unknown) =>
  error && typeof error === "object" && "status" in error ? error.status : undefined;
const retryAfter = (error: unknown) =>
  error &&
  typeof error === "object" &&
  "retryAfter" in error &&
  typeof error.retryAfter === "number"
    ? error.retryAfter
    : 0;

function validStored(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredSession>,
    tokens = record.tokens;
  return (
    record.version === 1 &&
    typeof record.email === "string" &&
    record.email.length <= 254 &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    record.expiresAt > 0 &&
    (record.refreshRequestId === null ||
      (typeof record.refreshRequestId === "string" &&
        /^[a-f0-9]{64}$/.test(record.refreshRequestId))) &&
    !!tokens &&
    tokens.token_type === "Bearer" &&
    typeof tokens.access_token === "string" &&
    tokens.access_token.length > 0 &&
    tokens.access_token.length <= 4096 &&
    typeof tokens.refresh_token === "string" &&
    /^ofr_[A-Za-z0-9_-]{43}$/.test(tokens.refresh_token) &&
    Number.isSafeInteger(tokens.refresh_expires_at) &&
    tokens.refresh_expires_at > 0 &&
    Number.isFinite(tokens.expires_in) &&
    tokens.expires_in > 0 &&
    tokens.expires_in <= 900 &&
    typeof tokens.session_id === "string" &&
    tokens.session_id.length > 0 &&
    tokens.session_id.length <= 128
  );
}

export class SessionManager {
  private snapshot: SessionSnapshot = { status: "loading", session: null, error: "" };
  private listeners = new Set<() => void>();
  private pending: Promise<StoredSession | null> | null = null;
  private revision = 0;
  private rerun = false;
  private timer: unknown;
  private retryDelay = 2000;
  private started = false;
  private deps: SessionDependencies;

  constructor(deps: SessionDependencies) {
    this.deps = deps;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start() {
    if (this.started) return;
    this.started = true;
    void this.restore();
  }

  // Storage events and wakeups invalidate requests that started before another tab changed the session.
  synchronize = () => {
    this.revision++;
    if (this.pending) this.rerun = true;
    else void this.restore();
  };

  private read(): StoredSession | null {
    const raw = this.deps.storage.getItem(SESSION_KEY);
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
    if (validStored(value)) return value;
    this.deps.storage.removeItem(SESSION_KEY);
    return null;
  }

  private save(session: StoredSession) {
    this.deps.storage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  private update(snapshot: SessionSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private clearTimer() {
    if (this.timer !== undefined) this.deps.cancel(this.timer);
    this.timer = undefined;
  }

  private authenticated(session: StoredSession) {
    this.clearTimer();
    this.retryDelay = 2000;
    this.update({ status: "signed_in", session, error: "" });
    const sessionEnd = session.tokens.refresh_expires_at * 1000;
    // The final access token already ends with the session; avoid repeated refreshes in its last seconds.
    const refreshAt =
      session.expiresAt < sessionEnd - 1000 ? session.expiresAt - 30_000 : sessionEnd;
    this.timer = this.deps.schedule(
      () => {
        void this.restore();
      },
      Math.max(1000, refreshAt - this.deps.now()),
    );
  }

  private signedOut(error = "") {
    this.clearTimer();
    this.update({ status: "signed_out", session: null, error });
  }

  async accept(tokens: Session, email: string) {
    this.revision++;
    const session: StoredSession = {
      version: 1,
      tokens,
      email: email.trim().toLowerCase(),
      expiresAt: this.deps.now() + tokens.expires_in * 1000,
      refreshRequestId: null,
    };
    if (!validStored(session)) throw new Error(t("libSessionManager.invalidSessionResponse"));
    try {
      await this.deps.lock(() => {
        this.save(session);
        this.authenticated(session);
      });
    } catch {
      // A successful login that cannot be persisted must not leave an orphaned server session.
      try {
        await this.deps.logout(tokens.access_token);
      } catch {
        /* Preserve the storage error. */
      }
      throw new SessionStorageError();
    }
  }

  private async rotate(force: boolean): Promise<StoredSession | null> {
    const previous = await this.deps.lock(() => {
      const stored = this.read();
      if (!stored) return null;
      if (stored.tokens.refresh_expires_at * 1000 <= this.deps.now()) {
        this.deps.storage.removeItem(SESSION_KEY);
        return null;
      }
      if (!force && !stored.refreshRequestId && stored.expiresAt > this.deps.now() + 30_000)
        return stored;
      if (!stored.refreshRequestId) {
        stored.refreshRequestId = this.deps.requestId();
        // Save before making the request: a reload or lost response must reuse this exact operation.
        this.save(stored);
      }
      return stored;
    });
    if (!previous?.refreshRequestId) return previous;
    try {
      const tokens = await this.deps.refresh(
        previous.tokens.refresh_token,
        previous.refreshRequestId,
      );
      return this.deps.lock(() => {
        const current = this.read();
        // A delayed response cannot resurrect a signed-out session or overwrite a newer rotation/login.
        if (
          !current ||
          current.tokens.refresh_token !== previous.tokens.refresh_token ||
          current.refreshRequestId !== previous.refreshRequestId
        )
          return current;
        const next: StoredSession = {
          ...current,
          tokens,
          expiresAt: this.deps.now() + tokens.expires_in * 1000,
          refreshRequestId: null,
        };
        if (!validStored(next) || next.tokens.session_id !== previous.tokens.session_id)
          throw new Error(t("libSessionManager.invalidSessionResponse"));
        this.save(next);
        return next;
      });
    } catch (error) {
      if (status(error) !== 401) throw error;
      return this.deps.lock(() => {
        const current = this.read();
        if (
          current?.tokens.refresh_token === previous.tokens.refresh_token &&
          current.refreshRequestId === previous.refreshRequestId
        ) {
          this.deps.storage.removeItem(SESSION_KEY);
          return null;
        }
        return current;
      });
    }
  }

  restore(force = false): Promise<StoredSession | null> {
    if (this.pending) return this.pending;
    const revision = this.revision;
    this.clearTimer();
    const task = async () => {
      let stored = await this.rotate(force);
      if (!stored) {
        if (revision === this.revision)
          this.signedOut(
            this.snapshot.session ? t("libSessionManager.yourSessionHasEndedSignInAgain") : "",
          );
        return null;
      }
      let profile;
      try {
        profile = await this.deps.currentUser(stored.tokens.access_token);
      } catch (error) {
        if (status(error) !== 401) throw error;
        stored = await this.rotate(true);
        if (!stored) {
          if (revision === this.revision)
            this.signedOut(t("libSessionManager.yourSessionHasEndedSignInAgain"));
          return null;
        }
        try {
          profile = await this.deps.currentUser(stored.tokens.access_token);
        } catch (failure) {
          if (status(failure) !== 401) throw failure;
          const rejectedToken = stored.tokens.refresh_token;
          await this.deps.lock(() => {
            const current = this.read();
            if (current?.tokens.refresh_token === rejectedToken)
              this.deps.storage.removeItem(SESSION_KEY);
          });
          if (revision === this.revision)
            this.signedOut(t("libSessionManager.yourSessionHasEndedSignInAgain"));
          return null;
        }
      }
      const email = profile.user.email_address;
      const active = await this.deps.lock(() => {
        const current = this.read();
        if (!current) return null;
        if (
          current.tokens.refresh_token === stored.tokens.refresh_token &&
          current.email !== email
        ) {
          current.email = email;
          this.save(current);
        }
        if (revision === this.revision) this.authenticated(current);
        return current;
      });
      if (!active && revision === this.revision) this.signedOut();
      return active;
    };
    this.pending = task()
      .catch((error: unknown) => {
        if (revision !== this.revision) return this.snapshot.session;
        // A transient failure preserves credentials and the durable rotation id for a safe retry.
        this.update({
          ...this.snapshot,
          status: this.snapshot.session ? "signed_in" : "unavailable",
          error: t("libSessionManager.unableToRestoreYourSessionCheckYourConnectionRetrying"),
        });
        const delay = Math.max(this.retryDelay, retryAfter(error));
        this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
        this.timer = this.deps.schedule(() => {
          void this.restore();
        }, delay);
        return this.snapshot.session;
      })
      .finally(() => {
        this.pending = null;
        if (this.rerun) {
          this.rerun = false;
          void this.restore();
        }
      });
    return this.pending;
  }

  async accessToken() {
    const stored = await this.deps.lock(() => this.read());
    if (!stored) throw new Error(t("libSessionManager.signInToContinue"));
    const current =
      stored.expiresAt <= this.deps.now() + 30_000 || stored.refreshRequestId
        ? await this.restore()
        : stored;
    if (!current || current.expiresAt <= this.deps.now() || current.refreshRequestId)
      throw new Error(t("libSessionManager.yourSessionIsUnavailable"));
    return current.tokens.access_token;
  }

  async signOut() {
    const session = await this.deps.lock(() => this.read());
    if (!session) {
      this.revision++;
      this.signedOut();
      return;
    }
    try {
      if (session.expiresAt <= this.deps.now() + 30_000 || session.refreshRequestId)
        await this.restore();
      const current = await this.deps.lock(() => this.read());
      // A login in another tab while sign-out is preparing must not revoke that new session.
      if (current && current.tokens.session_id !== session.tokens.session_id) {
        this.revision++;
        this.authenticated(current);
        return;
      }
      if (current) {
        if (current.expiresAt <= this.deps.now() || current.refreshRequestId)
          throw new Error(t("libSessionManager.yourSessionIsUnavailable"));
        await this.deps.logout(current.tokens.access_token);
      }
    } catch (error) {
      if (status(error) !== 401 && (await this.deps.lock(() => this.read()))) throw error;
    }
    this.revision++;
    const remaining = await this.deps.lock(() => {
      const current = this.read();
      if (current?.tokens.session_id === session.tokens.session_id) {
        this.deps.storage.removeItem(SESSION_KEY);
        return null;
      }
      return current;
    });
    if (remaining) this.authenticated(remaining);
    else this.signedOut();
  }
}
