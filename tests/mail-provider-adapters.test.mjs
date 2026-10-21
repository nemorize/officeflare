import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundleDir = await mkdtemp(join(tmpdir(), "officeflare-mail-provider-tests-"));
await build({
  entryPoints: { providers: "src/mail/providers.ts", secrets: "src/mail/secrets.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: bundleDir,
  outExtension: { ".js": ".mjs" },
  external: ["cloudflare:sockets"],
});
const { providers, provider, parseProviderConfig, publicProvider } = await import(pathToFileURL(join(bundleDir, "providers.mjs")).href);
const { seal } = await import(pathToFileURL(join(bundleDir, "secrets.mjs")).href);
after(async () => rm(bundleDir, { recursive: true, force: true }));

const env = {
  MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  MAIL_BUCKET: {
    async get(key) {
      assert.equal(key, "attachments/invoice");
      return new Response("pdf-bytes");
    },
  },
};
const snapshot = (overrides = {}) => ({
  from: "sender@example.test",
  to: ["recipient@example.test"],
  cc: [],
  bcc: [],
  subject: "A test message",
  text: "Hello",
  html: "<p>Hello</p>",
  headers: {},
  attachments: [],
  ...overrides,
});
async function connection(id, config, credentials) {
  const encrypted = await seal(env, JSON.stringify(credentials));
  return { id, provider: id, name: id, enabled: 1, version: 1, config_json: JSON.stringify(config), secret_ciphertext: encrypted.ciphertext, secret_nonce: encrypted.nonce };
}
function mockFetch(t, implementation) {
  const previous = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = previous; });
}

test("provider registry includes the direct HTTP, SMTP, JMAP, Cloudflare REST, and SENS adapters", () => {
  const ids = new Set(providers.map((entry) => entry.id));
  for (const id of ["cloudflare", "cloudflare-rest", "ncloud-sens", "smtp", "jmap", "resend", "postmark", "sendgrid", "ses", "mailgun", "mailersend", "brevo", "mailtrap", "maileroo", "lettermint", "mailpace", "zeptomail", "mailchannels", "plunk", "loops", "mailchimp-transactional", "sparkpost", "iterable", "microsoft-graph", "scaleway", "unosend", "sequenzy", "jetemail", "primitive", "lettr", "sendheron", "helo"])
    assert.ok(ids.has(id), `missing ${id}`);
  assert.throws(() => parseProviderConfig({ host: "smtp.example.test", port: "587", security: "plain" }, provider("smtp")), /Invalid Connection security/);
  assert.equal(publicProvider(provider("smtp")).secret_fields.some((item) => item.key === "password"), true);
});

test("Resend receives the normalized message and a stable provider idempotency key", async (t) => {
  const c = await connection("resend", {}, { apiKey: "resend-secret" });
  let request;
  mockFetch(t, async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return Response.json({ id: "resend-message" });
  });
  const result = await provider("resend").send(env, snapshot(), c, "submission-123");
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.headers.get("authorization"), "Bearer resend-secret");
  assert.equal(request.headers.get("idempotency-key"), "submission-123");
  assert.equal(request.body.to[0], "recipient@example.test");
  assert.deepEqual(result, { provider_message_id: "resend-message" });
});

test("Cloudflare binding and REST adapters submit normalized messages", async (t) => {
  let bindingMessage;
  const boundEnv = { ...env, EMAIL: { async send(message) { bindingMessage = message; return { messageId: "cloudflare-binding-message" }; } } };
  const bindingResult = await provider("cloudflare").send(boundEnv, snapshot({ reply_to: "reply@example.test" }));
  assert.deepEqual(bindingResult, { provider_message_id: "cloudflare-binding-message" });
  assert.equal(bindingMessage.from, "sender@example.test");
  assert.deepEqual(bindingMessage.to, ["recipient@example.test"]);
  assert.equal(bindingMessage.replyTo, "reply@example.test");

  const c = await connection("cloudflare-rest", { accountId: "account-123" }, { apiToken: "cloudflare-secret" });
  let request;
  mockFetch(t, async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return Response.json({ success: true, result: { message_id: "cloudflare-rest-message" } });
  });
  const restResult = await provider("cloudflare-rest").send(env, snapshot(), c, "cloudflare-submission");
  assert.equal(request.url, "https://api.cloudflare.com/client/v4/accounts/account-123/email/sending/send");
  assert.equal(request.headers.get("authorization"), "Bearer cloudflare-secret");
  assert.deepEqual(request.body.to, ["recipient@example.test"]);
  assert.deepEqual(restResult, { provider_message_id: "cloudflare-rest-message" });
});

