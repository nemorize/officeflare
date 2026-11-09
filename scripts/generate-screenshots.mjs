#!/usr/bin/env node
// npm run screenshots -- [--interval 2] [--gif-only] [--skip-build] [--headed]
// A fresh local Worker, D1, R2 and Durable Objects are created for each capture.
// Mail delivery stays inside the demo Worker. Temporary data is removed on exit.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { exportJWK, generateKeyPair } from "jose";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import { chromium } from "playwright";
import sharp from "sharp";
import { runNode, runViteBuild, runWrangler } from "./wrangler.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "screenshots");
const scenes = [
  "01-mail-list.jpg",
  "02-mail-message.jpg",
  "03-mail-reply.jpg",
  "04-calendar-month.jpg",
  "05-calendar-create-event.jpg",
  "06-calendar-invite-guests.jpg",
  "07-calendar-share-event.jpg",
  "08-drive-list.jpg",
  "09-drive-folder.jpg",
  "10-drive-upload-pdf.jpg",
  "11-drive-pdf-preview.jpg",
  "12-drive-external-share.jpg",
];
const subject = "Atlas launch review - ready for your feedback";
const email = "alex.morgan@northstar.example";
const say = (message) => console.log(`[screenshots] ${message}`);

function options() {
  const { values } = parseArgs({
    options: {
      interval: { type: "string", default: "2" },
      "gif-only": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      headed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const seconds = Number(values.interval);
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 60)
    throw new Error("--interval must be a number between 0.1 and 60 seconds.");
  return { ...values, delay: Math.round(seconds * 100) * 10 };
}

function demoDates() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  const month = `${parts.year}-${parts.month}`;
  return {
    month,
    quarter: `Q${Math.ceil(Number(parts.month) / 3)}`,
    label: new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
    }).format(new Date()),
    day: (day) => `${month}-${String(day).padStart(2, "0")}`,
  };
}

