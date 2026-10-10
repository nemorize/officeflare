import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_readConfig as readConfig } from "wrangler";
import { deploy, deploymentOptions, ensureDatabase, ensureMailResources, ensureProfileResources, ensureQueueResources, withDatabaseConfig } from "../scripts/deploy.mjs";

const database = { name: "officeflare-user-accounts", uuid: "00000000-0000-0000-0000-000000000001" };
const config = { configPath: "/test/wrangler.jsonc", name: "officeflare", d1_databases: [{ binding: "DB", database_name: database.name }] };
const flags = ["--config", config.configPath, "--env", "production"];
const boundFlags = ["--config", "/test/.officeflare-deploy.jsonc", "--env", "production"];

test("shared Queue provisioning prepares notification work and dead-letter queues once", async () => {
  const names = [];
  await ensureQueueResources({ queues: {
    producers: [{ binding: "NOTIFICATION_QUEUE", queue: "notifications" }, { binding: "MAIL_QUEUE", queue: "mail" }],
    consumers: [{ queue: "notifications", dead_letter_queue: "notifications-dlq" }, { queue: "mail", dead_letter_queue: "mail-dlq" }],
  } }, [], async (args) => { assert.equal(args[1], "info"); names.push(args[2]); return `Queue Name: ${args[2]}\nQueue ID: 0123abcd\n`; });
  assert.deepEqual(names, ["notifications", "mail", "notifications-dlq", "mail-dlq"]);
});

test("profile image storage is provisioned and an existing bucket is reused", async () => {
  const selected = { r2_buckets: [{ binding: "MAIL_BUCKET", bucket_name: "mail" }, { binding: "PROFILE_BUCKET", bucket_name: "profiles" }] };
  let existing = false; const commands = [];
  const wrangler = async (args) => {
    commands.push(args[2]); assert.equal(args[3], "profiles");
    if (args[2] === "create") { existing = true; return "created"; }
    if (!existing) throw new Error("The specified bucket does not exist.");
    return JSON.stringify({ name: "profiles" });
  };
  await ensureProfileResources(selected, [], wrangler);
  assert.deepEqual(commands, ["info", "create", "info"]);
  commands.length = 0; await ensureProfileResources(selected, [], wrangler);
  assert.deepEqual(commands, ["info"]);
});

test("mail provisioning confirms the R2 bucket and both work and dead-letter queues", async () => {
  const selected = {r2_buckets:[{binding:"MAIL_BUCKET",bucket_name:"mail"}],queues:{
    producers:[{binding:"MAIL_QUEUE",queue:"mail-work"}],consumers:[{queue:"mail-work",dead_letter_queue:"mail-dlq"}],
  }};
  const calls=[],existing=new Set();
  const wrangler=async(args,options)=>{
    assert.equal(options.capture,true); assert.deepEqual(args.slice(-flags.length),flags);calls.push(args.slice(0,-flags.length));
    const r2=args[0]==="r2",command=r2?args[2]:args[1],name=r2?args[3]:args[2];
    if(command==="create"){existing.add(name);return "created";}
    if(!existing.has(name))throw new Error(r2?"The specified bucket does not exist.":`Queue "${name}" does not exist.`);
    return r2?JSON.stringify({name}):`Queue Name: ${name}\nQueue ID: 0123abcd\n`;
  };
  await ensureMailResources(selected,flags,wrangler);
  assert.deepEqual([...existing],["mail","mail-work","mail-dlq"]);
  calls.length=0;await ensureMailResources(selected,flags,wrangler);
  assert.equal(calls.length,3);assert.ok(calls.every((args)=>!args.includes("create")));
});

