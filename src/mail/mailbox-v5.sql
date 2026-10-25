ALTER TABLE events ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX events_idempotency_index ON events(event_id) WHERE event_id IS NOT NULL;
CREATE TABLE maintenance_state (id INTEGER PRIMARY KEY CHECK(id=1), completed_at INTEGER NOT NULL) STRICT;
INSERT INTO maintenance_state VALUES(1,0);
