import { t } from "../../shared/i18n/index.ts";
import { useState } from "react";
import { useParams } from "react-router";
import { Button, Icon, useNotifications } from "../components/ui";
import { CalendarAttachmentList } from "../components/calendar-collaboration";
import {
  CalendarNotice,
  useCalendarAction,
  useCalendarResource,
} from "../components/calendar-controls";
import { LoadingSkeleton } from "../components/loading-skeleton";
import { api } from "../lib/api";
import {
  calendarApi,
  plainDescription,
  type CalendarAttendee,
  type CalendarAttachment,
  type CalendarEvent,
} from "../lib/calendar";
import { eventDateLabel, eventTimeLabel } from "../lib/calendar-date";

interface Invitation {
  attendee: CalendarAttendee;
  event: CalendarEvent;
  attachments: CalendarAttachment[];
  is_revoked: boolean;
}
export function CalendarInvitationPage() {
  const { attendeeId } = useParams(),
    [revision, setRevision] = useState(0),
    notify = useNotifications(),
    action = useCalendarAction();
  const path = `/inbox-invitations/${encodeURIComponent(attendeeId ?? "")}`,
    resource = useCalendarResource<Invitation>(path, revision),
    value = resource.data;
  const zone = value?.event.start?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const respond = (response_status: string) =>
    action.run(async () => {
      if (!value) return;
      const key = value.attendee.occurrence_key;
      await calendarApi(`${path}/rsvp`, {
        method: "POST",
        body: {
          version: value.attendee.version,
          response_status,
          ...(key ? { scope: "single", occurrence_key: key } : { scope: "all" }),
        },
      });
      setRevision((old) => old + 1);
      notify.success(t("routesCalendarInvitation.yourResponseHasBeenSaved"));
    });
  const download = () =>
    action.run(async () => {
      const blob = await api<Blob>(`/api/calendar${path}/event.ics`, { response: "blob" }),
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "invite.ics";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  return (
    <section className="account-page calendar-invitation-page">
      <header className="account-page-header">
        <span className="calendar-invitation-eyebrow">
          <Icon name="calendar" />
          {t("routesCalendarInvitation.calendarInvitation")}
        </span>
        <h1>{value?.event.title ?? t("routesCalendarInvitation.youReInvited")}</h1>
      </header>
      <section className="account-panel calendar-invitation-card">
        <CalendarNotice error={resource.error || action.error} />
        {resource.loading && !value ? (
          <LoadingSkeleton kind="reader" label={t("routesCalendarInvitation.openingInvitation")} />
        ) : value?.is_revoked ? (
          <p>{t("routesCalendarInvitation.thisInvitationIsNoLongerAvailable")}</p>
        ) : (
          value && (
            <>
              <div className="calendar-detail-row">
                <Icon name="clock" />
                <div>
                  {eventDateLabel(value.event, zone)}
                  <small>
                    {eventTimeLabel(value.event, zone)}
                    {t("routesCalendarInvitation.text")}
                    {zone.replaceAll("_", " ")}
                  </small>
                </div>
              </div>
              {value.event.location?.label && (
                <div className="calendar-detail-row">
                  <Icon name="navigation" />
                  <span>{value.event.location.label}</span>
                </div>
              )}
              {value.event.description_html && (
                <div className="calendar-detail-row calendar-detail-description">
                  <Icon name="align" />
                  <p>{plainDescription(value.event.description_html)}</p>
                </div>
              )}
              {value.event.organizer?.email_address && (
                <div className="calendar-detail-row">
                  <Icon name="user" />
                  <div>
                    {value.event.organizer.email_address}
                    <small>{t("routesCalendarInvitation.organizer")}</small>
                  </div>
                </div>
              )}
              <CalendarAttachmentList attachments={value.attachments ?? []} />
              <div className="calendar-invitation-response">
                <h2>{t("routesCalendarInvitation.willYouBeAttending")}</h2>
                {!!value.event.recurrence?.length && !value.attendee.occurrence_key && (
                  <p>{t("routesCalendarInvitation.yourResponseAppliesToTheEntireSeries")}</p>
                )}
                <div>
                  {[
                    ["accepted", t("common.yes")],
                    ["tentative", t("routesCalendarInvitation.maybe")],
                    ["declined", t("common.no")],
                  ].map(([status, label]) => (
                    <Button
                      key={status}
                      disabled={action.busy}
                      variant={value.attendee.response_status === status ? "primary" : "secondary"}
                      onClick={() => {
                        void respond(status!);
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
              <Button
                variant="text"
                disabled={action.busy}
                onClick={() => {
                  void download();
                }}
              >
                <Icon name="download" />
                {t("routesCalendarInvitation.downloadCalendarInvitationIcs")}
              </Button>
            </>
          )
        )}
        {resource.error && (
          <Button onClick={() => setRevision((old) => old + 1)}>
            {t("routesCalendarInvitation.tryAgain")}
          </Button>
        )}
      </section>
    </section>
  );
}
