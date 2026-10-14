CREATE TABLE IF NOT EXISTS ui_command_receipts (
  operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
