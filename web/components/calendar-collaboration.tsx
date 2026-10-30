import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button, CheckboxControl, Icon, Input, SelectControl, useNotifications } from "./ui";
import {
  CalendarField,
  CalendarIconButton,
  CalendarModal,
  CalendarNotice,
  useCalendarAction,
  useCalendarResource,
} from "./calendar-controls";
import { useCalendar } from "./calendar-context";
import { RecipientField } from "./mail-recipients";
import { CalendarRegistrations } from "./calendar-registration";
import { LoadingSkeleton } from "./loading-skeleton";
import { DriveFileIcon } from "./drive-controls";
import { useAccess } from "./console-access";
import { api, ApiError } from "../lib/api";
import { MailOperation, parseRecipients } from "../lib/mail-helpers";
import {
  calendarApi,
  calendarRank,
  eventPath,
  type CalendarAttendee,
  type CalendarAttachment,
  type CalendarEvent,
} from "../lib/calendar";
import { addDays, dateInstant, dateLabel, todayIn } from "../lib/calendar-date";
import type { DriveItem } from "../lib/drive";

interface ShareLink {
  id: string;
  version: number;
  mode: string;
  expires_at: number;
  revoked_at: number | null;
  password_protected: boolean;
  occurrence_key: string | null;
}
export function CalendarShareLinks({
  calendarId,
  event,
  occurrenceKey = "",
}: {
  calendarId: string;
  event?: CalendarEvent;
  occurrenceKey?: string;
}) {
  const calendar = useCalendar(),
    action = useCalendarAction(),
    notify = useNotifications();
  const [revision, setRevision] = useState(0),
    [mode, setMode] = useState("view"),
    [password, setPassword] = useState(""),
    [expiry, setExpiry] = useState(addDays(todayIn(calendar.zone), 30)),
    [ics, setIcs] = useState(true);
  const [fields, setFields] = useState(["title", "location"]),
    [urls, setUrls] = useState<Record<string, string>>({});
  const operation = useRef(new MailOperation()),
    base = event ? eventPath(event) : `/calendars/${calendarId}`;
  const links = useCalendarResource<{ links: ShareLink[] }>(`${base}/share-links`, revision);
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      notify.success(t("componentsCalendarCollaboration.linkCopied"));
    } catch {
      notify.info(t("componentsCalendarCollaboration.selectAndCopyTheLinkBelow"));
    }
  };
  const create = () =>
    action.run(async () => {
      const body = {
        mode,
        shared_fields: fields,
        allow_ics: ics,
        ...(password ? { password } : {}),
        expires_at: Math.floor(
          new Date(dateInstant(addDays(expiry, 1), calendar.zone)).getTime() / 1000,
        ),
        ...(occurrenceKey ? { occurrence_key: occurrenceKey } : {}),
      };
      try {
        const result = await calendarApi<{ link: ShareLink & { url: string } }>(
          `${base}/share-links`,
          { method: "POST", body, headers: operation.current.headers(body) },
        );
        operation.current.complete();
        setUrls((old) => ({ ...old, [result.link.id]: result.link.url }));
        setPassword("");
        setRevision((old) => old + 1);
        notify.success(t("componentsCalendarCollaboration.shareLinkCreated"));
      } catch (failure) {
        if (failure instanceof ApiError && failure.status < 500) operation.current.complete();
        throw failure;
      }
    });
  return (
    <section className="calendar-link-settings">
      <p>
        <LocalizedMessage
          id="componentsCalendarCollaboration.anyoneWithALinkCanViewTheFieldsYou"
          values={{
            value1:
              event &&
              t("componentsCalendarCollaboration.aRegistrationLinkAlsoLetsExternalGuestsJoin"),
          }}
        />
      </p>
      {!event && (
        <p className="calendar-field-hint">
          {t("componentsCalendarCollaboration.privateEventsAppearAsBusy")}
        </p>
      )}
      {calendar.can("sharing.external") && (
        <form
          className="calendar-settings-fields"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="calendar-two-fields">
            {event && (
              <CalendarField label={t("componentsCalendarCollaboration.linkType")}>
                <SelectControl
                  aria-label={t("componentsCalendarCollaboration.linkType")}
                  value={mode}
                  onValueChange={setMode}
                  options={[
                    { value: "view", label: t("componentsCalendarCollaboration.viewEvent") },
                    { value: "join", label: t("componentsCalendarCollaboration.viewRegister") },
                  ]}
                />
              </CalendarField>
            )}
            <CalendarField
              label={t("componentsCalendarCollaboration.expiresOn")}
              type="date"
              value={expiry}
              min={todayIn(calendar.zone)}
              required
              onChange={(event) => setExpiry(event.target.value)}
            />
          </div>
          <CalendarField
            label={t("componentsCalendarCollaboration.passwordOptional")}
            type="password"
            autoComplete="new-password"
            value={password}
            minLength={8}
            maxLength={128}
            placeholder={t("componentsCalendarCollaboration.atLeast8Characters")}
            onChange={(event) => setPassword(event.target.value)}
          />
          <fieldset className="calendar-shared-fields">
            <legend>{t("componentsCalendarCollaboration.visibleInformation")}</legend>
            {[
              ["title", t("componentsCalendarCollaboration.title")],
              ["location", t("componentsCalendarCollaboration.location")],
              ["description_html", t("componentsCalendarCollaboration.description")],
              ["organizer", t("componentsCalendarCollaboration.organizer")],
              ["attachments", t("componentsCalendarCollaboration.attachments")],
            ].map(([value, label]) => (
              <label key={value}>
                <CheckboxControl
                  checked={fields.includes(value!)}
                  onCheckedChange={(checked) =>
                    setFields((old) =>
                      checked ? [...old, value!] : old.filter((field) => field !== value),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label className="calendar-check-label">
            <CheckboxControl checked={ics} onCheckedChange={setIcs} />
            {t("componentsCalendarCollaboration.allowCalendarFileIcsDownloads")}
          </label>
          <div>
            <Button type="submit" disabled={action.busy || !fields.length}>
              <Icon name="link" />
              {action.busy
                ? t("common.creating")
                : t("componentsCalendarCollaboration.createShareLink")}
            </Button>
          </div>
        </form>
      )}
      <div className="calendar-share-links">
        {links.data?.links.map((link) => (
          <div
            className="calendar-share-link"
            key={link.id}
            data-inactive={!!link.revoked_at || link.expires_at * 1000 < Date.now() || undefined}
          >
            <div>
              <Icon name={link.password_protected ? "shield" : "link"} />
              <strong>
                {link.mode === "join"
                  ? t("componentsCalendarCollaboration.registrationLink")
                  : t("componentsCalendarCollaboration.viewLink")}
              </strong>
              <span>
                {link.revoked_at
                  ? t("common.revoked")
                  : link.expires_at * 1000 < Date.now()
                    ? t("common.expired")
                    : t("componentsCalendarCollaboration.expires", {
                        dateLabel: dateLabel(
                          new Date(link.expires_at * 1000).toISOString().slice(0, 10),
                          { month: "short", day: "numeric" },
                        ),
                      })}
              </span>
            </div>
            {!link.revoked_at && (
              <>
                <div className="calendar-link-actions">
                  {urls[link.id] ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        void copy(urls[link.id]!);
                      }}
                    >
                      <Icon name="copy" />
                      {t("componentsCalendarCollaboration.copyLink")}
                    </Button>
                  ) : (
                    calendar.can("sharing.external") && (
                      <Button
                        size="sm"
                        disabled={action.busy}
                        onClick={() => {
                          void action.run(async () => {
                            const body = { version: link.version };
                            try {
                              const result = await calendarApi<{
                                link: ShareLink & { url: string };
                              }>(`/share-links/${link.id}/rotate`, {
                                method: "POST",
                                body,
                                headers: operation.current.headers(body),
                              });
                              operation.current.complete();
                              setUrls((old) => ({ ...old, [link.id]: result.link.url }));
                              setRevision((old) => old + 1);
                              notify.success(
                                t(
                                  "componentsCalendarCollaboration.linkReplacedThePreviousLinkHasStoppedWorking",
                                ),
                              );
                            } catch (failure) {
                              if (failure instanceof ApiError && failure.status < 500)
                                operation.current.complete();
                              throw failure;
                            }
                          });
                        }}
                      >
                        {t("componentsCalendarCollaboration.replaceGetLink")}
                      </Button>
                    )
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() => {
                      void action.run(async () => {
                        await calendarApi(`/share-links/${link.id}?version=${link.version}`, {
                          method: "DELETE",
                        });
                        setUrls((old) => {
                          const next = { ...old };
                          delete next[link.id];
                          return next;
                        });
                        setRevision((old) => old + 1);
                        notify.success(t("componentsCalendarCollaboration.shareLinkRevoked"));
                      });
                    }}
                  >
                    {t("componentsCalendarCollaboration.revoke")}
                  </Button>
                </div>
                {urls[link.id] && (
                  <Input
                    aria-label={t("componentsCalendarCollaboration.shareLinkUrl")}
                    readOnly
                    value={urls[link.id]}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <p className="calendar-field-hint">
        {t("componentsCalendarCollaboration.saveANewLinkWhenYouCreateItTo")}
      </p>
      <CalendarNotice error={action.error || links.error} />
    </section>
  );
}

function CalendarDrivePicker({
  onChoose,
  onClose,
}: {
  onChoose: (item: DriveItem) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<{ id: string; name: string }[]>([
    { id: "root", name: t("componentsCalendarCollaboration.myDrive") },
  ]);
  const parent = path.at(-1)!.id;
  return (
    <CalendarModal
      title={t("componentsCalendarCollaboration.attachFromDrive")}
      description={t("componentsCalendarCollaboration.guestsNeedPermissionToOpenTheSelectedFile")}
      onClose={onClose}
      className="calendar-drive-picker"
    >
      <div className="calendar-drive-breadcrumb">
        {path.map((folder, index) => (
          <Button
            key={folder.id}
            variant="text"
            size="sm"
            onClick={() => setPath(path.slice(0, index + 1))}
          >
            {folder.name}
          </Button>
        ))}
      </div>
      <CalendarDriveFolder
        key={parent}
        parent={parent}
        onFolder={(item) => setPath([...path, { id: item.id, name: item.name }])}
        onChoose={onChoose}
      />
    </CalendarModal>
  );
}
function CalendarDriveFolder({
  parent,
  onFolder,
  onChoose,
}: {
  parent: string;
  onFolder: (item: DriveItem) => void;
  onChoose: (item: DriveItem) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<string[]>([]);
  // Use the normal authenticated resource hook's request lifecycle through a small API bridge.
  return (
    <DriveFolderPage
      key={cursor ?? "first"}
      parent={parent}
      cursor={cursor}
      onFolder={onFolder}
      onChoose={onChoose}
      onNext={(next) => {
        setPrevious((old) => [...old, cursor ?? ""]);
        setCursor(next);
      }}
      onPrevious={
        previous.length
          ? () => {
              setCursor(previous.at(-1) || null);
              setPrevious((old) => old.slice(0, -1));
            }
          : undefined
      }
    />
  );
}
function DriveFolderPage({
  parent,
  cursor,
  onFolder,
  onChoose,
  onNext,
  onPrevious,
}: {
  parent: string;
  cursor: string | null;
  onFolder: (item: DriveItem) => void;
  onChoose: (item: DriveItem) => void;
  onNext: (cursor: string) => void;
  onPrevious?: () => void;
}) {
  const [data, setData] = useState<{ items: DriveItem[]; next_cursor: string | null } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: DriveItem[]; next_cursor: string | null }>(
      `/api/drive/items?view=my&parent_id=${encodeURIComponent(parent)}&limit=100&sort=name&order=asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [parent, cursor]);
  return (
    <>
      <div className="calendar-drive-files">
        {!data && !error && (
          <LoadingSkeleton label={t("componentsCalendarCollaboration.loadingFiles")} />
        )}
        {data?.items.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => (item.kind === "folder" ? onFolder(item) : onChoose(item))}
          >
            <DriveFileIcon item={item} />
            <span>{item.name}</span>
            <Icon name={item.kind === "folder" ? "chevron" : "plus"} />
          </button>
        ))}
        {data && !data.items.length && (
          <p>{t("componentsCalendarCollaboration.thisFolderIsEmpty")}</p>
        )}
      </div>
      <CalendarNotice error={error} />
      <div className="calendar-dialog-actions">
        {onPrevious && <Button onClick={onPrevious}>{t("common.previous")}</Button>}
        {data?.next_cursor && (
          <Button onClick={() => onNext(data.next_cursor!)}>{t("common.next")}</Button>
        )}
      </div>
    </>
  );
}

function CalendarGuests({
  event,
  occurrenceKey,
  reload,
}: {
  event: CalendarEvent;
  occurrenceKey: string;
  reload: () => void;
}) {
  const calendar = useCalendar(),
    action = useCalendarAction(),
    notify = useNotifications();
  const [guests, setGuests] = useState(""),
    operation = useRef(new MailOperation());
  const query = occurrenceKey ? `?occurrence_key=${encodeURIComponent(occurrenceKey)}` : "";
  const resource = useCalendarResource<{ attendees: CalendarAttendee[] }>(
    `${eventPath(event)}/attendees${query}`,
    calendar.revision,
  );
  const canInvite =
    calendar.can("events.invite") &&
    calendarRank(calendar.data?.calendars.find((cal) => cal.id === event.calendar_id)) >= 3;
  return (
    <section className="calendar-guests">
      <p>
        {t(
          "componentsCalendarCollaboration.workspaceMembersReceiveANotificationExternalGuestsReceiveAn",
        )}
      </p>
      <div className="calendar-guest-list">
        {resource.data?.attendees.map((attendee) => (
          <div className="calendar-guest" key={attendee.id}>
            <span className="calendar-person-initial">
              {(attendee.display_name || attendee.email_address).slice(0, 1).toUpperCase()}
              <span data-response={attendee.response_status}>
                {attendee.response_status === "accepted"
                  ? "✓"
                  : attendee.response_status === "declined"
                    ? "×"
                    : "?"}
              </span>
            </span>
            <div>
              <strong>{attendee.display_name || attendee.email_address}</strong>
              <small>{attendee.email_address}</small>
            </div>
            <span className="calendar-small-tag">{enumLabel(attendee.response_status)}</span>
            {canInvite && (
              <CalendarIconButton
                icon="close"
                label={t("componentsCalendarCollaboration.remove", {
                  email_address: attendee.email_address,
                })}
                disabled={action.busy}
                onClick={() => {
                  void action.run(async () => {
                    await calendarApi(
                      `${eventPath(event)}/attendees/${attendee.id}?version=${attendee.version}${occurrenceKey ? `&occurrence_key=${encodeURIComponent(occurrenceKey)}` : ""}`,
                      { method: "DELETE" },
                    );
                    reload();
                  });
                }}
              />
            )}
          </div>
        ))}
      </div>
      {resource.data && !resource.data.attendees.length && (
        <p className="calendar-field-hint">{t("componentsCalendarCollaboration.noGuestsYet")}</p>
      )}
      {canInvite && (
        <form
          className="calendar-guest-form"
          onSubmit={(submit) => {
            submit.preventDefault();
            void action.run(async () => {
              const body = {
                version: event.version,
                attendees: parseRecipients(guests).map((email_address) => ({ email_address })),
                ...(occurrenceKey ? { occurrence_key: occurrenceKey } : {}),
              };
              try {
                await calendarApi(`${eventPath(event)}/attendees`, {
                  method: "POST",
                  body,
                  headers: operation.current.headers(body),
                });
                operation.current.complete();
                setGuests("");
                reload();
                notify.success(t("componentsCalendarCollaboration.guestsInvited"));
              } catch (failure) {
                if (failure instanceof ApiError && failure.status < 500)
                  operation.current.complete();
                throw failure;
              }
            });
          }}
        >
          <RecipientField
            label={t("componentsCalendarCollaboration.addGuests")}
            value={guests}
            onChange={setGuests}
          />
          <Button type="submit" disabled={action.busy || !guests.trim()}>
            <Icon name="plus" />
            {t("componentsCalendarCollaboration.invite")}
          </Button>
        </form>
      )}
      <CalendarNotice error={action.error || resource.error} />
    </section>
  );
}
function CalendarAttachments({
  event,
  occurrenceKey,
  reload,
}: {
  event: CalendarEvent;
  occurrenceKey: string;
  reload: () => void;
}) {
  const calendar = useCalendar(),
    action = useCalendarAction(),
    access = useAccess();
  const [title, setTitle] = useState(""),
    [url, setUrl] = useState(""),
    [drive, setDrive] = useState(false),
    operation = useRef(new MailOperation());
  const query = occurrenceKey ? `?occurrence_key=${encodeURIComponent(occurrenceKey)}` : "";
  const resource = useCalendarResource<{ attachments: CalendarAttachment[] }>(
    `${eventPath(event)}/attachments${query}`,
    calendar.revision,
  );
  const editable =
    calendar.can("events.update") &&
    calendarRank(calendar.data?.calendars.find((cal) => cal.id === event.calendar_id)) >= 3;
  const add = (fields: Record<string, unknown>) =>
    action.run(async () => {
      const body = {
        version: event.version,
        ...fields,
        ...(occurrenceKey ? { occurrence_key: occurrenceKey } : {}),
      };
      try {
        await calendarApi(`${eventPath(event)}/attachments`, {
          method: "POST",
          body,
          headers: operation.current.headers(body),
        });
        operation.current.complete();
        setUrl("");
        setTitle("");
        setDrive(false);
        reload();
      } catch (failure) {
        if (failure instanceof ApiError && failure.status < 500) operation.current.complete();
        throw failure;
      }
    });
  return (
    <section className="calendar-attachments">
      <p>{t("componentsCalendarCollaboration.addALinkOrAnExistingDriveFileTo")}</p>
      <CalendarAttachmentList
        attachments={resource.data?.attachments ?? []}
        remove={
          editable
            ? (attachment) => {
                void action.run(async () => {
                  await calendarApi(
                    `${eventPath(event)}/attachments/${attachment.id}?version=${attachment.version}${occurrenceKey ? `&occurrence_key=${encodeURIComponent(occurrenceKey)}` : ""}`,
                    { method: "DELETE" },
                  );
                  reload();
                });
              }
            : undefined
        }
        busy={action.busy}
      />
      {editable && (
        <>
          <form
            className="calendar-settings-fields"
            onSubmit={(event) => {
              event.preventDefault();
              void add({ url, ...(title.trim() ? { title: title.trim() } : {}) });
            }}
          >
            <CalendarField
              label={t("componentsCalendarCollaboration.link")}
              type="url"
              required
              placeholder={t("componentsCalendarCollaboration.https")}
              value={url}
              maxLength={2048}
              onChange={(event) => setUrl(event.target.value)}
            />
            <CalendarField
              label={t("componentsCalendarCollaboration.titleOptional")}
              value={title}
              maxLength={255}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="calendar-link-actions">
              <Button type="submit" disabled={action.busy || !url}>
                <Icon name="link" />
                {t("componentsCalendarCollaboration.addLink")}
              </Button>
              {access.permissions.includes("drive.access") && (
                <Button disabled={action.busy} onClick={() => setDrive(true)}>
                  <Icon name="drive" />
                  {t("componentsCalendarCollaboration.fromDrive")}
                </Button>
              )}
            </div>
          </form>
          <p className="calendar-field-hint">
            {t("componentsCalendarCollaboration.driveFilesKeepTheirExistingAccessPermissions")}
          </p>
        </>
      )}
      <CalendarNotice error={action.error || resource.error} />
      {drive && (
        <CalendarDrivePicker
          onClose={() => setDrive(false)}
          onChoose={(item) => {
            void add({ drive_item_id: item.id });
          }}
        />
      )}
    </section>
  );
}
export function CalendarAttachmentList({
  attachments,
  remove,
  busy,
}: {
  attachments: CalendarAttachment[];
  remove?: (attachment: CalendarAttachment) => void;
  busy?: boolean;
}) {
  return (
    <div className="calendar-attachment-list">
      {attachments.map((item) => (
        <div key={item.id}>
          <Icon name={item.drive_item_id ? "drive" : "link"} />
          {item.unavailable ? (
            <span>{t("componentsCalendarCollaboration.fileUnavailable")}</span>
          ) : item.drive_item_id ? (
            <Link to={`/drive/items/${item.drive_item_id}`}>
              {item.title || t("componentsCalendarCollaboration.driveFile")}
            </Link>
          ) : item.url ? (
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              {item.title || item.url}
              <Icon name="external" width="12" height="12" />
            </a>
          ) : (
            <span>{item.title || t("componentsCalendarCollaboration.attachment")}</span>
          )}
          {remove && (
            <CalendarIconButton
              icon="close"
              label={t("componentsCalendarCollaboration.remove2", {
                value1: item.title || t("componentsCalendarCollaboration.attachment"),
              })}
              disabled={busy}
              onClick={() => remove(item)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
export function CalendarCollaborationDialog({
  event,
  initialTab,
  onClose,
}: {
  event: CalendarEvent;
  initialTab: string;
  onClose: () => void;
}) {
  const calendar = useCalendar(),
    [tab, setTab] = useState(initialTab),
    [occurrence, setOccurrence] = useState("all");
  const master = useCalendarResource<{ event: CalendarEvent }>(eventPath(event), calendar.revision);
  const manager =
    calendarRank(calendar.data?.calendars.find((cal) => cal.id === event.calendar_id)) >= 5;
  const key =
    master.data?.event.recurrence?.length && occurrence === "single"
      ? (event.occurrence_key ?? "")
      : "";
  const reload = () => calendar.refresh();
  return (
    <CalendarModal
      title={event.title}
      description={t("componentsCalendarCollaboration.guestsAttachmentsAndExternalSharing")}
      onClose={onClose}
      className="calendar-collaboration-modal"
    >
      <div
        className="calendar-editor-tabs"
        role="tablist"
        aria-label={t("componentsCalendarCollaboration.eventCollaboration")}
      >
        {[
          { value: "guests", label: t("componentsCalendarCollaboration.guests") },
          { value: "attachments", label: t("componentsCalendarCollaboration.attachments") },
          ...(manager
            ? [
                { value: "sharing", label: t("componentsCalendarCollaboration.sharing") },
                { value: "registration", label: t("componentsCalendarCollaboration.registration") },
              ]
            : []),
        ].map((value) => (
          <button
            key={value.value}
            role="tab"
            aria-selected={tab === value.value}
            onClick={() => setTab(value.value)}
          >
            {value.label}
          </button>
        ))}
      </div>
      {!!master.data?.event.recurrence?.length && event.occurrence_key && (
        <div className="calendar-collaboration-scope">
          <SelectControl
            aria-label={t("componentsCalendarCollaboration.manageGuestsAttachmentsAndLinksFor")}
            value={occurrence}
            onValueChange={setOccurrence}
            options={[
              { value: "all", label: t("componentsCalendarCollaboration.entireSeries") },
              { value: "single", label: t("componentsCalendarCollaboration.thisEventOnly") },
            ]}
          />
        </div>
      )}
      {!master.data ? (
        <>
          <LoadingSkeleton label={t("componentsCalendarCollaboration.loadingEvent")} />
          <CalendarNotice error={master.error} />
        </>
      ) : (
        <div className="calendar-collaboration-content" key={`${tab}:${key}`}>
          {tab === "guests" ? (
            <CalendarGuests event={master.data.event} occurrenceKey={key} reload={reload} />
          ) : tab === "attachments" ? (
            <CalendarAttachments event={master.data.event} occurrenceKey={key} reload={reload} />
          ) : manager && tab === "registration" ? (
            <CalendarRegistrations event={master.data.event} occurrenceKey={key} />
          ) : manager ? (
            <CalendarShareLinks
              calendarId={event.calendar_id}
              event={master.data.event}
              occurrenceKey={key}
            />
          ) : null}
        </div>
      )}
    </CalendarModal>
  );
}
