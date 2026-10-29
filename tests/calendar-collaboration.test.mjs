import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../src/db/schema.ts";
import { fixture } from "./calendar-fixture.mjs";
const day = (date = "2026-12-10") => ({
  title: "Collaboration meeting",
  start: { date },
  end: {
    date: new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10),
  },
});
test("Calendar collaboration: grants, invitation delivery and verified registrations", async (t) => {
  const f = await fixture(t),
    { db, call, create, event, patch, bucket, flush, raw, mf, tokens, counts } = f;
  const api = async (path, { actor = "alice", method = "GET", data, expected = 200 } = {}) => {
    const response = await mf.dispatchFetch("https://office.test/api" + path, {
      method,
      headers: {
        Authorization: `Bearer ${tokens[actor]}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(response.status, expected, await response.clone().text());
    return response.status === 204 ? null : response.json();
  };
  const sent = async () => {
    const files = await bucket.list({ prefix: "test-sent/" });
    return Promise.all(files.objects.map(async (file) => (await bucket.get(file.key)).json()));
  };
  const deliveries = async (id) =>
    (await call(`/calendars/primary/events/${id}/invitation-deliveries`)).deliveries;
  const flushAfterSnapshot = async (id, query) => {
    const response = await f.faults.fetch("https://office.test/test-calendar/flush", {
      method: "POST",
      body: JSON.stringify({ ids: [id], after_snapshot: query }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  const publicCall = (path, options = {}) => call(path, { actor: null, ...options });
  const createLink = async (id, extra = {}) =>
    (
      await call(`/calendars/primary/events/${id}/share-links`, {
        method: "POST",
        data: { mode: "join", ...extra },
        expected: 201,
      })
    ).link;
  const registerSession = async (link, address) => {
    const base = `/public/share-links/${link.token}`,
      session = await publicCall(base + "/sessions", {
        method: "POST",
        data: {},
        expected: 201,
      }),
      headers = { "X-Calendar-Link-Session": session.session_token };
    const verification = await publicCall(base + "/email-challenges", {
      method: "POST",
      data: { email_address: address },
      headers,
      expected: 201,
    });
    await flush();
    const message = (await sent())
      .filter((value) => value.to.includes(address) && value.subject.includes("Verify"))
      .at(-1);
    assert.ok(message);
    const code = message.text.match(/\b\d{6}\b/)[0];
    await publicCall(`${base}/email-challenges/${verification.challenge_id}/verify`, {
      method: "POST",
      data: { code },
      headers,
    });
    return { base, headers, session };
  };
  let primary, meeting, externalToken, capacityEvent, join, firstReg, secondReg;
  await t.test("all collaboration DDL columns agree with Drizzle", async () => {
    for (const name of [
      "calendar_workspace_settings",
      "calendar_groups",
      "calendar_group_members",
      "calendar_working_hours",
      "calendar_event_attendees",
      "calendar_attendee_occurrence_responses",
      "calendar_attendee_exclusions",
      "calendar_invitation_tokens",
      "calendar_share_links",
      "calendar_link_sessions",
      "calendar_external_email_challenges",
      "calendar_registration_policies",
      "calendar_registration_instances",
      "calendar_event_registrations",
      "calendar_registration_manage_tokens",
      "calendar_invitation_deliveries",
      "calendar_outbox",
      "calendar_public_limits",
      "calendar_event_attachments",
      "calendar_time_proposals",
    ]) {
      const model = schema[name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())],
        columns = await db.prepare(`PRAGMA table_info(${name})`).all();
      assert.deepEqual(
        columns.results.map((value) => value.name).sort(),
        Object.keys(getTableColumns(model)).sort(),
        name,
      );
    }
  });
  await t.test(
    "transactional system sender and personal organizer mailboxes are configured independently",
    async () => {
      await db.batch([
        db.prepare(
          "INSERT INTO mail_domains(id,name,outbound_connection_id,outbound_enabled) VALUES('calendar-domain','calendar.test','cloudflare-bindings',1)",
        ),
        db.prepare(
          "INSERT INTO mail_mailboxes(id,owner_user_id,name,status) VALUES('system-calendar-box','admin','Calendar sender','active')",
        ),
        db.prepare(
          "INSERT INTO mail_addresses(id,domain_id,mailbox_id,local_part,send_enabled) VALUES('system-calendar-address','calendar-domain','system-calendar-box','calendar',1)",
        ),
        db.prepare(
          "INSERT INTO roles(id,key,label) VALUES('calendar-mail-test','calendar-mail-test','Calendar sender test')",
        ),
        db.prepare(
          "INSERT INTO role_permissions(role_id,permission_key) VALUES('calendar-mail-test','mail.access')",
        ),
        db.prepare(
          "INSERT INTO user_roles(user_id,role_id) VALUES('alice','calendar-mail-test'),('bob','calendar-mail-test')",
        ),
        db.prepare(
          "INSERT INTO mail_mailboxes(id,owner_user_id,name,kind,status) VALUES('alice-calendar-box','alice','Alice personal mail','personal','active'),('bob-calendar-box','bob','Bob personal mail','personal','active')",
        ),
        db.prepare(
          "INSERT INTO mail_addresses(id,domain_id,mailbox_id,local_part,is_primary,send_enabled) VALUES('alice-calendar-address','calendar-domain','alice-calendar-box','alice',1,1),('bob-calendar-address','calendar-domain','bob-calendar-box','bob',1,1)",
        ),
      ]);
      await call("/admin/settings", { actor: "alice", expected: 403 });
      await call("/admin/settings", {
        actor: "admin",
        method: "PATCH",
        data: { version: 1, system_address_id: "system-calendar-address" },
      });
      primary = (await call("/bootstrap")).primary_calendar_id;
    },
  );
  await t.test(
    "one claim commits internal inbox and external outbox; internal invitees need no Calendar access",
    async () => {
      await db
        .prepare(
          "INSERT INTO notification_preferences(user_id,enabled,rules_json) VALUES('no-calendar',0,'{}')",
        )
        .run();
      meeting = await create({
        ...day(),
        title: "한글 회의 🗓️".repeat(20),
        description_html: "<p>Private meeting details</p>",
        attendees: [
          { user_id: "no-calendar" },
          {
            email_address: "external@example.test",
            display_name: "External attendee",
          },
          { email_address: "other@example.test" },
        ],
      });
      const rows = await deliveries(meeting.event.id);
      assert.equal(rows.filter((value) => value.channel === "notification_center").length, 1);
      assert.equal(rows.filter((value) => value.channel === "email").length, 2);
      assert.equal(
        rows.find((value) => value.recipient_user_id === "no-calendar").status,
        "inbox_committed",
      );
      const inbox = await api("/notifications?service=calendar", {
        actor: "no-calendar",
      });
      assert.equal(inbox.notifications.length, 1);
      assert.equal(inbox.notifications[0].required, true);
      const own = await call("/inbox-invitations", { actor: "no-calendar" });
      assert.equal(own.invitations.length, 1);
      const detail = await call(`/inbox-invitations/${own.invitations[0].id}`, {
        actor: "no-calendar",
      });
      assert.equal(detail.event.title, meeting.event.title);
      assert.equal(detail.attendees.length, 1);
      await call(`/inbox-invitations/${own.invitations[0].id}`, {
        actor: "bob",
        expected: 404,
      });
      await api("/notifications/preferences", {
        actor: "no-calendar",
        method: "PUT",
        data: {
          enabled: false,
          rules: { "type:calendar.invited": false },
          version: 1,
        },
        expected: 400,
      });
      await call(`/inbox-invitations/${own.invitations[0].id}/rsvp`, {
        actor: "no-calendar",
        method: "POST",
        data: { version: detail.attendee.version, response_status: "accepted" },
      });
    },
  );
  await t.test(
    "external emails carry actual recipient-specific ICS attachments with valid folding and no internal email",
    async () => {
      await flush();
      const messages = await sent();
      assert.equal(messages.length, 2);
      assert.ok(messages.every((value) => !value.to.includes("no-calendar@office.test")));
      const message = messages.find((value) => value.to.includes("external@example.test"));
      assert.equal(message.from, "alice@calendar.test");
      assert.deepEqual(message.cc, []);
      assert.equal(message.attachments.length, 1);
      const file = message.attachments[0];
      assert.equal(file.filename, "invite.ics");
      assert.equal(file.disposition, "attachment");
      assert.match(file.type, /text\/calendar.*method=REQUEST/);
      const ics = Buffer.from(file.content, "base64").toString("utf8");
      assert.match(ics, /METHOD:REQUEST/);
      assert.match(
        ics.replace(/\r\n /g, ""),
        /ORGANIZER;SENT-BY="mailto:alice@calendar.test":mailto:alice@office.test/,
      );
      assert.match(ics, /DTSTART;VALUE=DATE:20261210/);
      assert.match(ics, /DTEND;VALUE=DATE:20261211/);
      assert.match(ics.replace(/\r\n /g, ""), /ATTENDEE.*external@example.test/);
      assert.doesNotMatch(ics, /other@example.test|no-calendar@office.test/);
      assert.ok(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75));
      assert.ok(ics.endsWith("\r\n"));
      externalToken = message.text.match(/ofci_[A-Za-z0-9_-]{43}/)[0];
      const external = await publicCall(`/invitations/${externalToken}`);
      assert.equal(external.attendees.length, 1);
      assert.equal(external.event.title, meeting.event.title);
      const before = (await sent()).length;
      await flush();
      assert.equal((await sent()).length, before);
    },
  );
  await t.test(
    "invitation GET cannot RSVP, and external response only updates its attendee",
    async () => {
      const detail = await publicCall(`/invitations/${externalToken}`);
      assert.equal(detail.attendee.response_status, "needs_action");
      await publicCall(`/invitations/${externalToken}/rsvp`, {
        method: "POST",
        data: { version: detail.attendee.version, response_status: "accepted" },
      });
      const mine = await publicCall(`/invitations/${externalToken}`);
      assert.equal(mine.attendee.response_status, "accepted");
      await publicCall(`/invitations/${externalToken}/rsvp`, {
        method: "POST",
        data: {
          version: mine.attendee.version,
          response_status: "declined",
          attendee_id: "anything",
        },
        expected: 400,
      });
    },
  );
  await t.test(
    "updates and cancellation preserve UID and increase SEQUENCE, sending CANCEL attachments",
    async () => {
      const uid = (await event(meeting.event.id)).i_cal_uid;
      await patch(meeting.event.id, { title: "Updated meeting" });
      await flush();
      const updates = (await sent()).filter(
        (value) => value.attachments?.[0]?.filename === "update.ics",
      );
      assert.equal(updates.length, 2);
      const ics = Buffer.from(updates[0].attachments[0].content, "base64").toString();
      assert.match(ics, new RegExp(`UID:${uid}`));
      assert.match(ics, /SEQUENCE:1/);
      await call(
        `/calendars/primary/events/${meeting.event.id}?version=${(await event(meeting.event.id)).version}`,
        { method: "DELETE", expected: 204 },
      );
      await flush();
      const cancelled = (await sent()).filter(
        (value) => value.attachments?.[0]?.filename === "cancel.ics",
      );
      assert.equal(cancelled.length, 2);
      const cancel = Buffer.from(cancelled[0].attachments[0].content, "base64").toString();
      assert.match(cancel, /METHOD:CANCEL/);
      assert.match(cancel, /STATUS:CANCELLED/);
      assert.match(cancel, new RegExp(`UID:${uid}`));
      assert.match(cancel, /SEQUENCE:2/);
      const own = await publicCall(`/invitations/${externalToken}`);
      assert.equal(own.is_revoked, true);
      assert.equal(Object.hasOwn(own.event, "description_html"), false);
    },
  );
  await t.test("send_updates none suppresses only external invitations", async () => {
    const value = await create({
      ...day("2027-01-01"),
      send_updates: "none",
      attendees: [{ user_id: "bob" }, { email_address: "none@example.test" }],
    });
    const list = await deliveries(value.event.id);
    assert.equal(list.find((value) => value.channel === "email").status, "suppressed");
    assert.equal(
      list.find((value) => value.channel === "notification_center").status,
      "inbox_committed",
    );
  });
  await t.test(
    "scope claims prevent invitation, audit and inbox writes on stale edits or SQL failure",
    async () => {
      const value = await create(day("2027-01-02")),
        before = await counts(),
        rowsBefore = await db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM calendar_event_attendees) a,(SELECT COUNT(*) FROM calendar_invitation_deliveries) d,(SELECT COUNT(*) FROM notification_inbox) n",
          )
          .first();
      await call(`/calendars/primary/events/${value.event.id}/attendees`, {
        method: "POST",
        data: { version: 1, attendees: [{ user_id: "bob" }] },
        fault: true,
        headers: { "x-test-fail-batch": "true" },
        expected: 500,
      });
      assert.deepEqual(await counts(), before);
      assert.deepEqual(
        await db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM calendar_event_attendees) a,(SELECT COUNT(*) FROM calendar_invitation_deliveries) d,(SELECT COUNT(*) FROM notification_inbox) n",
          )
          .first(),
        rowsBefore,
      );
    },
  );
  await t.test("group grants follow membership while invitations expand a snapshot", async () => {
    await call("/bootstrap", { actor: "bob" });
    const group = (
      await call("/groups", {
        method: "POST",
        data: { name: "Team", member_ids: ["bob"] },
        expected: 201,
      })
    ).group;
    const cal = (
      await call("/calendars", {
        method: "POST",
        data: { name: "Shared group" },
        expected: 201,
      })
    ).calendar;
    await call(`/calendars/${cal.id}/acl`, {
      method: "POST",
      data: { scope_type: "group", scope_key: group.id, role: "reader" },
      expected: 201,
    });
    await call(`/calendars/${cal.id}`, { actor: "bob" });
    const groupEvent = await create({
      ...day("2027-01-03"),
      attendees: [{ group_id: group.id }],
    });
    await call(`/groups/${group.id}`, {
      method: "PUT",
      data: { version: 1, name: "Team", member_ids: [] },
    });
    await call(`/calendars/${cal.id}`, { actor: "bob", expected: 404 });
    const invited = (await call(`/calendars/primary/events/${groupEvent.event.id}/attendees`))
      .attendees;
    assert.equal(invited[0].user_id, "bob");
  });
  await t.test(
    "calendar links hide private details; explicit event links reveal only selected fields",
    async () => {
      const privateEvent = await create({
          ...day("2027-01-05"),
          title: "Private title",
          description_html: "<p>Secret</p>",
          location: "Secret room",
        }),
        calendarLink = (
          await call("/calendars/primary/share-links", {
            method: "POST",
            data: { shared_fields: ["title", "description_html", "location"] },
            expected: 201,
          })
        ).link;
      const visible = await publicCall(
        `/public/share-links/${calendarLink.token}/events?time_min=2027-01-04T00%3A00%3A00Z&time_max=2027-01-07T00%3A00%3A00Z`,
      );
      const redacted = visible.events.find((value) => value.id === privateEvent.event.id);
      assert.equal(redacted.title, "Busy");
      assert.equal(Object.hasOwn(redacted, "description_html"), false);
      const link = await createLink(privateEvent.event.id, { mode: "view" }),
        detail = await publicCall(`/public/share-links/${link.token}`);
      assert.equal(detail.event.title, "Private title");
      assert.equal(Object.hasOwn(detail.event, "description_html"), false);
      await publicCall(`/public/share-links/${link.token}/registrations`, {
        method: "POST",
        data: { display_name: "Test" },
        expected: 403,
      });
    },
  );
  await t.test("password sessions expire on policy change, rotation and revocation", async () => {
    const value = await create(day("2027-01-06")),
      link = await createLink(value.event.id, {
        mode: "view",
        password: "password for link",
      }),
      base = `/public/share-links/${link.token}`;
    assert.equal((await publicCall(base)).locked, true);
    await publicCall(base + "/sessions", {
      method: "POST",
      data: { password: "wrong password" },
      expected: 403,
    });
    const session = await publicCall(base + "/sessions", {
        method: "POST",
        data: { password: "password for link" },
        expected: 201,
      }),
      headers = { "X-Calendar-Link-Session": session.session_token };
    await publicCall(base, { headers });
    const changed = await call(`/share-links/${link.id}`, {
      method: "PATCH",
      data: { version: 1, shared_fields: ["title", "location"] },
    });
    await publicCall(base, { headers, expected: 403 });
    const rotated = await call(`/share-links/${link.id}/rotate`, {
      method: "POST",
      data: { version: changed.link.version },
    });
    await publicCall(base, { expected: 404 });
    await call(`/share-links/${link.id}?version=${rotated.link.version}`, {
      method: "DELETE",
      expected: 204,
    });
    await publicCall(`/public/share-links/${rotated.link.token}`, {
      expected: 404,
    });
  });
  await t.test("public email challenge is session-bound, single-use and capped", async () => {
    capacityEvent = await create(day("2027-02-01"));
    await call(`/calendars/primary/events/${capacityEvent.event.id}/registration-policy`, {
      method: "PUT",
      data: { version: 0, capacity: 1, waitlist_enabled: true },
    });
    join = await createLink(capacityEvent.event.id);
    const base = `/public/share-links/${join.token}`,
      session = await publicCall(base + "/sessions", {
        method: "POST",
        data: {},
        expected: 201,
      }),
      headers = { "X-Calendar-Link-Session": session.session_token };
    const result = await publicCall(base + "/email-challenges", {
      method: "POST",
      data: { email_address: "verified@example.test" },
      headers,
      expected: 201,
    });
    await publicCall(base + "/registrations", {
      method: "POST",
      data: { display_name: "Guest" },
      headers,
      expected: 403,
    });
    const second = await publicCall(base + "/sessions", {
      method: "POST",
      data: {},
      expected: 201,
    });
    await publicCall(`${base}/email-challenges/${result.challenge_id}/verify`, {
      method: "POST",
      data: { code: "123456" },
      headers: { "X-Calendar-Link-Session": second.session_token },
      expected: 400,
    });
    for (let i = 0; i < 5; i++)
      await publicCall(`${base}/email-challenges/${result.challenge_id}/verify`, {
        method: "POST",
        data: { code: "000000" },
        headers,
        expected: 400,
      });
    assert.equal(
      (
        await db
          .prepare("SELECT attempts FROM calendar_external_email_challenges WHERE id=?")
          .bind(result.challenge_id)
          .first()
      ).attempts,
      5,
    );
  });
  await t.test(
    "automatic confirmation and waitlist share capacity with invited attendees",
    async () => {
      const first = await registerSession(join, "first@example.test"),
        second = await registerSession(join, "second@example.test");
      firstReg = await publicCall(first.base + "/registrations", {
        method: "POST",
        data: { display_name: "First" },
        headers: first.headers,
        expected: 201,
      });
      secondReg = await publicCall(second.base + "/registrations", {
        method: "POST",
        data: { display_name: "Second" },
        headers: second.headers,
        expected: 201,
      });
      assert.equal(firstReg.registration.status, "confirmed");
      assert.equal(secondReg.registration.status, "waitlisted");
      assert.equal(secondReg.registration.attendee_id, null);
      const detail = await publicCall(`/public/registrations/${secondReg.manage_token}`);
      assert.equal(detail.invitation, null);
      await publicCall(`/public/registrations/${secondReg.manage_token}/event.ics`, {
        expected: 403,
      });
      const list = await call(`/calendars/primary/events/${capacityEvent.event.id}/attendees`);
      assert.equal(list.attendees.length, 1);
    },
  );
  await t.test(
    "management token is independent of link revocation and cancellation promotes oldest waiter atomically",
    async () => {
      await call(`/share-links/${join.id}?version=1`, {
        method: "DELETE",
        expected: 204,
      });
      await publicCall(`/public/share-links/${join.token}`, { expected: 404 });
      await publicCall(`/public/registrations/${firstReg.manage_token}`);
      await publicCall(`/public/registrations/${firstReg.manage_token}/cancel`, {
        method: "POST",
        data: { version: firstReg.registration.version },
      });
      const promoted = await publicCall(`/public/registrations/${secondReg.manage_token}`);
      assert.equal(promoted.registration.status, "confirmed");
      assert.ok(promoted.invitation.event.title);
      const download = await raw(`/public/registrations/${secondReg.manage_token}/event.ics`, {
        actor: null,
      });
      assert.equal(download.status, 200);
      assert.match(await download.text(), /METHOD:REQUEST/);
    },
  );
  await t.test(
    "manual pending registration cannot accept itself or download private invitation details",
    async () => {
      const value = await create({
        ...day("2027-03-01"),
        description_html: "Private room link",
      });
      await call(`/calendars/primary/events/${value.event.id}/registration-policy`, {
        method: "PUT",
        data: {
          version: 0,
          approval_mode: "manual",
          capacity: 2,
          form_schema: [{ key: "reason", label: "Reason", type: "text", required: true }],
        },
      });
      const link = await createLink(value.event.id),
        session = await registerSession(link, "manual@example.test");
      await publicCall(session.base + "/registrations", {
        method: "POST",
        data: { display_name: "Manual" },
        headers: session.headers,
        expected: 400,
      });
      const reg = await publicCall(session.base + "/registrations", {
        method: "POST",
        data: { display_name: "Manual", answers: { reason: "Discussion" } },
        headers: session.headers,
        expected: 201,
      });
      assert.equal(reg.registration.status, "pending");
      await publicCall(`/public/registrations/${reg.manage_token}/rsvp`, {
        method: "POST",
        data: { version: 1, response_status: "accepted" },
        expected: 409,
      });
      await call(
        `/calendars/primary/events/${value.event.id}/registrations/${reg.registration.id}/decision`,
        { method: "POST", data: { version: 1, decision: "approve" } },
      );
      assert.equal(
        (await publicCall(`/public/registrations/${reg.manage_token}`)).registration.status,
        "confirmed",
      );
    },
  );
  await t.test(
    "an external recipient becoming internal before sending gets an inbox notification instead",
    async () => {
      const value = await create({
          ...day("2027-04-01"),
          attendees: [{ email_address: "later@example.test" }],
        }),
        pending = (await deliveries(value.event.id))[0];
      await db
        .prepare(
          "INSERT INTO users(id,email_address,password_hash) SELECT 'later-user','later@example.test',password_hash FROM users WHERE id='bob'",
        )
        .run();
      const before = (await sent()).length;
      await flush([pending.id]);
      assert.equal((await sent()).length, before);
      const delivery = (await deliveries(value.event.id))[0];
      assert.equal(delivery.channel, "notification_center");
      assert.equal(delivery.recipient_user_id, "later-user");
      assert.equal(delivery.status, "inbox_committed");
    },
  );
  await t.test(
    "provider unknown acceptance is not retried or manually resent without resolution",
    async () => {
      const value = await create({
          ...day("2027-04-02"),
          attendees: [{ email_address: "unknown@example.test" }],
        }),
        pending = (await deliveries(value.event.id))[0];
      await bucket.put("test-mode", "unknown");
      await flush([pending.id]);
      await bucket.delete("test-mode");
      assert.equal((await deliveries(value.event.id))[0].status, "unknown");
      const before = (await sent()).length;
      await flush([pending.id]);
      assert.equal((await sent()).length, before);
      await call(`/calendars/primary/events/${value.event.id}/invitations/resend`, {
        method: "POST",
        data: { version: (await event(value.event.id)).version },
        expected: 409,
      });
    },
  );
  await t.test("concurrent RSVP claims allocate the last seat once", async () => {
    const value = await create({
      ...day("2027-05-01"),
      attendees: [{ user_id: "bob" }, { user_id: "no-calendar" }],
    });
    await call(`/calendars/primary/events/${value.event.id}/registration-policy`, {
      method: "PUT",
      data: { version: 0, capacity: 1 },
    });
    const attendees = (await call(`/calendars/primary/events/${value.event.id}/attendees`))
      .attendees;
    const results = await Promise.all(
      attendees.map((attendee) =>
        raw(`/inbox-invitations/${attendee.id}/rsvp`, {
          actor: attendee.user_id,
          method: "POST",
          data: { version: 1, response_status: "accepted" },
        }),
      ),
    );
    assert.deepEqual(results.map((value) => value.status).sort(), [200, 409]);
    assert.equal(
      (await call(`/calendars/primary/events/${value.event.id}/attendees`)).attendees.filter(
        (value) => value.response_status === "accepted",
      ).length,
      1,
    );
  });
  await t.test(
    "concurrent verified registrations become confirmed and waitlisted without overbooking",
    async () => {
      const value = await create({
        ...day("2027-05-05"),
        recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      });
      await call(`/calendars/primary/events/${value.event.id}/registration-policy`, {
        method: "PUT",
        data: { version: 0, capacity: 1 },
      });
      const link = await createLink(value.event.id),
        sessions = await Promise.all(
          ["race-a@example.test", "race-b@example.test"].map((address) =>
            registerSession(link, address),
          ),
        );
      const results = await Promise.all(
        sessions.map((session, index) =>
          publicCall(session.base + "/registrations", {
            method: "POST",
            headers: session.headers,
            data: {
              display_name: "Race " + index,
              occurrence_key: "d:2027-05-06",
            },
            expected: 201,
          }),
        ),
      );
      assert.deepEqual(results.map((value) => value.registration.status).sort(), [
        "confirmed",
        "waitlisted",
      ]);
      const confirmed = await db
        .prepare(
          "SELECT COUNT(*) n FROM calendar_event_registrations WHERE event_id=? AND status='confirmed'",
        )
        .bind(value.event.id)
        .first();
      assert.equal(confirmed.n, 1);
    },
  );
  await t.test(
    "personal mailbox aliases are internal and inactive internal accounts never become email recipients",
    async () => {
      await db.batch([
        db.prepare(
          "INSERT INTO mail_mailboxes(id,owner_user_id,name,kind,status) VALUES('alias-box','no-calendar','Alias','personal','disabled')",
        ),
        db.prepare(
          "INSERT INTO mail_addresses(id,domain_id,mailbox_id,local_part) VALUES('calendar-alias','calendar-domain','alias-box','colleague')",
        ),
      ]);
      const value = await create({
        ...day("2027-05-10"),
        attendees: [{ email_address: "colleague@calendar.test" }, { user_id: "no-calendar" }],
      });
      const rows = await deliveries(value.event.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].channel, "notification_center");
      assert.equal(rows[0].recipient_user_id, "no-calendar");
      await db.prepare("UPDATE users SET disabled_at=unixepoch() WHERE id='no-calendar'").run();
      const disabled = await create({
        ...day("2027-05-11"),
        attendees: [{ email_address: "colleague@calendar.test" }],
      });
      assert.equal((await deliveries(disabled.event.id))[0].status, "suppressed");
      assert.equal((await deliveries(disabled.event.id))[0].channel, "notification_center");
      await db.prepare("UPDATE users SET disabled_at=NULL WHERE id='no-calendar'").run();
    },
  );
  await t.test(
    "recurring ICS includes VTIMEZONE and original RECURRENCE-ID for a moved exception",
    async () => {
      const value = await create({
        title: "DST meeting",
        start: {
          date_time: "2026-03-01T09:00:00-05:00",
          time_zone: "America/New_York",
        },
        end: {
          date_time: "2026-03-01T10:00:00-05:00",
          time_zone: "America/New_York",
        },
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
        attendees: [{ email_address: "dst@example.test" }],
      });
      await flush((await deliveries(value.event.id)).map((value) => value.id));
      await patch(value.event.id, {
        scope: "single",
        occurrence_key: "t:2026-03-08T13:00:00Z",
        start: {
          date_time: "2026-03-08T11:00:00-04:00",
          time_zone: "America/New_York",
        },
        end: {
          date_time: "2026-03-08T12:00:00-04:00",
          time_zone: "America/New_York",
        },
      });
      await flush((await deliveries(value.event.id)).map((value) => value.id));
      const messages = (await sent()).filter((value) => value.to.includes("dst@example.test")),
        initial = Buffer.from(
          messages.find((value) => value.attachments[0].filename === "invite.ics").attachments[0]
            .content,
          "base64",
        ).toString(),
        changed = Buffer.from(
          messages.find((value) => value.attachments[0].filename === "update.ics").attachments[0]
            .content,
          "base64",
        ).toString();
      assert.match(initial, /BEGIN:VTIMEZONE/);
      assert.match(initial, /DTSTART;TZID=America\/New_York:20260301T090000/);
      assert.match(initial, /RRULE:FREQ=WEEKLY;COUNT=3/);
      assert.match(changed, /RECURRENCE-ID:20260308T130000Z/);
      assert.match(changed, /DTSTART:20260308T150000Z/);
    },
  );
  await t.test("series splits preserve attendees and future occurrence responses", async () => {
    const value = await create({
        ...day("2027-06-01"),
        recurrence: ["RRULE:FREQ=DAILY;COUNT=4"],
        attendees: [{ user_id: "bob" }],
      }),
      attendee = (await call(`/calendars/primary/events/${value.event.id}/attendees`)).attendees[0];
    await call(`/inbox-invitations/${attendee.id}/rsvp`, {
      actor: "bob",
      method: "POST",
      data: { version: 1, response_status: "accepted" },
    });
    await call(`/inbox-invitations/${attendee.id}/rsvp`, {
      actor: "bob",
      method: "POST",
      data: {
        version: 2,
        response_status: "declined",
        scope: "single",
        occurrence_key: "d:2027-06-04",
      },
    });
    const split = await patch(value.event.id, {
        scope: "following",
        occurrence_key: "d:2027-06-03",
        title: "Future series",
      }),
      list = (await call(`/calendars/primary/events/${split.event.id}/attendees`)).attendees;
    assert.equal(list.length, 1);
    assert.equal(list[0].response_status, "accepted");
    const future = (
      await call(
        `/calendars/primary/events/${split.event.id}/attendees?occurrence_key=d%3A2027-06-04`,
      )
    ).attendees;
    assert.equal(future[0].response_status, "declined");
  });
  await t.test(
    "a registered occurrence detached from its rule retains its private management token",
    async () => {
      const value = await create({
          ...day("2027-07-01"),
          recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
        }),
        link = await createLink(value.event.id),
        session = await registerSession(link, "detach-registration@example.test"),
        reg = await publicCall(session.base + "/registrations", {
          method: "POST",
          headers: session.headers,
          data: { display_name: "Detached", occurrence_key: "d:2027-07-02" },
          expected: 201,
        });
      const changed = await patch(value.event.id, {
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
      });
      assert.equal(changed.detached_event_ids.length, 1);
      const moved = await publicCall(`/public/registrations/${reg.manage_token}`);
      assert.equal(moved.registration.event_id, changed.detached_event_ids[0]);
      assert.equal(moved.registration.occurrence_key, "");
      assert.equal(moved.invitation.event.start.date, "2027-07-02");
    },
  );
  await t.test(
    "invited copies appear in personal calendars; hiding them preserves their busy interval",
    async () => {
      const value = await create({
          ...day("2027-08-01"),
          attendees: [{ user_id: "bob" }],
        }),
        own = (await call("/bootstrap", { actor: "bob" })).primary_calendar_id,
        period =
          "/calendars/primary/events?time_min=2027-08-01T00%3A00%3A00Z&time_max=2027-08-02T00%3A00%3A00Z",
        list = await call(period, { actor: "bob" }),
        copy = list.events.find((item) => item.id === value.event.id);
      assert.ok(copy);
      assert.equal(copy.title, value.event.title);
      await call(`/copies/${copy.copy_id}?version=1`, {
        actor: "bob",
        method: "DELETE",
        expected: 204,
      });
      assert.ok(
        !(await call(period, { actor: "bob" })).events.some((item) => item.id === value.event.id),
      );
      const busy = await call("/freebusy/query", {
        actor: "bob",
        method: "POST",
        data: {
          calendar_ids: [own],
          time_min: "2027-08-01T00:00:00Z",
          time_max: "2027-08-02T00:00:00Z",
        },
      });
      assert.equal(busy.calendars[0].busy.length, 1);
    },
  );
  await t.test(
    "working hours and busy queries exclude free events and enforce calendar access",
    async () => {
      await call("/working-hours", {
        method: "PUT",
        data: {
          version: 0,
          time_zone: "Asia/Seoul",
          weekly: { 1: [{ start: "09:00", end: "18:00" }] },
          exceptions: { "2027-08-02": [{ start: "09:00", end: "12:00" }] },
        },
      });
      const value = await create({
        title: "Busy",
        start: {
          date_time: "2027-08-02T10:00:00+09:00",
          time_zone: "Asia/Seoul",
        },
        end: {
          date_time: "2027-08-02T11:00:00+09:00",
          time_zone: "Asia/Seoul",
        },
      });
      await create({ ...day("2027-08-02"), transparency: "free" });
      const slots = await call("/availability/query", {
        method: "POST",
        data: {
          calendar_ids: [primary],
          time_min: "2027-08-02T00:00:00Z",
          time_max: "2027-08-02T04:00:00Z",
          duration_minutes: 60,
          step_minutes: 60,
          working_hours_only: true,
        },
      });
      assert.deepEqual(
        slots.slots.map((value) => value.start),
        ["2027-08-02T00:00:00Z", "2027-08-02T02:00:00Z"],
      );
      await call("/freebusy/query", {
        actor: "bob",
        method: "POST",
        data: {
          calendar_ids: [primary],
          time_min: "2027-08-02T00:00:00Z",
          time_max: "2027-08-02T04:00:00Z",
        },
        expected: 404,
      });
    },
  );
  await t.test("restricted writers cannot invite themselves into private occurrences", async () => {
    const value = await create({
      ...day("2027-09-01"),
      visibility: "public",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
    });
    await patch(value.event.id, {
      scope: "single",
      occurrence_key: "d:2027-09-02",
      visibility: "private",
      title: "Secret",
    });
    await call(`/calendars/${primary}/acl`, {
      method: "POST",
      data: {
        scope_type: "user",
        scope_key: "bob",
        role: "writer_without_private",
      },
      expected: 201,
    });
    const version = (await event(value.event.id)).version;
    for (const scope of [undefined, "d:2027-09-02"])
      await call(`/calendars/${primary}/events/${value.event.id}/attendees`, {
        actor: "bob",
        method: "POST",
        data: {
          version,
          attendees: [{ user_id: "bob" }],
          ...(scope ? { occurrence_key: scope } : {}),
        },
        expected: 404,
      });
  });
  await t.test(
    "unknown delivery acceptance can be resolved with an audited provider receipt",
    async () => {
      const row = await db
        .prepare("SELECT id FROM calendar_invitation_deliveries WHERE status='unknown' LIMIT 1")
        .first();
      assert.ok(row);
      await call(`/admin/invitation-deliveries/${row.id}/resolve`, {
        actor: "admin",
        method: "POST",
        data: { decision: "retry", reason: "No receipt yet" },
        expected: 400,
      });
      await call(`/admin/invitation-deliveries/${row.id}/resolve`, {
        actor: "admin",
        method: "POST",
        data: {
          decision: "accepted",
          provider_message_id: "verified-provider-receipt",
          reason: "Confirmed by provider",
        },
      });
      assert.equal(
        (
          await db
            .prepare("SELECT status FROM calendar_invitation_deliveries WHERE id=?")
            .bind(row.id)
            .first()
        ).status,
        "accepted",
      );
    },
  );
  await t.test("emails open response pages and no public GET changes attendance", async () => {
    const value = await create({
      ...day("2027-10-01"),
      attendees: [{ email_address: "page@example.test" }],
    });
    await flush((await deliveries(value.event.id)).map((value) => value.id));
    const message = (await sent()).find((value) => value.to.includes("page@example.test")),
      token = message.text.match(/ofci_[A-Za-z0-9_-]{43}/)[0],
      before = await counts(),
      response = await raw(`/invitations/${token}`, {
        actor: null,
        headers: { Accept: "text/html" },
      });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /script-src 'nonce-/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(await response.text(), /data-response="accepted"/);
    assert.deepEqual(await counts(), before);
    const link = await createLink(value.event.id),
      page = await raw(`/public/share-links/${link.token}`, {
        actor: null,
        headers: { Accept: "text/html" },
      });
    assert.match(await page.text(), /Send verification code/);
  });
  await t.test(
    "proposed times require an organizer transaction before changing an event",
    async () => {
      const value = await create({
          ...day("2027-10-05"),
          attendees: [{ user_id: "bob" }],
        }),
        attendee = (await call(`/calendars/primary/events/${value.event.id}/attendees`))
          .attendees[0],
        proposal = await call(`/inbox-invitations/${attendee.id}/time-proposals`, {
          actor: "bob",
          method: "POST",
          data: {
            start: { date: "2027-10-06" },
            end: { date: "2027-10-07" },
            comment: "Can we move it?",
          },
          expected: 201,
        });
      assert.equal((await event(value.event.id)).start.date, "2027-10-05");
      await call(
        `/calendars/primary/events/${value.event.id}/time-proposals/${proposal.proposal.id}/resolve`,
        {
          method: "POST",
          data: {
            version: 1,
            event_version: (await event(value.event.id)).version,
            decision: "accept",
          },
        },
      );
      assert.equal((await event(value.event.id)).start.date, "2027-10-06");
    },
  );
  await t.test(
    "anonymous publication redacts private details and stops after revocation",
    async () => {
      const visible = await create({
        ...day("2027-11-01"),
        title: "Public title",
        visibility: "public",
      });
      const hidden = await create({
        ...day("2027-11-01"),
        title: "Secret title",
        visibility: "private",
        description_html: "<p>Secret body</p>",
      });
      const grant = (
        await call(`/calendars/${primary}/acl`, {
          method: "POST",
          data: {
            scope_type: "public",
            scope_key: "workspace",
            role: "reader",
          },
          expected: 201,
        })
      ).acl;
      const path = `/public/calendars/${primary}`;
      const list = await publicCall(
        path + "/events?time_min=2027-10-31T15%3A00%3A00Z&time_max=2027-11-01T15%3A00%3A00Z",
      );
      assert.equal(list.events.find((item) => item.id === visible.event.id).title, "Public title");
      const secret = list.events.find((item) => item.id === hidden.event.id);
      assert.equal(secret.title, "Busy");
      assert.equal(Object.hasOwn(secret, "description_html"), false);
      await call(`/calendars/${primary}/acl/${grant.id}?version=1`, {
        method: "DELETE",
        expected: 204,
      });
      await publicCall(path, { expected: 404 });
    },
  );
  await t.test(
    "link bounds also restrict direct occurrence reads, downloads and registration",
    async () => {
      const value = await create({
        ...day("2027-11-10"),
        recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      });
      const bounds = {
        time_min: "2027-11-11T00:00:00Z",
        time_max: "2027-11-12T00:00:00Z",
      };
      const link = await createLink(value.event.id, bounds);
      const base = `/public/share-links/${link.token}`;
      assert.equal((await publicCall(base)).event, null);
      await publicCall(base + "?occurrence_key=d%3A2027-11-10", {
        expected: 404,
      });
      assert.equal(
        (await publicCall(base + "?occurrence_key=d%3A2027-11-11")).event.start.date,
        "2027-11-11",
      );
      await call(`/calendars/primary/events/${value.event.id}/share-links`, {
        method: "POST",
        data: { mode: "join", ...bounds, occurrence_key: "d:2027-11-10" },
        expected: 404,
      });
      const session = await registerSession(link, "bounds@example.test");
      await publicCall(base + "/registrations", {
        method: "POST",
        data: { occurrence_key: "d:2027-11-10" },
        headers: session.headers,
        expected: 404,
      });
      const registration = await publicCall(base + "/registrations", {
        method: "POST",
        data: {
          occurrence_key: "d:2027-11-11",
          display_name: "Bounds attendee",
        },
        headers: session.headers,
        expected: 201,
      });
      const ownPath = `/public/registrations/${registration.manage_token}`;
      const responseRequest = {
        method: "POST",
        data: {
          version: registration.registration.version,
          response_status: "tentative",
        },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      };
      const response = await publicCall(ownPath + "/rsvp", responseRequest);
      assert.equal(response.registration_version, registration.registration.version + 1);
      assert.equal((await publicCall(ownPath)).registration.version, response.registration_version);
      assert.deepEqual(await publicCall(ownPath + "/rsvp", responseRequest), response);
      await publicCall(ownPath + "/rsvp", {
        method: "POST",
        data: responseRequest.data,
        expected: 412,
      });
      await publicCall(ownPath + "/rsvp", {
        method: "POST",
        data: {
          version: response.registration_version,
          response_status: "declined",
        },
      });
      const declined = await publicCall(ownPath);
      assert.equal(declined.registration.version, response.registration_version + 1);
      assert.equal(declined.invitation.attendee.response_status, "declined");
      const fixed = await createLink(value.event.id, {
        ...bounds,
        occurrence_key: "d:2027-11-11",
        allow_ics: true,
      });
      await patch(value.event.id, {
        scope: "single",
        occurrence_key: "d:2027-11-11",
        start: { date: "2027-11-20" },
        end: { date: "2027-11-21" },
      });
      await publicCall(`/public/share-links/${fixed.token}/export.ics`, {
        expected: 404,
      });
    },
  );
  await t.test(
    "attachment metadata follows current Drive permissions and rejects unsafe URLs",
    async () => {
      const value = await create({
        ...day("2027-12-01"),
        attendees: [{ user_id: "bob" }],
      });
      const path = `/calendars/primary/events/${value.event.id}/attachments`;
      for (const url of ["javascript:alert(1)", "https://user:password@example.test/secret"])
        await call(path, {
          method: "POST",
          data: { version: (await event(value.event.id)).version, url },
          expected: 400,
        });
      await call(path, {
        method: "POST",
        data: {
          version: (await event(value.event.id)).version,
          url: "https://example.test/agenda",
          title: "Agenda",
        },
        expected: 201,
      });
      await db
        .prepare(
          "INSERT INTO role_permissions(role_id,permission_key) VALUES('calendar-test','drive.access')",
        )
        .run();
      const file = crypto.randomUUID();
      await db
        .prepare(
          "INSERT INTO drive_items(id,owner_user_id,kind,name,created_by) VALUES(?,'alice','file','Private file','alice')",
        )
        .bind(file)
        .run();
      const attachment = (
        await call(path, {
          method: "POST",
          data: {
            version: (await event(value.event.id)).version,
            drive_item_id: file,
          },
          expected: 201,
        })
      ).attachment;
      const own = (
        await call(`/calendars/primary/events/${value.event.id}/attendees`)
      ).attendees.find((item) => item.user_id === "bob");
      const detail = async () =>
        (await call(`/inbox-invitations/${own.id}`, { actor: "bob" })).attachments.find(
          (item) => item.id === attachment.id,
        );
      assert.equal((await detail()).unavailable, true);
      assert.equal(Object.hasOwn(await detail(), "title"), false);
      await db
        .prepare(
          "INSERT INTO drive_permissions(item_id,user_id,role,created_by) VALUES(?,'bob','viewer','alice')",
        )
        .bind(file)
        .run();
      assert.equal((await detail()).title, "Private file");
      await db
        .prepare("DELETE FROM drive_permissions WHERE item_id=? AND user_id='bob'")
        .bind(file)
        .run();
      assert.equal((await detail()).unavailable, true);
      await db
        .prepare(
          "DELETE FROM role_permissions WHERE role_id='calendar-test' AND permission_key='drive.access'",
        )
        .run();
    },
  );
  await t.test(
    "calendar trash and restore deliver CANCEL then REQUEST with the same UID",
    async () => {
      const cal = (
        await call("/calendars", {
          method: "POST",
          data: { name: "Lifecycle" },
          expected: 201,
        })
      ).calendar;
      const value = await create(
        {
          ...day("2028-01-01"),
          attendees: [{ user_id: "bob" }, { email_address: "calendar-lifecycle@example.test" }],
        },
        cal.id,
      );
      const path = `/calendars/${cal.id}/events/${value.event.id}/invitation-deliveries`;
      const rows = async () => (await call(path)).deliveries;
      await flush((await rows()).map((value) => value.id));
      await call(`/calendars/${cal.id}?version=${cal.version}`, {
        method: "DELETE",
        expected: 204,
      });
      const cancellations = (
        await db
          .prepare(
            "SELECT id FROM calendar_invitation_deliveries WHERE event_id=? AND action='cancel' AND channel='email'",
          )
          .bind(value.event.id)
          .all()
      ).results;
      assert.equal(cancellations.length, 1);
      await flush(cancellations.map((value) => value.id));
      await call(`/calendars/${cal.id}/restore`, {
        method: "POST",
        data: { version: cal.version + 1 },
      });
      await flush(
        (await rows()).filter((value) => value.action === "update").map((value) => value.id),
      );
      const messages = (await sent()).filter((value) =>
        value.to.includes("calendar-lifecycle@example.test"),
      );
      assert.equal(messages.length, 3);
      const content = messages.map((value) =>
        Buffer.from(value.attachments[0].content, "base64").toString(),
      );
      assert.ok(content.some((value) => /METHOD:CANCEL/.test(value) && /SEQUENCE:1/.test(value)));
      assert.ok(content.some((value) => /METHOD:REQUEST/.test(value) && /SEQUENCE:2/.test(value)));
      assert.ok(content.every((item) => item.includes(`UID:${value.event.i_cal_uid}`)));
    },
  );
  await t.test(
    "moving into an invitee calendar merges the existing copy without losing RSVP",
    async () => {
      const target = (await call("/bootstrap", { actor: "bob" })).primary_calendar_id;
      await call(`/calendars/${target}/acl`, {
        actor: "bob",
        method: "POST",
        data: { scope_type: "user", scope_key: "alice", role: "writer" },
        expected: 201,
      });
      const value = await create({
        ...day("2028-02-01"),
        attendees: [{ user_id: "bob" }],
      });
      const attendee = (await call(`/calendars/primary/events/${value.event.id}/attendees`))
        .attendees[0];
      await call(`/inbox-invitations/${attendee.id}/rsvp`, {
        actor: "bob",
        method: "POST",
        data: { version: attendee.version, response_status: "accepted" },
      });
      const moved = await call(`/calendars/primary/events/${value.event.id}/move`, {
        method: "POST",
        data: {
          version: (await event(value.event.id)).version,
          target_calendar_id: target,
        },
      });
      assert.equal(moved.event.calendar_id, target);
      assert.equal(
        (await call(`/inbox-invitations/${attendee.id}`, { actor: "bob" })).attendee
          .response_status,
        "accepted",
      );
      const copies = (
        await db
          .prepare(
            "SELECT * FROM calendar_event_copies WHERE event_id=? AND calendar_id=? AND removed_at IS NULL",
          )
          .bind(value.event.id, target)
          .all()
      ).results;
      assert.equal(copies.length, 1);
      assert.equal(copies[0].copy_kind, "organizer");
    },
  );
  await t.test(
    "revoked sources block personal ICS downloads and removed attendees can be invited again",
    async () => {
      const value = await create({ ...day("2028-03-01") });
      const link = await createLink(value.event.id);
      const session = await registerSession(link, "revoked-registration@example.test");
      const reg = await publicCall(session.base + "/registrations", {
        method: "POST",
        data: { display_name: "Registered guest" },
        headers: session.headers,
        expected: 201,
      });
      const own = `/public/registrations/${reg.manage_token}`;
      const file = await raw(own + "/event.ics", { actor: null });
      assert.equal(file.status, 200);
      await call(
        `/calendars/primary/events/${value.event.id}?version=${(await event(value.event.id)).version}`,
        { method: "DELETE", expected: 204 },
      );
      assert.equal((await publicCall(own)).invitation.is_revoked, true);
      await publicCall(own + "/event.ics", { expected: 404 });
      const invited = await create({
        ...day("2028-03-02"),
        attendees: [{ user_id: "bob" }],
      });
      const path = `/calendars/primary/events/${invited.event.id}/attendees`;
      const old = (await call(path)).attendees[0];
      await call(`${path}/${old.id}?version=${old.version}`, {
        method: "DELETE",
        expected: 204,
      });
      await call(`/inbox-invitations/${old.id}/event.ics`, {
        actor: "bob",
        expected: 404,
      });
      const replacement = await call(path, {
        method: "POST",
        data: {
          version: (await event(invited.event.id)).version,
          attendees: [{ user_id: "bob" }],
        },
        expected: 201,
      });
      assert.notEqual(replacement.attendees[0].id, old.id);
      assert.equal(
        (
          await call(`/inbox-invitations/${replacement.attendees[0].id}`, {
            actor: "bob",
          })
        ).is_revoked,
        false,
      );
    },
  );
  await t.test(
    "invitations use the organizer's sendable personal address without a system sender",
    async () => {
      await db
        .prepare(
          "UPDATE calendar_workspace_settings SET system_address_id=NULL WHERE id='workspace'",
        )
        .run();
      try {
        const value = await create({
          ...day("2028-04-01"),
          attendees: [
            { email_address: "personal-primary@example.test" },
            { user_id: "no-calendar" },
          ],
        });
        await flush((await deliveries(value.event.id)).map((item) => item.id));
        assert.equal(
          (await sent()).find((item) => item.to.includes("personal-primary@example.test")).from,
          "alice@calendar.test",
        );
        assert.equal(
          (await deliveries(value.event.id)).find(
            (item) => item.recipient_user_id === "no-calendar",
          ).status,
          "inbox_committed",
        );
        await db
          .prepare(
            "INSERT INTO mail_addresses(id,domain_id,mailbox_id,local_part,send_enabled) VALUES('alice-calendar-alias','calendar-domain','alice-calendar-box','alice-alias',1)",
          )
          .run();
        await db
          .prepare("UPDATE mail_addresses SET send_enabled=0 WHERE id='alice-calendar-address'")
          .run();
        const alias = await create({
          ...day("2028-04-02"),
          attendees: [{ email_address: "personal-alias@example.test" }],
        });
        await flush((await deliveries(alias.event.id)).map((item) => item.id));
        assert.equal(
          (await sent()).find((item) => item.to.includes("personal-alias@example.test")).from,
          "alice-alias@calendar.test",
        );
      } finally {
        await db
          .prepare("UPDATE mail_addresses SET send_enabled=1 WHERE id='alice-calendar-address'")
          .run();
        await db.prepare("DELETE FROM mail_addresses WHERE id='alice-calendar-alias'").run();
        await db
          .prepare(
            "UPDATE calendar_workspace_settings SET system_address_id='system-calendar-address' WHERE id='workspace'",
          )
          .run();
      }
    },
  );
  await t.test(
    "unavailable personal mail suppresses external invitations instead of using the system address",
    async () => {
      const cases = [
        [
          "no personal mailbox",
          "UPDATE mail_mailboxes SET kind='shared' WHERE id='alice-calendar-box'",
          "UPDATE mail_mailboxes SET kind='personal' WHERE id='alice-calendar-box'",
        ],
        [
          "disabled mailbox",
          "UPDATE mail_mailboxes SET status='disabled' WHERE id='alice-calendar-box'",
          "UPDATE mail_mailboxes SET status='active' WHERE id='alice-calendar-box'",
        ],
        [
          "provisioning mailbox",
          "UPDATE mail_mailboxes SET status='provisioning' WHERE id='alice-calendar-box'",
          "UPDATE mail_mailboxes SET status='active' WHERE id='alice-calendar-box'",
        ],
        [
          "disabled address",
          "UPDATE mail_addresses SET send_enabled=0 WHERE id='alice-calendar-address'",
          "UPDATE mail_addresses SET send_enabled=1 WHERE id='alice-calendar-address'",
        ],
        [
          "disabled domain",
          "UPDATE mail_domains SET outbound_enabled=0 WHERE id='calendar-domain'",
          "UPDATE mail_domains SET outbound_enabled=1 WHERE id='calendar-domain'",
        ],
        [
          "disabled provider",
          "UPDATE mail_provider_connections SET enabled=0 WHERE id='cloudflare-bindings'",
          "UPDATE mail_provider_connections SET enabled=1 WHERE id='cloudflare-bindings'",
        ],
        [
          "revoked Mail access",
          "DELETE FROM role_permissions WHERE role_id='calendar-mail-test' AND permission_key='mail.access'",
          "INSERT INTO role_permissions(role_id,permission_key) VALUES('calendar-mail-test','mail.access')",
        ],
      ];
      for (const [label, disable, restore] of cases) {
        const value = await create({
          ...day("2028-04-03"),
          attendees: [
            {
              email_address: `unavailable-${cases.findIndex((item) => item[0] === label)}@example.test`,
            },
            { user_id: "bob" },
          ],
        });
        const rows = await deliveries(value.event.id),
          external = rows.find((item) => item.channel === "email"),
          before = (await sent()).length;
        await db.prepare(disable).run();
        try {
          await flush([external.id]);
          const result = (await deliveries(value.event.id)).find((item) => item.id === external.id);
          assert.equal(result.status, "suppressed", label);
          assert.equal(result.error_code, "personal_sender_unavailable", label);
          assert.equal((await sent()).length, before, label);
          assert.equal(
            rows.find((item) => item.recipient_user_id === "bob").status,
            "inbox_committed",
          );
        } finally {
          await db.prepare(restore).run();
        }
      }
    },
  );
  await t.test(
    "revocation after snapshot creation prevents SMTP and a safe retry preserves the original ICS",
    async () => {
      const value = await create({
        ...day("2028-04-04"),
        attendees: [{ email_address: "sender-race@example.test" }],
      });
      const pending = (await deliveries(value.event.id)).find((item) => item.channel === "email"),
        before = (await sent()).length;
      try {
        await flushAfterSnapshot(
          pending.id,
          "UPDATE mail_addresses SET send_enabled=0 WHERE id='alice-calendar-address'",
        );
        assert.equal((await deliveries(value.event.id))[0].status, "retry_wait");
        assert.equal((await sent()).length, before);
        const key = `calendar/deliveries/${pending.id}/invite.ics`,
          original = await (await bucket.get(key)).text();
        await db
          .prepare("UPDATE mail_addresses SET send_enabled=1 WHERE id='alice-calendar-address'")
          .run();
        await db.prepare("UPDATE calendar_outbox SET run_at=0 WHERE id=?").bind(pending.id).run();
        await flush([pending.id]);
        assert.equal((await deliveries(value.event.id))[0].status, "accepted");
        assert.equal(await (await bucket.get(key)).text(), original);
        assert.equal(
          (await sent()).find((item) => item.to.includes("sender-race@example.test")).from,
          "alice@calendar.test",
        );
      } finally {
        await db
          .prepare("UPDATE mail_addresses SET send_enabled=1 WHERE id='alice-calendar-address'")
          .run();
      }
    },
  );
  await t.test("a saved invitation cannot switch provider connections on retry", async () => {
    const value = await create({
      ...day("2028-04-05"),
      attendees: [{ email_address: "sender-binding@example.test" }],
    });
    const pending = (await deliveries(value.event.id))[0],
      before = (await sent()).length;
    await db
      .prepare(
        "INSERT INTO mail_provider_connections(id,provider,name) VALUES('calendar-replacement-provider','cloudflare','Replacement')",
      )
      .run();
    try {
      await flushAfterSnapshot(
        pending.id,
        "UPDATE mail_addresses SET send_enabled=0 WHERE id='alice-calendar-address'",
      );
      await db
        .prepare("UPDATE mail_addresses SET send_enabled=1 WHERE id='alice-calendar-address'")
        .run();
      await db
        .prepare(
          "UPDATE mail_domains SET outbound_connection_id='calendar-replacement-provider' WHERE id='calendar-domain'",
        )
        .run();
      await db.prepare("UPDATE calendar_outbox SET run_at=0 WHERE id=?").bind(pending.id).run();
      await flush([pending.id]);
      const result = (await deliveries(value.event.id))[0];
      assert.equal(result.status, "failed");
      assert.equal(result.error_code, "sender_configuration_changed");
      assert.equal((await sent()).length, before);
    } finally {
      await db
        .prepare(
          "UPDATE mail_domains SET outbound_connection_id='cloudflare-bindings' WHERE id='calendar-domain'",
        )
        .run();
      await db
        .prepare("UPDATE mail_addresses SET send_enabled=1 WHERE id='alice-calendar-address'")
        .run();
    }
  });
  await t.test(
    "delegated calendar invitations use the calendar organizer's personal mailbox",
    async () => {
      const target = (await call("/bootstrap", { actor: "bob" })).primary_calendar_id;
      const value = await create(
        {
          ...day("2028-04-06"),
          attendees: [{ email_address: "delegated-organizer@example.test" }],
        },
        target,
      );
      const rows = (
        await call(`/calendars/${target}/events/${value.event.id}/invitation-deliveries`, {
          actor: "bob",
        })
      ).deliveries;
      await flush(rows.map((item) => item.id));
      assert.equal(
        (await sent()).find((item) => item.to.includes("delegated-organizer@example.test")).from,
        "bob@calendar.test",
      );
    },
  );
});
