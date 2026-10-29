import { useState } from "react";
import { Button, Dialog, DialogPopup, Icon, Popover, PopoverPopup, useNotifications } from "./ui";
import {
  CalendarIconButton,
  CalendarNotice,
  useCalendarAction,
  useCalendarResource,
} from "./calendar-controls";
import { useCalendar } from "./calendar-context";
import { useAccount } from "./account-context";
import { CalendarScopeDialog } from "./calendar-editor";
import { CalendarAttachmentList } from "./calendar-collaboration";
import { useWorkspaceMobile } from "../lib/workspace-responsive";
import { api } from "../lib/api";
import {
  calendarApi,
  calendarRank,
  calendarWritable,
  eventPath,
  plainDescription,
  type CalendarAttendee,
  type CalendarAttachment,
  type CalendarEvent,
} from "../lib/calendar";
import { eventDateLabel, eventTimeLabel } from "../lib/calendar-date";
import { useEventAppearance } from "./calendar-views";

interface InvitationDetail {
  event: CalendarEvent;
  attendee: CalendarAttendee;
  attendees: CalendarAttendee[];
  attachments: CalendarAttachment[];
  is_revoked: boolean;
}
export function CalendarEventDetail({
  event: item,
  anchor,
  onClose,
  onEdit,
  onDelete,
  onManage,
}: {
  event: CalendarEvent;
  anchor: HTMLElement;
  onClose: () => void;
  onEdit: (event: CalendarEvent) => void;
  onDelete: (event: CalendarEvent) => void;
  onManage: (event: CalendarEvent, tab: string) => void;
}) {
  const calendar = useCalendar(),
    mobile = useWorkspaceMobile(),
    action = useCalendarAction(),
    notify = useNotifications(),
    { user } = useAccount(),
    appearance = useEventAppearance();
  const [response, setResponse] = useState<string | null>(null),
    [savedResponse, setSavedResponse] = useState<string | null>(null);
  const source = item.invitation_id
    ? `/inbox-invitations/${encodeURIComponent(item.invitation_id)}`
    : eventPath(item);
  const master = useCalendarResource<{ event: CalendarEvent } & Partial<InvitationDetail>>(
    item.is_redacted ? null : source,
    calendar.revision,
  );
  const instance = useCalendarResource<{ event: CalendarEvent }>(
    !item.invitation_id && !item.is_redacted && item.occurrence_key
      ? `${source}/instances/${encodeURIComponent(item.occurrence_key)}`
      : null,
    calendar.revision,
  );
  const event = item.invitation_id
    ? { ...master.data?.event, ...item }
    : (instance.data?.event ?? master.data?.event ?? item);
  const recurring = !!master.data?.event.recurrence?.length;
  const keyQuery = item.occurrence_key
    ? `?occurrence_key=${encodeURIComponent(item.occurrence_key)}`
    : "";
  const attendees = useCalendarResource<{ attendees: CalendarAttendee[] }>(
    !item.invitation_id && !item.is_redacted ? `${source}/attendees${keyQuery}` : null,
    calendar.revision,
  );
  const attachments = useCalendarResource<{ attachments: CalendarAttachment[] }>(
    !item.invitation_id && !item.is_redacted ? `${source}/attachments${keyQuery}` : null,
    calendar.revision,
  );
  const guests = master.data?.attendees ?? attendees.data?.attendees ?? [],
    mine = master.data?.attendee ?? guests.find((guest) => guest.user_id === user?.id);
  const rank = calendarRank(calendar.data?.calendars.find((cal) => cal.id === item.calendar_id));
  const writable =
    !item.invitation_id &&
    !event.is_redacted &&
    !master.data?.is_revoked &&
    calendarWritable(calendar.data?.calendars.find((cal) => cal.id === item.calendar_id)) &&
    !!master.data &&
    (!item.occurrence_key || !!instance.data);
  const detailError = master.error || instance.error || attendees.error || attachments.error;
  const respond = (status: string, scope: string) =>
    action.run(async () => {
      if (!mine) return;
      const latest = await calendarApi<InvitationDetail>(`/inbox-invitations/${mine.id}`);
      if (latest.is_revoked) throw new Error("This invitation is no longer available.");
      await calendarApi(`/inbox-invitations/${mine.id}/rsvp`, {
        method: "POST",
        body: {
          version: latest.attendee.version,
          response_status: status,
          scope,
          ...(scope === "single" ? { occurrence_key: item.occurrence_key } : {}),
        },
      });
      setSavedResponse(status);
      calendar.refresh();
      notify.success("Your response has been saved.");
      setResponse(null);
    });
  const download = () =>
    action.run(async () => {
      const blob = await api<Blob>(`/api/calendar/inbox-invitations/${mine!.id}/event.ics`, {
        response: "blob",
      });
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "invite.ics";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  const contents = (
    <>
      <div className="calendar-detail-toolbar">
        {writable && calendar.can("events.update") && (
          <CalendarIconButton icon="edit" label="Edit event" onClick={() => onEdit(item)} />
        )}
        {writable && calendar.can("events.delete") && (
          <CalendarIconButton icon="trash" label="Delete event" onClick={() => onDelete(item)} />
        )}
        {mine && (
          <CalendarIconButton
            icon="download"
            label="Download calendar invitation"
            disabled={action.busy}
            onClick={() => {
              void download();
            }}
          />
        )}
        {writable && rank >= 5 && (
          <CalendarIconButton
            icon="link"
            label="Share event"
            onClick={() => onManage(item, "sharing")}
          />
        )}
        <CalendarIconButton icon="close" label="Close event details" onClick={onClose} />
      </div>
      <div className="calendar-detail-body" style={appearance(item)}>
        <div className="calendar-detail-title-row">
          <span className="calendar-detail-color" />
          <div>
            {mobile ? (
              <Dialog.Title>{event.title}</Dialog.Title>
            ) : (
              <Popover.Title>{event.title}</Popover.Title>
            )}
            <p>
              {eventDateLabel(event, calendar.zone, calendar.data?.preferences.locale)}
              <br />
              {eventTimeLabel(event, calendar.zone, calendar.data?.preferences.locale)}
            </p>
            {recurring && (
              <span className="calendar-detail-repeat">
                <Icon name="refresh" width="12" height="12" />
                Repeating event
              </span>
            )}
          </div>
        </div>
        {mobile ? (
          <Dialog.Description className="visually-hidden">
            Event details and guest responses
          </Dialog.Description>
        ) : (
          <Popover.Description className="visually-hidden">
            Event details and guest responses
          </Popover.Description>
        )}
        {master.data?.is_revoked ? (
          <CalendarNotice error="This invitation is no longer available." />
        ) : (
          <>
            {event.location?.label && (
              <div className="calendar-detail-row">
                <Icon name="navigation" />
                <div>
                  {event.location.label}
                  {event.location.address && <small>{event.location.address}</small>}
                </div>
              </div>
            )}
            {event.description_html && (
              <div className="calendar-detail-row calendar-detail-description">
                <Icon name="align" />
                <p>{plainDescription(event.description_html)}</p>
              </div>
            )}
            {guests.length > 0 && (
              <div className="calendar-detail-row">
                <Icon name="users" />
                <div className="calendar-detail-guests">
                  <strong>
                    {guests.length} guest{guests.length === 1 ? "" : "s"}
                  </strong>
                  <span>
                    {guests.filter((guest) => guest.response_status === "accepted").length} yes ·{" "}
                    {guests.filter((guest) => guest.response_status === "tentative").length} maybe ·{" "}
                    {guests.filter((guest) => guest.response_status === "needs_action").length}{" "}
                    awaiting
                  </span>
                  {guests.slice(0, 4).map((guest) => (
                    <div key={guest.id}>
                      <span className="calendar-person-initial">
                        {(guest.display_name || guest.email_address).slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        {guest.display_name || guest.email_address}
                        {guest.user_id === user?.id && <small> (you)</small>}
                      </span>
                      <span className="calendar-guest-status" title={guest.response_status}>
                        {guest.response_status === "accepted"
                          ? "✓"
                          : guest.response_status === "declined"
                            ? "×"
                            : "?"}
                      </span>
                    </div>
                  ))}
                  {guests.length > 4 && <span>+{guests.length - 4} more</span>}
                </div>
              </div>
            )}
            {(master.data?.attachments ?? attachments.data?.attachments ?? []).length > 0 && (
              <div className="calendar-detail-row">
                <Icon name="attachment" />
                <CalendarAttachmentList
                  attachments={master.data?.attachments ?? attachments.data!.attachments}
                />
              </div>
            )}
            <div className="calendar-detail-row">
              <Icon name="calendar" />
              <div>
                {calendar.data?.calendars.find((cal) => cal.id === item.calendar_id)?.name ??
                  "Calendar"}
                {event.organizer?.email_address && (
                  <small>Organized by {event.organizer.email_address}</small>
                )}
                <small>
                  {calendar.data?.calendars.find((cal) => cal.id === item.calendar_id)?.kind ===
                    "external" && "Read-only external calendar · "}
                  {event.visibility === "private" ? "Private · " : ""}
                  {event.transparency === "free" ? "Free" : "Busy"}
                </small>
              </div>
            </div>
            {writable && (
              <div className="calendar-detail-manage">
                <Button size="sm" variant="text" onClick={() => onManage(item, "guests")}>
                  <Icon name="users" />
                  Manage guests
                </Button>
                <Button size="sm" variant="text" onClick={() => onManage(item, "attachments")}>
                  <Icon name="attachment" />
                  Attachments
                </Button>
              </div>
            )}
            {mine && (
              <div className="calendar-rsvp">
                <strong>Going?</strong>
                <div>
                  {[
                    ["accepted", "Yes"],
                    ["tentative", "Maybe"],
                    ["declined", "No"],
                  ].map(([status, label]) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={
                        (savedResponse ?? item.response_status ?? mine.response_status) === status
                          ? "primary"
                          : "secondary"
                      }
                      disabled={action.busy}
                      onClick={() =>
                        recurring ? setResponse(status!) : void respond(status!, "all")
                      }
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <CalendarNotice error={action.error || detailError} />
      </div>
    </>
  );
  return (
    <>
      {mobile ? (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open && !response) onClose();
          }}
        >
          <DialogPopup data-ui-theme="neutral" className="calendar-detail calendar-modal">
            {contents}
          </DialogPopup>
        </Dialog.Root>
      ) : (
        <Popover.Root
          open
          onOpenChange={(open) => {
            if (!open && !response) onClose();
          }}
        >
          <PopoverPopup
            data-ui-theme="neutral"
            className="calendar-detail"
            positionerProps={{
              anchor,
              side: "right",
              align: "start",
              sideOffset: 12,
              collisionPadding: 12,
            }}
            finalFocus={() =>
              anchor.isConnected ? anchor : document.getElementById("workspace-main")
            }
          >
            {contents}
          </PopoverPopup>
        </Popover.Root>
      )}
      {response && (
        <CalendarScopeDialog
          title="Respond to repeating event"
          error={action.error}
          allowFollowing={false}
          onClose={() => setResponse(null)}
          busy={action.busy}
          onConfirm={(scope) => {
            void respond(response, scope);
          }}
        />
      )}
    </>
  );
}
