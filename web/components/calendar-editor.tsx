import { t } from "../../shared/i18n/index.ts";
import { useEffect, useId, useRef, useState } from "react";
import {
  Button,
  CheckboxControl,
  Dialog,
  DialogPopup,
  Field,
  Icon,
  Input,
  Radio,
  RadioGroup,
  SelectControl,
  Tabs,
  Textarea,
  useNotifications,
} from "./ui";
import {
  CalendarField,
  CalendarIconButton,
  CalendarModal,
  CalendarNotice,
  useCalendarAction,
  useCalendarResource,
} from "./calendar-controls";
import { useCalendar, type CalendarCreateRequest } from "./calendar-context";
import { RecipientField } from "./mail-recipients";
import { LoadingSkeleton } from "./loading-skeleton";
import { ApiError } from "../lib/api";
import { MailOperation, parseRecipients } from "../lib/mail-helpers";
import {
  calendarApi,
  calendarWritable,
  eventPath,
  type CalendarEvent,
  type CalendarScope,
} from "../lib/calendar";
import {
  addDays,
  dateInstant,
  dateLabel,
  endpointLocal,
  eventTimeLabel,
  Temporal,
  validDate,
} from "../lib/calendar-date";
import {
  draftForEvent,
  draftTimes,
  eventChanges,
  initialNewEvent,
  recurrenceChanged,
  type EventDraft,
} from "../lib/calendar-editor";