// A complete one-page PDF, using standard PDF fonts and vector drawing commands.
// No Python, external document generator or downloaded sample document is needed.
function deliveryBrief(dates) {
  const commands = [];
  const escape = (value) => value.replace(/[\\()]/g, "\\$&");
  const text = (x, y, value, size = 11, bold = false, color = "0.09 0.14 0.23") =>
    commands.push(
      `${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${escape(value)}) Tj ET`,
    );
  const rect = (x, y, w, h, color) => commands.push(`${color} rg ${x} ${y} ${w} ${h} re f`);
  rect(0, 770, 595, 72, "0.09 0.14 0.23");
  text(42, 807, "NORTHSTAR STUDIO", 12, true, "1 1 1");
  text(42, 789, `PRODUCT OPERATIONS / ${dates.label.toUpperCase()}`, 8, false, "0.79 0.83 0.9");
  text(42, 725, "Atlas", 34, true);
  text(42, 697, `${dates.quarter} delivery brief`, 23);
  text(42, 672, "Customer portal launch | Prepared by Alex Morgan", 10);
  rect(42, 629, 151, 24, "0.91 0.96 0.94");
  text(53, 637, "ON TRACK FOR LAUNCH", 8, true, "0.15 0.47 0.32");
  text(42, 592, "A confident finish to the quarter.", 16, true);
  [
    "The Atlas customer portal is entering its final release cycle. Product,",
    "engineering and design are aligned on a focused launch scope, with",
    "customer onboarding and operational readiness as our final priorities.",
  ].forEach((line, i) => text(42, 568 - i * 17, line));
  [
    [42, "92%", "Delivery readiness"],
    [218, "24 / 26", "Milestones complete"],
    [394, `${dates.month.slice(5)}/24`, "Target launch"],
  ].forEach(([x, value, label]) => {
    rect(x, 452, 159, 66, "0.95 0.96 0.98");
    text(x + 14, 485, value, 23, true, "0.21 0.4 0.84");
    text(x + 14, 467, label, 9);
  });
  text(42, 412, "Release readiness", 15, true);
  [
    ["Core platform", "Daniel Kim", "Complete", 1],
    ["Design quality", "Sophia Reed", "Complete", 1],
    ["Customer onboarding", "Maya Chen", "In review", 0.88],
    ["Partner enablement", "Ethan Park", "On track", 0.78],
  ].forEach(([label, owner, status, progress], i) => {
    const y = 378 - i * 40;
    text(42, y, label, 10, true);
    text(42, y - 14, owner, 8);
    rect(235, y - 8, 190, 5, "0.89 0.91 0.94");
    rect(235, y - 8, 190 * progress, 5, "0.21 0.4 0.84");
    text(450, y - 5, status, 9);
  });
  text(42, 204, "Next up", 15, true);
  [
    "12 - Product and design launch review",
    "17 - Customer success walkthrough",
    "24 - Atlas portal launch",
  ].forEach((line, i) => text(42, 178 - i * 23, `${dates.month}/${line}`, 10));
  text(42, 51, "Internal | Northstar Studio | Product operations", 8);
  text(544, 51, "1", 8);
  const stream = commands.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((value, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${value}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function createDemo() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const modules = [
    { type: "ESModule", path: join(root, "dist/index.js") },
    ...(await readdir(join(root, "dist")))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => ({ type: "Text", path: join(root, "dist", name) })),
  ];
  const common = {
    compatibilityDate: "2026-09-29",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "readme-demo" },
    r2Buckets: ["MAIL_BUCKET", "DRIVE_BUCKET", "PROFILE_BUCKET"],
    queueProducers: { MAIL_QUEUE: "demo-mail", NOTIFICATION_QUEUE: "demo-notifications" },
    bindings: {
      AUTH_SIGNING_KEYS: JSON.stringify({
        active_kid: "demo",
        keys: [{ ...(await exportJWK(privateKey)), kid: "demo" }],
      }),
      MFA_ENCRYPTION_KEYS: JSON.stringify({
        active_version: 1,
        keys: { 1: randomBytes(32).toString("base64url") },
      }),
      AUTH_ISSUER: "officeflare",
      AUTH_AUDIENCE: "officeflare-api",
      MAIL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      MAIL_PARTITION_TARGET_BYTES: "6000000000",
      NOTIFICATION_QUEUE_NAME: "demo-notifications",
    },
  };
  return new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          ...common,
          name: "officeflare",
          modules,
          durableObjects: {
            MAILBOX: { className: "MailboxDO", useSQLite: true },
            MAIL_PARTITION: { className: "MailPartitionDO", useSQLite: true },
            NOTIFICATION_HUB: { className: "NotificationHubDO", useSQLite: true },
          },
          queueConsumers: {
            "demo-mail": { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 },
            "demo-notifications": { maxBatchSize: 10, maxBatchTimeout: 0, maxRetries: 0 },
          },
          serviceBindings: { EMAIL: { name: "demo-mail", entrypoint: "DemoEmail" } },
          assets: {
            directory: join(root, "dist/client"),
            run_worker_first: ["/api", "/api/*"],
            routerConfig: { has_user_worker: true },
            assetConfig: { not_found_handling: "single-page-application" },
          },
        },
        {
          ...common,
          name: "demo-mail",
          modules: [
            {
              type: "ESModule",
              path: join(root, "scripts/readme-demo-worker.mjs"),
              contents: `
                import worker from "../dist/index.js";
                import { WorkerEntrypoint } from "cloudflare:workers";
                export class DemoEmail extends WorkerEntrypoint {
                  async send() { return { messageId: "<" + crypto.randomUUID() + "@northstar.example>" }; }
                }
                export default { async fetch(request, env, ctx) {
                  let rejected = null;
                  await worker.email({
                    from: request.headers.get("x-sender"),
                    to: "alex.morgan@northstar.example",
                    raw: request.body,
                    rawSize: Number(request.headers.get("content-length")),
                    headers: request.headers,
                    setReject(reason) { rejected = reason; },
                    async forward() { throw new Error("Demo forwarding is disabled"); }
                  }, env, ctx);
                  return Response.json({ rejected });
                }};
              `,
            },
            ...modules,
          ],
          durableObjects: {
            MAILBOX: { className: "MailboxDO", scriptName: "officeflare", useSQLite: true },
            MAIL_PARTITION: {
              className: "MailPartitionDO",
              scriptName: "officeflare",
              useSQLite: true,
            },
          },
        },
      ],
    }),
  );
}

