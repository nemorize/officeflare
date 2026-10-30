import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState } from "react";
import { Button, CheckboxControl, Input, useNotifications } from "./ui";
import {
  CalendarField,
  CalendarModal,
  CalendarNotice,
  useCalendarAction,
  useCalendarResource,
} from "./calendar-controls";
import { CalendarTimeZoneField } from "./calendar-editor";
import { useCalendar } from "./calendar-context";
import { calendarApi, type CalendarRecord } from "../lib/calendar";
import { MailOperation } from "../lib/mail-helpers";
import { ApiError } from "../lib/api";

interface Feed {
  version: number;
  source_host: string;
  enabled: boolean;
  status: "pending" | "syncing" | "healthy" | "error" | "paused";
  last_attempt_at: number | null;
  last_success_at: number | null;
  next_sync_at: number | null;
  event_count: number;
  error_message: string | null;
  warnings: string[];
}
const stamp = (value: number | null) =>
  value ? new Date(value * 1000).toLocaleString() : t("componentsCalendarFeed.notYet");
export function CalendarFeedDialog({
  cal: initial,
  onClose,
}: {
  cal?: CalendarRecord;
  onClose: () => void;
}) {
  const calendar = useCalendar(),
    action = useCalendarAction(),
    notify = useNotifications();
  const [cal, setCal] = useState(initial),
    [name, setName] = useState(initial?.name ?? ""),
    [url, setUrl] = useState("");
  const [zone, setZone] = useState(initial?.time_zone ?? calendar.zone),
    [enabled, setEnabled] = useState<boolean | null>(null),
    [revision, setRevision] = useState(0),
    [disconnect, setDisconnect] = useState(false);
  const operation = useRef(new MailOperation()),
    lastSuccess = useRef<number | null>(null);
  const resource = useCalendarResource<{ feed: Feed }>(
      cal ? `/calendars/${cal.id}/feed` : null,
      revision,
    ),
    feed = resource.data?.feed;
  useEffect(() => {
    if (!cal) return;
    const timer = setInterval(
      () => setRevision((value) => value + 1),
      feed?.status === "pending" || feed?.status === "syncing" ? 3000 : 15000,
    );
    return () => clearInterval(timer);
  }, [cal?.id, feed?.status]);
  useEffect(() => {
    if (feed?.last_success_at && feed.last_success_at !== lastSuccess.current) {
      lastSuccess.current = feed.last_success_at;
      calendar.refresh();
    }
  }, [feed?.last_success_at]);
  const save = () =>
    action.run(async () => {
      if (!cal) {
        const body = { name: name.trim(), url: url.trim(), time_zone: zone };
        try {
          const result = await calendarApi<{ calendar: CalendarRecord }>("/feeds", {
            method: "POST",
            body,
            headers: operation.current.headers(body),
          });
          operation.current.complete();
          setCal(result.calendar);
          setUrl("");
          calendar.refresh(true);
          notify.success(
            t("componentsCalendarFeed.externalCalendarRegisteredItsFirstSyncIsQueued"),
          );
        } catch (error) {
          if (error instanceof ApiError && error.status < 500) operation.current.complete();
          throw error;
        }
      } else {
        if (name.trim() !== cal.name) {
          const result = await calendarApi<{ calendar: CalendarRecord }>(`/calendars/${cal.id}`, {
            method: "PATCH",
            body: { version: cal.version, name: name.trim() },
          });
          setCal(result.calendar);
          calendar.refresh(true);
        }
        if (feed && (url.trim() || (enabled !== null && enabled !== feed.enabled))) {
          await calendarApi(`/calendars/${cal.id}/feed`, {
            method: "PATCH",
            body: {
              version: feed.version,
              ...(url.trim() ? { url: url.trim() } : {}),
              ...(enabled !== null ? { enabled } : {}),
            },
          });
          setUrl("");
          setEnabled(null);
          setRevision((value) => value + 1);
        }
        notify.success(t("componentsCalendarFeed.externalCalendarSettingsSaved"));
      }
    });
  const connectionFields = (
    <div className="calendar-settings-fields">
      <CalendarField
        label={t("componentsCalendarFeed.calendarName")}
        required
        maxLength={255}
        value={name}
        disabled={action.busy}
        onChange={(event) => setName(event.target.value)}
      />
      <CalendarField
        label={
          cal
            ? t("componentsCalendarFeed.replaceSubscriptionUrl")
            : t("componentsCalendarFeed.subscriptionUrl")
        }
        hint={
          cal
            ? t("componentsCalendarFeed.sourceLeaveBlankToKeepTheSavedUrl", {
                value1: feed?.source_host ?? t("common.loading"),
              })
            : t("componentsCalendarFeed.pasteAPublicOrSecretIcsSubscriptionLinkFrom")
        }
      >
        <Input
          type="url"
          aria-label={
            cal
              ? t("componentsCalendarFeed.replaceSubscriptionUrl")
              : t("componentsCalendarFeed.subscriptionUrl")
          }
          placeholder={t("componentsCalendarFeed.httpsCalendarExampleComCalendarIcs")}
          value={url}
          autoComplete="off"
          spellCheck={false}
          required={!cal}
          maxLength={4096}
          disabled={action.busy}
          onChange={(event) => setUrl(event.target.value)}
        />
      </CalendarField>
      {!cal && <CalendarTimeZoneField value={zone} onChange={setZone} />}
      <p className="calendar-import-hint">
        {t("componentsCalendarFeed.officeflareChecksForUpdatesEveryHourYouCanAlso")}
      </p>
      {cal && feed && (
        <label className="calendar-check-label">
          <CheckboxControl
            checked={enabled ?? feed.enabled}
            disabled={action.busy}
            onCheckedChange={setEnabled}
          />
          {t("componentsCalendarFeed.automaticallySynchronizeThisCalendar")}
        </label>
      )}
    </div>
  );
  return (
    <CalendarModal
      title={
        cal
          ? t("componentsCalendarFeed.externalCalendar")
          : t("componentsCalendarFeed.subscribeToACalendar")
      }
      description={t("componentsCalendarFeed.readOnlySyncFromAnIcalendarUrlChangesMade")}
      onClose={onClose}
      busy={action.busy}
      className="calendar-feed-modal"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {cal ? (
          <details className="calendar-feed-connection">
            <summary>
              <LocalizedMessage
                id="componentsCalendarFeed.connectionSettings"
                values={{ name: cal.name }}
              />
            </summary>
            {connectionFields}
          </details>
        ) : (
          connectionFields
        )}
        {cal && (
          <section
            className="calendar-feed-status"
            aria-label={t("componentsCalendarFeed.synchronizationStatus")}
          >
            <p className="calendar-import-hint">
              <LocalizedMessage
                id="componentsCalendarFeed.checksEveryHour"
                values={{ source_host: feed?.source_host }}
              />
            </p>
            <p role="status">
              <strong>
                {feed
                  ? {
                      pending: t("componentsCalendarFeed.waitingToSynchronize"),
                      syncing: t("componentsCalendarFeed.synchronizing"),
                      healthy: t("componentsCalendarFeed.upToDate"),
                      error: t("componentsCalendarFeed.syncNeedsAttention"),
                      paused: t("componentsCalendarFeed.syncPaused"),
                    }[feed.status]
                  : t("componentsCalendarFeed.loadingSyncStatus")}
              </strong>
            </p>
            {feed && (
              <>
                <dl>
                  <div>
                    <dt>{t("componentsCalendarFeed.lastChecked")}</dt>
                    <dd>{stamp(feed.last_attempt_at)}</dd>
                  </div>
                  <div>
                    <dt>{t("componentsCalendarFeed.lastSuccessfulSync")}</dt>
                    <dd>{stamp(feed.last_success_at)}</dd>
                  </div>
                  <div>
                    <dt>{t("componentsCalendarFeed.nextCheck")}</dt>
                    <dd>
                      {feed.enabled ? stamp(feed.next_sync_at) : t("componentsCalendarFeed.paused")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("componentsCalendarFeed.events")}</dt>
                    <dd>{feed.event_count}</dd>
                  </div>
                </dl>
                <CalendarNotice error={feed.error_message ?? ""} />
                {feed.error_message && (
                  <p className="calendar-import-hint">
                    {t(
                      "componentsCalendarFeed.previouslySynchronizedEventsStayAvailableOfficeflareRetriesAutomaticallyIf",
                    )}
                  </p>
                )}
                {!!feed.warnings.length && (
                  <details>
                    <summary>{t("componentsCalendarFeed.syncNotes")}</summary>
                    {feed.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </details>
                )}
                <Button
                  size="sm"
                  disabled={action.busy || !feed.enabled || feed.status === "syncing"}
                  onClick={() => {
                    void action.run(async () => {
                      await calendarApi(`/calendars/${cal.id}/feed/refresh`, {
                        method: "POST",
                        body: { version: feed.version },
                      });
                      setRevision((value) => value + 1);
                      notify.info(t("componentsCalendarFeed.calendarRefreshQueued"));
                    });
                  }}
                >
                  {t("componentsCalendarFeed.refreshNow")}
                </Button>
              </>
            )}
          </section>
        )}
        <CalendarNotice error={action.error || resource.error} />
        {cal && feed && (
          <div className="calendar-feed-disconnect">
            {disconnect ? (
              <>
                <p>{t("componentsCalendarFeed.disconnectThisCalendarAndRemoveItFromYourView")}</p>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={action.busy}
                  onClick={() => {
                    void action.run(async () => {
                      await calendarApi(`/calendars/${cal.id}/feed?version=${feed.version}`, {
                        method: "DELETE",
                      });
                      calendar.refresh(true);
                      notify.success(t("componentsCalendarFeed.externalCalendarDisconnected"));
                      onClose();
                    });
                  }}
                >
                  {t("componentsCalendarFeed.disconnectCalendar")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={action.busy}
                  onClick={() => setDisconnect(false)}
                >
                  {t("componentsCalendarFeed.keepCalendar")}
                </Button>
              </>
            ) : (
              <Button
                variant="text"
                size="sm"
                disabled={action.busy}
                onClick={() => setDisconnect(true)}
              >
                {t("componentsCalendarFeed.disconnectCalendar")}
              </Button>
            )}
          </div>
        )}
        <div className="calendar-dialog-actions">
          <Button variant="ghost" disabled={action.busy} onClick={onClose}>
            {cal ? t("common.done") : t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={action.busy || !name.trim() || (!cal && !url.trim()) || (!!cal && !feed)}
          >
            {action.busy
              ? t("common.saving")
              : cal
                ? t("common.save")
                : t("componentsCalendarFeed.subscribe")}
          </Button>
        </div>
      </form>
    </CalendarModal>
  );
}
