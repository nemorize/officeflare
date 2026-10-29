CREATE TABLE drive_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  quota_bytes INTEGER NOT NULL CHECK (quota_bytes >= 0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE drive_items (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  parent_id TEXT REFERENCES drive_items (id),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  current_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  trashed_at INTEGER,
  purged_at INTEGER
)
STRICT;
CREATE INDEX drive_items_parent ON drive_items (parent_id, updated_at DESC, id DESC);
CREATE INDEX drive_items_owner ON drive_items (owner_user_id, updated_at DESC, id DESC);
CREATE TRIGGER drive_items_parent_insert
BEFORE INSERT ON drive_items
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Invalid Drive parent')
  WHERE
    NOT EXISTS (
      SELECT 1
      FROM drive_items p
      WHERE
        p.id = NEW.parent_id
        AND p.kind = 'folder'
        AND p.owner_user_id = NEW.owner_user_id
        AND p.purged_at IS NULL
        AND p.trashed_at IS NULL
    );
END;
CREATE TRIGGER drive_items_parent_update
BEFORE UPDATE OF parent_id, owner_user_id ON drive_items
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Invalid Drive parent')
  WHERE
    NOT EXISTS (
      SELECT 1
      FROM drive_items p
      WHERE
        p.id = NEW.parent_id
        AND p.kind = 'folder'
        AND p.owner_user_id = NEW.owner_user_id
        AND p.purged_at IS NULL
        AND (p.trashed_at IS NULL OR NEW.parent_id = OLD.parent_id)
    );
  SELECT RAISE(ABORT, 'Drive folder cycle')
  WHERE
    NEW.parent_id IN
      (
        WITH RECURSIVE
          descendants(id) AS (
            SELECT OLD.id
            UNION ALL
            SELECT d.id
            FROM drive_items d
            JOIN descendants p ON d.parent_id = p.id
          )
        SELECT id
        FROM descendants
      );
END;
CREATE TABLE drive_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  blob_key TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT NOT NULL,
  etag TEXT NOT NULL,
  sha256 TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX drive_versions_item ON drive_versions (item_id, created_at DESC, id DESC);
CREATE INDEX drive_versions_blob ON drive_versions (blob_key);
CREATE TRIGGER drive_version_immutable_update
BEFORE UPDATE ON drive_versions
BEGIN
  SELECT RAISE(ABORT, 'Drive versions are immutable');
END;
CREATE TRIGGER drive_version_insert
AFTER INSERT ON drive_versions
BEGIN
  UPDATE drive_accounts
  SET used_bytes = used_bytes + NEW.size
  WHERE user_id = (SELECT owner_user_id FROM drive_items WHERE id = NEW.item_id);
END;
CREATE TRIGGER drive_version_delete
AFTER DELETE ON drive_versions
BEGIN
  UPDATE drive_accounts
  SET used_bytes = used_bytes - OLD.size
  WHERE user_id = (SELECT owner_user_id FROM drive_items WHERE id = OLD.item_id);
END;
CREATE TABLE drive_permissions (
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  expires_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (item_id, user_id)
)
STRICT;
CREATE INDEX drive_permissions_user ON drive_permissions (user_id, item_id);
CREATE TABLE drive_links (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  allow_download INTEGER NOT NULL DEFAULT 1 CHECK (allow_download IN (0, 1)),
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX drive_links_item ON drive_links (item_id);
CREATE TABLE drive_uploads (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES drive_accounts (user_id),
  created_by TEXT NOT NULL REFERENCES users (id),
  item_id TEXT NOT NULL,
  parent_id TEXT REFERENCES drive_items (id),
  name TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT NOT NULL,
  sha256 TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('single', 'multipart')),
  blob_key TEXT NOT NULL UNIQUE,
  multipart_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('allocating', 'open', 'writing', 'ready', 'committing', 'completed', 'cancelled')
  ),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
)
STRICT;
CREATE INDEX drive_uploads_expiry ON drive_uploads (expires_at, status);
CREATE TRIGGER drive_upload_reserved
AFTER INSERT ON drive_uploads
BEGIN
  UPDATE drive_accounts
  SET reserved_bytes = reserved_bytes + NEW.size
  WHERE user_id = NEW.owner_user_id;
END;
CREATE TRIGGER drive_upload_released
AFTER UPDATE OF status ON drive_uploads
WHEN NEW.status IN ('completed', 'cancelled') AND OLD.status NOT IN ('completed', 'cancelled')
BEGIN
  UPDATE drive_accounts
  SET reserved_bytes = reserved_bytes - NEW.size
  WHERE user_id = NEW.owner_user_id;
END;
CREATE TABLE drive_upload_parts (
  upload_id TEXT NOT NULL REFERENCES drive_uploads (id)
    ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size INTEGER NOT NULL CHECK (size > 0),
  etag TEXT NOT NULL,
  PRIMARY KEY (upload_id, part_number)
)
STRICT;
CREATE TABLE drive_activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  actor_user_id TEXT REFERENCES users (id),
  link_id TEXT REFERENCES drive_links (id),
  action TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX drive_activity_item ON drive_activity (item_id, seq DESC);
CREATE TRIGGER drive_activity_immutable_update
BEFORE UPDATE ON drive_activity
BEGIN
  SELECT RAISE(ABORT, 'Drive activity is immutable');
END;
CREATE TRIGGER drive_activity_immutable_delete
BEFORE DELETE ON drive_activity
BEGIN
  SELECT RAISE(ABORT, 'Drive activity is immutable');
END;
CREATE TABLE drive_operations (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE drive_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id),
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  kind TEXT NOT NULL CHECK (kind IN ('updated', 'removed', 'permissions')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX drive_changes_user ON drive_changes (user_id, seq);
CREATE TABLE drive_stars (
  user_id TEXT NOT NULL REFERENCES users (id),
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, item_id)
)
STRICT;
CREATE TABLE drive_recents (
  user_id TEXT NOT NULL REFERENCES users (id),
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  viewed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, item_id)
)
STRICT;
CREATE TABLE drive_comments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  parent_id TEXT REFERENCES drive_comments (id),
  author_user_id TEXT NOT NULL REFERENCES users (id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
)
STRICT;
CREATE INDEX drive_comments_item ON drive_comments (item_id, created_at, id);
CREATE TABLE drive_access_requests (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES drive_items (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  decided_at INTEGER
)
STRICT;
CREATE UNIQUE INDEX drive_access_requests_pending ON drive_access_requests (item_id, user_id)
WHERE status = 'pending';
CREATE TABLE drive_garbage (
  blob_key TEXT PRIMARY KEY,
  not_before INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_until INTEGER NOT NULL DEFAULT 0
)
STRICT;
