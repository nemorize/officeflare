import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../shared/i18n/index.ts";
import type { PushConfiguration } from "../../shared/push";
import { api, ApiError, errorMessage } from "../lib/api";
import { sessions, useSession } from "../lib/session";
import {
  bindPushWorker,
  browserPushToken,
  pushChoiceKey,
  pushDeviceId,
  pushSupported,
} from "../lib/push-browser";
import { useAccount } from "./account-context";
import { Button, Dialog, DialogPopup } from "./ui";

import { PushContext as Context } from "./push-context";

export function PushNotificationProvider({ children }: { children: ReactNode }) {
  const { user } = useAccount(),
    auth = useSession();
  const sessionId = auth.session?.tokens.session_id,
    userId = user?.email_address === auth.session?.email ? user?.id : undefined;
  const [config, setConfig] = useState<PushConfiguration | null>(null);
  const [prompt, setPrompt] = useState(false),
    [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const inFlight = useRef(false),
    alive = useRef(false);
  const supported = pushSupported();
  const register = useCallback(
    async (configuration: PushConfiguration, automatic = false, signal?: AbortSignal) => {
      if (!userId || !sessionId) return;
      const current = () =>
        alive.current &&
        !signal?.aborted &&
        sessions.getSnapshot().session?.tokens.session_id === sessionId &&
        (!automatic || localStorage.getItem(pushChoiceKey(userId)) === "enabled");
      if (!current()) return;
      const token = await browserPushToken(configuration);
      if (!current()) return;
      await api("/api/push/tokens", {
        method: "PUT",
        body: {
          device_id: pushDeviceId(),
          token_type: "fcm_web",
          token,
          session_id: sessionId,
        },
      });
      if (!current()) {
        if (
          sessions.getSnapshot().session?.tokens.session_id === sessionId &&
          localStorage.getItem(pushChoiceKey(userId)) === "disabled"
        )
          await api("/api/push/tokens", { method: "DELETE", body: { device_id: pushDeviceId() } });
        return;
      }
      await bindPushWorker({ userId, sessionId });
      if (current()) {
        setEnabled(true);
        setPrompt(false);
      }
    },
    [userId, sessionId],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!userId || !sessionId) return;
    const controller = new AbortController();
    void bindPushWorker(null).catch(() => {});
    let running = false;
    const refresh = async () => {
      if (running || inFlight.current || document.visibilityState === "hidden") return;
      running = true;
      try {
        const configuration = await api<PushConfiguration>("/api/push/config", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setConfig(configuration);
        setError("");
        setDenied(supported && Notification.permission === "denied");
        if (!supported) return;
        const choice = localStorage.getItem(pushChoiceKey(userId));
        if (
          configuration.available &&
          choice === "enabled" &&
          Notification.permission === "granted"
        ) {
          inFlight.current = true;
          setBusy(true);
          try {
            await register(configuration, true, controller.signal);
          } finally {
            inFlight.current = false;
            if (!controller.signal.aborted) setBusy(false);
          }
        } else {
          setEnabled(false);
          await bindPushWorker(null);
          if (choice === "enabled" && Notification.permission !== "granted")
            await api("/api/push/tokens", {
              method: "DELETE",
              body: { device_id: pushDeviceId() },
            });
          setPrompt(configuration.available && !choice && Notification.permission !== "denied");
        }
      } catch {
        // A transient failure never prompts for permission or changes saved consent.
        if (!controller.signal.aborted) {
          setConfig((previous) => previous ?? { available: false });
          setError(t("push.loadingFailed"));
        }
      } finally {
        running = false;
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const timer = setInterval(visible, 60 * 60 * 1000);
    window.addEventListener("focus", visible);
    window.addEventListener("online", visible);
    const changed = (event: StorageEvent) => {
      if (event.key === pushChoiceKey(userId)) void refresh();
    };
    window.addEventListener("storage", changed);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", visible);
      window.removeEventListener("online", visible);
      window.removeEventListener("storage", changed);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [userId, sessionId, supported, register]);

  async function enable() {
    if (inFlight.current || !config?.available || !supported || !userId) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      // Invoke directly from the click handler to preserve browser user activation.
      const permission = await Notification.requestPermission();
      setDenied(permission === "denied");
      if (permission !== "granted") {
        localStorage.setItem(pushChoiceKey(userId), "dismissed");
        setPrompt(false);
        if (permission === "denied") setError(t("push.denied"));
        return;
      }
      await register(config);
      if (!alive.current || sessions.getSnapshot().session?.tokens.session_id !== sessionId) return;
      localStorage.setItem(pushChoiceKey(userId), "enabled");
      setPrompt(false);
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof ApiError ? errorMessage(failure) : t("push.failed"));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function disable() {
    if (inFlight.current || !userId) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      // Persist opt-out first, preventing another tab from renewing this registration.
      localStorage.setItem(pushChoiceKey(userId), "disabled");
      await bindPushWorker(null);
      await api("/api/push/tokens", { method: "DELETE", body: { device_id: pushDeviceId() } });
      setEnabled(false);
      setPrompt(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function dismiss() {
    if (busy || !userId) return;
    try {
      localStorage.setItem(pushChoiceKey(userId), "dismissed");
    } catch {
      /* Retry is available in preferences. */
    }
    setPrompt(false);
    setError("");
  }
  return (
    <Context.Provider
      value={{
        loaded: !!config,
        available: !!config?.available,
        supported,
        enabled,
        denied,
        busy,
        error,
        enable,
        disable,
      }}
    >
      {children}
      <Dialog.Root
        open={prompt}
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
      >
        <DialogPopup>
          <Dialog.Title>{t("push.promptTitle")}</Dialog.Title>
          <Dialog.Description>{t("push.promptDescription")}</Dialog.Description>
          {error && (
            <p role="alert" className="account-notice">
              {error}
            </p>
          )}
          <div className="account-actions">
            <Button onClick={dismiss} disabled={busy}>
              {t("push.later")}
            </Button>
            <Button variant="primary" onClick={() => void enable()} disabled={busy}>
              {t("push.enable")}
            </Button>
          </div>
        </DialogPopup>
      </Dialog.Root>
    </Context.Provider>
  );
}
