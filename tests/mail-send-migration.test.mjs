import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

test("send size migration preserves existing domain configuration and defaults to the provider ceiling", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);",
  );
  db.exec(readFileSync("migrations/0009_create_mail_control.sql", "utf8"));
  db.exec(
    "INSERT INTO mail_domains(id,name,inbound_connection_id,outbound_connection_id,inbound_enabled,outbound_enabled,plus_addressing) VALUES('domain','legacy.test','cloudflare-bindings','cloudflare-bindings',1,1,1);",
  );
  const before = db.prepare("SELECT * FROM mail_domains").get();
  db.exec(readFileSync("migrations/0016_mail_send_limits.sql", "utf8"));
  const { max_send_bytes, ...preserved } = db.prepare("SELECT * FROM mail_domains").get();
  assert.equal(max_send_bytes, null);
  assert.deepEqual(preserved, { ...before });
  assert.throws(() => db.exec("UPDATE mail_domains SET max_send_bytes=0"), /CHECK constraint/);
  assert.throws(() => db.exec("UPDATE mail_domains SET max_send_bytes=-1"), /CHECK constraint/);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("mail send migration merges historical grants and scopes without widening read or write access", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);",
  );
  db.exec(readFileSync("migrations/0009_create_mail_control.sql", "utf8"));
  for (const user of ["owner", "as-only", "behalf-only", "both", "neither"])
    db.prepare("INSERT INTO users VALUES(?)").run(user);
  db.exec(
    "INSERT INTO mail_mailboxes(id,owner_user_id,name) VALUES('box','owner','Legacy mailbox'); INSERT INTO mail_api_keys(id,user_id,name,token_hash,auth_version,expires_at) VALUES('key','owner','Legacy key','hash',1,9999999999);",
  );
  for (const [user, as, behalf] of [
    ["as-only", 1, 0],
    ["behalf-only", 0, 1],
    ["both", 1, 1],
    ["neither", 0, 0],
  ])
    db.prepare(
      "INSERT INTO mail_mailbox_members(mailbox_id,user_id,can_read,can_write,can_send_as,can_send_on_behalf) VALUES('box',?,1,0,?,?)",
    ).run(user, as, behalf);
  for (const action of ["read", "write", "send_as", "send_on_behalf"])
    db.prepare("INSERT INTO mail_api_key_scopes VALUES('key','box',?)").run(action);
  db.exec(readFileSync("migrations/0015_unify_mail_send_permission.sql", "utf8"));
  assert.deepEqual(
    db
      .prepare(
        "SELECT user_id,can_read,can_write,can_send,can_manage FROM mail_mailbox_members ORDER BY user_id",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { user_id: "as-only", can_read: 1, can_write: 0, can_send: 1, can_manage: 0 },
      { user_id: "behalf-only", can_read: 1, can_write: 0, can_send: 1, can_manage: 0 },
      { user_id: "both", can_read: 1, can_write: 0, can_send: 1, can_manage: 0 },
      { user_id: "neither", can_read: 1, can_write: 0, can_send: 0, can_manage: 0 },
    ],
  );
  assert.deepEqual(
    db
      .prepare("SELECT action FROM mail_api_key_scopes ORDER BY action")
      .all()
      .map((row) => row.action),
    ["read", "send", "write"],
  );
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info(mail_mailbox_members)")
      .all()
      .filter((row) => row.name.startsWith("can_send"))
      .map((row) => row.name),
    ["can_send"],
  );
  for (const action of ["send_as", "send_on_behalf"])
    assert.throws(
      () => db.prepare("INSERT INTO mail_api_key_scopes VALUES('key','box',?)").run(action),
      /CHECK constraint/,
    );
  db.exec("DELETE FROM mail_api_keys WHERE id='key'");
  assert.equal(db.prepare("SELECT count(*) n FROM mail_api_key_scopes").get().n, 0);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("partition migration removes send mode while preserving queued sends and their delivery records", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(readFileSync("src/mail/partition.sql", "utf8"));
  db.exec(
    "INSERT INTO messages(id,thread_id,direction,folder_id,subject,from_address,received_at,body_r2_key,draft_owner_id,created_at,updated_at) VALUES('message','thread','outbound','drafts','Legacy send','owner@example.test',100,'body','owner',100,100); INSERT INTO drafts(message_id,state,created_by) VALUES('message','submitted','owner'); INSERT INTO submissions(id,message_id,actor_id,actor_auth_version,address_id,send_mode,provider,connection_id,request_hash,draft_version,snapshot_r2_key,status,scheduled_at,created_at,updated_at) VALUES('submission','message','owner',1,'address','send_on_behalf','cloudflare','connection','hash',1,'snapshot','scheduled',200,100,100); INSERT INTO submission_recipients(submission_id,email_address) VALUES('submission','recipient@example.test'); INSERT INTO submission_attempts(id,submission_id,provider,connection_id,started_at) VALUES('attempt','submission','cloudflare','connection',100);",
  );
  const before = db
    .prepare(
      "SELECT id,message_id,actor_id,address_id,request_hash,draft_version,snapshot_r2_key,status,scheduled_at FROM submissions",
    )
    .all();
  db.exec(readFileSync("src/mail/partition-v2.sql", "utf8"));
  assert.deepEqual(
    db
      .prepare(
        "SELECT id,message_id,actor_id,address_id,request_hash,draft_version,snapshot_r2_key,status,scheduled_at FROM submissions",
      )
      .all(),
    before,
  );
  assert.equal(
    db
      .prepare("PRAGMA table_info(submissions)")
      .all()
      .some((row) => row.name === "send_mode"),
    false,
  );
  assert.equal(db.prepare("SELECT state FROM drafts").get().state, "submitted");
  assert.equal(db.prepare("SELECT count(*) n FROM submission_recipients").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM submission_attempts").get().n, 1);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
