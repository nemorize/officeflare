import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";

test("domain provider migration copies encrypted settings without sharing or losing transport identities", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of (await readdir("migrations")).sort().filter((name) => name < "0026"))
    db.exec(await readFile("migrations/" + name, "utf8"));
  db.prepare("INSERT INTO users(id,email_address) VALUES('owner','owner@test.example')").run();
  db.prepare(
    "INSERT INTO mail_provider_connections(id,provider,name,enabled,version,config_json,secret_ciphertext,secret_nonce) VALUES('legacy-provider','ses','Legacy',1,7,?,?,?)",
  ).run(JSON.stringify({ region: "us-east-1" }), "encrypted-credential", "saved-nonce");
  db.exec(
    "INSERT INTO mail_domains(id,name,inbound_connection_id,outbound_connection_id,inbound_enabled,outbound_enabled,is_default) VALUES('first','first.test','cloudflare-bindings','legacy-provider',1,1,1),('second','second.test',NULL,'legacy-provider',0,1,0)",
  );
  db.exec(
    "INSERT INTO mail_provider_connections(id,provider,name,enabled) VALUES('disabled','cloudflare','Disabled',0)",
  );
  db.exec(
    "INSERT INTO mail_domains(id,name,inbound_connection_id,outbound_connection_id,inbound_enabled,outbound_enabled) VALUES('third','third.test','disabled','disabled',1,1)",
  );
  db.exec(
    "INSERT INTO mail_mailboxes(id,owner_user_id,name,status) VALUES('box','owner','Inbox','active'); INSERT INTO mail_addresses(id,domain_id,mailbox_id,local_part) VALUES('address','first','box','owner')",
  );
  db.exec(
    "INSERT INTO mail_routing_rules(id,domain_id,name,conditions_json,action) VALUES('rule','first','Routing','[]','store')",
  );
  db.exec(await readFile("migrations/0026_domain_provider_settings.sql", "utf8"));
  const first = db.prepare("SELECT * FROM mail_domains WHERE id='first'").get();
  const second = db.prepare("SELECT * FROM mail_domains WHERE id='second'").get();
  const settings = JSON.parse(first.provider_settings_json);
  assert.equal(first.version, 7);
  assert.equal(first.is_default, 1);
  assert.equal(first.inbound_enabled, 1);
  assert.equal(first.outbound_enabled, 1);
  assert.equal(settings.inbound.id, "cloudflare-bindings");
  assert.deepEqual(settings.outbound, {
    id: "legacy-provider",
    provider: "ses",
    config: { region: "us-east-1" },
    secret_ciphertext: "encrypted-credential",
    secret_nonce: "saved-nonce",
  });
  assert.deepEqual(JSON.parse(second.provider_settings_json).outbound, settings.outbound);
  db.exec(
    "UPDATE mail_domains SET provider_settings_json=json_set(provider_settings_json,'$.outbound.config.region','eu-west-1') WHERE id='first'",
  );
  assert.equal(
    JSON.parse(
      db.prepare("SELECT provider_settings_json FROM mail_domains WHERE id='second'").get()
        .provider_settings_json,
    ).outbound.config.region,
    "us-east-1",
  );
  const disabled = db
    .prepare("SELECT inbound_enabled,outbound_enabled FROM mail_domains WHERE id='third'")
    .get();
  assert.equal(disabled.inbound_enabled, 0);
  assert.equal(disabled.outbound_enabled, 0);
  assert.equal(
    db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='mail_provider_connections'").get()
      .n,
    0,
  );
  const columns = db
    .prepare("PRAGMA table_info(mail_domains)")
    .all()
    .map((entry) => entry.name);
  assert.ok(!columns.includes("inbound_connection_id"));
  assert.ok(!columns.includes("outbound_connection_id"));
  assert.equal(
    db.prepare("SELECT domain_id FROM mail_addresses WHERE id='address'").get().domain_id,
    "first",
  );
  assert.equal(
    db.prepare("SELECT domain_id FROM mail_routing_rules WHERE id='rule'").get().domain_id,
    "first",
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
