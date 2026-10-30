import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useState } from "react";
import { Button, CheckboxControl, Input, SelectControl, useNotifications } from "./ui";
import {
  CalendarField,
  CalendarNotice,
  useCalendarAction,
  useCalendarResource,
} from "./calendar-controls";
import { useCalendar } from "./calendar-context";
import { calendarApi, eventPath, type CalendarEvent } from "../lib/calendar";
import { LoadingSkeleton } from "./loading-skeleton";
import { registrationPolicyBody, type RegistrationPolicy } from "../lib/calendar-sharing";
interface Registration {
  id: string;
  version: number;
  display_name: string;
  email_address: string;
  status: string;
  additional_guests: number;
  occurrence_key: string;
}
export function CalendarRegistrations({
  event,
  occurrenceKey,
}: {
  event: CalendarEvent;
  occurrenceKey: string;
}) {
  const calendar = useCalendar(),
    action = useCalendarAction(),
    notify = useNotifications();
  const query = occurrenceKey ? `?occurrence_key=${encodeURIComponent(occurrenceKey)}` : "";
  const policy = useCalendarResource<{ policy: RegistrationPolicy }>(
    `${eventPath(event)}/registration-policy${query}`,
    calendar.revision,
  );
  const resource = useCalendarResource<{ registrations: Registration[] }>(
    `${eventPath(event)}/registrations${query}`,
    calendar.revision,
  );
  return (
    <section className="calendar-registrations">
      <p>{t("componentsCalendarRegistration.guestsCanRegisterUsingARegistrationLinkInThe")}</p>
      {policy.data ? (
        <RegistrationPolicyForm
          key={`${occurrenceKey}:${policy.data.policy.version}`}
          policy={policy.data.policy}
          event={event}
          occurrenceKey={occurrenceKey}
        />
      ) : (
        policy.loading && (
          <LoadingSkeleton
            label={t("componentsCalendarRegistration.loadingRegistrationSettings")}
          />
        )
      )}
      <h3>
        <LocalizedMessage
          id="componentsCalendarRegistration.registrations2"
          values={{ value1: resource.data ? `(${resource.data.registrations.length})` : "" }}
        />
      </h3>
      {resource.data?.registrations.map((registration) => (
        <div className="calendar-guest" key={registration.id}>
          <div>
            <strong>{registration.display_name || registration.email_address}</strong>
            <small>
              {registration.email_address}
              {registration.additional_guests > 0
                ? t("componentsCalendarRegistration.guests", {
                    additional_guests: registration.additional_guests,
                  })
                : ""}
            </small>
          </div>
          <span className="calendar-small-tag">{enumLabel(registration.status)}</span>
          {calendar.can("events.invite") &&
            ["pending", "waitlisted"].includes(registration.status) && (
              <div className="calendar-registration-actions">
                {["approve", "reject"].map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    disabled={action.busy}
                    variant={decision === "approve" ? "secondary" : "ghost"}
                    onClick={() => {
                      void action.run(async () => {
                        await calendarApi(
                          `${eventPath(event)}/registrations/${registration.id}/decision`,
                          { method: "POST", body: { version: registration.version, decision } },
                        );
                        calendar.refresh();
                        notify.success(
                          decision === "approve"
                            ? t("componentsCalendarRegistration.registrationApproved")
                            : t("componentsCalendarRegistration.registrationRejected"),
                        );
                      });
                    }}
                  >
                    {decision === "approve"
                      ? t("componentsCalendarRegistration.approve")
                      : t("componentsCalendarRegistration.reject")}
                  </Button>
                ))}
              </div>
            )}
        </div>
      ))}
      {resource.data && !resource.data.registrations.length && (
        <p className="calendar-field-hint">
          {t("componentsCalendarRegistration.noRegistrationsYet")}
        </p>
      )}
      <CalendarNotice error={policy.error || resource.error || action.error} />
    </section>
  );
}
function RegistrationPolicyForm({
  policy,
  event,
  occurrenceKey,
}: {
  policy: RegistrationPolicy;
  event: CalendarEvent;
  occurrenceKey: string;
}) {
  const calendar = useCalendar(),
    action = useCalendarAction(),
    notify = useNotifications();
  const [capacity, setCapacity] = useState(policy.capacity == null ? "" : String(policy.capacity)),
    [mode, setMode] = useState(policy.approval_mode),
    [waitlist, setWaitlist] = useState(policy.waitlist_enabled),
    [extra, setExtra] = useState(policy.additional_guests_limit),
    [open, setOpen] = useState(policy.status === "open");
  const editable = calendar.can("events.invite");
  return (
    <form
      className="calendar-registration-policy"
      onSubmit={(submit) => {
        submit.preventDefault();
        void action.run(async () => {
          await calendarApi(`${eventPath(event)}/registration-policy`, {
            method: "PUT",
            body: registrationPolicyBody(policy, occurrenceKey, {
              capacity: capacity === "" ? null : Number(capacity),
              approval_mode: mode,
              waitlist_enabled: waitlist,
              additional_guests_limit: extra,
              status: open ? "open" : "closed",
            }),
          });
          calendar.refresh();
          notify.success(t("componentsCalendarRegistration.registrationSettingsSaved"));
        });
      }}
    >
      <div className="calendar-two-fields">
        <CalendarField
          label={t("componentsCalendarRegistration.capacityOptional")}
          type="number"
          min={0}
          max={10000}
          value={capacity}
          disabled={!editable}
          placeholder={t("componentsCalendarRegistration.noLimit")}
          onChange={(event) => setCapacity(event.target.value)}
        />
        <CalendarField label={t("componentsCalendarRegistration.approval")}>
          <SelectControl
            aria-label={t("componentsCalendarRegistration.registrationApproval")}
            value={mode}
            disabled={!editable}
            onValueChange={setMode}
            options={[
              { value: "automatic", label: t("componentsCalendarRegistration.automatic") },
              { value: "manual", label: t("componentsCalendarRegistration.requiresApproval") },
            ]}
          />
        </CalendarField>
      </div>
      <CalendarField
        label={t("componentsCalendarRegistration.additionalGuestsPerPerson")}
        type="number"
        min={0}
        max={20}
        required
        value={extra}
        disabled={!editable}
        onChange={(event) => setExtra(Number(event.target.value))}
      />
      <label className="calendar-check-label">
        <CheckboxControl checked={waitlist} disabled={!editable} onCheckedChange={setWaitlist} />
        {t("componentsCalendarRegistration.enableAWaitingList")}
      </label>
      <label className="calendar-check-label">
        <CheckboxControl checked={open} disabled={!editable} onCheckedChange={setOpen} />
        {t("componentsCalendarRegistration.registrationIsOpen")}
      </label>
      <CalendarNotice error={action.error} />
      {editable && (
        <div>
          <Button type="submit" disabled={action.busy}>
            {t("componentsCalendarRegistration.saveRegistrationSettings")}
          </Button>
        </div>
      )}
    </form>
  );
}
