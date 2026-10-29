CREATE TABLE user_mail_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users (id)
    ON DELETE CASCADE,
  preferences_json TEXT NOT NULL CHECK (json_valid(preferences_json)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
