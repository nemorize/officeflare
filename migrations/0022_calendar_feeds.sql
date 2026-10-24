CREATE TABLE calendar_feeds (
  calendar_id TEXT PRIMARY KEY NOT NULL REFERENCES calendars(id),
  source_secret TEXT CHECK (source_secret IS NULL OR json_valid(source_secret)),
  source_hash TEXT,
  source_host TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
  etag TEXT,
  last_modified TEXT,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  next_sync_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX calendar_feeds_due ON calendar_feeds(enabled,next_sync_at,lease_until);
