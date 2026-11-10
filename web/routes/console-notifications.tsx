import { useEffect, useState } from "react";
import { t } from "../../shared/i18n/index.ts";
import type { PushSettings } from "../../shared/push";
import { api, errorMessage } from "../lib/api";
import { useAccess } from "../components/console-access";
import {
  ConsoleSection,
  ConsoleSettingsHeader,
  ConsoleState,
} from "../components/console-settings";
import { Button, CheckboxControl, CheckboxLabel, useNotifications } from "../components/ui";

export function NotificationConsolePage() {
  const access = useAccess(),
    toast = useNotifications();
  const [settings, setSettings] = useState<PushSettings | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const editable = access.permissions.includes("admin.notifications.settings.manage");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<PushSettings>("/api/push/settings", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setSettings(data);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [revision]);
  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<PushSettings>("/api/push/settings", {
        method: "PUT",
        body: {
          web_push_enabled: settings.web_push_enabled,
          version: settings.version,
        },
      });
      setSettings(result);
      toast.success(t("push.saved"));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-page console-page console-settings" data-ui-theme="neutral">
      <ConsoleSettingsHeader
        title={t("push.adminTitle")}
        description={t("push.adminDescription")}
      />
      <ConsoleState
        loading={!settings}
        error={error}
        retry={() => setRevision((value) => value + 1)}
      />
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ConsoleSection
            title={t("push.title")}
            description={settings.configured ? t("push.configured") : t("push.notConfigured")}
          >
            <CheckboxLabel className="notification-setting">
              <span className="notification-setting-content">
                <strong>{t("push.adminEnable")}</strong>
                <small>{t("push.adminHint")}</small>
              </span>
              <CheckboxControl
                checked={settings.web_push_enabled}
                disabled={busy || !editable || (!settings.configured && !settings.web_push_enabled)}
                onCheckedChange={(checked) =>
                  setSettings({ ...settings, web_push_enabled: checked })
                }
              />
            </CheckboxLabel>
            {editable && (
              <div className="account-actions">
                <Button type="submit" variant="primary" disabled={busy}>
                  {t("common.save")}
                </Button>
              </div>
            )}
          </ConsoleSection>
        </form>
      )}
    </section>
  );
}
