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
          <h1>Notifications</h1>
          <p>Updates across your Officeflare workspace.</p>
        </div>
        <Link
          to="/profile/notifications"
          aria-label="Notification settings"
          title="Notification settings"
        >
          <Icon name="settings" width="20" height="20" />
        </Link>
      </header>
      <div className="notification-toolbar">
        <Field.Root className="notification-filter">
          <Field.Label htmlFor="notification-state">Show</Field.Label>
          <SelectControl
            id="notification-state"
            value={state}
            onValueChange={(value) => setState(value as NotificationState)}
            options={(["inbox", "unread", "archived", "snoozed", "all"] as const).map((value) => ({
              value,
              label: value[0]!.toUpperCase() + value.slice(1),
            }))}
          />
        </Field.Root>
        <Field.Root className="notification-filter">
          <Field.Label htmlFor="notification-service">Service</Field.Label>
          <SelectControl
            id="notification-service"
            value={service}
            onValueChange={setService}
            options={[
              { value: "", label: "All services" },
              ...services.map((value) => ({
                value,
                label: value[0]!.toUpperCase() + value.slice(1),
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
            Retry
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
            Loading notifications…
          </p>
        )}
        {!list.loading && !list.error && !list.items.length && (
          <div className="notification-empty">
            <Icon
              name={state === "archived" ? "archive" : state === "snoozed" ? "clock" : "bell"}
              width="28"
              height="28"
            />
            <strong>No notifications here</strong>
            <p>Updates will appear as activity happens.</p>
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
            Load more
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
      toast.success("Notification settings saved.");
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
        <h1>Notification settings</h1>
        <p>Choose the updates you receive in your notification center.</p>
      </header>
      {error && (
        <p className="notification-error" role="alert">
          {error}
          <Button size="sm" disabled={busy} onClick={() => setReload((value) => value + 1)}>
            Reload settings
          </Button>
        </p>
      )}
      {!settings ? (
        !error && <p role="status">Loading settings…</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <section className="account-panel">
            <div className="account-panel-header">
              <h2>In-app notifications</h2>
              <p>Security notifications are always delivered to help protect your account.</p>
            </div>
            <CheckboxLabel className="notification-setting">
              <span className="notification-setting-content">
                <strong>Receive workspace updates by default</strong>
                <small>Individual choices below override this default.</small>
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
                      ? "Always on"
                      : `${item.service === "account" ? "Account" : "System"} · ${item.category}`}
                  </small>
                </span>
                <CheckboxControl
                  checked={
                    item.required ||
                    (settings.rules[`type:${item.type}`] ??
                      settings.rules[`category:${item.service}:${item.category}`] ??
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
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </section>
        </form>
      )}
    </section>
  );
}
