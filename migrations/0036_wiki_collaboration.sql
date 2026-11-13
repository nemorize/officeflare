CREATE TABLE collaboration_resources (
  id TEXT PRIMARY KEY NOT NULL,
  service TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  retired_at INTEGER,
  purged_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (service, resource_id)
)
STRICT;
CREATE INDEX collaboration_resources_retired ON collaboration_resources (retired_at, purged_at);
CREATE TABLE collaboration_tickets (
  token_hash TEXT PRIMARY KEY NOT NULL,
  resource_id TEXT NOT NULL REFERENCES collaboration_resources (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL REFERENCES user_sessions (id),
  auth_version INTEGER NOT NULL,
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
)
STRICT;
CREATE INDEX collaboration_tickets_user ON collaboration_tickets (user_id, expires_at);
CREATE INDEX collaboration_tickets_expiry ON collaboration_tickets (expires_at);
CREATE TABLE wiki_spaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'personal')),
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  version INTEGER NOT NULL DEFAULT 1,
  acl_version INTEGER NOT NULL DEFAULT 1,
  tree_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER
)
STRICT;
CREATE UNIQUE INDEX wiki_personal_space ON wiki_spaces (owner_user_id) WHERE kind = 'personal';
CREATE TABLE wiki_space_members (
  space_id TEXT NOT NULL REFERENCES wiki_spaces (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'manager')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (space_id, user_id)
)
STRICT;
CREATE INDEX wiki_members_user ON wiki_space_members (user_id, space_id);
CREATE TABLE wiki_pages (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL REFERENCES wiki_spaces (id),
  parent_id TEXT,
  resource_id TEXT NOT NULL UNIQUE REFERENCES collaboration_resources (id),
  title TEXT NOT NULL DEFAULT '',
  plain_text TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  permission_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (
    permission_mode IN ('inherit', 'restricted')
  ),
  version INTEGER NOT NULL DEFAULT 1,
  projected_epoch INTEGER NOT NULL DEFAULT 0,
  projected_seq INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  trashed_at INTEGER,
  purged_at INTEGER,
  UNIQUE (space_id, id),
  FOREIGN KEY (space_id, parent_id) REFERENCES wiki_pages (space_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
)
STRICT;
CREATE INDEX wiki_pages_parent ON wiki_pages (space_id, parent_id, sort_order, id);
CREATE INDEX wiki_pages_trash ON wiki_pages (space_id, trashed_at, id);
CREATE TABLE wiki_page_grants (
  page_id TEXT NOT NULL REFERENCES wiki_pages (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'manager')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (page_id, user_id)
)
STRICT;
CREATE INDEX wiki_grants_user ON wiki_page_grants (user_id, page_id);
CREATE TABLE wiki_comments (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES wiki_pages (id),
  author_user_id TEXT NOT NULL REFERENCES users (id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  resolved_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
)
STRICT;
CREATE INDEX wiki_comments_page ON wiki_comments (page_id, created_at, id);
CREATE TABLE wiki_favorites (
  user_id TEXT NOT NULL REFERENCES users (id),
  page_id TEXT NOT NULL REFERENCES wiki_pages (id),
  PRIMARY KEY (user_id, page_id)
)
STRICT;
CREATE TABLE wiki_assets (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES wiki_pages (id),
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id),
  ready_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX wiki_assets_pending ON wiki_assets (ready_at, created_at);
CREATE INDEX wiki_assets_page ON wiki_assets (page_id, id);
CREATE TABLE wiki_operations (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE wiki_activity (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  page_id TEXT,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX wiki_activity_space ON wiki_activity (space_id, created_at, id);

WITH
  definitions(id, key, label, is_default) AS (
    VALUES
      ('system-wiki-user', 'wiki-user', 'Wiki user', 1),
      ('system-wiki-reader', 'wiki-reader', 'Wiki read-only user', 0)
  )
INSERT INTO roles (id, key, label, is_default)
SELECT
  id,
  CASE
    WHEN EXISTS (SELECT 1 FROM roles WHERE roles.key = definitions.key) THEN
      'officeflare-' || definitions.key || '-' || lower(hex(randomblob(4)))
    ELSE key
  END,
  label,
  is_default
FROM definitions;
WITH
  capabilities(key) AS (
    VALUES
      ('wiki.access'),
      ('wiki.spaces.create'),
      ('wiki.pages.create'),
      ('wiki.pages.update'),
      ('wiki.pages.delete'),
      ('wiki.pages.move'),
      ('wiki.sharing.internal'),
      ('wiki.comments.create'),
      ('wiki.history.read'),
      ('wiki.history.restore'),
      ('wiki.assets.upload'),
      ('wiki.pages.export')
  )
INSERT INTO role_permissions (role_id, permission_key)
SELECT 'system-wiki-user', key FROM capabilities
UNION ALL
SELECT 'system-administrator', key FROM capabilities;
INSERT INTO role_permissions (role_id, permission_key) VALUES ('system-wiki-reader', 'wiki.access');