test("Brevo, Mailtrap, Lettermint, and Unosend adapters accept free-plan API responses", async (t) => {
  const cases = [
    { id: "brevo", config: {}, credentials: { apiKey: "brevo-secret" }, url: "https://api.brevo.com/v3/smtp/email", header: ["api-key", "brevo-secret"], response: { messageId: "brevo-message" } },
    { id: "mailtrap", config: {}, credentials: { apiToken: "mailtrap-secret" }, url: "https://send.api.mailtrap.io/api/send", header: ["authorization", "Bearer mailtrap-secret"], response: { success: true, message_ids: ["mailtrap-message"] } },
    { id: "lettermint", config: {}, credentials: { apiToken: "lettermint-secret" }, url: "https://api.lettermint.co/v1/send", header: ["x-lettermint-token", "lettermint-secret"], response: { id: "lettermint-message" } },
    { id: "unosend", config: {}, credentials: { apiKey: "unosend-secret" }, url: "https://www.unosend.co/api/v1/emails", header: ["authorization", "Bearer unosend-secret"], response: { id: "unosend-message" } },
  ];
  for (const item of cases) await t.test(item.id, async (t) => {
    const c = await connection(item.id, item.config, item.credentials);
    let request;
    mockFetch(t, async (url, init) => {
      request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return Response.json(item.response);
    });
    const result = await provider(item.id).send(env, snapshot(), c, `${item.id}-submission`);
    assert.equal(request.url, item.url);
    assert.equal(request.headers.get(item.header[0]), item.header[1]);
    assert.equal(result.provider_message_id, item.response.id ?? item.response.messageId ?? item.response.message_ids[0]);
    assert.ok(request.body.subject);
    assert.ok(request.body.to);
  });
});

test("Maileroo receives documented address and attachment fields with a stable reference", async (t) => {
  const c = await connection("maileroo", {}, { apiKey: "maileroo-secret" });
  let request;
  mockFetch(t, async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return Response.json({ data: { reference_id: "maileroo-reference" } });
  });
  const result = await provider("maileroo").send(env, snapshot({
    reply_to: "reply@example.test",
    attachments: [{ id: "file", filename: "invoice.pdf", content_type: "application/pdf", size_bytes: 9, content_id: null, r2_key: "attachments/invoice", disposition: "attachment" }],
  }), c, "maileroo-submission");
  assert.equal(request.url, "https://smtp.maileroo.com/api/v2/emails");
  assert.equal(request.headers.get("authorization"), "Bearer maileroo-secret");
  assert.deepEqual(request.body.from, { address: "sender@example.test" });
  assert.deepEqual(request.body.to, [{ address: "recipient@example.test" }]);
  assert.deepEqual(request.body.reply_to, [{ address: "reply@example.test" }]);
  assert.equal(request.body.attachments[0].file_name, "invoice.pdf");
  assert.equal(request.body.attachments[0].inline, false);
  assert.match(request.body.reference_id, /^[0-9a-f]{24}$/);
  assert.deepEqual(result, { provider_message_id: "maileroo-reference" });
});