test("mail provisioning stops on permission errors or an unconfirmed resource identity",async()=>{
  const selected={r2_buckets:[{binding:"MAIL_BUCKET",bucket_name:"mail"}]};
  let calls=0;
  await assert.rejects(ensureMailResources(selected,[],async()=>{calls++;throw new Error("Authentication failed");}),/Authentication failed/);
  assert.equal(calls,1);
  await assert.rejects(ensureMailResources(selected,[],async()=>JSON.stringify({name:"other"})),/identity could not be confirmed/);
});

test("mail provisioning reconciles a concurrent creation using a fresh identity check",async()=>{
  let inspections=0;
  await ensureMailResources({queues:{producers:[{binding:"MAIL_QUEUE",queue:"work"}]}},[],async(args)=>{
    if(args[1]==="create")throw new Error("Already exists");
    if(++inspections===1)throw new Error('Queue "work" does not exist.');
    return "Queue Name: work\nQueue ID: 0123abcd\n";
  });
  assert.equal(inspections,2);
});

function recorder(failAt) {
  const calls = [];
  let created = false;
  const record = (stage) => {
    calls.push(stage);
    if (stage === failAt) throw new Error(`Failed ${stage}`);
  };
  return { calls, dependencies: {
    loadConfig: (options) => { assert.equal(options.env, "production"); return config; },
    typecheck: async () => record("typecheck"),
    buildWeb: async () => record("web-build"),
    log: () => {},
    bindDatabase: async (_config, options, selected, action) => {
      assert.equal(options.env, "production"); assert.equal(selected.uuid, database.uuid);
      record("bind"); return action(boundFlags[1]);
    },
    bootstrap: async (options) => { assert.deepEqual(options.flags, boundFlags); record("bootstrap"); },
    wrangler: async (args, options) => {
      const stage = args[0] === "types" ? "types" : args[0] === "deploy" ?
        (args.includes("--dry-run") ? "build" : "deploy") : args[1] === "migrations" ? "migrations" : args[1];
      assert.deepEqual(args.slice(-flags.length), ["migrations", "deploy"].includes(stage) ? boundFlags : flags);
      record(stage);
      if (stage === "list") { assert.equal(options.capture, true); return JSON.stringify(created ? [database] : []); }
      if (stage === "create") { assert.ok(args.includes("--no-update-config")); created = true; }
    },
  } };
}

test("deployment prepares D1, migrates and initializes before publishing the Worker", async () => {
  const { calls, dependencies } = recorder();
  await deploy({ env: "production" }, dependencies);
  assert.deepEqual(calls, ["types", "typecheck", "web-build", "build", "list", "create", "list", "bind", "migrations", "bootstrap", "deploy"]);
});

test("first-deployment secrets are passed to Wrangler builds and uploads only", async () => {
  const { dependencies } = recorder();
  const wrangler = dependencies.wrangler;
  let deployments = 0;
  dependencies.wrangler = async (args, options) => {
    assert.equal(args.includes("--secrets-file"), args[0] === "deploy");
    if (args[0] === "deploy") { deployments++; assert.equal(args[args.indexOf("--secrets-file") + 1], "/test/deployment.secrets"); }
    return wrangler(args, options);
  };
  await deploy({ env: "production", "secrets-file": "/test/deployment.secrets" }, dependencies);
  assert.equal(deployments, 2);
});

test("every failed deployment stage prevents later stages", async (t) => {
  const sequence = ["types", "typecheck", "web-build", "build", "list", "create", "bind", "migrations", "bootstrap", "deploy"];
  for (const stage of sequence) {
    await t.test(stage, async () => {
      const { calls, dependencies } = recorder(stage);
      await assert.rejects(deploy({ env: "production" }, dependencies), new RegExp(`Failed ${stage}`));
      assert.equal(calls.at(-1), stage);
      if (stage !== "deploy") assert.equal(calls.includes("deploy"), false);
    });
  }
});