async function seedDemo(mf, dates, temp) {
  const origin = (await mf.ready).origin;
  const db = await mf.getD1Database("DB");
  for (const name of (await readdir(join(root, "migrations"))).sort()) {
    if (!name.endsWith(".sql")) continue;
    let statement = "",
      trigger = false;
    for (const line of (await readFile(join(root, "migrations", name), "utf8")).split("\n")) {
      if (!line.trim() || line.trim().startsWith("--")) continue;
      if (line.startsWith("CREATE TRIGGER")) trigger = true;
      statement += line + "\n";
      if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
        await db.prepare(statement).run();
        statement = "";
        trigger = false;
      }
    }
    assert.equal(statement.trim(), "", `Incomplete migration: ${name}`);
  }
  const bundled = await build({
    entryPoints: [join(root, "src/auth/password.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const { hashPassword } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(password);
  const people = [
    ["alex", "Alex Morgan", "alex.morgan"],
    ["maya", "Maya Chen", "maya.chen"],
    ["daniel", "Daniel Kim", "daniel.kim"],
    ["sophia", "Sophia Reed", "sophia.reed"],
    ["ethan", "Ethan Park", "ethan.park"],
    ["olivia", "Olivia Bennett", "olivia.bennett"],
  ];
  for (const [id, name, local] of people) {
    await db
      .prepare(
        "INSERT INTO users(id,email_address,display_name,language,password_hash) VALUES(?,?,?,'en',?)",
      )
      .bind(id, `${local}@northstar.example`, name, passwordHash)
      .run();
    await db
      .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,'system-administrator')")
      .bind(id)
      .run();
  }
  let token,
    sequence = 0;
  const call = async (path, { method = "GET", data, bytes } = {}) => {
    const response = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        "cf-connecting-ip": `192.0.2.${(++sequence % 240) + 1}`,
        "Accept-Language": "en",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
      },
      body: bytes ?? (data ? JSON.stringify(data) : undefined),
    });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  token = (
    await call("/api/auth/login", { method: "POST", data: { email_address: email, password } })
  ).access_token;
  const domain = (
    await call("/api/mail/domains", {
      method: "POST",
      data: {
        name: "northstar.example",
        inbound_enabled: true,
        outbound_enabled: true,
      },
    })
  ).domain;
  const box = (
    await call("/api/mail/mailboxes", {
      method: "POST",
      data: {
        name: "Alex Morgan",
        owner_user_id: "alex",
        kind: "shared",
      },
    })
  ).mailbox;
  await call("/api/mail/addresses", {
    method: "POST",
    data: {
      domain_id: domain.id,
      mailbox_id: box.id,
      local_part: "alex.morgan",
      is_primary: true,
    },
  });
  const mailBase = `/api/mail/mailboxes/${box.id}`;
  for (const name of ["Atlas project", "Customers & partners", "Finance"])
    await call(`${mailBase}/folders`, { method: "POST", data: { name } });
  const mails = [
    [
      "olivia.bennett",
      "Operating budget - approved",
      "The updated operating budget is approved. Team allocations are ready in our finance workspace. Thank you for keeping the planning cycle on schedule.",
    ],
    [
      "daniel.kim",
      "API rollout: staging is ready for validation",
      "Atlas staging is running the release candidate. Please use the validation checklist in Drive and add any remaining feedback before Thursday.",
    ],
    [
      "ethan.park",
      "Partner onboarding - next cohort",
      `Our next partner cohort begins on ${dates.day(17)}. I have shared the onboarding calendar and partner guide with Customer Success.`,
    ],
    [
      "sophia.reed",
      "Brand refresh: final assets are in Drive",
      "The approved visual assets are now in Brand & Marketing. You will find the color palette, social templates and launch presentation in the campaign folder.",
    ],
    [
      "maya.chen",
      "Customer interviews: research highlights",
      "We spoke with eight customer teams this week. The strongest themes were simpler onboarding, clearer permissions and faster document sharing. The synthesis is ready for review.",
    ],
    [
      "olivia.bennett",
      "Vendor renewals - review by Friday",
      "Please review the vendor renewal summary and flag any changes to seats or usage before Friday so we can finalize the purchase plan.",
    ],
    [
      "daniel.kim",
      "Security review complete - Atlas release",
      "The final security review is complete. No launch blockers remain. We have documented follow-up improvements in the engineering release checklist.",
    ],
    [
      "ethan.park",
      "Northstar + Acme: workshop agenda",
      "The workshop agenda is ready. We will cover the customer journey, shared success metrics and rollout timeline. Looking forward to a productive session.",
    ],
    [
      "sophia.reed",
      "Design handoff: onboarding flow v3",
      "All onboarding screens are ready for engineering. The handoff includes responsive states, accessible focus styles and updated empty-state copy.",
    ],
    [
      "maya.chen",
      "Product review - agenda and pre-read",
      "Please read the delivery brief before our monthly product review and add discussion topics to the shared agenda.",
    ],
    [
      "daniel.kim",
      "Atlas weekly update - release candidate is green",
      "All core release checks are passing. We are closing the final two onboarding tasks and keeping the release candidate stable for the customer walkthrough.",
    ],
    [
      "maya.chen",
      subject,
      `Hi Alex,<br><br>We are in a strong position for the ${dates.day(24)} launch. The latest delivery brief is in our shared Drive folder, and the team has closed the major product and engineering milestones.<br><br><strong>For our launch review</strong><ul><li>Confirm the onboarding walkthrough with Customer Success.</li><li>Review the final partner enablement checklist.</li><li>Agree on launch-day ownership and the customer announcement.</li></ul>I have invited Daniel and Sophia. Could you add your operational readiness notes before we meet?<br><br>Thanks for keeping everyone aligned.<br><br>Maya Chen<br>Product Lead - Northstar Studio`,
    ],
  ];
  const inbound = await mf.getWorker("demo-mail");
  for (const [index, [local, title, content]] of mails.entries()) {
    const from = `${local}@northstar.example`;
    const name = people.find((person) => person[2] === local)[1];
    const raw = Buffer.from(
      `From: ${name} <${from}>\r\nTo: Alex Morgan <${email}>\r\nSubject: ${title}\r\nDate: ${new Date(Date.now() - (mails.length - index) * 1800000).toUTCString()}\r\nMessage-ID: <northstar-${index}@northstar.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<div style="font:15px/1.7 Arial,sans-serif;color:#263143;max-width:700px">${content}</div>`,
    );
    const response = await inbound.fetch("http://demo/inbound", {
      method: "POST",
      headers: {
        "x-sender": from,
        "content-length": String(raw.length),
      },
      body: raw,
    });
    assert.equal((await response.json()).rejected, null);
  }
  let messages = [];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    messages = (await call(`${mailBase}/messages?folder_id=inbox&limit=50`)).messages;
    if (messages.length === mails.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(messages.length, mails.length, "Demo inbound mail did not finish processing");
  for (const [i, message] of messages.entries()) {
    await call(`${mailBase}/messages/${message.id}`, {
      method: "PATCH",
      data: {
        version: message.version,
        is_read: i % 3 === 0,
        is_starred: message.subject === subject || i === 0,
      },
    });
  }
  const bootstrap = await call("/api/calendar/bootstrap");
  await call("/api/calendar/preferences", {
    method: "PATCH",
    data: {
      version: bootstrap.preferences.version,
      default_view: "month",
      remember_view: false,
      time_zone: "Asia/Seoul",
      locale: "en-US",
      week_start: 1,
    },
  });
  const primary = bootstrap.primary_calendar_id;
  const team = (
    await call("/api/calendar/calendars", {
      method: "POST",
      data: {
        name: "Product & Design",
        kind: "shared",
        time_zone: "Asia/Seoul",
      },
    })
  ).calendar;
  const ops = (
    await call("/api/calendar/calendars", {
      method: "POST",
      data: {
        name: "Company & Operations",
        kind: "shared",
        time_zone: "Asia/Seoul",
      },
    })
  ).calendar;
  for (const [calendar, color] of [
    [primary, "#5277d5"],
    [team.id, "#a35ec4"],
    [ops.id, "#409d7c"],
  ])
    await db
      .prepare("UPDATE calendar_subscriptions SET color=? WHERE calendar_id=?")
      .bind(color, calendar)
      .run();
  for (const id of ["maya", "daniel"])
    await call(`/api/calendar/calendars/${team.id}/acl`, {
      method: "POST",
      data: { scope_type: "user", scope_key: id, role: "writer" },
    });
  const events = [
    [2, 9, "Weekly team sync", primary],
    [3, 14, "Customer discovery", team.id],
    [4, 10, "Design critique", team.id],
    [5, 15, "Partner onboarding", ops.id],
    [6, 11, "Sprint retrospective", primary],
    [9, 9, "Weekly team sync", primary],
    [9, 14, "Atlas release candidate", team.id],
    [10, 10, "Customer interviews", team.id],
    [10, 15, "Operations planning", ops.id],
    [11, 13, "Design handoff", team.id],
    [12, 10, "Atlas launch review", team.id],
    [12, 15, "Budget checkpoint", ops.id],
    [13, 11, "Customer success sync", primary],
    [16, 9, "Weekly team sync", primary],
    [17, 14, "Customer walkthrough", team.id],
    [18, 10, "Partner enablement", ops.id],
    [19, 13, "Launch communications", team.id],
    [20, 11, "Release readiness", primary],
    [23, 9, "Weekly team sync", primary],
    [24, 10, "Atlas portal launch", team.id],
    [25, 14, "Customer onboarding", team.id],
    [26, 11, "Company all-hands", ops.id],
    [27, 15, "Launch retrospective", primary],
    [28, 9, "Next month planning", ops.id],
  ];
  for (const [day, hour, title, calendar] of events) {
    const clock = (value) => `${dates.day(day)}T${String(value).padStart(2, "0")}:00:00+09:00`;
    await call(`/api/calendar/calendars/${calendar}/events`, {
      method: "POST",
      data: {
        title,
        start: { date_time: clock(hour), time_zone: "Asia/Seoul" },
        end: { date_time: clock(hour + 1), time_zone: "Asia/Seoul" },
        description_html:
          "<p>Review launch readiness, confirm customer onboarding and align on launch-day ownership.</p>",
        location: { label: "Northstar HQ - Studio A" },
        ...(title === "Atlas launch review"
          ? { attendees: ["maya", "daniel", "sophia"].map((user_id) => ({ user_id })) }
          : {}),
      },
    });
  }
  const folder = async (name, parent_id = null) =>
    (await call("/api/drive/folders", { method: "POST", data: { name, parent_id } })).item;
  const project = await folder("Atlas - Customer portal");
  const brand = await folder("Brand & Marketing");
  const operations = await folder("Company operations");
  for (const name of ["Customer success", "Engineering", "Finance & Legal"]) await folder(name);
  await folder("Launch planning", project.id);
  const research = await folder("Customer research", project.id);
  await folder("Design handoff", project.id);
  const upload = async (name, bytes, content_type, parent_id = null) => {
    const { upload } = await call("/api/drive/uploads", {
      method: "POST",
      data: { name, parent_id, content_type, size: bytes.length },
    });
    await call(`/api/drive/uploads/${upload.id}/content`, { method: "PUT", bytes });
    return (await call(`/api/drive/uploads/${upload.id}/complete`, { method: "POST", data: {} }))
      .item;
  };
  const pdf = deliveryBrief(dates),
    briefName = `Atlas - ${dates.quarter} delivery brief.pdf`;
  await upload(briefName, pdf, "application/pdf", project.id);
  await upload("Team operations brief.pdf", pdf, "application/pdf");
  await upload("Operating plan.pdf", pdf, "application/pdf", operations.id);
  await upload(
    "Launch checklist.txt",
    Buffer.from(
      "ATLAS LAUNCH CHECKLIST\n\nProduct review complete\nEngineering release approved\nCustomer walkthrough ready\nLaunch-day ownership confirmed\n",
    ),
    "text/plain",
    project.id,
  );
  await upload(
    "Customer interview notes.txt",
    Buffer.from(
      "Customer research synthesis\n\nKey themes: simpler onboarding, clear permissions, faster document sharing.\n",
    ),
    "text/plain",
    research.id,
  );
  await upload(
    "Campaign plan.csv",
    Buffer.from(
      "Campaign,Owner,Status\nAtlas launch,Maya Chen,In progress\nPartner workshop,Ethan Park,Ready\n",
    ),
    "text/csv",
    brand.id,
  );
  await upload(
    "Team directory.csv",
    Buffer.from(
      "Name,Team\nAlex Morgan,Operations\nMaya Chen,Product\nDaniel Kim,Engineering\nSophia Reed,Design\n",
    ),
    "text/csv",
  );
  await upload(
    "Launch calendar.txt",
    Buffer.from(
      `Launch review: ${dates.day(12)}\nCustomer walkthrough: ${dates.day(17)}\nAtlas launch: ${dates.day(24)}\n`,
    ),
    "text/plain",
  );
  for (const id of ["maya", "daniel", "sophia"]) {
    const { item } = await call(`/api/drive/items/${project.id}`);
    await call(`/api/drive/items/${project.id}/permissions/${id}`, {
      method: "PUT",
      data: { version: item.version, role: id === "sophia" ? "commenter" : "editor" },
    });
  }
  const uploadName = `Atlas - ${dates.quarter} delivery brief (review copy).pdf`;
  const uploadPath = join(temp, uploadName);
  await writeFile(uploadPath, pdf);
  return { origin, password, project: project.name, briefName, uploadName, uploadPath };
}

async function launchBrowser(headed) {
  try {
    return await chromium.launch({ headless: !headed });
  } catch (error) {
    if (!String(error.message).includes("playwright install")) throw error;
    say("Installing Playwright Chromium for the first run...");
    await runNode(join(root, "node_modules/playwright/cli.js"), ["install", "chromium"]);
    return chromium.launch({ headless: !headed });
  }
}

async function capture(browser, demo, dates, stage) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Asia/Seoul",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return /^https?:$/.test(url.protocol) && url.origin !== demo.origin
      ? route.abort()
      : route.continue();
  });
  let count = 0;
  const shoot = async (name) => {
    assert.equal(scenes[count], name, "Screenshot order changed");
    for (const toast of await page
      .getByRole("button", { name: "Dismiss notification", exact: true })
      .all())
      if (await toast.isVisible()) await toast.click();
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(stage, name),
      type: "jpeg",
      quality: 90,
      fullPage: true,
      animations: "disabled",
      caret: "hide",
    });
    count++;
    say(`${count}/${scenes.length}: ${name}`);
  };
  await page.goto(`${demo.origin}/login`);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(demo.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const message = page.getByRole("button", {
    name: /maya\.chen@northstar\.example Atlas launch review/,
  });
  await message.waitFor({ state: "visible" });
  await shoot(scenes[0]);
  await message.click();
  await page
    .frameLocator("iframe")
    .locator("body")
    .filter({ hasText: "Hi Alex," })
    .waitFor({ state: "visible" });
  await shoot(scenes[1]);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const undock = page.getByRole("button", { name: "Open in compose window", exact: true });
  await undock.click();
  const expand = page.getByRole("button", { name: "Expand composer", exact: true });
  await expand.click();
  await page
    .getByRole("button", { name: "Restore default size", exact: true })
    .waitFor({ state: "visible" });
  await page
    .getByRole("textbox", { name: "Message body", exact: true })
    .fill(
      `Hi Maya,\nThanks for the update. The operations checklist is ready, and Customer Success has confirmed the ${dates.day(17)} walkthrough.\nI have added launch-day owners and support coverage to the delivery brief. We can review the final handoff together at our launch review.\nBest,\nAlex Morgan\nProduct Operations - Northstar Studio`,
    );
  await page.getByText("Draft saved", { exact: true }).waitFor({ state: "visible" });
  const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
  assert.ok(
    send && send.y >= 0 && send.y + send.height <= 720,
    "Reply controls must fit in the screenshot",
  );
  await shoot(scenes[2]);
  await page.getByRole("button", { name: "Save and close draft", exact: true }).click();
  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  const launch = page.getByRole("button", { name: /^Atlas launch review,/ });
  await launch.waitFor({ state: "visible" });
  await shoot(scenes[3]);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Event title", exact: true });
  await title.fill("Atlas customer onboarding workshop");
  await page.getByLabel("Start date", { exact: true }).fill(dates.day(18));
  await page.getByLabel("End date", { exact: true }).fill(dates.day(18));
  await page.getByLabel("Start time", { exact: true }).fill("14:00");
  await page.getByLabel("End time", { exact: true }).fill("15:00");
  await page
    .getByRole("textbox", { name: "Guests", exact: true })
    .fill("maya.chen@northstar.example, daniel.kim@northstar.example");
  await page
    .getByRole("textbox", { name: "Location", exact: true })
    .fill("Northstar HQ - Studio A");
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill(
      "Walk through the Atlas onboarding journey with Product and Customer Success. Review the launch checklist and confirm team ownership.",
    );
  await page.getByRole("combobox", { name: "Calendar", exact: true }).click();
  await page.getByRole("option", { name: "Product & Design", exact: true }).click();
  await title.scrollIntoViewIfNeeded();
  await shoot(scenes[4]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("heading", { name: "Event created.", exact: true })
    .waitFor({ state: "visible" });
  await launch.click();
  await page.getByRole("button", { name: "Manage guests", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Add guests", exact: true })
    .fill("ethan.park@northstar.example");
  await page.getByRole("textbox", { name: "Add guests", exact: true }).press("Tab");
  await shoot(scenes[5]);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page
    .getByRole("heading", { name: "Guests invited.", exact: true })
    .waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "Sharing", exact: true }).click();
  for (const name of ["Description", "Organizer"])
    await page.getByRole("checkbox", { name, exact: true }).check();
  await page.getByRole("button", { name: "Create share link", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Share link URL", exact: true })
    .waitFor({ state: "visible" });
  await shoot(scenes[6]);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("link", { name: "Drive", exact: true }).click();
  await page
    .getByRole("button", { name: "Team directory.csv", exact: true })
    .waitFor({ state: "visible" });
  await shoot(scenes[7]);
  await page.getByRole("button", { name: demo.project, exact: true }).dblclick();
  await page
    .getByRole("heading", { name: demo.project, exact: true })
    .waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: demo.briefName, exact: true })
    .waitFor({ state: "visible" });
  await shoot(scenes[8]);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "File upload", exact: true }).click();
  await (await choosing).setFiles(demo.uploadPath);
  await page.getByText("Uploads complete", { exact: true }).waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: demo.uploadName, exact: true })
    .waitFor({ state: "visible" });
  await shoot(scenes[9]);
  await page.getByRole("button", { name: "Dismiss completed uploads", exact: true }).click();
  await page.getByRole("button", { name: demo.briefName, exact: true }).dblclick();
  await page.waitForFunction(() =>
    document.querySelector(".drive-pdf-accessible-text")?.textContent.includes("NORTHSTAR STUDIO"),
  );
  await shoot(scenes[10]);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("tab", { name: "Public links", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Link password (optional)", exact: true })
    .fill("Northstar2026!");
  await page.getByRole("button", { name: "Create public link", exact: true }).click();
  await page
    .getByRole("textbox", { name: "New share link", exact: true })
    .waitFor({ state: "visible" });
  await page.getByText("Password protected link", { exact: true }).waitFor({ state: "visible" });
  await shoot(scenes[11]);
  assert.equal(count, scenes.length);
  assert.deepEqual(errors, [], "Uncaught errors in the demo UI");
  await context.close();
}

async function makeGif(source, destination, delay) {
  const images = [];
  for (const name of scenes) {
    const image = await readFile(join(source, name));
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.width, 1280, name);
    assert.equal(metadata.height, 720, name);
    images.push(image);
  }
  await sharp(images, { join: { animated: true } })
    .gif({ delay: scenes.map(() => delay), loop: 0, effort: 7, keepDuplicateFrames: true })
    .toFile(destination);
  const metadata = await sharp(destination, { animated: true }).metadata();
  assert.equal(metadata.pages, scenes.length, "Unexpected GIF frame count");
  assert.ok(
    metadata.delay.every((value) => value === delay),
    "Unexpected GIF frame timing",
  );
  assert.equal(metadata.loop, 0, "GIF must loop indefinitely");
}

