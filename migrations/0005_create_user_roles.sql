CREATE TABLE roles (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;

CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles (id)
    ON DELETE CASCADE,
  permission_key TEXT NOT NULL CHECK (length(permission_key) BETWEEN 1 AND 100),
  PRIMARY KEY (role_id, permission_key)
)
STRICT;

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users (id)
    ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles (id)
    ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users (id)
    ON DELETE SET NULL,
  assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, role_id)
)
STRICT;
CREATE INDEX user_roles_role_id_index ON user_roles (role_id);

-- Deployment bootstrap assigns this role to the initial administrator.
INSERT INTO roles (id, key, label, description, is_system)
VALUES
  (
    'system-administrator',
    'administrator',
    'Administrator',
    'Manages roles and user role assignments.',
    1
  );
INSERT INTO role_permissions (role_id, permission_key)
VALUES
  ('system-administrator', 'roles.read'),
  ('system-administrator', 'roles.manage'),
  ('system-administrator', 'users.roles.read'),
  ('system-administrator', 'users.roles.manage');