test("SparkPost models CC and BCC as envelope recipients and reuses its idempotency key", async (t) => {
  const c = await connection("sparkpost", { region: "eu" }, { apiKey: "sparkpost-secret" });
  let request;
  mockFetch(t, async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return Response.json({ results: { id: "sparkpost-transmission" } });
  });
  const result = await provider("sparkpost").send(env, snapshot({ to: ["to@example.test"], cc: ["cc@example.test"], bcc: ["bcc@example.test"] }), c, "sparkpost-submission");
  assert.equal(request.url, "https://api.eu.sparkpost.com/api/v1/transmissions");
  assert.equal(request.headers.get("idempotency-key"), "sparkpost-submission");
  assert.deepEqual(request.body.recipients.map((item) => item.address), [
    { email: "to@example.test" },
    { email: "cc@example.test", header_to: "to@example.test" },
    { email: "bcc@example.test", header_to: "to@example.test" },
  ]);
  assert.equal(request.body.content.headers.CC, "cc@example.test");
  assert.equal("BCC" in request.body.content.headers, false);
  assert.deepEqual(result, { provider_message_id: "sparkpost-transmission" });
});

test("Lettr uses native idempotency and documented attachment fields", async (t) => {
  const c = await connection("lettr", {}, { apiKey: "lettr-secret" });
  let request;
  mockFetch(t, async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return Response.json({ data: { request_id: "lettr-request" } });
  });
  const result = await provider("lettr").send(env, snapshot({
    attachments: [{ id: "file", filename: "invoice.pdf", content_type: "application/pdf", size_bytes: 9, content_id: null, r2_key: "attachments/invoice", disposition: "attachment" }],
  }), c, "lettr-submission");
  assert.equal(request.url, "https://app.lettr.com/api/emails");
  assert.equal(request.headers.get("idempotency-key"), "lettr-submission");
  assert.deepEqual(request.body.attachments[0], { name: "invoice.pdf", type: "application/pdf", data: "cGRmLWJ5dGVz" });
  assert.deepEqual(result, { provider_message_id: "lettr-request" });
});

test("ZeptoMail accepts only its official HTTPS send endpoints", async (t) => {
  const c = await connection("zeptomail", { sendUrl: "https://api.zeptomail.eu/v1.1/email" }, { sendToken: "zeptomail-secret" });
  let request;
  mockFetch(t, async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return Response.json({ message_id: "zeptomail-message" });
  });
  const result = await provider("zeptomail").send(env, snapshot(), c, "zeptomail-submission");
  assert.equal(request.url, "https://api.zeptomail.eu/v1.1/email");
  assert.equal(request.headers.get("authorization"), "Zoho-enczapikey zeptomail-secret");
  assert.deepEqual(result, { provider_message_id: "zeptomail-message" });
  const invalid = await connection("zeptomail", { sendUrl: "https://attacker.example/v1.1/email" }, { sendToken: "zeptomail-secret" });
  await assert.rejects(provider("zeptomail").send(env, snapshot(), invalid), (error) => error.code === "provider_configuration_missing");
});

test("SENS signs the exact request path and supports CC/BCC in shared-recipient requests", async (t) => {
  const serviceId = "ncp:mail:kr:123456:main";
  const c = await connection("ncloud-sens", { serviceId }, { accessKey: "access-key", secretKey: "secret-key" });
  const requests = [];
  mockFetch(t, async (url, init) => {
    const request = { url: String(url), headers: new Headers(init.headers), body: init.body };
    requests.push(request);
    if (request.url === "https://mail.apigw.ntruss.com/api/v1/files") {
      assert.ok(request.body instanceof FormData);
      const upload = request.body.get("fileList");
      assert.equal(upload.name, "invoice.pdf");
      assert.equal(await upload.text(), "pdf-bytes");
      return Response.json({ files: [{ fileName: "invoice.pdf", fileId: "sens-file" }] });
    }
    request.body = JSON.parse(request.body);
    return Response.json({ requestId: "sens-request" }, { status: 202 });
  });
  await provider("ncloud-sens").send(env, snapshot({ to: ["one@example.test", "two@example.test"] }), c, "submission-456");
  const result = await provider("ncloud-sens").send(env, snapshot({
    to: ["one@example.test", "two@example.test"],
    cc: ["copy@example.test"],
    bcc: ["hidden@example.test"],
    attachments: [{ id: "file", filename: "invoice.pdf", content_type: "application/pdf", size_bytes: 9, content_id: null, r2_key: "attachments/invoice", disposition: "attachment" }],
  }), c, "submission-789");
  const uploadRequest = requests[1], request = requests[2];
  assert.equal(request.url, `https://sens.apigw.ntruss.com/mail/v2/services/${serviceId}/requests`);
  assert.equal(requests[0].body.individual, true);
  assert.equal(request.body.individual, false);
  assert.deepEqual(request.body.attachFileIds, ["sens-file"]);
  assert.deepEqual(request.body.recipients, [
    { address: "one@example.test", type: "TO" },
    { address: "two@example.test", type: "TO" },
    { address: "copy@example.test", type: "CC" },
    { address: "hidden@example.test", type: "BCC" },
  ]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  for (const [signedRequest, path] of [[uploadRequest, "/api/v1/files"], [request, `/mail/v2/services/${serviceId}/requests`]]) {
    const timestamp = signedRequest.headers.get("x-ncp-apigw-timestamp");
    const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`POST\n${path}\n${timestamp}\naccess-key`)));
    assert.equal(signedRequest.headers.get("x-ncp-apigw-signature-v2"), Buffer.from(signed).toString("base64"));
  }
  assert.deepEqual(result, { provider_message_id: "sens-request" });
});

