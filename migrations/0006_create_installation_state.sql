-- Independent of users so deleting or disabling an administrator never reopens bootstrap.
CREATE TABLE installation_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  initialized_at INTEGER NOT NULL DEFAULT (unixepoch()),
  bootstrap_user_id TEXT
) STRICT;
