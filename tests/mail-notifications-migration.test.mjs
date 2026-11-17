import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

test("mail push migration removes every saved mail notification and its delivery work while preserving other notifications", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE user_sessions (id TEXT PRIMARY KEY, revoked_at INTEGER);
    CREATE TABLE role_permissions (role_id TEXT, permission_key TEXT);
    CREATE TABLE mail_mailboxes (id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('alice'), ('bob');
    INSERT INTO user_sessions VALUES ('session', NULL);
    INSERT INTO mail_mailboxes VALUES ('mailbox');
  `);
  db.exec(readFileSync("migrations/0013_notifications.sql", "utf8"));
  db.exec(readFileSync("migrations/0031_push_notifications.sql", "utf8"));
  db.exec(`
    INSERT INTO push_tokens (id, user_id, session_id, auth_version, device_id, token_type, token)
    VALUES ('token', 'alice', 'session', 1, 'device', 'fcm_web', 'token');
    INSERT INTO notification_preferences (user_id, enabled, rules_json, version) VALUES
      ('alice', 0, '{"type:mail.received":false,"category:mail:messages":true,"service:mail":false,"type:wiki.shared":true,"service:drive":false}', 3),
      ('bob', 1, '{"type:wiki.comment":false}', 2);
  `);
  for (const [id, type] of [
    ["unread", "mail.received"],
    ["read", "mail.received"],
    ["archived", "mail.received"],
    ["snoozed", "mail.received"],
    ["deleted", "mail.received"],
    ["legacy", "mail.legacy"],
    ["suppressed", "mail.received"],
    ["keep", "wiki.shared"],
  ]) {
    db.prepare(
      "INSERT INTO notification_events (id, source_key, type, title, body) VALUES (?, ?, ?, ?, '')",
    ).run(id, id, type, id);
    db.prepare(
      "INSERT INTO notification_recipients (event_id, user_id, decision) VALUES (?, 'alice', ?)",
    ).run(id, id === "suppressed" ? "suppressed" : "deliver");
    if (id !== "suppressed")
      db.prepare(
        "INSERT INTO notification_inbox (id, user_id, event_id) VALUES (?, 'alice', ?)",
      ).run(id, id);
  }
  db.exec(`
    UPDATE notification_inbox SET read_at = 1 WHERE id = 'read';
    UPDATE notification_inbox SET archived_at = 1 WHERE id = 'archived';
    UPDATE notification_inbox SET snoozed_until = 9999999999 WHERE id = 'snoozed';
    UPDATE notification_inbox SET deleted_at = 1 WHERE id = 'deleted';
    INSERT INTO notification_push_deliveries (seq, token_id, delivered_at)
    SELECT seq, 'token', 1 FROM notification_changes WHERE kind = 'created';
  `);
  const kept = db.prepare("SELECT * FROM notification_inbox WHERE id = 'keep'").get();
  const keptChanges = db
    .prepare("SELECT * FROM notification_changes WHERE notification_id = 'keep'")
    .all();
  const oldMailSeqs = db
    .prepare("SELECT seq FROM notification_changes WHERE notification_id != 'keep'")
    .all();
  const bob = db.prepare("SELECT * FROM notification_preferences WHERE user_id = 'bob'").get();

  db.exec(readFileSync("migrations/0043_mail_push_only.sql", "utf8"));

  assert.deepEqual(db.prepare("SELECT * FROM notification_inbox").all(), [kept]);
  assert.deepEqual(
    db
      .prepare("SELECT id FROM notification_events")
      .all()
      .map((row) => row.id),
    ["keep"],
  );
  assert.deepEqual(
    db
      .prepare("SELECT event_id FROM notification_recipients")
      .all()
      .map((row) => row.event_id),
    ["keep"],
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM notification_changes WHERE notification_id = 'keep'").all(),
    keptChanges,
  );
  const deletions = db
    .prepare(
      "SELECT notification_id, kind FROM notification_changes WHERE notification_id != 'keep'",
    )
    .all();
  assert.equal(deletions.length, 6);
  assert.ok(deletions.every((row) => row.kind === "deleted"));
  for (const { seq } of oldMailSeqs) {
    assert.equal(db.prepare("SELECT * FROM notification_outbox WHERE seq = ?").get(seq), undefined);
    assert.equal(
      db.prepare("SELECT * FROM notification_push_deliveries WHERE seq = ?").get(seq),
      undefined,
    );
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_push_deliveries").get().n, 1);
  const alice = db.prepare("SELECT * FROM notification_preferences WHERE user_id = 'alice'").get();
  assert.equal(alice.enabled, 0);
  assert.equal(alice.version, 4);
  assert.deepEqual(JSON.parse(alice.rules_json), {
    "type:wiki.shared": true,
    "service:drive": false,
  });
  assert.deepEqual(
    db.prepare("SELECT * FROM notification_preferences WHERE user_id = 'bob'").get(),
    bob,
  );
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);

  db.exec(`
    INSERT INTO mail_push_outbox (source_key, mailbox_id, user_id, title, body)
    VALUES ('mail:mailbox:ingest', 'mailbox', 'alice', 'New mail', 'sender');
    INSERT INTO mail_push_deliveries (seq, token_id) SELECT seq, 'token' FROM mail_push_outbox;
    DELETE FROM mail_mailboxes WHERE id = 'mailbox';
  `);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mail_push_outbox").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mail_push_deliveries").get().n, 0);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