test("JMAP uploads attachments and creates an email submission through its advertised session", async (t) => {
  const c = await connection("jmap", { sessionUrl: "https://jmap.example.test/.well-known/jmap" }, { accessToken: "jmap-secret" });
  const calls = [];
  mockFetch(t, async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith("/.well-known/jmap")) return Response.json({ apiUrl: "https://jmap.example.test/api", uploadUrl: "https://jmap.example.test/upload/{accountId}", primaryAccounts: { "urn:ietf:params:jmap:mail": "account-1" } });
    if (target.endsWith("/upload/account-1")) {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["content-type"], "application/pdf");
      return Response.json({ blobId: "blob-1", size: 9 });
    }
    const call = JSON.parse(init.body).methodCalls[0];
    if (call[0] === "Mailbox/get") return Response.json({ methodResponses: [["Mailbox/get", { list: [{ id: "outbox-1", role: "outbox" }] }, "mailboxes"]] });
    if (call[0] === "Email/set") {
      const message = call[1].create.message;
      assert.equal(message.mailboxIds["outbox-1"], true);
      assert.equal(message.attachments[0].blobId, "blob-1");
      assert.equal(message.bodyValues.html.value, "<p>Hello</p>");
      return Response.json({ methodResponses: [["Email/set", { created: { message: { id: "email-1" } } }, "email"]] });
    }
    assert.equal(call[0], "EmailSubmission/set");
    assert.equal(call[1].create.submission.emailId, "email-1");
    return Response.json({ methodResponses: [["EmailSubmission/set", { created: { submission: { id: "submission-1" } } }, "submission"]] });
  });
  const result = await provider("jmap").send(env, snapshot({ attachments: [{ id: "file", filename: "invoice.pdf", content_type: "application/pdf", size_bytes: 9, content_id: null, r2_key: "attachments/invoice", disposition: "attachment" }] }), c, "job-1");
  assert.deepEqual(result, { provider_message_id: "submission-1" });
  assert.deepEqual(calls, ["https://jmap.example.test/.well-known/jmap", "https://jmap.example.test/api", "https://jmap.example.test/upload/account-1", "https://jmap.example.test/api", "https://jmap.example.test/api"]);
});

test("mail provider secret migration adds encrypted secret and public config columns", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);");
  db.exec(readFileSync("migrations/0009_create_mail_control.sql", "utf8"));
  db.exec(readFileSync("migrations/0021_mail_provider_connection_secrets.sql", "utf8"));
  const columns = db.prepare("PRAGMA table_info(mail_provider_connections)").all().map((row) => row.name);
  assert.ok(columns.includes("config_json"));
  assert.ok(columns.includes("secret_ciphertext"));
  assert.ok(columns.includes("secret_nonce"));
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
