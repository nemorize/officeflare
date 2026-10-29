-- Calendar phase 1. Scheduling data and authorization claims share the account D1.
CREATE TABLE calendars (
  id TEXT PRIMARY KEY NOT NULL,
  data_owner_user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared', 'resource', 'system', 'external')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  location TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 1024),
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  default_visibility TEXT NOT NULL DEFAULT 'private' CHECK (
    default_visibility IN ('private', 'public')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  trashed_at INTEGER
)
STRICT;
CREATE INDEX calendars_owner ON calendars (data_owner_user_id, trashed_at, status);
CREATE TABLE calendar_primary_calendars (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id),
  calendar_id TEXT NOT NULL UNIQUE REFERENCES calendars (id)
)
STRICT;
CREATE TABLE calendar_acl (
  id TEXT PRIMARY KEY NOT NULL,
  calendar_id TEXT NOT NULL REFERENCES calendars (id),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('user', 'group', 'organization', 'domain', 'public')
  ),
  scope_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('free_busy', 'reader', 'writer_without_private', 'writer', 'manager')
  ),
  expires_at INTEGER,
  granted_by TEXT REFERENCES users (id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (calendar_id, scope_type, scope_key)
)
STRICT;
CREATE INDEX calendar_acl_subject ON calendar_acl (scope_type, scope_key, expires_at);
CREATE TABLE calendar_subscriptions (
  user_id TEXT NOT NULL REFERENCES users (id),
  calendar_id TEXT NOT NULL REFERENCES calendars (id),
  name_override TEXT,
  color TEXT,
  selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  default_reminders_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(default_reminders_json)
    AND json_type(default_reminders_json) = 'array'
  ),
  notification_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(notification_policy_json)
    AND json_type(notification_policy_json) = 'object'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, calendar_id)
)
STRICT;
CREATE INDEX calendar_subscriptions_user ON calendar_subscriptions (user_id, selected, sort_order);
CREATE TABLE calendar_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id),
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  secondary_time_zone TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  week_start INTEGER NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  default_view TEXT NOT NULL DEFAULT 'week' CHECK (
    default_view IN ('day', 'week', 'month', 'agenda')
  ),
  default_duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (
    default_duration_minutes BETWEEN 1 AND 1440
  ),
  invitation_policy TEXT NOT NULL DEFAULT 'all' CHECK (
    invitation_policy IN ('all', 'known_senders', 'on_response')
  ),
  display_options_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(display_options_json)
    AND json_type(display_options_json) = 'object'
  ),
  default_reminders_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(default_reminders_json)
    AND json_type(default_reminders_json) = 'array'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE calendar_labels (
  id TEXT PRIMARY KEY NOT NULL,
  calendar_id TEXT NOT NULL REFERENCES calendars (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE (calendar_id, id)
)
STRICT;
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY NOT NULL,
  organizer_calendar_id TEXT NOT NULL REFERENCES calendars (id),
  organizer_user_id TEXT REFERENCES users (id),
  organizer_email TEXT NOT NULL,
  creator_user_id TEXT REFERENCES users (id),
  authority TEXT NOT NULL DEFAULT 'native' CHECK (authority IN ('native', 'remote')),
  i_cal_uid TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  event_type TEXT NOT NULL DEFAULT 'default' CHECK (
    event_type IN
      (
        'default',
        'focus_time',
        'out_of_office',
        'working_location',
        'birthday',
        'from_mail',
        'task_block'
      )
  ),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (
    status IN ('confirmed', 'tentative', 'cancelled')
  ),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 1024),
  description_html TEXT NOT NULL DEFAULT '' CHECK (length(description_html) <= 20000),
  location_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(location_json)
    AND json_type(location_json) = 'object'
  ),
  time_kind TEXT NOT NULL CHECK (time_kind IN ('timed', 'all_day')),
  start_at INTEGER,
  end_at INTEGER,
  start_date TEXT,
  end_date TEXT,
  start_local TEXT,
  end_local TEXT,
  start_time_zone TEXT,
  end_time_zone TEXT,
  recurrence_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(recurrence_json)
    AND json_type(recurrence_json) = 'array'
  ),
  recurrence_until_at INTEGER,
  visibility TEXT NOT NULL DEFAULT 'default' CHECK (visibility IN ('default', 'private', 'public')),
  transparency TEXT NOT NULL DEFAULT 'busy' CHECK (transparency IN ('busy', 'free')),
  guest_permissions_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(guest_permissions_json)
    AND json_type(guest_permissions_json) = 'object'
  ),
  type_properties_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(type_properties_json)
    AND json_type(type_properties_json) = 'object'
  ),
  shared_properties_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(shared_properties_json)
    AND json_type(shared_properties_json) = 'object'
  ),
  source_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(source_json)
    AND json_type(source_json) = 'object'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  trashed_at INTEGER,
  UNIQUE (organizer_calendar_id, i_cal_uid),
  CHECK (
    (
      time_kind = 'timed'
      AND start_at IS NOT NULL
      AND end_at IS NOT NULL
      AND end_at > start_at
      AND start_local IS NOT NULL
      AND end_local IS NOT NULL
      AND start_time_zone IS NOT NULL
      AND end_time_zone IS NOT NULL
      AND start_date IS NULL
      AND end_date IS NULL
    )
    OR (
      time_kind = 'all_day'
      AND start_date IS NOT NULL
      AND end_date IS NOT NULL
      AND end_date > start_date
      AND start_at IS NULL
      AND end_at IS NULL
      AND start_local IS NULL
      AND end_local IS NULL
      AND start_time_zone IS NULL
      AND end_time_zone IS NULL
    )
  ),
  CHECK (
    json_array_length(recurrence_json) = 0
    OR time_kind = 'all_day'
    OR start_time_zone = end_time_zone
  )
)
STRICT;
CREATE INDEX calendar_events_timed ON calendar_events (organizer_calendar_id, start_at, end_at)
WHERE trashed_at IS NULL;
CREATE INDEX calendar_events_dates ON calendar_events (organizer_calendar_id, start_date, end_date)
WHERE trashed_at IS NULL;
CREATE INDEX calendar_events_recurring
ON calendar_events (organizer_calendar_id, recurrence_until_at)
WHERE recurrence_json <> '[]' AND trashed_at IS NULL;
CREATE TABLE calendar_event_scopes (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES calendar_events (id),
  occurrence_key TEXT NOT NULL DEFAULT '',
  UNIQUE (event_id, occurrence_key),
  UNIQUE (id, event_id)
)
STRICT;
CREATE TABLE calendar_event_overrides (
  scope_id TEXT PRIMARY KEY NOT NULL REFERENCES calendar_event_scopes (id)
    ON DELETE CASCADE,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
  patch_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(patch_json)
    AND json_type(patch_json) = 'object'
  ),
  effective_start_at INTEGER,
  effective_end_at INTEGER,
  effective_start_date TEXT,
  effective_end_date TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX calendar_overrides_timed
