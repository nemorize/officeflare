import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { applicationHostname } from "../shared/application-host.ts";
import { deploymentHostnames, deployAndRememberHosts } from "../scripts/deployment-hosts.mjs";

const built = await build({
  entryPoints: ["src/mail/application-hosts.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { rememberMailApplicationHost, mailApplicationHosts } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64")
);
function site() {
  const hosts = new Set();
  let reads = 0,
    writes = 0;
  const env = {
    MAIL_BUCKET: {},
    DB: {
      withSession() {
        return {
          prepare() {
            return {
              bind(hostname) {
                return {
                  async run() {
                    hosts.add(hostname);
                    writes++;
                  },
                };
              },
              async all() {
                reads++;
                return { results: [...hosts].sort().map((hostname) => ({ hostname })) };
              },
            };
          },
        };
      },
    },
  };
  return { env, hosts, counts: () => ({ reads, writes }) };
}

test("actual application URLs and route targets normalize without accepting credentials or non-HTTP targets", () => {
  assert.equal(applicationHostname("https://OFFICE.EXAMPLE.org.:443/mail"), "office.example.org");
  assert.equal(applicationHostname("office.example.org/api/*"), "office.example.org");
  assert.equal(applicationHostname("http://localhost:8787/mail"), "localhost");
  for (const value of [
    undefined,
    "",
    "cron: */5 * * * *",
    "*.example.org/*",
    "https://user:secret@example.org",
    "ftp://example.org/file",
  ])
    assert.equal(applicationHostname(value), null);
});

test("background rendering reuses deployed hosts and learns authenticated domain changes without sharing site state", async () => {
  const first = site(),
    second = site();
  first.hosts.add("app.account.workers.dev");
  assert.deepEqual(await mailApplicationHosts(first.env), ["app.account.workers.dev"]);
  await rememberMailApplicationHost(first.env, "https://office.example.org/mail");
  await rememberMailApplicationHost(first.env, "https://office.example.org/another");
  assert.deepEqual(await mailApplicationHosts(first.env), [
    "app.account.workers.dev",
    "office.example.org",
  ]);
  await mailApplicationHosts(first.env);
  assert.deepEqual(first.counts(), { reads: 2, writes: 1 });
  assert.deepEqual(await mailApplicationHosts(second.env), []);
  await rememberMailApplicationHost(second.env, "https://office.example.org/mail");
  assert.deepEqual(await mailApplicationHosts(second.env), ["office.example.org"]);
  assert.deepEqual(second.counts(), { reads: 2, writes: 1 });
});

test("deployment hosts come from the latest published deployment and configured routes, including workers.dev aliases", () => {
  const output = [
    { type: "deploy", targets: ["https://old.example.org"] },
    { type: "version-upload", preview_url: "https://preview.example.org" },
    {
      type: "deploy",
      targets: [
        "https://app.account.workers.dev",
        "https://OFFICE.EXAMPLE.org",
        "cron: */5 * * * *",
      ],
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  assert.deepEqual(
    deploymentHostnames(
      {
        routes: [
          { pattern: "office.example.org", custom_domain: true },
          "another.example.org/mail/*",
          "*.wildcard.example.org/*",
        ],
      },
      output,
    ),
    ["another.example.org", "app.account.workers.dev", "office.example.org"],
  );
});

test("deployment records hosts in D1, cleans private output files, and preserves output owned by Workers Builds", async (t) => {
  const external = await mkdtemp(join(tmpdir(), "officeflare-worker-build-output-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  for (const environment of [
    {},
    { WRANGLER_OUTPUT_FILE_PATH: join(external, "build.jsonl") },
    { WRANGLER_OUTPUT_FILE_DIRECTORY: external },
  ]) {
    const calls = [];
    let path;
    const flags = ["--config", "/test/deployment.jsonc", "--env", "production"];
    const hosts = await deployAndRememberHosts(
      {},
      ["deploy", ...flags],
      flags,
      async (args, options) => {
        calls.push(args);
        if (args[0] === "deploy") {
          path = options.env.WRANGLER_OUTPUT_FILE_PATH;
          await appendFile(
            path,
            JSON.stringify({
              type: "deploy",
              targets: ["https://app.account.workers.dev", "https://office.example.org"],
            }) + "\n",
          );
        } else {
          assert.deepEqual(args.slice(0, 6), [
            "d1",
            "execute",
            "DB",
            "--remote",
            "--json",
            "--command",
          ]);
          assert.deepEqual(args.slice(-flags.length), flags);
          assert.ok(args[6].includes('"app.account.workers.dev"'));
          assert.ok(args[6].includes('"office.example.org"'));
        }
      },
      environment,
    );
    assert.deepEqual(hosts, ["app.account.workers.dev", "office.example.org"]);
    assert.equal(calls.length, 2);
    if (Object.keys(environment).length)
      assert.ok((await readFile(path, "utf8")).includes('"type":"deploy"'));
    else await assert.rejects(stat(dirname(path)), { code: "ENOENT" });
  }
  let failedOutput,
    operations = 0;
  await assert.rejects(
    deployAndRememberHosts(
      {},
      ["deploy"],
      [],
      async (_args, options) => {
        operations++;
        failedOutput = options.env.WRANGLER_OUTPUT_FILE_PATH;
        throw new Error("test deployment failure");
      },
      {},
    ),
    /test deployment failure/,
  );
  assert.equal(operations, 1);
  await assert.rejects(stat(dirname(failedOutput)), { code: "ENOENT" });
});
