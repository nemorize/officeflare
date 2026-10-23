import { fail, type Connection, type SubmissionSnapshot } from "./types";
import { unseal } from "./secrets";

export interface ProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
  options?: string[];
}
export interface MailProvider {
  id: string;
  label: string;
  capabilities: {
    receive: boolean;
    send: boolean;
    max_send_bytes: number;
    max_recipients: number;
  };
  config_fields: ProviderField[];
  secret_fields: ProviderField[];
  send(
    env: Env,
    snapshot: SubmissionSnapshot,
    connection?: Connection,
    submissionId?: string,
  ): Promise<{ provider_message_id: string }>;
}
type AttachmentData = {
  filename: string;
  content_type: string;
  content: string;
  disposition: "inline" | "attachment";
  content_id?: string;
};
type ProviderConfig = Record<string, string>;
type ProviderSecret = Record<string, string>;
type SendResult = { provider_message_id: string };

const field = (key: string, label = key, help?: string): ProviderField => ({ key, label, required: true, help });
const secret = (key: string, label = key, help?: string): ProviderField => ({ key, label, required: true, secret: true, help });
const optionalField = (key: string, label = key, help?: string): ProviderField => ({ key, label, help });
const standard = (id: string, label: string, secretFields: ProviderField[], options: {
  config?: ProviderField[]; maxBytes?: number; maxRecipients?: number; receive?: boolean;
} = {}): MailProvider => ({
  id,
  label,
  capabilities: {
    receive: !!options.receive,
    send: true,
    max_send_bytes: options.maxBytes ?? 5 * 1024 * 1024,
    max_recipients: options.maxRecipients ?? 50,
  },
  config_fields: options.config ?? [],
  secret_fields: secretFields,
  send: (env, snapshot, connection, submissionId) => sendWithProvider(env, id, snapshot, connection, submissionId),
});

// Provider adapters use fetch and Web Crypto directly. No vendor SDKs are
// loaded into the Worker, and each adapter translates the shared snapshot into
// the provider's documented wire format.
const cloudflare: MailProvider = {
  id: "cloudflare",
  label: "Cloudflare Email Service (Worker binding)",
  capabilities: { receive: true, send: true, max_send_bytes: 5 * 1024 * 1024, max_recipients: 50 },
  config_fields: [], secret_fields: [],
  async send(env, snapshot) {
    if (!env.EMAIL) throw providerError("provider_configuration_missing");
    const attachments = await loadAttachments(env, snapshot);
    const result = await env.EMAIL.send({
      from: snapshot.from,
      to: snapshot.to,
      cc: snapshot.cc,
      bcc: snapshot.bcc,
      subject: snapshot.subject,
      text: snapshot.text,
      html: snapshot.html,
      replyTo: snapshot.reply_to,
      headers: snapshot.headers,
      attachments: attachments.map((file) => {
        const attachment = { filename: file.filename, type: file.content_type, content: file.content };
        return file.disposition === "inline" && file.content_id
          ? { ...attachment, disposition: "inline" as const, contentId: file.content_id }
          : { ...attachment, disposition: "attachment" as const };
      }),
    });
    if (!result?.messageId) throw providerError("missing_provider_receipt");
    return { provider_message_id: result.messageId };
  },
};

export const providers: MailProvider[] = [
  cloudflare,
  standard("cloudflare-rest", "Cloudflare Email Sending (REST)", [secret("apiToken", "API token")], { config: [field("accountId", "Account ID")], maxBytes: 5 * 1024 * 1024 }),
  standard("resend", "Resend", [secret("apiKey", "API key")], { maxBytes: 40 * 1024 * 1024, maxRecipients: 50 }),
  standard("postmark", "Postmark", [secret("serverToken", "Server token")], { config: [{ key: "messageStream", label: "Message stream" }], maxBytes: 10 * 1024 * 1024 }),
  standard("sendgrid", "Twilio SendGrid", [secret("apiKey", "API key")], { maxBytes: 30 * 1024 * 1024, maxRecipients: 1000 }),
  standard("ses", "Amazon SES v2", [secret("accessKeyId", "Access key ID"), secret("secretAccessKey", "Secret access key"), { key: "sessionToken", label: "Session token", secret: true }], { config: [field("region", "AWS region"), { key: "configurationSet", label: "Configuration set" }], maxBytes: 40 * 1024 * 1024 }),
  standard("mailgun", "Mailgun", [secret("apiKey", "Private API key")], { config: [field("domain", "Sending domain"), { key: "region", label: "Region", help: "Use us (default) or eu." }], maxBytes: 25 * 1024 * 1024 }),
  standard("mailersend", "MailerSend", [secret("apiKey", "API token")], { maxBytes: 25 * 1024 * 1024 }),
  standard("brevo", "Brevo", [secret("apiKey", "API key")], { maxBytes: 25 * 1024 * 1024 }),
  standard("mailtrap", "Mailtrap Email API", [secret("apiToken", "API token")], { maxBytes: 25 * 1024 * 1024 }),
  standard("maileroo", "Maileroo", [secret("apiKey", "API key")], { maxBytes: 20 * 1024 * 1024 }),
  standard("lettermint", "Lettermint", [secret("apiToken", "API token")], { config: [{ key: "route", label: "Route" }], maxBytes: 25 * 1024 * 1024 }),
  standard("mailpace", "MailPace", [secret("serverToken", "Server token")], { maxBytes: 30 * 1024 * 1024 }),
  standard("zeptomail", "ZeptoMail", [secret("sendToken", "Send mail token")], { config: [field("sendUrl", "Send mail URL", "Use your regional endpoint, for example https://api.zeptomail.com/v1.1/email.")], maxBytes: 15 * 1024 * 1024 }),
  standard("mailchannels", "MailChannels Email API", [secret("apiKey", "API key")], { maxBytes: 25 * 1024 * 1024 }),
  standard("plunk", "Plunk", [secret("apiKey", "API key")], { maxBytes: 10 * 1024 * 1024 }),
  standard("mailchimp-transactional", "Mailchimp Transactional (Mandrill)", [secret("apiKey", "API key")], { maxBytes: 25 * 1024 * 1024 }),
  standard("sparkpost", "SparkPost", [secret("apiKey", "API key")], { config: [{ key: "region", label: "Region", help: "Use us (default) or eu." }], maxBytes: 20 * 1024 * 1024 }),
  standard("microsoft-graph", "Microsoft Graph", [secret("clientSecret", "Client secret")], { config: [field("tenantId", "Tenant ID"), field("clientId", "Application client ID"), field("mailbox", "Mailbox user ID or address")], maxBytes: 3 * 1024 * 1024 }),
  standard("scaleway", "Scaleway TEM", [secret("apiKey", "API key")], { config: [field("projectId", "Project ID"), { key: "region", label: "Region", help: "For example fr-par or nl-ams." }], maxBytes: 20 * 1024 * 1024 }),
  standard("unosend", "Unosend", [secret("apiKey", "API key")], { maxBytes: 25 * 1024 * 1024 }),
  standard("jetemail", "JetEmail", [secret("apiKey", "API key")], { config: [field("senderName", "Sender name", "JetEmail requires a display name for the sender.")], maxBytes: 40 * 1024 * 1024 }),
  standard("lettr", "Lettr", [secret("apiKey", "API key")], { maxBytes: 20 * 1024 * 1024, maxRecipients: 50 }),
  standard("sendheron", "SendHeron", [secret("apiKey", "API key")], { config: [optionalField("senderName", "Sender name")], maxBytes: 20 * 1024 * 1024 }),
  standard("helo", "Helo", [secret("apiKey", "API key")], { config: [optionalField("channelId", "Channel ID")], maxBytes: 20 * 1024 * 1024 }),
  standard("smtp", "SMTP", [secret("username", "Username"), secret("password", "Password")], { config: [field("host", "SMTP host"), field("port", "Port", "Use 465 for implicit TLS or 587 for STARTTLS."), { key: "security", label: "Connection security", required: true, options: ["tls", "starttls"] }], maxBytes: 25 * 1024 * 1024, maxRecipients: 50 }),
  standard("jmap", "JMAP", [secret("accessToken", "Access token")], { config: [field("sessionUrl", "JMAP session URL"), optionalField("accountId", "Account ID", "Leave blank to use the mail account advertised by the session.")], maxBytes: 25 * 1024 * 1024, maxRecipients: 50 }),
];