async function updateCaption(delay) {
  const path = join(root, "README.md");
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const seconds = delay / 1000;
  const updated = text.replace(
    /Slides advance every [\d.]+ seconds?\./,
    `Slides advance every ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
  );
  if (updated !== text) await writeFile(path, updated);
}

async function main() {
  const config = options();
  if (config.help) {
    console.log(`Usage: npm run screenshots -- [options]

  --interval <seconds>  GIF slide duration (default: 2)
  --gif-only            Rebuild the GIF from the 12 existing JPEG screenshots
  --skip-build          Use an existing dist/ build for a full capture
  --headed              Show the capture browser
  --help, -h            Show this help

The default flow builds the app, seeds a temporary local instance with fictional
company data, captures 12 screens, and writes screenshots/officeflare-demo.gif.
Chromium is installed automatically on the first full run if it is missing.
All temporary browser and Worker state is cleaned up after success or failure.
The README slide-duration caption is kept in sync with --interval.`);
    return;
  }
  process.chdir(root);
  const temp = await mkdtemp(join(tmpdir(), "officeflare-screenshots-"));
  const stage = join(temp, "screenshots");
  await mkdir(stage);
  let browser, mf, cleanupPromise;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      try {
        await browser?.close();
      } finally {
        try {
          await mf?.dispose();
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
    })());
  const interrupt = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (!config["gif-only"]) {
      if (!config["skip-build"]) {
        say("Building the app and local Worker...");
        await runNode(join(root, "node_modules/typescript/bin/tsc"), [
          "--project",
          "tsconfig.i18n-tests.json",
        ]);
        await runViteBuild();
        await runWrangler(["deploy", "--dry-run", "--outdir", "dist"]);
      }
      browser = await launchBrowser(config.headed);
      say("Preparing fictional Northstar Studio data...");
      mf = await createDemo();
      const dates = demoDates(),
        demo = await seedDemo(mf, dates, temp);
      say("Capturing Mail, Calendar and Drive...");
      await capture(browser, demo, dates, stage);
    }
    say(`Encoding ${scenes.length} slides at ${config.delay / 1000} seconds each...`);
    const gif = join(stage, "officeflare-demo.gif");
    await makeGif(config["gif-only"] ? output : stage, gif, config.delay);
    await mkdir(output, { recursive: true });
    if (!config["gif-only"])
      for (const name of scenes) await copyFile(join(stage, name), join(output, name));
    // Rename within the destination directory so an interrupted encode keeps the old GIF.
    const pending = join(output, `.officeflare-demo-${randomUUID()}.gif`);
    try {
      await copyFile(gif, pending);
      await rename(pending, join(output, "officeflare-demo.gif"));
    } finally {
      await rm(pending, { force: true });
    }
    await updateCaption(config.delay);
    say(
      `Done: screenshots/officeflare-demo.gif (${scenes.length} slides, ${(scenes.length * config.delay) / 1000}s loop)`,
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await cleanup();
  }
}

await main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
