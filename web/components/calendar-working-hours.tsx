import { t } from "../../shared/i18n/index.ts";
import { useState } from "react";
import { Button, CheckboxControl, Input, useNotifications } from "./ui";
import {
  CalendarIconButton,
  CalendarModal,
  CalendarNotice,
  useCalendarAction,
  useCalendarResource,
} from "./calendar-controls";
import { CalendarTimeZoneField } from "./calendar-editor";
import { CalendarSettingsForm, useCalendarSettingsDraft } from "./calendar-settings-form";
import { SettingsSection } from "./settings-layout";
import { useCalendar } from "./calendar-context";
import { calendarApi } from "../lib/calendar";
import { minuteTime, validDate } from "../lib/calendar-date";
import { LoadingSkeleton } from "./loading-skeleton";

interface Hours {
  version: number;
  time_zone: string;
  weekly: Record<string, { start: number; end: number }[]>;
  exceptions: Record<string, { start: number; end: number }[]>;
}
type Range = { start: string; end: string };
const ranges = (value: Hours["weekly"]) =>
  Object.fromEntries(
    Object.entries(value).map(([day, values]) => [
      day,
      values.map((range) => ({ start: minuteTime(range.start), end: minuteTime(range.end) })),
    ]),
  );
export function CalendarWorkingHours({ onClose }: { onClose: () => void }) {
  return <WorkingHoursResource onClose={onClose} />;
}
export function CalendarWorkingHoursSettings() {
  return <WorkingHoursResource />;
}
function WorkingHoursResource({ onClose }: { onClose?: () => void }) {
  const [revision, setRevision] = useState(0),
    resource = useCalendarResource<{ working_hours: Hours }>("/working-hours", revision);
  if (resource.data)
    return <WorkingHoursForm hours={resource.data.working_hours} onClose={onClose} />;
  const state = (
    <>
      {resource.loading && (
        <LoadingSkeleton
          kind="form"
          label={t("componentsCalendarWorkingHours.loadingWorkingHours")}
        />
      )}
      <CalendarNotice error={resource.error} />
      {resource.error && (
        <Button onClick={() => setRevision((old) => old + 1)}>
          {t("componentsCalendarWorkingHours.tryAgain")}
        </Button>
      )}
    </>
  );
  return onClose ? (
    <CalendarModal title={t("componentsCalendarWorkingHours.workingHours")} onClose={onClose}>
      {state}
    </CalendarModal>
  ) : (
    state
  );
}
function RangeFields({
  label,
  values,
  onChange,
}: {
  label: string;
  values: Range[];
  onChange: (value: Range[]) => void;
}) {
  return (
    <>
      <div>
        {values.length ? (
          values.map((range, at) => (
            <div className="calendar-working-range" key={at}>
              <Input
                type="time"
                aria-label={t("componentsCalendarWorkingHours.start", {
                  label: label,
                  value2: at + 1,
                })}
                required
                value={range.start}
                onChange={(event) =>
                  onChange(
                    values.map((range, index) =>
                      index === at ? { ...range, start: event.target.value } : range,
                    ),
                  )
                }
              />
              <span>{t("componentsCalendarWorkingHours.text")}</span>
              <Input
                type={range.end === "24:00" ? "text" : "time"}
                aria-label={t("componentsCalendarWorkingHours.end", {
                  label: label,
                  value2: at + 1,
                })}
                required
                value={range.end}
                onChange={(event) =>
                  onChange(
                    values.map((range, index) =>
                      index === at ? { ...range, end: event.target.value } : range,
                    ),
                  )
                }
              />
              <CalendarIconButton
                icon="close"
                label={t("componentsCalendarWorkingHours.removeInterval", {
                  label: label,
                  value2: at + 1,
                })}
                onClick={() => onChange(values.filter((_, index) => index !== at))}
              />
            </div>
          ))
        ) : (
          <span className="calendar-field-hint">
            {t("componentsCalendarWorkingHours.unavailable")}
          </span>
        )}
      </div>
      <CalendarIconButton
        icon="plus"
        label={t("componentsCalendarWorkingHours.addInterval", { label: label })}
        disabled={values.length >= 10}
        onClick={() => onChange([...values, { start: "09:00", end: "18:00" }])}
      />
    </>
  );
}
function WorkingHoursForm({ hours, onClose }: { hours: Hours; onClose?: () => void }) {
  const calendar = useCalendar(),
    action = useCalendarAction(),
    notify = useNotifications();
  const [version, setVersion] = useState(hours.version),
    [exceptionDate, setExceptionDate] = useState(""),
    [dateError, setDateError] = useState("");
  const valuesFor = (value: Hours) => ({
    time_zone: value.version ? value.time_zone : calendar.zone,
    weekly: ranges(value.weekly),
    exceptions: ranges(value.exceptions),
  });
  const draft = useCalendarSettingsDraft(valuesFor(hours)),
    { value, setValue } = draft;
  const save = async () => {
    const saved = await calendarApi<{ working_hours: Hours }>("/working-hours", {
      method: "PUT",
      body: { version, ...value },
    });
    setVersion(saved.working_hours.version);
    draft.replace(valuesFor(saved.working_hours));
    notify.success(t("componentsCalendarWorkingHours.workingHoursSaved"));
    onClose?.();
  };
  const fields = (
    <>
      <SettingsSection
        title={t("componentsCalendarWorkingHours.weeklyWorkingHours")}
        description={t("componentsCalendarWorkingHours.findATimeUsesTheseHoursWhenTheWorking")}
      >
        <div className="calendar-working-time-zone">
          <CalendarTimeZoneField
            value={value.time_zone}
            onChange={(time_zone) => setValue((old) => ({ ...old, time_zone }))}
          />
        </div>
        <div className="calendar-working-days">
          {[
            t("componentsCalendarWorkingHours.sunday"),
            t("componentsCalendarWorkingHours.monday"),
            t("componentsCalendarWorkingHours.tuesday"),
            t("componentsCalendarWorkingHours.wednesday"),
            t("componentsCalendarWorkingHours.thursday"),
            t("componentsCalendarWorkingHours.friday"),
            t("componentsCalendarWorkingHours.saturday"),
          ].map((label, index) => {
            const day = String(index),
              values = value.weekly[day] ?? [];
            const change = (values: Range[]) =>
              setValue((old) => ({ ...old, weekly: { ...old.weekly, [day]: values } }));
            return (
              <div className="calendar-working-day" key={day}>
                <label>
                  <CheckboxControl
                    checked={!!values.length}
                    onCheckedChange={(checked) =>
                      change(checked ? [{ start: "09:00", end: "18:00" }] : [])
                    }
                  />
                  {label.slice(0, 3)}
                </label>
                <RangeFields label={label} values={values} onChange={change} />
              </div>
            );
          })}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("componentsCalendarWorkingHours.dateExceptions")}
        description={t(
          "componentsCalendarWorkingHours.overrideYourUsualHoursForASpecificDateLeave",
        )}
      >
        {Object.entries(value.exceptions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, values]) => (
            <div className="calendar-settings-exception" key={date}>
              <div className="calendar-settings-exception-heading">
                <strong>{date}</strong>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setValue((old) => ({
                      ...old,
                      exceptions: Object.fromEntries(
                        Object.entries(old.exceptions).filter(([key]) => key !== date),
                      ),
                    }))
                  }
                >
                  {t("componentsCalendarWorkingHours.removeException")}
                </Button>
              </div>
              <div className="calendar-working-day">
                <span>
                  {values.length
                    ? t("componentsCalendarWorkingHours.customHours")
                    : t("componentsCalendarWorkingHours.dayOff")}
                </span>
                <RangeFields
                  label={date}
                  values={values}
                  onChange={(values) =>
                    setValue((old) => ({
                      ...old,
                      exceptions: { ...old.exceptions, [date]: values },
                    }))
                  }
                />
              </div>
            </div>
          ))}
        <div className="calendar-settings-add-date">
          <Input
            type="date"
            aria-label={t("componentsCalendarWorkingHours.exceptionDate")}
            min="1970-01-01"
            max="2100-12-31"
            value={exceptionDate}
            onChange={(event) => {
              setExceptionDate(event.target.value);
              setDateError("");
            }}
          />
          <Button
            disabled={!exceptionDate}
            onClick={() => {
              if (!validDate(exceptionDate)) {
                setDateError(
                  t("componentsCalendarWorkingHours.chooseAValidDateBetween1970And2100"),
                );
                return;
              }
              if (exceptionDate in value.exceptions) {
                setDateError(t("componentsCalendarWorkingHours.thisDateAlreadyHasAnException"));
                return;
              }
              setValue((old) => ({
                ...old,
                exceptions: { ...old.exceptions, [exceptionDate]: [] },
              }));
              setExceptionDate("");
              setDateError("");
            }}
          >
            {t("componentsCalendarWorkingHours.addDate")}
          </Button>
        </div>
        <CalendarNotice error={dateError} />
      </SettingsSection>
    </>
  );
  if (!onClose)
    return (
      <CalendarSettingsForm dirty={draft.dirty} onReset={draft.reset} onSave={save}>
        {fields}
      </CalendarSettingsForm>
    );
  return (
    <CalendarModal
      title={t("componentsCalendarWorkingHours.workingHours")}
      onClose={onClose}
      busy={action.busy}
      className="calendar-settings-modal"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(save);
        }}
      >
        {fields}
        <CalendarNotice error={action.error} />
        <div className="calendar-dialog-actions">
          <Button variant="ghost" onClick={onClose} disabled={action.busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={!draft.dirty || action.busy}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </CalendarModal>
  );
}
