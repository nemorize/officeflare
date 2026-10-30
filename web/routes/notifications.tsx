import { enumLabel } from "../../shared/i18n/labels.ts";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  Button,
  CheckboxControl,
  CheckboxLabel,
  Field,
  SelectControl,
  Icon,
  useNotifications,
} from "@/components/ui";
import { NotificationCard, ReadAllButton } from "../components/notification-center";
import {
  useNotificationCenter,
  useNotificationList,
} from "../components/notification-center-context";
import { api, errorMessage } from "../lib/api";
import type {
  NotificationPreferences,
  NotificationState,
  NotificationType,
} from "../lib/notification-center";

export function NotificationsPage() {
  const center = useNotificationCenter(),
    [state, setState] = useState<NotificationState>("inbox"),
    [service, setService] = useState("");
  const [types, setTypes] = useState<NotificationType[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ types: NotificationType[] }>("/api/notifications/types", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
      .then((result) => {
        if (!controller.signal.aborted) setTypes(result.types);
      })
      .catch(() => {
        /* The all-services inbox remains available if the catalog is offline. */
      });
    return () => controller.abort();
  }, []);
  const services = [...new Set(types.map((item) => item.service))];
  const list = useNotificationList(state, service);
  return (
    <section className="account-page notification-page">
      <header className="account-page-header notification-page-header">
        <div>
          <h1>{t("routesNotifications.notifications")}</h1>
          <p>{t("routesNotifications.updatesAcrossYourOfficeflareWorkspace")}</p>
        </div>
        <Link
          to="/profile/notifications"
          aria-label={t("routesNotifications.notificationSettings")}
          title={t("routesNotifications.notificationSettings")}
        >
          <Icon name="settings" width="20" height="20" />
        </Link>
      </header>
      <div className="notification-toolbar">
        <Field.Root className="notification-filter">
          <Field.Label htmlFor="notification-state">{t("routesNotifications.show")}</Field.Label>
          <SelectControl
            id="notification-state"
            value={state}
            onValueChange={(value) => setState(value as NotificationState)}
            options={(["inbox", "unread", "archived", "snoozed", "all"] as const).map((value) => ({
              value,
              label: enumLabel(value),
            }))}
          />
        </Field.Root>
        <Field.Root className="notification-filter">
          <Field.Label htmlFor="notification-service">
            {t("routesNotifications.service")}
          </Field.Label>
          <SelectControl
            id="notification-service"
            value={service}
            onValueChange={setService}
            options={[
              { value: "", label: t("routesNotifications.allServices") },
              ...services.map((value) => ({
                value,
                label: enumLabel(value),
              })),
            ]}
          />
        </Field.Root>
        <ReadAllButton />
      </div>
      {(list.error || center.error) && (
        <p className="notification-error" role="alert">
          {list.error || center.error}
          <Button
            size="sm"
            onClick={() => {
              void center.refresh(true);
            }}
          >
            {t("common.retry")}
          </Button>
        </p>
      )}
      <div className="notification-page-list" aria-busy={list.loading}>
        <ul>
          {list.items.map((item) => (
            <NotificationCard key={item.id} item={item} stale={list.stale} />
          ))}
        </ul>
        {list.loading && (
          <p className="notification-empty" role="status">
            {t("routesNotifications.loadingNotifications")}
          </p>
        )}
        {!list.loading && !list.error && !list.items.length && (
          <div className="notification-empty">
            <Icon
              name={state === "archived" ? "archive" : state === "snoozed" ? "clock" : "bell"}
              width="28"
              height="28"
            />
            <strong>{t("routesNotifications.noNotificationsHere")}</strong>
            <p>{t("routesNotifications.updatesWillAppearAsActivityHappens")}</p>
          </div>
        )}
      </div>
      {list.next && (
        <div className="notification-load-more">
          <Button
            disabled={list.loading}
            onClick={() => {
              void list.loadMore();
            }}
          >
            {t("routesNotifications.loadMore")}
          </Button>
        </div>
      )}
    </section>
  );
}

export function NotificationSettingsPage() {
  const toast = useNotifications(),
    center = useNotificationCenter();
  const [settings, setSettings] = useState<NotificationPreferences | null>(null),
    [types, setTypes] = useState<NotificationType[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setSettings(null);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    void Promise.all([
      api<NotificationPreferences>("/api/notifications/preferences", { signal }),
      api<{ types: NotificationType[] }>("/api/notifications/types", { signal }),
    ])
      .then(([preferences, catalog]) => {
        if (!controller.signal.aborted) {
          setSettings(preferences);
          setTypes(catalog.types);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [reload]);
  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    try {
      const result = await api<NotificationPreferences>("/api/notifications/preferences", {
        method: "PUT",
        body: settings,
      });
      setSettings(result);
      toast.success(t("routesNotifications.notificationSettingsSaved"));
      await center.refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-page">
      <header className="account-page-header">
        <h1>{t("routesNotifications.notificationSettings")}</h1>
        <p>{t("routesNotifications.chooseTheUpdatesYouReceiveInYourNotificationCenter")}</p>
      </header>
      {error && (
        <p className="notification-error" role="alert">
          {error}
          <Button size="sm" disabled={busy} onClick={() => setReload((value) => value + 1)}>
            {t("routesNotifications.reloadSettings")}
          </Button>
        </p>
      )}
      {!settings ? (
        !error && <p role="status">{t("routesNotifications.loadingSettings")}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <section className="account-panel">
            <div className="account-panel-header">
              <h2>{t("routesNotifications.inAppNotifications")}</h2>
              <p>
                {t("routesNotifications.securityNotificationsAreAlwaysDeliveredToHelpProtectYour")}
              </p>
            </div>
            <CheckboxLabel className="notification-setting">
              <span className="notification-setting-content">
                <strong>{t("routesNotifications.receiveWorkspaceUpdatesByDefault")}</strong>
                <small>{t("routesNotifications.individualChoicesBelowOverrideThisDefault")}</small>
              </span>
              <CheckboxControl
                checked={settings.enabled}
                disabled={busy}
                onCheckedChange={(checked) => setSettings({ ...settings, enabled: checked })}
              />
            </CheckboxLabel>
            {types.map((item) => (
              <CheckboxLabel key={item.type} className="notification-setting">
                <span className="notification-setting-content">
                  <strong>{item.label}</strong>
                  <small>
                    {item.required
                      ? t("routesNotifications.alwaysOn")
                      : `${item.service === "account" ? t("routesNotifications.account") : t("routesNotifications.system")} · ${enumLabel(item.category)}`}
                  </small>
                </span>
                <CheckboxControl
                  checked={
                    item.required ||
                    (settings.rules[`type:${item.type}`] ??
                      settings.rules[`category:${item.service}:${enumLabel(item.category)}`] ??
                      settings.rules[`service:${item.service}`] ??
                      settings.enabled)
                  }
                  disabled={busy || item.required}
                  onCheckedChange={(checked) =>
                    setSettings({
                      ...settings,
                      rules: { ...settings.rules, [`type:${item.type}`]: checked },
                    })
                  }
                />
              </CheckboxLabel>
            ))}
            <div className="account-actions">
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? t("common.saving") : t("common.saveChanges")}
              </Button>
            </div>
          </section>
        </form>
      )}
    </section>
  );
}
