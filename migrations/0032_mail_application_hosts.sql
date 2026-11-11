CREATE TABLE mail_application_hosts (
  hostname TEXT PRIMARY KEY NOT NULL CHECK (length(hostname) BETWEEN 1 AND 253),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
