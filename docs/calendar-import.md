# Importing iCalendar files

Open **Calendar settings and tools → Import events (.ics)**, choose a destination
calendar and a UTF-8 `.ics` file, then select **Preview import**. Review errors and
warnings before selecting **Import events**. The result lists every entry's status;
valid events can be imported even when unrelated entries fail validation.

Files can contain up to 200 entries and must be at most 1 MiB. The destination
requires permission to create calendar events and a calendar role that allows
writing events.

Supported information:

- Title, plain-text description, location and geographic coordinates.
- UTC and IANA time zones, floating times interpreted in the destination calendar's
  time zone, all-day events with exclusive end dates, and positive durations.
- Visibility, free/busy transparency, and confirmed, tentative or cancelled status.
- Daily, weekly, monthly and yearly recurrence within Officeflare's existing
  recurrence limits, plus `RDATE`, `EXDATE`, and moved/cancelled occurrences with
  `RECURRENCE-ID`.

Time zones must resolve to an IANA identifier. Vendor-prefixed `TZID` values can
use a `VTIMEZONE` component's IANA `X-LIC-LOCATION` alias. Arbitrary custom time
zone rules are not supported. Invalid dates, daylight-saving gaps, unsupported
recurrence rules, `RDATE` periods, zero-duration timed events and
`RECURRENCE-ID;RANGE=THISANDFUTURE` produce errors instead of silently changing
the event. If an occurrence exception is invalid, its whole series is rejected
to avoid importing an incorrect recurrence set.

Imports create personal copies. Organizer/guest information, invitations,
reminders and unsupported properties are reported as warnings and are not
imported. Unsupported components, such as `VTODO`, are reported as skipped.
No invitations or email are sent by importing.

The original UID is preserved. A UID already present in the destination calendar,
including its trash, is skipped. Importing never updates existing events.

## API

`POST /api/calendar/calendars/:calendarId/imports`

```json
{ "content": "BEGIN:VCALENDAR\r\n...", "dry_run": true }
```

Use `dry_run: true` to preview without writing. Omit it or set it to `false` to
import; imports require an `Idempotency-Key` header. The response includes
`calendar_id`, `dry_run`, `events_imported`, a `summary` of entry counts and an
`entries` array containing statuses, messages and warnings. Each VEVENT counts
as an entry, including individual recurrence exceptions; `events_imported`
counts master events. Writes, recurrence exceptions, change records and the
idempotency receipt are committed in one transaction.

Format reference: [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545).
Parsing uses [ICAL.js](https://kewisch.github.io/ical.js/api/).
