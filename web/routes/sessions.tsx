import { LocalizedMessage } from "../components/i18n";
import { getLocale, t } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogPopup, Button, Icon, useNotifications } from "@/components/ui";
import { api, errorMessage } from "../lib/api";
import { sessions } from "../lib/session";

interface AccountSession {
  id: string;
  current: boolean;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  user_agent: string | null;
}
const date = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleString(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });
function device(agent: string | null) {
  if (!agent) return t("routesSessions.browserSession");
  const browser = /Edg\//.test(agent)
    ? t("routesSessions.edge")
    : /Firefox\//.test(agent)
      ? t("routesSessions.firefox")
      : /Chrome\//.test(agent)
        ? t("routesSessions.chrome")
        : /Safari\//.test(agent)
          ? t("routesSessions.safari")
          : t("routesSessions.browser");
  const system = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? t("routesSessions.android")
      : /Windows/.test(agent)
        ? t("routesSessions.windows")
        : /Mac/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? t("routesSessions.linux")
            : t("routesSessions.anotherDevice");
  return t("routesSessions.on", { browser: browser, system: system });
}

export function SessionsPage() {
  const notify = useNotifications();
  const [items, setItems] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<AccountSession | "all" | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<{ sessions: AccountSession[] }>("/api/me/sessions", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setItems(result.sessions);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function revoke() {
    if (!target || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api(
        target === "all" ? "/api/me/sessions" : `/api/me/sessions/${encodeURIComponent(target.id)}`,
        { method: "DELETE" },
      );
      if (target === "all") {
        notify.success(t("routesSessions.allSessionsHaveBeenSignedOut"));
        await sessions.restore();
      } else {
        setItems((current) => current.filter((item) => item.id !== target.id));
        notify.success(t("routesSessions.theSessionHasBeenSignedOut"));
      }
      setTarget(null);
    } catch (failure) {
      notify.error(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="account-page">
      <header className="account-page-header">
        <h1>{t("routesSessions.sessions")}</h1>
        <p>{t("routesSessions.reviewTheDevicesSignedInToYourAccount")}</p>
      </header>
      <section className="account-panel">
        <div className="account-panel-header">
          <h2>{t("routesSessions.activeSessions")}</h2>
          <p>{t("routesSessions.signOutASessionYouNoLongerUseOr")}</p>
        </div>
        {loading ? (
          <p className="account-loading" role="status">
            {t("routesSessions.loadingSessions")}
          </p>
        ) : (
          <>
            {error ? (
              <p className="account-notice" data-error role="alert">
                {error}
              </p>
            ) : (
              <div className="account-session-list">
                {items.map((item) => (
                  <div className="account-session" key={item.id}>
                    <span className="account-session-icon">
                      <Icon name="laptop" width="19" height="19" />
                    </span>
                    <div className="account-session-details">
                      <div className="account-session-title">
                        <h3>{device(item.user_agent)}</h3>
                        {item.current && (
                          <span className="account-session-badge">
                            {t("routesSessions.thisDevice")}
                          </span>
                        )}
                      </div>
                      <p>
                        <LocalizedMessage
                          id="routesSessions.signedIn"
                          values={{ date: date(item.created_at) }}
                        />
                      </p>
                      <p>
                        <LocalizedMessage
                          id="routesSessions.lastActive"
                          values={{ date: date(item.last_used_at) }}
                        />
                      </p>
                      <p>
                        <LocalizedMessage
                          id="routesSessions.expires"
                          values={{ date: date(item.expires_at) }}
                        />
                      </p>
                    </div>
                    {!item.current && (
                      <Button size="sm" disabled={busy} onClick={() => setTarget(item)}>
                        {t("routesSessions.signOut")}
                      </Button>
                    )}
                  </div>
                ))}
                {!items.length && (
                  <p className="account-loading">{t("routesSessions.noActiveSessions")}</p>
                )}
              </div>
            )}
          </>
        )}
      </section>
      <section className="account-panel account-danger-panel">
        <div>
          <h2>{t("routesSessions.signOutEverywhere")}</h2>
          <p>{t("routesSessions.endAllSessionsIncludingThisDevice")}</p>
        </div>
        <Button variant="danger" disabled={busy} onClick={() => setTarget("all")}>
          {t("routesSessions.signOutEverywhere")}
        </Button>
      </section>
      <AlertDialog.Root
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !inFlight.current) setTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialog.Title>
            {target === "all"
              ? t("routesSessions.signOutEverywhere2")
              : t("routesSessions.signOutThisSession")}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {target === "all"
              ? t("routesSessions.youWillNeedToSignInAgainOnEvery")
              : t("routesSessions.theSelectedDeviceWillNeedToSignInAgain")}
          </AlertDialog.Description>
          <div className="account-actions">
            <Button disabled={busy} onClick={() => setTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                void revoke();
              }}
            >
              {busy ? t("routesSessions.signingOut") : t("routesSessions.signOut")}
            </Button>
          </div>
        </AlertDialogPopup>
      </AlertDialog.Root>
    </section>
  );
}
