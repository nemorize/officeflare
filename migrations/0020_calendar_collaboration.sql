-- Calendar collaboration, recipient-specific invitations and external registration.
CREATE TABLE calendar_workspace_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'workspace'),
  system_address_id TEXT REFERENCES mail_addresses (id),
  internal_sharing_enabled INTEGER NOT NULL DEFAULT 1 CHECK (internal_sharing_enabled IN (0, 1)),
  external_sharing_enabled INTEGER NOT NULL DEFAULT 1 CHECK (external_sharing_enabled IN (0, 1)),
  public_link_max_days INTEGER NOT NULL DEFAULT 90 CHECK (public_link_max_days BETWEEN 1 AND 365),
  public_link_password_required INTEGER NOT NULL DEFAULT 0 CHECK (
    public_link_password_required IN (0, 1)
  ),
  authorization_epoch INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
INSERT INTO calendar_workspace_settings (id) VALUES ('workspace');
CREATE TABLE calendar_groups (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
)
STRICT;
CREATE TABLE calendar_group_members (
  group_id TEXT NOT NULL REFERENCES calendar_groups (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  PRIMARY KEY (group_id, user_id)
)
STRICT;
CREATE TABLE calendar_working_hours (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id),
  time_zone TEXT NOT NULL,
  weekly_json TEXT NOT NULL CHECK (json_valid(weekly_json)),
  exceptions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(exceptions_json)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE calendar_event_attendees (
  id TEXT PRIMARY KEY NOT NULL,
  scope_id TEXT NOT NULL REFERENCES calendar_event_scopes (id),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'external')),
  user_id TEXT REFERENCES users (id),
  email_address TEXT NOT NULL,
  email_key TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  optional INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0, 1)),
  additional_guests INTEGER NOT NULL DEFAULT 0 CHECK (additional_guests BETWEEN 0 AND 20),
  response_status TEXT NOT NULL DEFAULT 'needs_action' CHECK (
    response_status IN ('needs_action', 'accepted', 'tentative', 'declined')
  ),
  attendance_mode TEXT NOT NULL DEFAULT 'unspecified' CHECK (
    attendance_mode IN ('unspecified', 'in_person', 'virtual')
  ),
  response_comment TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  responded_at INTEGER,
  removed_at INTEGER,
  CHECK (
    (principal_type = 'user' AND user_id IS NOT NULL)
    OR (principal_type = 'external' AND user_id IS NULL)
  )
)
STRICT;
CREATE UNIQUE INDEX calendar_attendees_active_email
ON calendar_event_attendees (scope_id, email_key)
WHERE removed_at IS NULL;
CREATE INDEX calendar_attendees_user ON calendar_event_attendees (user_id, removed_at);
CREATE TABLE calendar_attendee_occurrence_responses (
  attendee_id TEXT NOT NULL REFERENCES calendar_event_attendees (id),
  occurrence_key TEXT NOT NULL,
  response_status TEXT NOT NULL CHECK (
    response_status IN ('needs_action', 'accepted', 'tentative', 'declined')
  ),
  attendance_mode TEXT NOT NULL DEFAULT 'unspecified' CHECK (
    attendance_mode IN ('unspecified', 'in_person', 'virtual')
  ),
  comment TEXT NOT NULL DEFAULT '',
  responded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (attendee_id, occurrence_key)
)
STRICT;
CREATE TABLE calendar_attendee_exclusions (
  event_id TEXT NOT NULL REFERENCES calendar_events (id),
  occurrence_key TEXT NOT NULL,
  email_key TEXT NOT NULL,
  PRIMARY KEY (event_id, occurrence_key, email_key)
)
STRICT;
CREATE TABLE calendar_invitation_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  attendee_id TEXT NOT NULL REFERENCES calendar_event_attendees (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE calendar_share_links (
  id TEXT PRIMARY KEY NOT NULL,
  calendar_id TEXT NOT NULL REFERENCES calendars (id),
  event_id TEXT REFERENCES calendar_events (id),
  target_type TEXT NOT NULL CHECK (target_type IN ('calendar', 'event')),
  occurrence_key TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('view', 'join')),
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  shared_fields_json TEXT NOT NULL DEFAULT '["title"]' CHECK (
    json_valid(shared_fields_json)
    AND json_type(shared_fields_json) = 'array'
  ),
  allow_ics INTEGER NOT NULL DEFAULT 0 CHECK (allow_ics IN (0, 1)),
  time_min INTEGER,
  time_max INTEGER,
  access_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users (id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (target_type = 'calendar' AND event_id IS NULL AND occurrence_key IS NULL AND mode = 'view')
    OR (target_type = 'event' AND event_id IS NOT NULL)
  ),
  CHECK (time_min IS NULL OR (time_max IS NOT NULL AND time_max > time_min))
)
STRICT;
CREATE INDEX calendar_share_links_target
ON calendar_share_links (calendar_id, event_id, revoked_at);
CREATE TABLE calendar_link_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  share_link_id TEXT NOT NULL REFERENCES calendar_share_links (id),
  token_hash TEXT NOT NULL UNIQUE,
  link_access_version INTEGER NOT NULL,
  verified_email TEXT,
  email_key TEXT,
  email_verified_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE calendar_external_email_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES calendar_link_sessions (id),
  share_link_id TEXT NOT NULL REFERENCES calendar_share_links (id),
  email_address TEXT NOT NULL,
  email_key TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE calendar_registration_policies (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES calendar_events (id),
  occurrence_key TEXT NOT NULL DEFAULT '',
  approval_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (approval_mode IN ('automatic', 'manual')),
  capacity INTEGER CHECK (capacity IS NULL OR capacity BETWEEN 0 AND 10000),
  waitlist_enabled INTEGER NOT NULL DEFAULT 1 CHECK (waitlist_enabled IN (0, 1)),
  additional_guests_limit INTEGER NOT NULL DEFAULT 0 CHECK (
    additional_guests_limit BETWEEN 0 AND 20
  ),
  registration_opens_at INTEGER,
  registration_closes_at INTEGER,
  allowed_email_domains_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(allowed_email_domains_json)
  ),
  form_schema_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(form_schema_json)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (event_id, occurrence_key),
  CHECK (
    registration_closes_at IS NULL
    OR registration_opens_at IS NULL
    OR registration_closes_at > registration_opens_at
  )
)
STRICT;
CREATE TABLE calendar_registration_instances (
  event_id TEXT NOT NULL REFERENCES calendar_events (id),
  occurrence_key TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, occurrence_key)
)
STRICT;
CREATE TABLE calendar_event_registrations (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES calendar_events (id),
  occurrence_key TEXT NOT NULL DEFAULT '',
  source_link_id TEXT REFERENCES calendar_share_links (id),
  attendee_id TEXT REFERENCES calendar_event_attendees (id),
  email_address TEXT NOT NULL,
  email_key TEXT NOT NULL,
  user_id TEXT REFERENCES users (id),
  display_name TEXT NOT NULL,
  additional_guests INTEGER NOT NULL DEFAULT 0,
  answers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(answers_json)),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'confirmed', 'waitlisted', 'rejected', 'cancelled')
  ),
  requested_response TEXT NOT NULL DEFAULT 'accepted' CHECK (
    requested_response IN ('accepted', 'tentative')
  ),
  requested_attendance_mode TEXT NOT NULL DEFAULT 'unspecified' CHECK (
    requested_attendance_mode IN ('unspecified', 'in_person', 'virtual')
  ),
  version INTEGER NOT NULL DEFAULT 1,
  waitlisted_at INTEGER,
  confirmed_at INTEGER,
  decided_by TEXT REFERENCES users (id),
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (event_id, occurrence_key, email_key)
)
STRICT;
CREATE INDEX calendar_registrations_queue
ON calendar_event_registrations (event_id, occurrence_key, status, waitlisted_at, id);
CREATE TABLE calendar_registration_manage_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  registration_id TEXT NOT NULL REFERENCES calendar_event_registrations (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
)
STRICT;
CREATE TABLE calendar_invitation_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL REFERENCES calendar_operations (id),
  event_id TEXT REFERENCES calendar_events (id),
  occurrence_key TEXT NOT NULL DEFAULT '',
  attendee_id TEXT REFERENCES calendar_event_attendees (id),
  action TEXT NOT NULL CHECK (
    action IN ('invite', 'update', 'cancel', 'response', 'confirmation', 'verify', 'recovery')
  ),
  sequence INTEGER NOT NULL DEFAULT 0,
  source_version INTEGER NOT NULL DEFAULT 0,
  recipient_user_id TEXT REFERENCES users (id),
  recipient_email TEXT,
  recipient_key TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('notification_center', 'email')),
  status TEXT NOT NULL CHECK (
    status IN
      (
        'queued',
        'inbox_committed',
        'accepted',
        'delivered',
        'retry_wait',
        'failed',
        'unknown',
        'sending',
        'suppressed',
        'superseded'
      )
  ),
  dedup_key TEXT NOT NULL UNIQUE,
  provider_message_id TEXT,
  message_id TEXT NOT NULL,
  error_code TEXT,
  accepted_at INTEGER,
  delivered_at INTEGER,
  retry_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (channel <> 'email' OR recipient_user_id IS NULL OR action IN ('verify', 'recovery'))
)
STRICT;
CREATE INDEX calendar_deliveries_event ON calendar_invitation_deliveries (event_id, created_at, id);
CREATE TABLE calendar_outbox (
  id TEXT PRIMARY KEY NOT NULL REFERENCES calendar_invitation_deliveries (id),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  run_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX calendar_outbox_due ON calendar_outbox (completed_at, run_at, lease_until);
CREATE TABLE calendar_public_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
)
STRICT;
CREATE TABLE calendar_event_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  scope_id TEXT NOT NULL REFERENCES calendar_event_scopes (id),
  drive_item_id TEXT REFERENCES drive_items (id),
  url TEXT,
  title TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  version INTEGER NOT NULL DEFAULT 1,
  removed_at INTEGER,
  CHECK ((drive_item_id IS NOT NULL AND url IS NULL) OR (drive_item_id IS NULL AND url IS NOT NULL))
)
STRICT;
CREATE TABLE calendar_time_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES calendar_events (id),
  attendee_id TEXT NOT NULL REFERENCES calendar_event_attendees (id),
  occurrence_key TEXT NOT NULL DEFAULT '',
  start_json TEXT NOT NULL CHECK (json_valid(start_json)),
  end_json TEXT NOT NULL CHECK (json_valid(end_json)),
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'rejected', 'withdrawn')
  ),
  version INTEGER NOT NULL DEFAULT 1,
  resolved_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
WITH
  grants(key) AS (
    VALUES
      ('calendar.sharing.internal'),
      ('calendar.sharing.external'),
      ('calendar.events.invite'),
      ('calendar.groups.manage')
  )
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT rp.role_id, g.key
FROM role_permissions rp
CROSS JOIN grants g
WHERE rp.permission_key = 'calendar.events.create';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES
  ('system-administrator', 'admin.calendar.settings.read'),
  ('system-administrator', 'admin.calendar.settings.manage');
UPDATE roles
SET version = version + 1
WHERE
  id IN (SELECT role_id FROM role_permissions WHERE permission_key = 'calendar.events.create')
  OR id = 'system-administrator';