ON calendar_event_overrides (effective_start_at, effective_end_at);
CREATE INDEX calendar_overrides_dates
ON calendar_event_overrides (effective_start_date, effective_end_date);
CREATE TABLE calendar_event_copies (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES calendar_events (id),
  calendar_id TEXT NOT NULL REFERENCES calendars (id),
  copy_kind TEXT NOT NULL DEFAULT 'organizer' CHECK (
    copy_kind IN ('organizer', 'attendee', 'import')
  ),
  color_override TEXT,
  label_id TEXT,
  use_default_reminders INTEGER NOT NULL DEFAULT 1 CHECK (use_default_reminders IN (0, 1)),
  private_properties_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(private_properties_json)
    AND json_type(private_properties_json) = 'object'
  ),
  hidden_at INTEGER,
  removed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (event_id, calendar_id),
  FOREIGN KEY (calendar_id, label_id) REFERENCES calendar_labels (calendar_id, id)
)
STRICT;
CREATE INDEX calendar_copies_calendar ON calendar_event_copies (calendar_id, removed_at, event_id);
CREATE TABLE calendar_operations (
  id TEXT PRIMARY KEY NOT NULL,
  actor_key TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users (id),
  operation TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  UNIQUE (actor_key, operation, idempotency_key)
)
STRICT;
CREATE TABLE calendar_series_links (
  previous_event_id TEXT NOT NULL REFERENCES calendar_events (id),
  next_event_id TEXT NOT NULL REFERENCES calendar_events (id),
  split_occurrence_key TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES calendar_operations (id),
  PRIMARY KEY (previous_event_id, next_event_id)
)
STRICT;
CREATE TABLE calendar_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id TEXT REFERENCES calendars (id),
  audience_user_id TEXT REFERENCES users (id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  occurrence_key TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'visibility_changed')),
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX calendar_changes_calendar ON calendar_changes (calendar_id, seq);
CREATE INDEX calendar_changes_user ON calendar_changes (audience_user_id, seq);
CREATE TABLE calendar_activity (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL REFERENCES calendar_operations (id),
  actor_user_id TEXT REFERENCES users (id),
  calendar_id TEXT REFERENCES calendars (id),
  event_id TEXT,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX calendar_activity_event ON calendar_activity (event_id, created_at, id);

-- Existing Calendar service roles receive the core operations that service access
-- previously represented. New custom read-only roles can grant calendar.access alone.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT DISTINCT p.role_id, new_permission.value
FROM role_permissions p
JOIN json_each(
  '["calendar.calendars.create","calendar.events.create","calendar.events.update","calendar.events.delete"]'
) new_permission
WHERE p.permission_key = 'calendar.access';
UPDATE roles
SET
  version = version + 1,
  updated_at = unixepoch()
WHERE id IN (SELECT role_id FROM role_permissions WHERE permission_key = 'calendar.access');
