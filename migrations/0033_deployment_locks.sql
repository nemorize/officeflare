-- Serialize one-time secret provisioning across concurrent deployments.
-- Only lease metadata is stored here; key material stays in Workers Secrets.
CREATE TABLE deployment_locks (
  name TEXT PRIMARY KEY NOT NULL,
  lease_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)
STRICT;