export function provider(name: string) {
  return providers.find((entry) => entry.id === name) ?? fail(422, "Unsupported provider: " + name);
}
export function publicProvider(entry: MailProvider) {
  return {
    provider: entry.id,
    label: entry.label,
    capabilities: entry.capabilities,
    config_fields: entry.config_fields,
    secret_fields: entry.secret_fields,
  };
}
export function parseProviderConfig(value: unknown, selected: MailProvider): ProviderConfig {
  const result: ProviderConfig = {};
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value)))
    fail(400, "Provider config must be an object");
  const source = (value ?? {}) as Record<string, unknown>;
  const allowed = new Set(selected.config_fields.map((item) => item.key));
  if (Object.keys(source).some((key) => !allowed.has(key))) fail(400, "Unsupported provider config field");
  for (const item of selected.config_fields) {
    const raw = source[item.key];
    if (raw === undefined || raw === "") {
      if (item.required) fail(400, `${item.label} is required`);
      continue;
    }
    if (typeof raw !== "string" || raw.length > 500 || /[\r\n\0]/.test(raw)) fail(400, `Invalid ${item.label}`);
    if (item.options && !item.options.includes(raw.trim())) fail(400, `Invalid ${item.label}`);
    result[item.key] = raw.trim();
  }
  return result;
}
function parseProviderSecretValues(value: unknown, selected: MailProvider, partial: boolean): ProviderSecret {
  const result: ProviderSecret = {};
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value)))
    fail(400, "Provider secrets must be an object");
  const source = (value ?? {}) as Record<string, unknown>;
  const allowed = new Set(selected.secret_fields.map((item) => item.key));
  if (Object.keys(source).some((key) => !allowed.has(key))) fail(400, "Unsupported provider secret field");
  for (const item of selected.secret_fields) {
    const raw = source[item.key];
    if (raw === undefined) {
      if (item.required && !partial) fail(400, `${item.label} is required`);
      continue;
    }
    if (typeof raw !== "string" || raw.length > 8192 || /[\r\n\0]/.test(raw)) fail(400, `Invalid ${item.label}`);
    const normalized = raw.trim();
    if (!normalized) {
      if (item.required && !partial) fail(400, `${item.label} is required`);
      continue;
    }
    result[item.key] = normalized;
  }
  return result;
}
export function parseProviderSecrets(value: unknown, selected: MailProvider): ProviderSecret {
  return parseProviderSecretValues(value, selected, false);
}
export function parseProviderSecretUpdates(value: unknown, selected: MailProvider): ProviderSecret {
  return parseProviderSecretValues(value, selected, true);
}

function providerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
const hex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
async function sha256Hex(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function hmac(keyValue: string | Uint8Array, value: string) {
  const keyBytes = typeof keyValue === "string" ? new TextEncoder().encode(keyValue) : keyValue;
  const key = await crypto.subtle.importKey("raw", keyBytes as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
async function hmacHex(key: Uint8Array, value: string) {
  return hex(await hmac(key, value));
}
async function loadAttachments(env: Env, snapshot: SubmissionSnapshot): Promise<AttachmentData[]> {
  const result: AttachmentData[] = [];
  for (const file of snapshot.attachments) {
    const object = await env.MAIL_BUCKET.get(file.r2_key);
    if (!object) throw providerError("LOCAL_ATTACHMENT_MISSING");
    result.push({
      filename: file.filename,
      content_type: file.content_type || "application/octet-stream",
      content: base64(new Uint8Array(await object.arrayBuffer())),
      disposition: file.disposition,
      ...(file.content_id ? { content_id: file.content_id } : {}),
    });
  }
  return result;
}
function recipients(snapshot: SubmissionSnapshot) {
  return [...snapshot.to, ...snapshot.cc, ...snapshot.bcc];
}
function headerArray(headers: Record<string, string>) {
  return Object.entries(headers).map(([Name, Value]) => ({ Name, Value }));
}
function messageId(value: unknown, submissionId?: string) {
  if (typeof value === "string" && value) return value;
  return `accepted:${submissionId ?? crypto.randomUUID()}`;
}
async function postJson(url: string, headers: Record<string, string>, body: unknown, submissionId?: string): Promise<{ body: Record<string, any>; headers: Headers }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
      // Workers supports manual/follow only; never forward provider credentials.
      redirect: "manual",
    });
  } catch {
    // A transport failure can happen after the remote provider has accepted the
    // message, so leave the queue's acceptance state unknown.
    throw providerError("acceptance_unknown");
  }
  const text = await response.text().catch(() => "");
  let parsed: Record<string, any> = {};
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, any>; } catch { parsed = {}; }
  }
  if (!response.ok) {
    if (response.status === 429) throw providerError("E_RATE_LIMIT_EXCEEDED");
    if (response.status >= 500) throw providerError("acceptance_unknown");
    throw providerError("E_PROVIDER_REJECTED");
  }
  return { body: parsed, headers: response.headers };
}
function configOf(connection?: Connection): ProviderConfig {
  try {
    const value = JSON.parse(connection?.config_json || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as ProviderConfig : {};
  } catch { return {}; }
}
async function secretsOf(env: Env, connection?: Connection): Promise<ProviderSecret> {
  if (!connection?.secret_ciphertext || !connection.secret_nonce) return {};
  try { return JSON.parse(await unseal(env, connection.secret_ciphertext, connection.secret_nonce)) as ProviderSecret; }
  catch { throw providerError("provider_configuration_missing"); }
}
function required(value: string | undefined, fieldName: string): string {
  if (!value) throw providerError("provider_configuration_missing");
  return value;
}
function textResponseId(body: Record<string, any>, headers: Headers, submissionId?: string): string {
  return messageId(
    body.id ?? body.messageId ?? body.message_id ?? body.MessageID ?? body.MessageId ??
      body.requestId ?? body.request_id ?? body.data?.id ?? body.data?.message_id ??
      body.result?.message_id ?? body.result?.requestId ?? body.message?.id ??
      body.results?.[0]?.id ?? body.results?.id ?? body.message_ids?.[0] ?? body.data?.emails?.[0]?.id ?? body.data?.request_id ?? body.data?.reference_id ?? body.data?.id ??
      headers.get("x-message-id") ?? headers.get("x-postmark-message-id"),
    submissionId,
  );
}
const toObject = (email: string) => ({ email });

async function sendWithProvider(env: Env, id: string, snapshot: SubmissionSnapshot, connection?: Connection, submissionId?: string): Promise<SendResult> {
  const config = configOf(connection), credentials = await secretsOf(env, connection);
  const files = await loadAttachments(env, snapshot);
  if (id === "smtp") return sendSmtp(config, credentials, snapshot, files);
  if (id === "jmap") return sendJmap(config, credentials, snapshot, files, submissionId);
  const to = snapshot.to.map(toObject), cc = snapshot.cc.map(toObject), bcc = snapshot.bcc.map(toObject);
  let url = "", headers: Record<string, string> = {}, body: unknown;
  switch (id) {
    case "cloudflare-rest":
      url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(required(config.accountId, "accountId"))}/email/sending/send`;
      headers.authorization = `Bearer ${required(credentials.apiToken, "apiToken")}`;
      body = {
        from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc,
        subject: snapshot.subject, text: snapshot.text, html: snapshot.html,
        reply_to: snapshot.reply_to, headers: snapshot.headers,
        attachments: files.map((file) => ({ content: file.content, filename: file.filename, type: file.content_type, disposition: file.disposition, ...(file.content_id ? { contentId: file.content_id } : {}) })),
      };
      break;
    case "resend":
      url = "https://api.resend.com/emails";
      headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`;
      if (submissionId) headers["Idempotency-Key"] = submissionId;
      body = { from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, text: snapshot.text, html: snapshot.html, reply_to: snapshot.reply_to, headers: snapshot.headers, attachments: files.map((file) => ({ filename: file.filename, content: file.content, content_type: file.content_type })) };
      break;
    case "postmark":
      url = "https://api.postmarkapp.com/email";
      headers["X-Postmark-Server-Token"] = required(credentials.serverToken, "serverToken");
      body = { From: snapshot.from, To: snapshot.to.join(","), ...(snapshot.cc.length ? { Cc: snapshot.cc.join(",") } : {}), ...(snapshot.bcc.length ? { Bcc: snapshot.bcc.join(",") } : {}), Subject: snapshot.subject, TextBody: snapshot.text, HtmlBody: snapshot.html, ...(snapshot.reply_to ? { ReplyTo: snapshot.reply_to } : {}), Headers: headerArray(snapshot.headers), ...(config.messageStream ? { MessageStream: config.messageStream } : {}), Attachments: files.map((file) => ({ Name: file.filename, Content: file.content, ContentType: file.content_type, ...(file.content_id ? { ContentID: `cid:${file.content_id}` } : {}) })) };
      break;
    case "sendgrid":
      url = "https://api.sendgrid.com/v3/mail/send";
      headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`;
      body = { personalizations: [{ to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}) }], from: { email: snapshot.from }, ...(snapshot.reply_to ? { reply_to: toObject(snapshot.reply_to) } : {}), subject: snapshot.subject, content: [{ type: "text/plain", value: snapshot.text }, ...(snapshot.html ? [{ type: "text/html", value: snapshot.html }] : [])], ...(Object.keys(snapshot.headers).length ? { headers: snapshot.headers } : {}), attachments: files.map((file) => ({ content: file.content, filename: file.filename, type: file.content_type, disposition: file.disposition, ...(file.content_id ? { content_id: file.content_id } : {}) })) };
      break;
    case "ses": {
      const region = required(config.region, "region"), host = `email.${region}.amazonaws.com`, path = "/v2/email/outbound-emails";
      const payload = {
        FromEmailAddress: snapshot.from,
        Destination: { ToAddresses: snapshot.to, CcAddresses: snapshot.cc, BccAddresses: snapshot.bcc },
        ...(snapshot.reply_to ? { ReplyToAddresses: [snapshot.reply_to] } : {}),
        ...(config.configurationSet ? { ConfigurationSetName: config.configurationSet } : {}),
        Content: { Simple: {
          Subject: { Data: snapshot.subject, Charset: "UTF-8" },
          Body: { ...(snapshot.text ? { Text: { Data: snapshot.text, Charset: "UTF-8" } } : {}), ...(snapshot.html ? { Html: { Data: snapshot.html, Charset: "UTF-8" } } : {}) },
          Headers: Object.entries(snapshot.headers).map(([Name, Value]) => ({ Name, Value })),
          Attachments: files.map((file) => ({ FileName: file.filename, RawContent: file.content, ContentType: file.content_type, ContentDisposition: file.disposition === "inline" ? "INLINE" : "ATTACHMENT", ContentTransferEncoding: "BASE64", ...(file.content_id ? { ContentId: file.content_id } : {}) })),
        } },
      };
      const requestBody = JSON.stringify(payload), date = new Date(), amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ""), dateStamp = amzDate.slice(0, 8);
      const bodyHash = await sha256Hex(requestBody), sessionToken = credentials.sessionToken;
      const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}${sessionToken ? `\nx-amz-security-token:${sessionToken}` : ""}`;
      const signedHeaders = `host;x-amz-content-sha256;x-amz-date${sessionToken ? ";x-amz-security-token" : ""}`;
      const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;
      const scope = `${dateStamp}/${region}/ses/aws4_request`, toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
      const kDate = await hmac(`AWS4${required(credentials.secretAccessKey, "secretAccessKey")}`, dateStamp),
        kRegion = await hmac(kDate, region), kService = await hmac(kRegion, "ses"), kSigning = await hmac(kService, "aws4_request"),
        signature = await hmacHex(kSigning, toSign);
      const signed = await fetch(`https://${host}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json", "x-amz-date": amzDate, "x-amz-content-sha256": bodyHash,
          ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
          authorization: `AWS4-HMAC-SHA256 Credential=${required(credentials.accessKeyId, "accessKeyId")}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body: requestBody,
        signal: AbortSignal.timeout(25_000),
      }).catch(() => { throw providerError("acceptance_unknown"); });
      const raw = await signed.text().catch(() => ""); let response: Record<string, any> = {};
      try { response = JSON.parse(raw) as Record<string, any>; } catch { response = {}; }
      if (!signed.ok) { if (signed.status === 429) throw providerError("E_RATE_LIMIT_EXCEEDED"); throw providerError(signed.status >= 500 ? "acceptance_unknown" : "E_PROVIDER_REJECTED"); }
      return { provider_message_id: textResponseId(response, signed.headers, submissionId) };
    }
    case "mailgun": {
      const domain = required(config.domain, "domain"), region = config.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
      const form = new FormData();
      form.set("from", snapshot.from); form.set("to", snapshot.to.join(",")); form.set("subject", snapshot.subject);
      if (snapshot.cc.length) form.set("cc", snapshot.cc.join(",")); if (snapshot.bcc.length) form.set("bcc", snapshot.bcc.join(","));
      if (snapshot.text) form.set("text", snapshot.text); if (snapshot.html) form.set("html", snapshot.html); if (snapshot.reply_to) form.set("h:Reply-To", snapshot.reply_to);
      for (const [name, value] of Object.entries(snapshot.headers)) form.append(`h:${name}`, value);
      for (let index = 0; index < files.length; index++) {
        const file = files[index]!;
        const bytes = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
        form.append(file.disposition === "inline" ? "inline" : "attachment", new Blob([bytes], { type: file.content_type }), file.filename);
      }
      url = `${region}/v3/${encodeURIComponent(domain)}/messages`;
      headers.authorization = `Basic ${btoa(`api:${required(credentials.apiKey, "apiKey")}`)}`;
      const response = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(25_000) }).catch(() => { throw providerError("acceptance_unknown"); });
      const raw = await response.text().catch(() => ""); let parsed: Record<string, any> = {};
      try { parsed = JSON.parse(raw) as Record<string, any>; } catch { parsed = {}; }
      if (!response.ok) { if (response.status === 429) throw providerError("E_RATE_LIMIT_EXCEEDED"); throw providerError(response.status >= 500 ? "acceptance_unknown" : "E_PROVIDER_REJECTED"); }
      return { provider_message_id: textResponseId(parsed, response.headers, submissionId) };
    }
    case "mailersend":
      url = "https://api.mailersend.com/v1/email"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`;
      body = { from: { email: snapshot.from }, to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject: snapshot.subject, text: snapshot.text, html: snapshot.html, ...(snapshot.reply_to ? { reply_to: { email: snapshot.reply_to } } : {}), ...(Object.keys(snapshot.headers).length ? { headers: snapshot.headers } : {}), attachments: files.map((file) => ({ content: file.content, filename: file.filename, id: file.content_id, disposition: file.disposition })) };
      break;
    case "brevo":
      url = "https://api.brevo.com/v3/smtp/email"; headers["api-key"] = required(credentials.apiKey, "apiKey");
      body = { sender: { email: snapshot.from }, to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject: snapshot.subject, textContent: snapshot.text, htmlContent: snapshot.html, ...(snapshot.reply_to ? { replyTo: { email: snapshot.reply_to } } : {}), headers: snapshot.headers, attachment: files.map((file) => ({ content: file.content, name: file.filename })) };
      break;
    case "mailtrap":
      url = "https://send.api.mailtrap.io/api/send"; headers.authorization = `Bearer ${required(credentials.apiToken, "apiToken")}`;
      body = { from: { email: snapshot.from }, to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject: snapshot.subject, text: snapshot.text, html: snapshot.html, ...(snapshot.reply_to ? { reply_to: { email: snapshot.reply_to } } : {}), headers: snapshot.headers, attachments: files.map((file) => ({ content: file.content, filename: file.filename, type: file.content_type, disposition: file.disposition })) };
      break;
    case "maileroo":
      url = "https://smtp.maileroo.com/api/v2/emails"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`;
      body = { from: { address: snapshot.from }, to: snapshot.to.map((address) => ({ address })), ...(snapshot.cc.length ? { cc: snapshot.cc.map((address) => ({ address })) } : {}), ...(snapshot.bcc.length ? { bcc: snapshot.bcc.map((address) => ({ address })) } : {}), subject: snapshot.subject, plain: snapshot.text, html: snapshot.html, ...(snapshot.reply_to ? { reply_to: [{ address: snapshot.reply_to }] } : {}), headers: snapshot.headers, ...(submissionId ? { reference_id: (await sha256Hex(submissionId)).slice(0, 24) } : {}), attachments: files.map((file) => ({ file_name: file.filename, content: file.content, content_type: file.content_type, inline: file.disposition === "inline", ...(file.content_id ? { content_id: file.content_id } : {}) })) };
      break;
    case "lettermint":
      url = "https://api.lettermint.co/v1/send"; headers["x-lettermint-token"] = required(credentials.apiToken, "apiToken"); if (submissionId) headers["Idempotency-Key"] = submissionId;
      body = { from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, text: snapshot.text, html: snapshot.html, reply_to: snapshot.reply_to, headers: snapshot.headers, ...(config.route ? { route: config.route } : {}), attachments: files.map((file) => ({ filename: file.filename, content: file.content, content_type: file.content_type, disposition: file.disposition, content_id: file.content_id })) };
      break;
    case "mailpace":
      url = "https://app.mailpace.com/api/v1/send"; headers["MailPace-Server-Token"] = required(credentials.serverToken, "serverToken"); if (submissionId) headers["Idempotency-Key"] = submissionId;
      body = { from: snapshot.from, to: snapshot.to.join(","), ...(snapshot.cc.length ? { cc: snapshot.cc.join(",") } : {}), ...(snapshot.bcc.length ? { bcc: snapshot.bcc.join(",") } : {}), subject: snapshot.subject, textbody: snapshot.text, htmlbody: snapshot.html, replyto: snapshot.reply_to, attachments: files.map((file) => ({ name: file.filename, content: file.content, content_type: file.content_type, ...(file.content_id ? { cid: `<${file.content_id}>` } : {}) })) };
      break;
    case "zeptomail":
      url = required(config.sendUrl, "sendUrl");
      try {
        const endpoint = new URL(url);
        if (endpoint.protocol !== "https:" || !/^api\.zeptomail\.(com|eu|in|com\.cn|com\.au|jp)$/i.test(endpoint.hostname) || endpoint.pathname !== "/v1.1/email" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("invalid endpoint");
        url = endpoint.toString();
      } catch { throw providerError("provider_configuration_missing"); }
      headers.authorization = `Zoho-enczapikey ${required(credentials.sendToken, "sendToken")}`;
      body = { from: { address: snapshot.from }, to: snapshot.to.map((address) => ({ email_address: { address } })), cc: snapshot.cc.map((address) => ({ email_address: { address } })), bcc: snapshot.bcc.map((address) => ({ email_address: { address } })), subject: snapshot.subject, textbody: snapshot.text, htmlbody: snapshot.html, reply_to: snapshot.reply_to ? [{ address: snapshot.reply_to }] : undefined, attachments: files.map((file) => ({ name: file.filename, content: file.content, mime_type: file.content_type })) };
      break;
    case "mailchannels":
      url = "https://api.mailchannels.net/tx/v1/send"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`;
      body = { personalizations: [{ to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}) }], from: { email: snapshot.from }, subject: snapshot.subject, content: [{ type: "text/plain", value: snapshot.text }, ...(snapshot.html ? [{ type: "text/html", value: snapshot.html }] : [])], headers: { ...snapshot.headers, ...(snapshot.reply_to ? { "Reply-To": snapshot.reply_to } : {}) }, attachments: files.map((file) => ({ content: file.content, filename: file.filename, type: file.content_type, disposition: file.disposition })) };
      break;
    case "plunk":
      url = "https://next-api.useplunk.com/v1/send"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`;
      body = { from: snapshot.from, to: snapshot.to[0], subject: snapshot.subject, body: snapshot.html || snapshot.text, ...(snapshot.reply_to ? { reply: snapshot.reply_to } : {}), ...(Object.keys(snapshot.headers).length ? { headers: snapshot.headers } : {}), attachments: files.map((file) => ({ filename: file.filename, content: file.content, contentType: file.content_type })), data: {} };
      if (snapshot.to.length !== 1 || snapshot.cc.length || snapshot.bcc.length) throw providerError("E_PROVIDER_FEATURE_UNSUPPORTED");
      break;
    case "mailchimp-transactional":
      url = "https://mandrillapp.com/api/1.0/messages/send.json";
      body = { key: required(credentials.apiKey, "apiKey"), message: { from_email: snapshot.from, to: [...snapshot.to.map((email) => ({ email, type: "to" })), ...snapshot.cc.map((email) => ({ email, type: "cc" })), ...snapshot.bcc.map((email) => ({ email, type: "bcc" }))], subject: snapshot.subject, text: snapshot.text, html: snapshot.html, headers: { ...snapshot.headers, ...(snapshot.reply_to ? { "Reply-To": snapshot.reply_to } : {}) }, attachments: files.map((file) => ({ type: file.content_type, name: file.filename, content: file.content, ...(file.content_id ? { content_id: file.content_id } : {}) })) } };
      break;
    case "sparkpost": {
      const region = config.region === "eu" ? "eu" : "us";
      url = `https://api.${region}.sparkpost.com/api/v1/transmissions`; headers["Authorization"] = required(credentials.apiKey, "apiKey");
      if (submissionId) headers["Idempotency-Key"] = submissionId;
      const primaryTo = snapshot.to.join(", ");
      const contentHeaders = { ...snapshot.headers, ...(snapshot.cc.length ? { CC: snapshot.cc.join(", ") } : {}) };
      body = {
        recipients: [
          ...snapshot.to.map((email) => ({ address: { email } })),
          ...snapshot.cc.map((email) => ({ address: { email, header_to: primaryTo } })),
          ...snapshot.bcc.map((email) => ({ address: { email, header_to: primaryTo } })),
        ],
        content: { from: snapshot.from, subject: snapshot.subject, ...(snapshot.text ? { text: snapshot.text } : {}), ...(snapshot.html ? { html: snapshot.html } : {}), ...(snapshot.reply_to ? { reply_to: snapshot.reply_to } : {}), ...(Object.keys(contentHeaders).length ? { headers: contentHeaders } : {}), attachments: files.filter((file) => file.disposition !== "inline").map((file) => ({ name: file.filename, type: file.content_type, data: file.content })), inline_images: files.filter((file) => file.disposition === "inline").map((file) => ({ name: file.content_id || file.filename, type: file.content_type, data: file.content })) },
      };
      break;
    }
    case "microsoft-graph": {
      const tenant = required(config.tenantId, "tenantId"), client = required(config.clientId, "clientId"), mailbox = required(config.mailbox, "mailbox");
      if (Object.keys(snapshot.headers).some((name) => !/^x-/i.test(name))) throw providerError("E_PROVIDER_FEATURE_UNSUPPORTED");
      const token = await graphToken(tenant, client, required(credentials.clientSecret, "clientSecret"));
      url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`;
      headers.authorization = `Bearer ${token}`;
      body = { message: { subject: snapshot.subject, body: { contentType: snapshot.html ? "HTML" : "Text", content: snapshot.html || snapshot.text }, toRecipients: snapshot.to.map((address) => ({ emailAddress: { address } })), ccRecipients: snapshot.cc.map((address) => ({ emailAddress: { address } })), bccRecipients: snapshot.bcc.map((address) => ({ emailAddress: { address } })), ...(snapshot.reply_to ? { replyTo: [{ emailAddress: { address: snapshot.reply_to } }] } : {}), internetMessageHeaders: Object.entries(snapshot.headers).map(([name, value]) => ({ name, value })), attachments: files.map((file) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: file.filename, contentType: file.content_type, contentBytes: file.content, isInline: file.disposition === "inline", ...(file.content_id ? { contentId: file.content_id } : {}) })) }, saveToSentItems: true };
      break;
    }
    case "scaleway":
      url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${encodeURIComponent(config.region || "fr-par")}/emails`;
      headers["X-Auth-Token"] = required(credentials.apiKey, "apiKey");
      body = { project_id: required(config.projectId, "projectId"), from: { email: snapshot.from }, to: snapshot.to.map((email) => ({ email })), cc: snapshot.cc.map((email) => ({ email })), bcc: snapshot.bcc.map((email) => ({ email })), subject: snapshot.subject, text: snapshot.text, html: snapshot.html, reply_to: snapshot.reply_to ? { email: snapshot.reply_to } : undefined, attachments: files.map((file) => ({ name: file.filename, content: file.content, type: file.content_type })) };
      break;
    case "unosend":
      url = "https://www.unosend.co/api/v1/emails"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`;
      body = { from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, text: snapshot.text, html: snapshot.html, reply_to: snapshot.reply_to, headers: snapshot.headers, attachments: files.map((file) => ({ filename: file.filename, content: file.content })) };
      break;
    case "jetemail":
      url = "https://api.jetemail.com/email"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`; if (submissionId) headers["Idempotency-Key"] = submissionId;
      body = { from: { email: snapshot.from, name: required(config.senderName, "senderName") }, to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject: snapshot.subject, html: snapshot.html, text: snapshot.text, ...(snapshot.reply_to ? { replyTo: snapshot.reply_to } : {}), headers: snapshot.headers, attachments: files.map((file) => ({ filename: file.filename, content: file.content, contentType: file.content_type })) };
      break;
    case "lettr":
      url = "https://app.lettr.com/api/emails"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`;
      if (submissionId) headers["Idempotency-Key"] = submissionId;
      body = { from: snapshot.from, to: snapshot.to, ...(snapshot.cc.length ? { cc: snapshot.cc } : {}), ...(snapshot.bcc.length ? { bcc: snapshot.bcc } : {}), subject: snapshot.subject, ...(snapshot.html ? { html: snapshot.html } : {}), ...(snapshot.text ? { text: snapshot.text } : {}), ...(snapshot.reply_to ? { reply_to: snapshot.reply_to } : {}), ...(Object.keys(snapshot.headers).length ? { headers: snapshot.headers } : {}), attachments: files.map((file) => ({ name: file.filename, type: file.content_type, data: file.content })) };
      break;
    case "sendheron":
      url = "https://api.sendheron.com/emails/send"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`; if (submissionId) headers["idempotency-key"] = submissionId;
      body = { from: snapshot.from, fromName: config.senderName || "", to: snapshot.to[0], cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, html: snapshot.html || `<pre>${escapeHtml(snapshot.text)}</pre>`, ...(snapshot.reply_to ? { replyTo: snapshot.reply_to } : {}), headers: snapshot.headers, attachments: files.map((file) => ({ filename: file.filename, content: file.content, contentType: file.content_type })) };
      if (snapshot.to.length !== 1) throw providerError("E_PROVIDER_FEATURE_UNSUPPORTED");
      break;
    case "helo":
      url = "https://api.helohq.com/send/transactional"; headers.authorization = `Bearer ${required(credentials.apiKey, "apiKey")}`; if (submissionId) headers["X-Helo-Idempotency-Key"] = submissionId.slice(0, 36);
      if (config.channelId) headers["X-Helo-Channel-Id"] = config.channelId;
      body = { from: { email: snapshot.from }, to: snapshot.to.map((email) => ({ email })), ...(cc.length ? { cc: cc.map((entry) => ({ email: entry.email })) } : {}), ...(bcc.length ? { bcc: bcc.map((entry) => ({ email: entry.email })) } : {}), subject: snapshot.subject, html: snapshot.html, text: snapshot.text, ...(snapshot.reply_to ? { replyTo: { email: snapshot.reply_to } } : {}), headers: snapshot.headers, attachments: files.map((file) => ({ filename: file.filename, content: file.content, contentType: file.content_type, disposition: file.disposition, contentId: file.content_id })) };
      break;
    default:
      throw providerError("provider_configuration_missing");
  }
  const { body: response, headers: responseHeaders } = await postJson(url, headers, body, submissionId);
  if (id === "cloudflare-rest" && response.success === false) throw providerError("E_PROVIDER_REJECTED");
  if (id === "mailchannels" && response.status === "error") throw providerError("E_PROVIDER_REJECTED");
  if (id === "helo" && response.status === "failed") throw providerError("E_PROVIDER_REJECTED");
  if (id === "sendheron" && response.status === "suppressed") throw providerError("E_PROVIDER_REJECTED");
  return { provider_message_id: textResponseId(response, responseHeaders, submissionId) };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function headerValue(value: string) {
  if (/[\r\n\0]/.test(value)) throw providerError("E_VALIDATION_ERROR");
  return /^[\x00-\x7f]*$/.test(value) ? value : `=?UTF-8?B?${base64(new TextEncoder().encode(value))}?=`;
}
function foldedBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}
function smtpMime(snapshot: SubmissionSnapshot, files: AttachmentData[]) {
  const lines = [
    `From: ${snapshot.from}`,
    `To: ${snapshot.to.join(", ")}`,
    ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(", ")}`] : []),
    ...(snapshot.reply_to ? [`Reply-To: ${snapshot.reply_to}`] : []),
    `Subject: ${headerValue(snapshot.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  for (const [name, value] of Object.entries(snapshot.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /^(from|to|cc|bcc|subject|reply-to|date|mime-version|content-type|content-transfer-encoding)$/i.test(name)) throw providerError("E_VALIDATION_ERROR");
    lines.push(`${name}: ${headerValue(value)}`);
  }
  const alternative = `officeflare-alt-${crypto.randomUUID()}`;
  const mixed = `officeflare-mixed-${crypto.randomUUID()}`;
  const bodyParts = [
    ...(snapshot.text ? [`--${alternative}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldedBase64(base64(new TextEncoder().encode(snapshot.text)))}`] : []),
    ...(snapshot.html ? [`--${alternative}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldedBase64(base64(new TextEncoder().encode(snapshot.html)))}`] : []),
  ];
  const content = snapshot.text && snapshot.html
    ? `Content-Type: multipart/alternative; boundary="${alternative}"\r\n\r\n${bodyParts.join("\r\n")}\r\n--${alternative}--`
    : `Content-Type: ${snapshot.html ? "text/html" : "text/plain"}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldedBase64(base64(new TextEncoder().encode(snapshot.html || snapshot.text)))}`;
  const attachmentParts = files.map((file) => {
    const safeName = file.filename.replace(/[\r\n"\\]/g, "_");
    const disposition = file.disposition === "inline" ? "inline" : "attachment";
    return `--${mixed}\r\nContent-Type: ${file.content_type}; name="${safeName}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: ${disposition}; filename="${safeName}"${file.content_id ? `\r\nContent-ID: <${file.content_id.replace(/[<>\r\n]/g, "")}>` : ""}\r\n\r\n${foldedBase64(file.content)}`;
  });
  const mimeBody = files.length
    ? `Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n--${mixed}\r\n${content}\r\n${attachmentParts.join("\r\n")}\r\n--${mixed}--`
    : content;
  return `${lines.join("\r\n")}\r\n\r\n${mimeBody}\r\n`;
}
type SmtpSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void>;
  startTls(): SmtpSocket;
};
class SmtpSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private socket: SmtpSocket;
  constructor(socket: SmtpSocket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }
  use(socket: SmtpSocket) {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = "";
  }
  async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end >= 0) {
        const result = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return result;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SMTP connection closed");
      this.buffer += new TextDecoder().decode(value, { stream: true });
      if (this.buffer.length > 16_384) throw new Error("SMTP response too large");
    }
  }
  async response() {
    const lines: string[] = [];
    let code = 0;
    for (;;) {
      const line = await this.line();
      if (!/^\d{3}[ -]/.test(line)) throw new Error("Invalid SMTP response");
      const nextCode = Number(line.slice(0, 3));
      if (!code) code = nextCode;
      if (code !== nextCode) throw new Error("Invalid SMTP response");
      lines.push(line);
      if (line[3] !== "-") return { code, lines };
    }
  }
  async expect(allowed: number[]) {
    const response = await this.response();
    if (!allowed.includes(response.code)) throw providerError("E_PROVIDER_REJECTED");
    return response;
  }
  async command(value: string, allowed: number[]) {
    if (/[\r\n\0]/.test(value)) throw providerError("E_VALIDATION_ERROR");
    await this.writer.write(new TextEncoder().encode(`${value}\r\n`));
    return this.expect(allowed);
  }
  async data(value: string) {
    await this.writer.write(new TextEncoder().encode(value.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")));
  }
  async finishData() {
    await this.writer.write(new TextEncoder().encode(".\r\n"));
  }
  async close() {
    try { this.reader.releaseLock(); } catch { /* stream already failed */ }
    try { this.writer.releaseLock(); } catch { /* stream already failed */ }
    try { await this.socket.close(); } catch { /* best effort */ }
  }
}
async function sendSmtp(config: ProviderConfig, credentials: ProviderSecret, snapshot: SubmissionSnapshot, files: AttachmentData[]): Promise<SendResult> {
  const host = required(config.host, "host"), port = Number(required(config.port, "port")), security = required(config.security, "security");
  if (!/^[a-z0-9.-]+$/i.test(host) || (security === "tls" ? port !== 465 : security === "starttls" ? port !== 587 : true)) throw providerError("provider_configuration_missing");
  const { connect } = await import("cloudflare:sockets");
  let socket: SmtpSocket | undefined, session: SmtpSession | undefined, dataWritten = false;
  try {
    socket = connect({ hostname: host, port }, { secureTransport: security === "tls" ? "on" : "starttls", allowHalfOpen: false }) as SmtpSocket;
    await socket.opened;
    session = new SmtpSession(socket);
    await session.expect([220]);
    await session.command("EHLO officeflare.local", [250]);
    if (security === "starttls") {
      await session.command("STARTTLS", [220]);
      socket = socket.startTls();
      await socket.opened;
      session.use(socket);
      await session.command("EHLO officeflare.local", [250]);
    }
    const username = required(credentials.username, "username"), password = required(credentials.password, "password");
    const auth = base64(new TextEncoder().encode(`\0${username}\0${password}`));
    const authenticated = await session.command(`AUTH PLAIN ${auth}`, [235, 334]);
    if (authenticated.code === 334) await session.command(auth, [235]);
    await session.command(`MAIL FROM:<${snapshot.from}>`, [250]);
    for (const address of recipients(snapshot)) await session.command(`RCPT TO:<${address}>`, [250, 251]);
    await session.command("DATA", [354]);
    await session.data(smtpMime(snapshot, files));
    dataWritten = true;
    await session.finishData();
    const accepted = await session.expect([250]);
    const serverId = accepted.lines.at(-1)?.replace(/^250[ -]?/, "").trim();
    await session.command("QUIT", [221]).catch(() => undefined);
    return { provider_message_id: messageId(serverId, crypto.randomUUID()) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw providerError(dataWritten ? "acceptance_unknown" : "E_PROVIDER_REJECTED");
  } finally {
    await session?.close();
    if (!session) try { await socket?.close(); } catch { /* best effort */ }
  }
}
type JmapMethodResponse = [string, Record<string, any>, string];
async function jmapPost(apiUrl: string, token: string, using: string[], methodCalls: unknown[], uncertain = false) {
  let response: Response;
  try {
    response = await fetch(apiUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ using, methodCalls }), signal: AbortSignal.timeout(25_000), redirect: "manual" });
  } catch { throw providerError(uncertain ? "acceptance_unknown" : "provider_configuration_missing"); }
  if (!response.ok) throw providerError(response.status >= 500 && uncertain ? "acceptance_unknown" : response.status === 429 ? "E_RATE_LIMIT_EXCEEDED" : "E_PROVIDER_REJECTED");
  const result = await response.json() as { methodResponses?: JmapMethodResponse[] };
  return result.methodResponses ?? [];
}
async function sendJmap(config: ProviderConfig, credentials: ProviderSecret, snapshot: SubmissionSnapshot, files: AttachmentData[], submissionId?: string): Promise<SendResult> {
  if (Object.keys(snapshot.headers).length) throw providerError("E_PROVIDER_FEATURE_UNSUPPORTED");
  const sessionUrl = required(config.sessionUrl, "sessionUrl"), token = required(credentials.accessToken, "accessToken");
  validateHttpsEndpoint(sessionUrl);
  let sessionResponse: Response;
  try { sessionResponse = await fetch(sessionUrl, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "manual" }); }
  catch { throw providerError("provider_configuration_missing"); }
  if (!sessionResponse.ok) throw providerError("provider_configuration_missing");
  const sessionData = await sessionResponse.json() as { apiUrl?: string; uploadUrl?: string; primaryAccounts?: Record<string, string> };
  const accountId = config.accountId || sessionData.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  if (!sessionData.apiUrl || !sessionData.uploadUrl || !accountId) throw providerError("provider_configuration_missing");
  const apiUrl = sessionData.apiUrl.replaceAll("{accountId}", encodeURIComponent(accountId));
  const uploadUrl = sessionData.uploadUrl.replaceAll("{accountId}", encodeURIComponent(accountId));
  validateHttpsEndpoint(apiUrl);
  validateHttpsEndpoint(uploadUrl);
  const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
  const mailboxResponses = await jmapPost(apiUrl, token, using, [["Mailbox/get", { accountId, ids: null, properties: ["id", "role"] }, "mailboxes"]]);
  const mailboxResult = mailboxResponses.find((entry) => entry[2] === "mailboxes")?.[1];
  const outboxId = mailboxResult?.list?.find((mailbox: { role?: string; id?: string }) => mailbox.role === "outbox")?.id;
  if (!outboxId) throw providerError("provider_configuration_missing");
  const uploaded = [];
  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
    let response: Response;
    try { response = await fetch(uploadUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": file.content_type }, body: new Blob([bytes]), signal: AbortSignal.timeout(25_000), redirect: "manual" }); }
    catch { throw providerError("E_PROVIDER_REJECTED"); }
    if (!response.ok) throw providerError(response.status >= 500 ? "acceptance_unknown" : "E_PROVIDER_REJECTED");
    const blob = await response.json() as { blobId?: string };
    if (!blob.blobId) throw providerError("E_PROVIDER_REJECTED");
    uploaded.push({ blobId: blob.blobId, type: file.content_type, name: file.filename, disposition: file.disposition, ...(file.content_id ? { cid: file.content_id } : {}) });
  }
  const email: Record<string, any> = {
    mailboxIds: { [outboxId]: true }, keywords: { "$draft": true },
    from: [{ email: snapshot.from }], to: snapshot.to.map((email) => ({ email })),
    ...(snapshot.cc.length ? { cc: snapshot.cc.map((email) => ({ email })) } : {}),
    ...(snapshot.bcc.length ? { bcc: snapshot.bcc.map((email) => ({ email })) } : {}),
    ...(snapshot.reply_to ? { replyTo: [{ email: snapshot.reply_to }] } : {}),
    subject: snapshot.subject,
    textBody: snapshot.text ? [{ partId: "text", type: "text/plain", charset: "utf-8" }] : [],
    htmlBody: snapshot.html ? [{ partId: "html", type: "text/html", charset: "utf-8" }] : [],
    bodyValues: {
      ...(snapshot.text ? { text: { value: snapshot.text } } : {}),
      ...(snapshot.html ? { html: { value: snapshot.html } } : {}),
    },
    ...(uploaded.length ? { attachments: uploaded } : {}),
  };
  const emailResponses = await jmapPost(apiUrl, token, using, [["Email/set", { accountId, create: { message: email } }, "email"]]);
  const emailResult = emailResponses.find((entry) => entry[2] === "email")?.[1];
  const emailId = emailResult?.created?.message?.id;
  if (!emailId) throw providerError("E_PROVIDER_REJECTED");
  const submissionCall = {
    accountId,
    create: {
      submission: {
        emailId,
        envelope: { mailFrom: { email: snapshot.from }, rcptTo: recipients(snapshot).map((email) => ({ email })) },
      },
    },
  };
  const submissionResponses = await jmapPost(apiUrl, token, using, [["EmailSubmission/set", submissionCall, "submission"]], true);
  const submissionResult = submissionResponses.find((entry) => entry[2] === "submission")?.[1];
  const resultId = submissionResult?.created?.submission?.id;
  if (!resultId) throw providerError("acceptance_unknown");
  return { provider_message_id: messageId(resultId, submissionId) };
}

function validateHttpsEndpoint(value: string) {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error("invalid endpoint");
  } catch { throw providerError("provider_configuration_missing"); }
}

async function graphToken(tenant: string, clientId: string, clientSecret: string) {
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  let response: Response;
  try { response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(15_000) }); }
  catch { throw providerError("acceptance_unknown"); }
  if (!response.ok) throw providerError(response.status === 429 ? "E_RATE_LIMIT_EXCEEDED" : response.status >= 500 ? "acceptance_unknown" : "provider_configuration_missing");
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw providerError("provider_configuration_missing");
  return data.access_token;
}