test("existing and Deploy to Cloudflare databases are reused without altering config", async () => {
  for (const binding of [config.d1_databases[0], { binding: "DB", database_id: database.uuid, database_name: "clone-name" }]) {
    const selected = { ...config, d1_databases: [binding] }, before = structuredClone(selected);
    let calls = 0;
    const found = await ensureDatabase(selected, [], async (args) => {
      calls++; assert.deepEqual(args, ["d1", "list", "--json"]); return JSON.stringify([database]);
    });
    assert.equal(found.uuid, database.uuid); assert.equal(calls, 1);
    assert.deepEqual(selected, before);
  }
  await assert.rejects(ensureDatabase({ ...config, d1_databases: [{ binding: "DB", database_id: "missing", database_name: database.name }] }, [],
    async (args) => { assert.equal(args[1], "list"); return JSON.stringify([database]); }), /database_id was not found/);
});

test("D1 provisioning handles a creation race and propagates other errors", async () => {
  let lists = 0;
  const found = await ensureDatabase(config, [], async (args) => {
    if (args[1] === "list") return JSON.stringify(++lists === 1 ? [] : [database]);
    throw Object.assign(new Error("creation race"), { stderr: "A database with that name already exists" });
  });
  assert.equal(found.uuid, database.uuid);
  for (const failure of ["list", "create"]) {
    const calls = [];
    await assert.rejects(ensureDatabase(config, [], async (args) => {
      calls.push(args[1]);
      if (args[1] === failure) throw new Error("Authentication failed");
      return "[]";
    }), /Authentication failed/);
    assert.deepEqual(calls, failure === "list" ? ["list"] : ["list", "create"]);
  }
});

test("a binding without a database name uses Wrangler's automatic resource name", async () => {
  const selected = { ...config, name: "clone-worker", d1_databases: [{ binding: "DB" }] };
  let created = false;
  await ensureDatabase(selected, [], async (args) => {
    if (args[1] === "create") { assert.equal(args[2], "clone-worker-db"); created = true; }
    return JSON.stringify(created ? [{ name: "clone-worker-db", uuid: database.uuid }] : []);
  });
  assert.equal(created, true);
});

test("deployment options accept only explicit Wrangler configuration and environment", () => {
  assert.deepEqual(deploymentOptions([]), {});
  assert.deepEqual(deploymentOptions(["--config", "wrangler.jsonc", "--env", "production"]), { config: "wrangler.jsonc", env: "production" });
  assert.deepEqual(deploymentOptions(["--secrets-file", "deployment.secrets"]), { "secrets-file": "deployment.secrets" });
  for (const args of [["--local"], ["--env"], ["--env", "--config"], ["--env", "a", "--env", "b"]]) {
    assert.throws(() => deploymentOptions(args), /Usage/);
  }
});

test("temporary config pins the DB, preserves relative paths and is cleaned up on success or failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "officeflare-deploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "wrangler.jsonc");
  const source = JSON.stringify({ name: "officeflare", main: "src/index.ts", compatibility_date: "2026-09-29",
    d1_databases: [config.d1_databases[0]], env: { production: { d1_databases: [config.d1_databases[0]] } },
  });
  await writeFile(path, source);
  for (const env of [undefined, "production"]) {
    const original = readConfig({ config: path, env }, { hideWarnings: true });
    for (const fails of [false, true]) {
      let temporary;
      const action = withDatabaseConfig(original, { env }, database, async (snapshot) => {
        temporary = snapshot;
        const pinned = readConfig({ config: snapshot, env }, { hideWarnings: true });
        assert.equal(pinned.main, original.main);
        assert.equal(pinned.name, original.name);
        assert.equal(pinned.d1_databases[0].database_id, database.uuid);
        assert.equal(pinned.d1_databases[0].database_name, database.name);
        assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
        if (fails) throw new Error("Deployment failed");
      });
      if (fails) await assert.rejects(action, /Deployment failed/); else await action;
      await assert.rejects(stat(temporary), { code: "ENOENT" });
      assert.equal(await readFile(path, "utf8"), source);
    }
  }
});