export function CalendarScopeDialog({
  title,
  onConfirm,
  onClose,
  busy = false,
  allowSingle = true,
  allowFollowing = true,
  error = "",
}: {
  title: string;
  onConfirm: (scope: CalendarScope) => void;
  onClose: () => void;
  busy?: boolean;
  allowSingle?: boolean;
  allowFollowing?: boolean;
  error?: string;
}) {
  const [scope, setScope] = useState<CalendarScope>(
    allowSingle ? "single" : allowFollowing ? "following" : "all",
  );
  return (
    <CalendarModal
      title={title}
      description={t("componentsCalendarEditor.chooseWhichEventsInThisSeriesToChange")}
      onClose={onClose}
      busy={busy}
      className="calendar-scope-modal"
    >
      <RadioGroup
        value={scope}
        onValueChange={(value) => setScope(value as CalendarScope)}
        aria-label={t("componentsCalendarEditor.repeatingEventScope")}
        className="calendar-scope-options"
      >
        {[
          {
            value: "single",
            label: t("componentsCalendarEditor.thisEvent"),
            disabled: !allowSingle,
          },
          {
            value: "following",
            label: t("componentsCalendarEditor.thisAndFollowingEvents"),
            disabled: !allowFollowing,
          },
          { value: "all", label: t("componentsCalendarEditor.allEvents"), disabled: false },
        ].map((option) => (
          <label key={option.value} data-disabled={option.disabled || undefined}>
            <Radio.Root value={option.value} disabled={option.disabled}>
              <Radio.Indicator>{t("componentsCalendarEditor.text")}</Radio.Indicator>
            </Radio.Root>
            <span>{option.label}</span>
          </label>
        ))}
      </RadioGroup>
      <CalendarNotice error={error} />
      <div className="calendar-dialog-actions">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={() => onConfirm(scope)} disabled={busy}>
          {t("componentsCalendarEditor.confirm")}
        </Button>
      </div>
    </CalendarModal>
  );
}
export const timeZones = [
  ...new Set([
    "UTC",
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...Intl.supportedValuesOf("timeZone"),
  ]),
];
export function CalendarTimeZoneField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <CalendarField label={t("componentsCalendarEditor.timeZone")}>
      <Input
        aria-label={t("componentsCalendarEditor.timeZone")}
        value={value}
        disabled={disabled}
        list={id}
        onChange={(event) => onChange(event.target.value)}
        required
      />
      <datalist id={id}>
        {timeZones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </CalendarField>
  );
}
function FindTime({
  draft,
  onChoose,
}: {
  draft: EventDraft;
  onChoose: (start: string, end: string) => void;
}) {
  const calendar = useCalendar(),
    action = useCalendarAction();
  const [ids, setIds] = useState<string[]>([draft.calendarId]),
    [slots, setSlots] = useState<{ start: string; end: string }[] | null>(null),
    [working, setWorking] = useState(false),
    [visible, setVisible] = useState(24);
  const load = () =>
    action.run(async () => {
      const times = draftTimes(draft);
      if (draft.allDay)
        throw new Error(t("componentsCalendarEditor.chooseStartAndEndTimesToFindAnAvailable"));
      const duration = Math.round(
        (Temporal.Instant.from(times.end.date_time!).epochMilliseconds -
          Temporal.Instant.from(times.start.date_time!).epochMilliseconds) /
          60_000,
      );
      const result = await calendarApi<{ slots: { start: string; end: string }[] }>(
        "/availability/query",
        {
          method: "POST",
          body: {
            calendar_ids: ids,
            time_min: dateInstant(draft.startDate, draft.zone),
            time_max: dateInstant(addDays(draft.startDate, 7), draft.zone),
            duration_minutes: duration,
            step_minutes: 30,
            working_hours_only: working,
          },
        },
      );
      setSlots(result.slots);
      setVisible(24);
    });
  return (
    <section className="calendar-find-time">
      <p>{t("componentsCalendarEditor.findATimeAcrossCalendarsYouCanAccess")}</p>
      <div className="calendar-availability-calendars">
        {calendar.data?.calendars.map((cal) => (
          <label key={cal.id}>
            <CheckboxControl
              checked={ids.includes(cal.id)}
              onCheckedChange={(checked) => {
                setIds((old) => (checked ? [...old, cal.id] : old.filter((id) => id !== cal.id)));
                setSlots(null);
              }}
            />
            {cal.name}
          </label>
        ))}
      </div>
      <label className="calendar-check-label">
        <CheckboxControl
          checked={working}
          onCheckedChange={(value) => {
            setWorking(value);
            setSlots(null);
          }}
        />
        {t("componentsCalendarEditor.withinWorkingHours")}
      </label>
      <CalendarNotice error={action.error} />
      <Button
        disabled={action.busy || !ids.length || draft.allDay}
        onClick={() => {
          void load();
        }}
      >
        {action.busy
          ? t("componentsCalendarEditor.findingTimes")
          : t("componentsCalendarEditor.findAvailableTimes")}
      </Button>
      {slots && (
        <div className="calendar-available-slots">
          {!slots.length && (
            <p>{t("componentsCalendarEditor.noAvailableTimesInTheNextSevenDaysTry")}</p>
          )}
          {slots.slice(0, visible).map((slot) => (
            <button type="button" key={slot.start} onClick={() => onChoose(slot.start, slot.end)}>
              <span>
                {dateLabel(
                  endpointLocal({ date_time: slot.start, time_zone: draft.zone }, draft.zone).date,
                  { weekday: "short", month: "short", day: "numeric" },
                )}
              </span>
              <strong>
                {eventTimeLabel(
                  {
                    start: { date_time: slot.start, time_zone: draft.zone },
                    end: { date_time: slot.end, time_zone: draft.zone },
                  } as CalendarEvent,
                  draft.zone,
                )}
              </strong>
              <Icon name="plus" />
            </button>
          ))}
          {slots.length > visible && (
            <Button variant="text" onClick={() => setVisible((old) => old + 24)}>
              {t("componentsCalendarEditor.showMoreTimes")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
export function CalendarEventEditor({
  event,
  request,
  onClose,
  onSaved,
}: {
  event?: CalendarEvent;
  request?: CalendarCreateRequest;
  onClose: () => void;
  onSaved: () => void;
}) {
  const calendar = useCalendar(),
    notify = useNotifications(),
    action = useCalendarAction();
  const master = useCalendarResource<{ event: CalendarEvent }>(event ? eventPath(event) : null);
  const instance = useCalendarResource<{ event: CalendarEvent }>(
    event?.occurrence_key
      ? `${eventPath(event)}/instances/${encodeURIComponent(event.occurrence_key)}`
      : null,
  );
  const [draft, setDraft] = useState<EventDraft | null>(null),
    [initial, setInitial] = useState<EventDraft | null>(null),
    [guests, setGuests] = useState("");
  const [tab, setTab] = useState("details"),
    [customRepeat, setCustomRepeat] = useState(false),
    [scope, setScope] = useState(false),
    [discard, setDiscard] = useState(false);
  const initialized = useRef(false),
    operation = useRef(new MailOperation());
  useEffect(() => {
    if (
      initialized.current ||
      !calendar.data ||
      (event && (!master.data || (event.occurrence_key && !instance.data)))
    )
      return;
    try {
      if (event?.occurrence_key && instance.data!.event.version !== master.data!.event.version)
        throw new Error(t("componentsCalendarEditor.thisEventChangedCloseAndReopenItToLoad"));
      const source = event
        ? {
            ...(instance.data?.event ?? master.data!.event),
            recurrence: master.data!.event.recurrence,
            version: master.data!.event.version,
          }
        : initialNewEvent(
            request?.date ?? calendar.date,
            calendar.zone,
            calendar.data.preferences.default_duration_minutes,
            request?.minute,
            request?.allDay,
            request?.endDate,
            request?.endMinute,
          );
      const value = draftForEvent(source, calendar.zone);
      value.calendarId =
        event?.calendar_id ??
        calendar.data.calendars.find(
          (cal) =>
            cal.id === calendar.data!.preferences.default_calendar_id && calendarWritable(cal),
        )?.id ??
        calendar.data.calendars.find(
          (cal) => cal.id === calendar.data!.primary_calendar_id && calendarWritable(cal),
        )?.id ??
        calendar.data.calendars.find((cal) => calendarWritable(cal))?.id ??
        "";
      setDraft(value);
      setInitial(value);
      initialized.current = true;
    } catch (error) {
      action.setError(
        error instanceof Error
          ? error.message
          : t("componentsCalendarEditor.unableToOpenThisEvent"),
      );
    }
  }, [master.data, instance.data, calendar.data, event, request]);
  const update = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) =>
    setDraft((old) => (old ? { ...old, [key]: value } : old));
  const dirty =
    draft && initial && (JSON.stringify(draft) !== JSON.stringify(initial) || guests.trim());
  const close = () => {
    if (action.busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const save = async (chosen: CalendarScope) => {
    if (!draft) return;
    await action.run(async () => {
      draftTimes(draft);
      const changes = eventChanges(draft, event ? initial : null, master.data?.event, chosen);
      if (event && !Object.keys(changes).length) {
        onClose();
        return;
      }
      const body = event
        ? {
            ...changes,
            version: master.data!.event.version,
            ...(master.data!.event.recurrence?.length
              ? { scope: chosen, occurrence_key: event.occurrence_key }
              : {}),
          }
        : {
            ...changes,
            ...(guests.trim()
              ? { attendees: parseRecipients(guests).map((email_address) => ({ email_address })) }
              : {}),
          };
      try {
        await calendarApi(event ? eventPath(event) : `/calendars/${draft.calendarId}/events`, {
          method: event ? "PATCH" : "POST",
          body,
          ...(!event ? { headers: operation.current.headers(body) } : {}),
        });
        operation.current.complete();
        notify.success(
          event
            ? t("componentsCalendarEditor.eventUpdated")
            : t("componentsCalendarEditor.eventCreated"),
        );
        onSaved();
      } catch (failure) {
        if (failure instanceof ApiError && failure.status < 500) operation.current.complete();
        throw failure;
      }
    });
  };
  const repeatChanged = !!draft && !!initial && recurrenceChanged(draft, initial);
  return (
    <>
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup
          data-ui-theme="neutral"
          className="calendar-modal calendar-editor"
          viewportProps={{ className: "calendar-editor-viewport" }}
        >
          <div className="calendar-editor-heading">
            <span>
              <Icon name="calendar" />
              {event
                ? t("componentsCalendarEditor.editEvent")
                : t("componentsCalendarEditor.newEvent")}
            </span>
            <CalendarIconButton
              icon="close"
              label={t("componentsCalendarEditor.closeEventEditor")}
              disabled={action.busy}
              onClick={close}
            />
          </div>
          <Dialog.Title className="visually-hidden">
            {event
              ? t("componentsCalendarEditor.editEvent")
              : t("componentsCalendarEditor.createEvent")}
          </Dialog.Title>
          <Dialog.Description className="visually-hidden">
            {t("componentsCalendarEditor.eventDatesGuestsAndDetails")}
          </Dialog.Description>
          {!draft ? (
            <div className="calendar-editor-loading">
              <LoadingSkeleton kind="form" label={t("componentsCalendarEditor.loadingEvent")} />
              <CalendarNotice error={master.error || instance.error || action.error} />
            </div>
          ) : (
            <form
              onSubmit={(submit) => {
                submit.preventDefault();
                try {
                  draftTimes(draft);
                } catch (error) {
                  action.setError((error as Error).message);
                  return;
                }
                if (master.data?.event.recurrence?.length) setScope(true);
                else void save("all");
              }}
            >
              <div className="calendar-editor-scroll">
                <Input
                  className="calendar-event-title-input"
                  variant="integrated"
                  aria-label={t("componentsCalendarEditor.eventTitle")}
                  placeholder={t("componentsCalendarEditor.addTitle")}
                  autoFocus
                  value={draft.title}
                  maxLength={1000}
                  onChange={(event) => update("title", event.target.value)}
                />
                <Tabs.Root
                  className="calendar-editor-sections"
                  value={tab}
                  onValueChange={(value) => setTab(String(value))}
                >
                  <Tabs.List
                    className="calendar-event-editor-tabs"
                    aria-label={t("componentsCalendarEditor.eventEditorSections")}
                  >
                    <Tabs.Tab value="details">
                      {t("componentsCalendarEditor.eventDetails")}
                    </Tabs.Tab>
                    <Tabs.Tab value="find">{t("componentsCalendarEditor.findATime")}</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="find">
                    <FindTime
                      draft={draft}
                      onChoose={(start, end) => {
                        const a = endpointLocal(
                            { date_time: start, time_zone: draft.zone },
                            draft.zone,
                          ),
                          b = endpointLocal({ date_time: end, time_zone: draft.zone }, draft.zone);
                        setDraft((old) =>
                          old
                            ? {
                                ...old,
                                startDate: a.date,
                                startTime: a.time,
                                endDate: b.date,
                                endTime: b.time,
                              }
                            : old,
                        );
                        setTab("details");
                      }}
                    />
                  </Tabs.Panel>
                  <Tabs.Panel value="details">
                    <div className="calendar-editor-fields">
                      <div className="calendar-editor-row">
                        <Icon name="clock" />
                        <div className="calendar-editor-time-fields">
                          <div className="calendar-date-time-pair">
                            <Input
                              aria-label={t("componentsCalendarEditor.startDate")}
                              type="date"
                              min="1970-01-01"
                              max="2100-12-31"
                              required
                              value={draft.startDate}
                              onChange={(event) => {
                                const value = event.target.value;
                                setDraft((old) =>
                                  old
                                    ? {
                                        ...old,
                                        startDate: value,
                                        endDate: old.endDate < value ? value : old.endDate,
                                      }
                                    : old,
                                );
                              }}
                            />
                            {!draft.allDay && (
                              <Input
                                aria-label={t("componentsCalendarEditor.startTime")}
                                type="time"
                                required
                                value={draft.startTime}
                                onChange={(event) => update("startTime", event.target.value)}
                              />
                            )}
                          </div>
                          <span className="calendar-time-divider">
                            {t("componentsCalendarEditor.text2")}
                          </span>
                          <div className="calendar-date-time-pair">
                            <Input
                              aria-label={t("componentsCalendarEditor.endDate")}
                              type="date"
                              min={draft.startDate}
                              max="2100-12-31"
                              required
                              value={draft.endDate}
                              onChange={(event) => update("endDate", event.target.value)}
                            />
                            {!draft.allDay && (
                              <Input
                                aria-label={t("componentsCalendarEditor.endTime")}
                                type="time"
                                required
                                value={draft.endTime}
                                onChange={(event) => update("endTime", event.target.value)}
                              />
                            )}
                          </div>
                          <label className="calendar-check-label">
                            <CheckboxControl
                              checked={draft.allDay}
                              onCheckedChange={(value) => update("allDay", value)}
                            />
                            {t("common.allDay")}
                          </label>
                        </div>
                      </div>
                      <div className="calendar-editor-row calendar-repeat-row">
                        <Icon name="refresh" />
                        <div>
                          <SelectControl
                            aria-label={t("componentsCalendarEditor.repeatEvent")}
                            value={draft.frequency}
                            onValueChange={(value) => update("frequency", value)}
                            options={[
                              { value: "", label: t("componentsCalendarEditor.doesNotRepeat") },
                              { value: "DAILY", label: t("componentsCalendarEditor.daily") },
                              {
                                value: "WEEKLY",
                                label: t("componentsCalendarEditor.weeklyOn", {
                                  dateLabel: dateLabel(
                                    validDate(draft.startDate) ?? calendar.date,
                                    { weekday: "long" },
                                  ),
                                }),
                              },
                              {
                                value: "MONTHLY",
                                label: t("componentsCalendarEditor.monthlyOnDay", {
                                  Number: Number(draft.startDate.slice(-2)),
                                }),
                              },
                              { value: "YEARLY", label: t("componentsCalendarEditor.yearly") },
                            ]}
                          />
                          {draft.frequency && (
                            <Button
                              variant="text"
                              size="sm"
                              onClick={() => setCustomRepeat(!customRepeat)}
                            >
                              {t("componentsCalendarEditor.customize")}
                            </Button>
                          )}
                          {customRepeat && draft.frequency && (
                            <div className="calendar-repeat-settings">
                              <CalendarField label={t("componentsCalendarEditor.repeatEvery")}>
                                <Input
                                  aria-label={t("componentsCalendarEditor.repeatInterval")}
                                  type="number"
                                  min={1}
                                  max={365}
                                  value={draft.interval}
                                  onChange={(event) =>
                                    update("interval", Number(event.target.value))
                                  }
                                />
                              </CalendarField>
                              {draft.frequency === "WEEKLY" && (
                                <div className="calendar-repeat-weekdays">
                                  {[
                                    { day: "MO", label: t("componentsCalendarEditor.monday") },
                                    { day: "TU", label: t("componentsCalendarEditor.tuesday") },
                                    { day: "WE", label: t("componentsCalendarEditor.wednesday") },
                                    { day: "TH", label: t("componentsCalendarEditor.thursday") },
                                    { day: "FR", label: t("componentsCalendarEditor.friday") },
                                    { day: "SA", label: t("componentsCalendarEditor.saturday") },
                                    { day: "SU", label: t("componentsCalendarEditor.sunday") },
                                  ].map(({ day, label }) => (
                                    <button
                                      type="button"
                                      key={day}
                                      aria-label={t("componentsCalendarEditor.repeatOn", {
                                        index: label,
                                      })}
                                      aria-pressed={draft.weekdays.includes(day)}
                                      onClick={() =>
                                        update(
                                          "weekdays",
                                          draft.weekdays.includes(day)
                                            ? draft.weekdays.filter((value) => value !== day)
                                            : [...draft.weekdays, day],
                                        )
                                      }
                                    >
                                      {day.slice(0, 1)}
                                    </button>
                                  ))}
                                </div>
                              )}
                              <CalendarField label={t("componentsCalendarEditor.ends")}>
                                <SelectControl
                                  aria-label={t("componentsCalendarEditor.repeatEnds")}
                                  value={draft.ends}
                                  onValueChange={(value) =>
                                    update("ends", value as EventDraft["ends"])
                                  }
                                  options={[
                                    { value: "never", label: t("common.never") },
                                    {
                                      value: "until",
                                      label: t("componentsCalendarEditor.onADate"),
                                    },
                                    {
                                      value: "count",
                                      label: t("componentsCalendarEditor.afterANumberOfEvents"),
                                    },
                                  ]}
                                />
                              </CalendarField>
                              {draft.ends === "until" && (
                                <Input
                                  aria-label={t("componentsCalendarEditor.repeatUntil")}
                                  type="date"
                                  value={draft.until}
                                  min={draft.startDate}
                                  required
                                  onChange={(event) => update("until", event.target.value)}
                                />
                              )}
                              {draft.ends === "count" && (
                                <Input
                                  aria-label={t("componentsCalendarEditor.numberOfOccurrences")}
                                  type="number"
                                  min={1}
                                  max={1000}
                                  value={draft.count}
                                  required
                                  onChange={(event) => update("count", Number(event.target.value))}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="calendar-editor-row">
                        <Icon name="clock" />
                        <CalendarTimeZoneField
                          value={draft.zone}
                          onChange={(value) => update("zone", value)}
                        />
                      </div>
                      {!event && calendar.can("events.invite") && (
                        <div className="calendar-editor-row">
                          <Icon name="users" />
                          <div className="calendar-editor-guests">
                            <RecipientField
                              label={t("componentsCalendarEditor.guests")}
                              value={guests}
                              onChange={setGuests}
                            />
                            <p className="calendar-field-hint">
                              {t("componentsCalendarEditor.addInternalOrExternalGuestsByEmail")}
                            </p>
                          </div>
                        </div>
                      )}
                      <div className="calendar-editor-row">
                        <Icon name="navigation" />
                        <Input
                          aria-label={t("componentsCalendarEditor.location")}
                          placeholder={t("componentsCalendarEditor.addLocation")}
                          value={draft.location}
                          maxLength={1024}
                          onChange={(event) => update("location", event.target.value)}
                        />
                      </div>
                      <div className="calendar-editor-row">
                        <Icon name="align" />
                        <Textarea
                          aria-label={t("componentsCalendarEditor.description")}
                          placeholder={t("componentsCalendarEditor.addADescription")}
                          rows={4}
                          value={draft.description}
                          maxLength={50000}
                          onChange={(event) => update("description", event.target.value)}
                        />
                      </div>
                      <div className="calendar-editor-row">
                        <Icon name="calendar" />
                        <div className="calendar-editor-calendar-options">
                          <SelectControl
                            aria-label={t("componentsCalendarEditor.calendar")}
                            value={draft.calendarId}
                            disabled={!!event}
                            onValueChange={(value) => update("calendarId", value)}
                            options={calendar
                              .data!.calendars.filter((cal) => calendarWritable(cal))
                              .map((cal) => ({ value: cal.id, label: cal.name }))}
                          />
                          <SelectControl
                            aria-label={t("componentsCalendarEditor.showAs")}
                            value={draft.transparency}
                            onValueChange={(value) => update("transparency", value)}
                            options={[
                              { value: "busy", label: t("componentsCalendarEditor.busy") },
                              { value: "free", label: t("componentsCalendarEditor.free") },
                            ]}
                          />
                          <SelectControl
                            aria-label={t("componentsCalendarEditor.eventVisibility")}
                            value={draft.visibility}
                            onValueChange={(value) => update("visibility", value)}
                            options={[
                              {
                                value: "default",
                                label: t("componentsCalendarEditor.defaultVisibility"),
                              },
                              { value: "private", label: t("componentsCalendarEditor.private") },
                              { value: "public", label: t("componentsCalendarEditor.public") },
                            ]}
                          />
                        </div>
                      </div>
                    </div>
                  </Tabs.Panel>
                </Tabs.Root>
                <CalendarNotice error={action.error} />
              </div>
              <div className="calendar-editor-footer">
                <span>
                  {guests.trim()
                    ? t(
                        "componentsCalendarEditor.internalGuestsAreNotifiedExternalEmailRequiresAnAvailable",
                      )
                    : ""}
                </span>
                <Button variant="ghost" disabled={action.busy} onClick={close}>
                  {t("common.cancel")}
                </Button>
                <Button variant="primary" type="submit" disabled={action.busy || !draft.calendarId}>
                  {action.busy ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </form>
          )}
        </DialogPopup>
      </Dialog.Root>
      {scope && (
        <CalendarScopeDialog
          title={t("componentsCalendarEditor.editRepeatingEvent")}
          allowSingle={!repeatChanged}
          onClose={() => setScope(false)}
          busy={action.busy}
          onConfirm={(chosen) => {
            setScope(false);
            void save(chosen);
          }}
        />
      )}
      {discard && (
        <CalendarModal
          title={t("componentsCalendarEditor.discardChanges")}
          description={t("componentsCalendarEditor.yourUnsavedChangesWillBeLost")}
          onClose={() => setDiscard(false)}
        >
          <div className="calendar-dialog-actions">
            <Button onClick={() => setDiscard(false)}>
              {t("componentsCalendarEditor.keepEditing")}
            </Button>
            <Button variant="danger" onClick={onClose}>
              {t("componentsCalendarEditor.discard")}
            </Button>
          </div>
        </CalendarModal>
      )}
    </>
  );
}
