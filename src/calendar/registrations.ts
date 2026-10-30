import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { now, uuid, type AppEnv } from "../auth/types";
import { digest, random } from "../auth/crypto";
import type { Attendee, Policy, Registration } from "./collaboration-types";
import type { Bind, Calendar, CalendarContext, Event, Condition } from "./types";
import {
  active,
  calendarCondition,
  condition,
  combine,
  eventCondition,
  first,
  permission,
  requireCalendar,
  requireEvent,
  rows,
} from "./access";
import {
  body,
  choice,
  expectedVersion,
  fail,
  fields,
  flag,
  identifier,
  integer,
  jsonObject,
  object,
  text,
} from "./input";
import { insert, mutate, update } from "./mutations";
import {
  email,
  attendeeValues,
  allAttendees,
  bumpAttendance,
  capacityCondition,
  effectiveAttendees,
  eventAvailable,
  occurrence,
  parseAttendee,
  policy,
  policyCondition,
  registrationKey,
  scope,
} from "./attendance-store";
import {
  linkCondition,
  linkSession,
  limitPublic,
  publicLink,
  sessionCondition,
  assertLinkOccurrence,
} from "./links";
import { prepareDeliveries, prepareMessage } from "./delivery";
import { attendeeCopyStatements, invitationDto, respond } from "./attendees";
import { calendarFile } from "./ical";
import { wakeCalendar } from "./jobs";
import { invitationPage } from "./public-page";
import { recipientUser } from "./recipients";
const root = "/calendars/:calendarId/events/:eventId";
export const registrationDto = (value: Registration) => {
  const { email_key, answers_json, user_id, ...rest } = value;
  return { ...rest, answers: JSON.parse(answers_json) };
};
export const literalCondition = (value: Condition) => {
  let index = 0;
  return value.sql.replace(/\?/g, () => {
    const arg = value.args[index++];
    return arg === null
      ? "NULL"
      : typeof arg === "number"
        ? String(arg)
        : `'${String(arg).replaceAll("'", "''")}'`;
  });
};
function formSchema(value: unknown) {
  if (!Array.isArray(value) || value.length > 10)
    fail(400, "INVALID_FORM", t("calendarRegistrations.atMost10FormFieldsAreAllowed"));
  const names = new Set<string>();
  return value.map((item) => {
    const data = object(item, t("calendarRegistrations.formField"));
    fields(data, ["key", "label", "type", "required", "options"]);
    const key = identifier(data.key, "key");
    if (names.has(key)) fail(400, "INVALID_FORM", t("calendarRegistrations.repeatedFormField"));
    names.add(key);
    const type = choice(data.type, "type", ["text", "boolean", "choice"]),
      label = text(data.label, "label", 255),
      required = data.required === undefined ? false : !!flag(data.required, "required");
    let options: string[] | undefined;
    if (type === "choice") {
      if (!Array.isArray(data.options) || data.options.length > 20 || !data.options.length)
        fail(400, "INVALID_FORM", t("calendarRegistrations.invalidFieldOptions"));
      options = data.options.map((item) => text(item, "option", 255));
    }
    return { key, label, type, required, ...(options ? { options } : {}) };
  });
}
function answers(value: unknown, p: Policy) {
  const data = jsonObject(value ?? {}, "answers"),
    schema = formSchema(JSON.parse(p.form_schema_json));
  fields(
    data,
    schema.map((value) => value.key),
  );
  for (const field of schema) {
    const answer = data[field.key];
    if (answer === undefined) {
      if (field.required)
        fail(400, "INVALID_ANSWERS", t("calendarRegistrations.missing", { key: field.key }));
      continue;
    }
    if (field.type === "boolean") flag(answer, field.key);
    else {
      const string = text(answer, field.key, 2048, !field.required);
      if (field.type === "choice" && !field.options!.includes(string))
        fail(400, "INVALID_ANSWERS", t("calendarRegistrations.invalid", { key: field.key }));
    }
  }
  return data;
}
async function target(c: CalendarContext) {
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
    event = await requireEvent(c, cal, identifier(c.req.param("eventId")), true);
  return { cal, event };
}
export const registrationRoutes = new Hono<AppEnv>();
registrationRoutes.get(root + "/registration-policy", async (c) => {
  const { event } = await target(c),
    key = c.req.query("occurrence_key") ?? "";
  await occurrence(c, event, key);
  const p = await policy(c, event.id, key);
  return c.json({
    policy: {
      ...p,
      waitlist_enabled: !!p.waitlist_enabled,
      allowed_email_domains: JSON.parse(p.allowed_email_domains_json),
      form_schema: JSON.parse(p.form_schema_json),
    },
  });
});
registrationRoutes.put(root + "/registration-policy", async (c) => {
  const data = await body(c, [
      "version",
      "occurrence_key",
      "approval_mode",
      "capacity",
      "waitlist_enabled",
      "additional_guests_limit",
      "registration_opens_at",
      "registration_closes_at",
      "allowed_email_domains",
      "form_schema",
      "status",
    ]),
    { cal, event } = await target(c),
    key = data.occurrence_key === undefined ? "" : text(data.occurrence_key, "occurrence_key", 64);
  await occurrence(c, event, key);
  const current = await first<Policy>(
      c.env,
      "SELECT * FROM calendar_registration_policies WHERE event_id=? AND occurrence_key=?",
      event.id,
      key,
    ),
    version = current ? expectedVersion(c, data) : 0;
  if (!current && data.version !== undefined && data.version !== 0)
    fail(412, "VERSION_CONFLICT", t("calendarRegistrations.registrationPolicyDoesNotExist"));
  const stamp = (value: unknown) =>
    value === null || value === undefined
      ? null
      : integer(value, t("calendarRegistrations.registrationTime"), 0);
  const domains = data.allowed_email_domains === undefined ? [] : data.allowed_email_domains;
  if (
    !Array.isArray(domains) ||
    domains.length > 20 ||
    domains.some((value) => typeof value !== "string" || !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(value))
  )
    fail(400, "INVALID_DOMAIN", t("calendarRegistrations.invalidAllowedEmailDomains"));
  const value: Policy = {
    id: current?.id ?? uuid(),
    event_id: event.id,
    occurrence_key: key,
    approval_mode: choice(data.approval_mode ?? "automatic", "approval_mode", [
      "automatic",
      "manual",
    ]),
    capacity: data.capacity == null ? null : integer(data.capacity, "capacity", 0, 10000),
    waitlist_enabled:
      data.waitlist_enabled === undefined ? 1 : flag(data.waitlist_enabled, "waitlist_enabled"),
    additional_guests_limit: integer(
      data.additional_guests_limit ?? 0,
      "additional_guests_limit",
      0,
      20,
    ),
    registration_opens_at: stamp(data.registration_opens_at),
    registration_closes_at: stamp(data.registration_closes_at),
    allowed_email_domains_json: JSON.stringify(domains.map((value) => value.toLowerCase())),
    form_schema_json: JSON.stringify(formSchema(data.form_schema ?? [])),
    status: choice(data.status ?? "open", "status", ["open", "closed"]),
    version: version + 1,
  };
  if (
    value.registration_opens_at !== null &&
    value.registration_closes_at !== null &&
    value.registration_closes_at <= value.registration_opens_at
  )
    fail(400, "INVALID_RANGE", t("calendarRegistrations.registrationClosesBeforeItOpens"));
  await mutate(c, {
    action: "calendar.events.invite",
    operation: "registration.policy",
    request: data,
    result: null,
    calendar: cal.id,
    event: event.id,
    checks: [
      eventCondition(c, cal, event, event.version),
      current
        ? policyCondition(current)
        : condition(
            "NOT EXISTS(SELECT 1 FROM calendar_registration_policies WHERE event_id=? AND occurrence_key=?)",
            event.id,
            key,
          ),
    ],
    build: (proof) => [
      current
        ? update(
            c,
            "calendar_registration_policies",
            value as unknown as Record<string, Bind>,
            "id=?",
            [value.id],
            proof,
          )
        : insert(
            c,
            "calendar_registration_policies",
            value as unknown as Record<string, Bind>,
            proof,
          ),
      ...bumpAttendance(c, event, proof, key),
    ],
  });
  return c.json({ policy: value });
});
registrationRoutes.get(root + "/registrations", async (c) => {
  const { event } = await target(c),
    key = c.req.query("occurrence_key");
  const list = await rows<Registration>(
    c.env,
    `SELECT * FROM calendar_event_registrations WHERE event_id=? ${key === undefined ? "" : "AND occurrence_key=?"} ORDER BY created_at,id LIMIT 501`,
    event.id,
    ...(key === undefined ? [] : [key]),
  );
  if (list.length > 500)
    fail(422, "TOO_MANY_REGISTRATIONS", t("calendarRegistrations.queryAnIndividualOccurrence"));
  return c.json({ registrations: list.map(registrationDto) });
});
async function preparedConfirmation(
  c: CalendarContext,
  event: Event,
  cal: Calendar,
  reg: Registration,
  p: Policy,
  givenScope?: Awaited<ReturnType<typeof scope>>,
) {
  const selected = givenScope ?? (await scope(c, event, reg.occurrence_key)),
    existing = (await effectiveAttendees(c, event.id, reg.occurrence_key)).find(
      (value) =>
        value.email_key === reg.email_key || (!!reg.user_id && value.user_id === reg.user_id),
    ),
    created =
      existing ??
      (await parseAttendee(
        c,
        {
          email_address: reg.email_address,
          display_name: reg.display_name,
          additional_guests: reg.additional_guests,
        },
        event,
        selected.id,
        reg.occurrence_key,
      )),
    attendee = {
      ...created,
      response_status: reg.requested_response,
      attendance_mode: reg.requested_attendance_mode,
      additional_guests: reg.additional_guests,
    },
    effective = await occurrence(c, event, reg.occurrence_key),
    notices = await prepareDeliveries(
      c,
      cal,
      effective,
      [attendee],
      "confirmation",
      reg.occurrence_key,
      { resend: true },
    );
  return {
    attendee,
    scopeCheck: selected.check,
    build: (proof: string, operation: string) => [
      ...selected.build(proof),
      ...(existing
        ? reg.occurrence_key && existing.occurrence_key === ""
          ? [
              c.env.DB.prepare(
                `INSERT INTO calendar_attendee_occurrence_responses(attendee_id,occurrence_key,response_status,attendance_mode) SELECT ?,?,?,? WHERE ${proof} ON CONFLICT(attendee_id,occurrence_key) DO UPDATE SET response_status=excluded.response_status,attendance_mode=excluded.attendance_mode,responded_at=unixepoch()`,
              ).bind(
                attendee.id,
                reg.occurrence_key,
                reg.requested_response,
                reg.requested_attendance_mode,
              ),
              update(
                c,
                "calendar_event_attendees",
                { version: existing.version + 1, updated_at: now() },
                "id=?",
                [attendee.id],
                proof,
              ),
            ]
          : [
              update(
                c,
                "calendar_event_attendees",
                {
                  response_status: reg.requested_response,
                  attendance_mode: reg.requested_attendance_mode,
                  additional_guests: reg.additional_guests,
                  version: existing.version + 1,
                  updated_at: now(),
                },
                "id=?",
                [attendee.id],
                proof,
              ),
            ]
        : [insert(c, "calendar_event_attendees", attendeeValues(attendee), proof)]),
      ...attendeeCopyStatements(c, event, [attendee], proof),
      ...notices(proof, operation),
    ],
  };
}
export async function preparePromotion(
  c: CalendarContext,
  event: Event,
  cal: Calendar,
  key: string,
) {
  const p = await policy(c, event.id, key);
  if (p.approval_mode !== "automatic") return (_proof: string, _operation: string) => [];
  const waiting = await rows<Registration>(
      c.env,
      "SELECT * FROM calendar_event_registrations WHERE event_id=? AND occurrence_key=? AND status='waitlisted' ORDER BY waitlisted_at,created_at,id LIMIT 10",
      event.id,
      key,
    ),
    plans: {
      reg: Registration;
      prepared: Awaited<ReturnType<typeof preparedConfirmation>>;
      capacity: Condition;
    }[] = [];
  for (const reg of waiting) {
    if (reg.additional_guests > p.additional_guests_limit) continue;
    const prepared = await preparedConfirmation(c, event, cal, reg, p);
    plans.push({
      reg,
      prepared,
      capacity: capacityCondition(event.id, key, reg.email_key, reg.additional_guests, p.capacity),
    });
  }
  return (proof: string, operation: string) =>
    plans.flatMap(({ reg, prepared, capacity }) => {
      const gate = `(${proof}) AND ${literalCondition(policyCondition(p))} AND EXISTS(SELECT 1 FROM calendar_event_registrations WHERE id='${reg.id}' AND version=${reg.version} AND status='waitlisted') AND ${literalCondition(capacity)}`;
      // Build attendee before the registration references it; all later side effects
      // depend on the exact new attendee and registration version being committed.
      const confirmation = prepared.build(gate, operation);
      const persisted = `(${proof}) AND EXISTS(SELECT 1 FROM calendar_event_registrations WHERE id='${reg.id}' AND version=${reg.version + 1} AND status='confirmed' AND attendee_id='${prepared.attendee.id}')`;
      return [
        ...confirmation,
        update(
          c,
          "calendar_event_registrations",
          {
            status: "confirmed",
            attendee_id: prepared.attendee.id,
            confirmed_at: now(),
            version: reg.version + 1,
            updated_at: now(),
          },
          "id=?",
          [reg.id],
          gate,
        ),
        ...bumpAttendance(c, event, persisted, key),
      ];
    });
}
registrationRoutes.post(root + "/registrations/:registrationId/decision", async (c) => {
  const data = await body(c, ["version", "decision"]),
    { cal, event } = await target(c),
    id = identifier(c.req.param("registrationId")),
    reg = await first<Registration>(
      c.env,
      "SELECT * FROM calendar_event_registrations WHERE id=? AND event_id=?",
      id,
      event.id,
    ),
    version = expectedVersion(c, data),
    decision = choice(data.decision, "decision", ["approve", "reject"]);
  if (!reg || !["pending", "waitlisted"].includes(reg.status))
    fail(
      409,
      "REGISTRATION_STATE",
      t("calendarRegistrations.thisRegistrationIsNotAwaitingApproval"),
    );
  const p = await policy(c, event.id, reg.occurrence_key),
    cap = capacityCondition(
      event.id,
      reg.occurrence_key,
      reg.email_key,
      reg.additional_guests,
      p.capacity,
    );
  if (decision === "approve" && !(await first(c.env, `SELECT 1 WHERE ${cap.sql}`, ...cap.args)))
    fail(409, "REGISTRATION_FULL", t("calendarRegistrations.thisOccurrenceHasReachedCapacity"));
  const confirmation =
    decision === "approve" ? await preparedConfirmation(c, event, cal, reg, p) : null;
  await mutate(c, {
    action: "calendar.events.invite",
    operation: `registration.decision:${id}`,
    idempotent: true,
    request: data,
    result: {
      status: decision === "approve" ? "confirmed" : "rejected",
      version: version + 1,
    },
    calendar: cal.id,
    event: event.id,
    checks: [
      eventAvailable(event.id, event.sequence),
      calendarCondition(c, cal, 5),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_registrations WHERE id=? AND version=? AND status IN('pending','waitlisted'))",
        id,
        version,
      ),
      policyCondition(p),
      ...(confirmation ? [cap, confirmation.scopeCheck] : []),
    ],
    build: (proof, operation) => [
      ...(confirmation ? confirmation.build(proof, operation) : []),
      update(
        c,
        "calendar_event_registrations",
        {
          status: confirmation ? "confirmed" : "rejected",
          attendee_id: confirmation?.attendee.id ?? null,
          confirmed_at: confirmation ? now() : null,
          decided_by: c.get("identity").user.id,
          version: version + 1,
          updated_at: now(),
        },
        "id=?",
        [id],
        proof,
      ),
      ...bumpAttendance(c, event, proof, reg.occurrence_key),
    ],
  });
  wakeCalendar(c);
  return c.json({
    status: confirmation ? "confirmed" : "rejected",
    version: version + 1,
  });
});
export const publicRegistrations = new Hono<AppEnv>();
function codeHash(c: CalendarContext, id: string, code: string, version?: number) {
  const ring = JSON.parse(c.env.MFA_ENCRYPTION_KEYS) as {
      active_version: number;
      keys: Record<string, string>;
    },
    v = version ?? ring.active_version;
  return `${v}:${createHmac("sha256", ring.keys[v] ?? "")
    .update(`calendar-verification:${id}:${code}`)
    .digest("hex")}`;
}
publicRegistrations.post("/public/share-links/:token/email-challenges", async (c) => {
  const data = await body(c, ["email_address"]),
    { link, event, auth } = await publicLink(c),
    session = await linkSession(c, link, true),
    address = email(data.email_address);
  if (link.mode !== "join" || !event)
    fail(403, "REGISTRATION_DISABLED", t("calendarRegistrations.thisLinkDoesNotAllowRegistration"));
  await limitPublic(c, `verify:${session!.id}`, 3, 600);
  await limitPublic(c, `verify-email:${address}`, 5);
  await limitPublic(c, `verify-ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`, 20);
  const id = uuid(),
    code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1000000).padStart(6, "0"),
    notices = await prepareMessage(c, address, {
      kind: "verify",
      action: "verify",
      code,
    });
  await mutate(c, {
    operation: `registration.verify.send:${session!.id}`,
    principal: {
      actor_key: `link-session:${session!.id}`,
      actor_user_id: null,
      auth: combine(auth, sessionCondition(session!)),
    },
    request: data,
    result: null,
    build: (proof, operation) => [
      c.env.DB.prepare(
        `UPDATE calendar_external_email_challenges SET used_at=unixepoch() WHERE session_id=? AND used_at IS NULL AND ${proof}`,
      ).bind(session!.id),
      insert(
        c,
        "calendar_external_email_challenges",
        {
          id,
          session_id: session!.id,
          share_link_id: link.id,
          email_address: address,
          email_key: address,
          code_hash: codeHash(c, id, code),
          expires_at: now() + 600,
        },
        proof,
      ),
      ...notices(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.json({ challenge_id: id, expires_in: 600 }, 201);
});
publicRegistrations.post(
  "/public/share-links/:token/email-challenges/:challengeId/verify",
  async (c) => {
    const data = await body(c, ["code"]),
      { link, auth } = await publicLink(c),
      session = await linkSession(c, link, true),
      id = identifier(c.req.param("challengeId")),
      challenge = await first<{
        code_hash: string;
        attempts: number;
        expires_at: number;
        used_at: number | null;
        email_address: string;
        email_key: string;
      }>(
        c.env,
        "SELECT * FROM calendar_external_email_challenges WHERE id=? AND session_id=? AND share_link_id=?",
        id,
        session!.id,
        link.id,
      ),
      code = text(data.code, "code", 6);
    if (
      !challenge ||
      challenge.used_at ||
      challenge.expires_at <= now() ||
      challenge.attempts >= 5 ||
      !/^\d{6}$/.test(code)
    )
      fail(400, "INVALID_CODE", t("calendarRegistrations.invalidOrExpiredVerificationCode"));
    const hash = codeHash(c, id, code, Number(challenge.code_hash.split(":")[0]));
    if (
      !timingSafeEqual(
        new TextEncoder().encode(hash),
        new TextEncoder().encode(challenge.code_hash),
      )
    ) {
      const guard = combine(auth, sessionCondition(session!));
      await c.env.DB.prepare(
        `UPDATE calendar_external_email_challenges SET attempts=attempts+1 WHERE id=? AND used_at IS NULL AND attempts<5 AND ${guard.sql}`,
      )
        .bind(id, ...guard.args)
        .run();
      fail(400, "INVALID_CODE", t("calendarRegistrations.invalidOrExpiredVerificationCode"));
    }
    await mutate(c, {
      operation: "registration.verify",
      principal: {
        actor_key: `link-session:${session!.id}`,
        actor_user_id: null,
        auth: combine(auth, sessionCondition(session!)),
      },
      request: data,
      result: null,
      checks: [
        condition(
          "EXISTS(SELECT 1 FROM calendar_external_email_challenges WHERE id=? AND session_id=? AND code_hash=? AND used_at IS NULL AND expires_at>unixepoch() AND attempts<5)",
          id,
          session!.id,
          hash,
        ),
      ],
      build: (proof) => [
        update(c, "calendar_external_email_challenges", { used_at: now() }, "id=?", [id], proof),
        update(
          c,
          "calendar_link_sessions",
          {
            verified_email: challenge.email_address,
            email_key: challenge.email_key,
            email_verified_at: now(),
          },
          "id=?",
          [session!.id],
          proof,
        ),
      ],
    });
    return c.json({ verified: true, email_address: challenge.email_address });
  },
);
async function register(c: CalendarContext, attempt = 0): Promise<Response> {
  try {
    const data = await body(c, [
        "occurrence_key",
        "display_name",
        "additional_guests",
        "answers",
        "response_status",
        "attendance_mode",
      ]),
      { link, event, cal, auth } = await publicLink(c),
      session = await linkSession(c, link, true);
    if (link.mode !== "join" || !event || !session!.email_verified_at || !session!.email_key)
      fail(
        403,
        "EMAIL_VERIFICATION_REQUIRED",
        t("calendarRegistrations.verifyYourEmailBeforeRegistering"),
      );
    await limitPublic(c, `register:${session!.id}`, 20);
    const key = registrationKey(event, data.occurrence_key ?? link.occurrence_key),
      p = await policy(c, event.id, key);
    if (link.occurrence_key && key !== link.occurrence_key)
      fail(403, "LINK_SCOPE", t("calendarRegistrations.thisLinkCoversOneOccurrence"));
    const effective = await occurrence(c, event, key);
    assertLinkOccurrence(link, effective, cal);
    if (
      p.status !== "open" ||
      (p.registration_opens_at !== null && p.registration_opens_at > now()) ||
      (p.registration_closes_at !== null && p.registration_closes_at <= now())
    )
      fail(409, "REGISTRATION_CLOSED", t("calendarRegistrations.registrationIsClosed"));
    const domains = JSON.parse(p.allowed_email_domains_json) as string[];
    if (domains.length && !domains.includes(session!.email_key.split("@")[1]!))
      fail(403, "REGISTRATION_DOMAIN", t("calendarRegistrations.thisEmailDomainCannotRegister"));
    const resolved = await recipientUser(c.env, session!.email_key);
    if (resolved.ambiguous)
      fail(
        400,
        "AMBIGUOUS_ATTENDEE",
        t("calendarRegistrations.thisAddressMatchesMoreThanOneAccount"),
      );
    const mapped = resolved.user;
    const member = (await effectiveAttendees(c, event.id, key)).find(
      (value) =>
        value.email_key === session!.email_key || (!!mapped && value.user_id === mapped.id),
    );
    const guests = integer(
        data.additional_guests ?? 0,
        "additional_guests",
        0,
        p.additional_guests_limit,
      ),
      form = answers(data.answers, p),
      old = await first<Registration>(
        c.env,
        "SELECT * FROM calendar_event_registrations WHERE event_id=? AND occurrence_key=? AND (email_key=? OR (user_id IS NOT NULL AND user_id=?))",
        event.id,
        key,
        session!.email_key,
        mapped?.id ?? null,
      ),
      cap = capacityCondition(
        event.id,
        key,
        member?.email_key ?? session!.email_key,
        guests,
        p.capacity,
      ),
      available = !!(await first(c.env, `SELECT 1 WHERE ${cap.sql}`, ...cap.args));
    if (old?.user_id && old.user_id !== mapped?.id)
      fail(
        409,
        "REGISTRATION_IDENTITY_CHANGED",
        t("calendarRegistrations.thisEmailRegistrationBelongsToADifferentAccountContact"),
      );
    let status: Registration["status"] =
      p.approval_mode === "manual" ? "pending" : available ? "confirmed" : "waitlisted";
    if (status === "waitlisted" && !p.waitlist_enabled)
      fail(409, "REGISTRATION_FULL", t("calendarRegistrations.thisOccurrenceHasReachedCapacity"));
    const reusable = old && !["cancelled", "rejected"].includes(old.status);
    const stamp = now(),
      reg: Registration = reusable
        ? old!
        : {
            id: old?.id ?? uuid(),
            event_id: event.id,
            occurrence_key: key,
            source_link_id: link.id,
            attendee_id: null,
            email_address: session!.verified_email!,
            email_key: session!.email_key,
            user_id: mapped?.id ?? null,
            display_name: text(data.display_name, "display_name", 255),
            additional_guests: guests,
            answers_json: JSON.stringify(form),
            status,
            requested_response: choice(data.response_status ?? "accepted", "response_status", [
              "accepted",
              "tentative",
            ]),
            requested_attendance_mode: choice(
              data.attendance_mode ?? "unspecified",
              "attendance_mode",
              ["unspecified", "in_person", "virtual"],
            ),
            version: (old?.version ?? 0) + 1,
            waitlisted_at: status === "waitlisted" ? stamp : null,
            confirmed_at: status === "confirmed" ? stamp : null,
            decided_by: null,
            cancelled_at: null,
            created_at: old?.created_at ?? stamp,
            updated_at: stamp,
          };
    const registrationScope = await scope(c, event, key);
    const confirmation =
      !reusable && status === "confirmed"
        ? await preparedConfirmation(c, event, cal, reg, p, registrationScope)
        : null;
    if (confirmation) reg.attendee_id = confirmation.attendee.id;
    const manage = `ofcr_${random()}`,
      manageId = uuid(),
      hash = await digest(manage),
      url = new URL(`/api/calendar/public/registrations/${manage}`, c.req.url).href,
      manageMail = reg.user_id
        ? null
        : await prepareMessage(c, reg.email_address, {
            kind: "recovery",
            action: "recovery",
            url,
            automatic: true,
          });
    const result = await mutate(c, {
      operation: `registration.create:${event.id}:${key}`,
      idempotent: true,
      secretResult: true,
      principal: {
        actor_key: `link-session:${session!.id}`,
        actor_user_id: null,
        auth: combine(
          auth,
          sessionCondition(session!),
          condition(
            "EXISTS(SELECT 1 FROM calendar_link_sessions WHERE id=? AND email_key=? AND email_verified_at IS NOT NULL)",
            session!.id,
            session!.email_key,
          ),
        ),
      },
      request: { ...data, email_key: session!.email_key },
      result: {
        registration: registrationDto(reg),
        manage_token: manage,
        manage_url: url,
      },
      calendar: cal.id,
      event: event.id,
      checks: [
        eventAvailable(event.id, event.sequence),
        policyCondition(p),
        registrationScope.check,
        ...(p.id
          ? [
              condition(
                "EXISTS(SELECT 1 FROM calendar_registration_policies WHERE id=? AND status='open' AND (registration_opens_at IS NULL OR registration_opens_at<=unixepoch()) AND (registration_closes_at IS NULL OR registration_closes_at>unixepoch()))",
                p.id,
              ),
            ]
          : []),
        ...(old
          ? [
              condition(
                "EXISTS(SELECT 1 FROM calendar_event_registrations WHERE id=? AND version=?)",
                old.id,
                old.version,
              ),
            ]
          : [
              condition(
                "NOT EXISTS(SELECT 1 FROM calendar_event_registrations WHERE event_id=? AND occurrence_key=? AND (email_key=? OR (user_id IS NOT NULL AND user_id=?)))",
                event.id,
                key,
                reg.email_key,
                mapped?.id ?? null,
              ),
            ]),
        ...(!reusable && status === "confirmed" ? [cap] : []),
        ...(!reusable && status === "waitlisted"
          ? [condition(`NOT (${cap.sql})`, ...cap.args)]
          : []),
      ],
      build: (proof, operation) => [
        ...(confirmation ? confirmation.build(proof, operation) : []),
        ...(!confirmation ? registrationScope.build(proof) : []),
        ...(old && !reusable
          ? [
              c.env.DB.prepare(
                `UPDATE calendar_registration_manage_tokens SET revoked_at=unixepoch() WHERE registration_id=? AND ${proof}`,
              ).bind(old.id),
            ]
          : []),
        ...(reusable
          ? []
          : [
              old
                ? update(
                    c,
                    "calendar_event_registrations",
                    reg as unknown as Record<string, Bind>,
                    "id=?",
                    [reg.id],
                    proof,
                  )
                : insert(
                    c,
                    "calendar_event_registrations",
                    reg as unknown as Record<string, Bind>,
                    proof,
                  ),
            ]),
        insert(
          c,
          "calendar_registration_manage_tokens",
          {
            id: manageId,
            registration_id: reg.id,
            token_hash: hash,
            expires_at: now() + 365 * 86400,
          },
          proof,
        ),
        ...(!reusable ? bumpAttendance(c, event, proof, key) : []),
        ...(manageMail ? manageMail(proof, operation) : []),
      ],
    });
    wakeCalendar(c);
    return c.json(result, 201);
  } catch (error) {
    // Recompute approval/waitlist state once after a concurrent seat claim.
    if (attempt === 0 && error instanceof Error && "status" in error && error.status === 412)
      return register(c, 1);
    throw error;
  }
}
publicRegistrations.post("/public/share-links/:token/registrations", (c) => register(c));
export async function managedRegistration(c: CalendarContext) {
  const token = text(c.req.param("manageToken"), "manage_token", 100);
  if (!/^ofcr_[A-Za-z0-9_-]{43}$/.test(token))
    fail(404, "REGISTRATION_NOT_FOUND", t("calendarRegistrations.registrationNotFound"));
  const hash = await digest(token),
    reg = await first<Registration>(
      c.env,
      "SELECT r.* FROM calendar_event_registrations r JOIN calendar_registration_manage_tokens t ON t.registration_id=r.id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>unixepoch()",
      hash,
    );
  if (!reg) fail(404, "REGISTRATION_NOT_FOUND", t("calendarRegistrations.registrationNotFound"));
  const event = await first<Event>(c.env, "SELECT * FROM calendar_events WHERE id=?", reg.event_id),
    cal = event
      ? await first<Calendar>(
          c.env,
          `SELECT cal.* FROM calendars cal JOIN users owner ON owner.id=cal.data_owner_user_id WHERE cal.id=? AND cal.status='active' AND ${active("owner")}`,
          event.organizer_calendar_id,
        )
      : null;
  if (!event || !cal)
    fail(404, "REGISTRATION_NOT_FOUND", t("calendarRegistrations.registrationNotFound"));
  const recipient = reg.user_id
    ? condition(`EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${active("u")})`, reg.user_id)
    : condition("1");
  if (!(await first(c.env, `SELECT 1 WHERE ${recipient.sql}`, ...recipient.args)))
    fail(404, "REGISTRATION_NOT_FOUND", t("calendarRegistrations.registrationIsUnavailable"));
  const auth = combine(
    recipient,
    condition(
      "EXISTS(SELECT 1 FROM calendar_registration_manage_tokens WHERE token_hash=? AND registration_id=? AND revoked_at IS NULL AND expires_at>unixepoch())",
      hash,
      reg.id,
    ),
  );
  return {
    reg,
    event,
    cal: { ...cal, effective_role: "writer" as const },
    auth,
    actorKey: `registration:${reg.id}`,
  };
}
publicRegistrations.get("/public/registrations/:manageToken", async (c) => {
  const { reg, event, cal, auth, actorKey } = await managedRegistration(c),
    attendee = reg.attendee_id
      ? (await allAttendees(c, event.id)).find((value) => value.id === reg.attendee_id)
      : null;
  const details =
    reg.status === "confirmed" && attendee
      ? await invitationDto(c, {
          attendee,
          event,
          cal,
          auth,
          actorKey,
          user: null,
          occurrenceKey: reg.occurrence_key,
        })
      : null;
  if (c.req.header("Accept")?.includes("text/html")) return invitationPage(c, "registration");
  return c.json({ registration: registrationDto(reg), invitation: details });
});
publicRegistrations.patch("/public/registrations/:manageToken", async (c) => {
  const data = await body(c, ["version", "display_name", "answers"]),
    { reg, event, auth, actorKey } = await managedRegistration(c),
    version = expectedVersion(c, data),
    p = await policy(c, event.id, reg.occurrence_key),
    values: Record<string, Bind> = { version: version + 1, updated_at: now() };
  if ("display_name" in data) values.display_name = text(data.display_name, "display_name", 255);
  if ("answers" in data) values.answers_json = JSON.stringify(answers(data.answers, p));
  await mutate(c, {
    operation: "registration.update",
    principal: { actor_key: actorKey, actor_user_id: null, auth },
    request: data,
    result: null,
    checks: [
      eventAvailable(event.id, event.sequence),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_registrations WHERE id=? AND version=?)",
        reg.id,
        version,
      ),
      policyCondition(p),
    ],
    build: (proof) => [update(c, "calendar_event_registrations", values, "id=?", [reg.id], proof)],
  });
  return c.json({
    registration: registrationDto({ ...reg, ...values } as Registration),
  });
});
publicRegistrations.post("/public/registrations/:manageToken/rsvp", async (c) => {
  const data = await body(c, ["version", "response_status", "attendance_mode", "comment"]),
    { reg, event, cal, auth, actorKey } = await managedRegistration(c),
    version = expectedVersion(c, data);
  if (reg.status !== "confirmed" || !reg.attendee_id)
    fail(
      409,
      "REGISTRATION_NOT_CONFIRMED",
      t("calendarRegistrations.thisRegistrationIsNotConfirmed"),
    );
  const attendee = (await allAttendees(c, event.id)).find((value) => value.id === reg.attendee_id);
  if (!attendee)
    fail(404, "INVITATION_NOT_FOUND", t("calendarRegistrations.yourInvitationIsUnavailable"));
  return c.json(
    await respond(
      c,
      {
        attendee,
        event,
        cal,
        auth,
        actorKey,
        user: null,
        registration: { id: reg.id, version, request: data },
      },
      {
        ...data,
        version: attendee.version,
        scope: reg.occurrence_key ? "single" : "all",
        occurrence_key: reg.occurrence_key || undefined,
      },
    ),
  );
});
publicRegistrations.post("/public/registrations/:manageToken/cancel", async (c) => {
  const data = await body(c, ["version"]),
    { reg, event, cal, auth, actorKey } = await managedRegistration(c),
    version = expectedVersion(c, data),
    attendee = reg.attendee_id
      ? (await allAttendees(c, event.id)).find((value) => value.id === reg.attendee_id)
      : null,
    promotion = await preparePromotion(c, event, cal, reg.occurrence_key),
    notices = attendee
      ? await prepareDeliveries(
          c,
          cal,
          {
            ...(await occurrence(c, event, reg.occurrence_key)),
            sequence: event.sequence,
            version: event.version + 1,
            status: "cancelled",
          },
          [attendee],
          "cancel",
          reg.occurrence_key,
          { resend: true },
        )
      : null;
  await mutate(c, {
    operation: `registration.cancel:${reg.id}`,
    idempotent: true,
    principal: { actor_key: actorKey, actor_user_id: null, auth },
    request: data,
    result: { status: "cancelled", version: version + 1 },
    calendar: cal.id,
    event: event.id,
    checks: [
      eventAvailable(event.id, event.sequence),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_registrations WHERE id=? AND version=? AND status<>'cancelled')",
        reg.id,
        version,
      ),
    ],
    build: (proof, operation) => [
      update(
        c,
        "calendar_event_registrations",
        {
          status: "cancelled",
          cancelled_at: now(),
          version: version + 1,
          updated_at: now(),
        },
        "id=?",
        [reg.id],
        proof,
      ),
      ...(attendee
        ? [
            ...(reg.occurrence_key && !attendee.occurrence_key
              ? [
                  c.env.DB.prepare(
                    `INSERT INTO calendar_attendee_occurrence_responses(attendee_id,occurrence_key,response_status) SELECT ?,?,'declined' WHERE ${proof} ON CONFLICT(attendee_id,occurrence_key) DO UPDATE SET response_status='declined',responded_at=unixepoch()`,
                  ).bind(attendee.id, reg.occurrence_key),
                ]
              : []),
            update(
              c,
              "calendar_event_attendees",
              {
                ...(reg.occurrence_key && !attendee.occurrence_key
                  ? {}
                  : { response_status: "declined", removed_at: now() }),
                version: attendee.version + 1,
                updated_at: now(),
              },
              "id=?",
              [attendee.id],
              proof,
            ),
          ]
        : []),
      ...bumpAttendance(c, event, proof, reg.occurrence_key),
      ...(notices ? notices(proof, operation) : []),
      ...promotion(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.json({ status: "cancelled", version: version + 1 });
});
publicRegistrations.get("/public/registrations/:manageToken/event.ics", async (c) => {
  const { reg, event, cal } = await managedRegistration(c);
  if (event.trashed_at || event.status === "cancelled" || cal.trashed_at)
    fail(404, "INVITATION_NOT_FOUND", t("calendarRegistrations.invitationIsUnavailable"));
  if (reg.status !== "confirmed" || !reg.attendee_id)
    fail(
      403,
      "REGISTRATION_NOT_CONFIRMED",
      t("calendarRegistrations.onlyConfirmedRegistrationsCanDownloadInvitations"),
    );
  const attendee = (await effectiveAttendees(c, event.id, reg.occurrence_key)).find(
    (value) => value.id === reg.attendee_id,
  );
  if (!attendee)
    fail(404, "INVITATION_NOT_FOUND", t("calendarRegistrations.invitationIsUnavailable"));
  return c.body(
    calendarFile({
      kind: "invitation",
      action: "invite",
      event: await occurrence(c, event, reg.occurrence_key),
      attendee,
      occurrence_key: reg.occurrence_key,
    }),
    200,
    {
      "Content-Type": "text/calendar; charset=UTF-8; method=REQUEST",
      "Content-Disposition": 'attachment; filename="invite.ics"',
    },
  );
});
publicRegistrations.post("/public/registrations/recovery", async (c) => {
  const data = await body(c, ["email_address", "event_id", "occurrence_key"]),
    address = email(data.email_address),
    eventId = identifier(data.event_id),
    key = data.occurrence_key === undefined ? "" : text(data.occurrence_key, "occurrence_key", 64);
  await limitPublic(c, `recovery:${address}`, 3);
  await limitPublic(c, `recovery-ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`, 10);
  const reg = await first<Registration>(
    c.env,
    "SELECT * FROM calendar_event_registrations WHERE email_key=? AND event_id=? AND occurrence_key=?",
    address,
    eventId,
    key,
  );
  if (
    reg &&
    (await first(
      c.env,
      `SELECT 1 WHERE ${eventAvailable(reg.event_id).sql}`,
      ...eventAvailable(reg.event_id).args,
    ))
  ) {
    if (
      reg.user_id &&
      !(await first(
        c.env,
        "SELECT 1 FROM users WHERE id=? AND lower(email_address)=?",
        reg.user_id,
        address,
      ))
    )
      return c.json({ accepted: true });
    const id = uuid(),
      token = `ofcr_${random()}`,
      hash = await digest(token),
      url = new URL(`/api/calendar/public/registrations/${token}`, c.req.url).href,
      notice = await prepareMessage(c, address, {
        kind: "recovery",
        action: "recovery",
        url,
      });
    await mutate(c, {
      operation: "registration.recovery",
      principal: {
        actor_key: `recovery:${await digest(address)}`,
        actor_user_id: null,
        auth: eventAvailable(reg.event_id),
      },
      request: data,
      result: null,
      build: (proof, operation) => [
        insert(
          c,
          "calendar_registration_manage_tokens",
          {
            id,
            registration_id: reg.id,
            token_hash: hash,
            expires_at: now() + 365 * 86400,
          },
          proof,
        ),
        ...notice(proof, operation),
      ],
    });
    wakeCalendar(c);
  }
  return c.json({ accepted: true });
});
