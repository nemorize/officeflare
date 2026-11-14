import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDatabase } from "../db";
import type { AppEnv } from "../auth/types";
import contacts from "../routes/contacts";
import drive from "../routes/drive";
import calendar from "../routes/calendar";
import { identity } from "../ai/store";
import { fail } from "../ai/errors";
import type { AIEnv, AIPrincipal } from "../ai/types";

// In-process Hono dispatch reuses each domain's validation, ACLs, conditional
// mutations, idempotency receipts and delivery outbox. There is no HTTP loopback
// and no synthetic administrator credential or new user login.
export async function domainRequest(
  env: AIEnv,
  principal: AIPrincipal,
  path: string,
  method = "GET",
  data?: unknown,
  operationKey?: string,
) {
  await identity(env, principal);
  const target = new URL("https://domain.officeflare.internal" + path);
  if (principal.kind !== "user" || !/^\/api\/(contacts|drive|calendar)(\/|$)/.test(target.pathname))
    fail(403, "AI_FORBIDDEN");
  const pending: Promise<unknown>[] = [],
    app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", createDatabase(env.DB));
    c.set("internalIdentity", {
      userId: principal.userId,
      sessionId: principal.sessionId,
      version: principal.authVersion,
    });
    await next();
  });
  app.route("/api/contacts", contacts);
  app.route("/api/drive", drive);
  app.route("/api/calendar", calendar);
  app.onError((error, c) =>
    error instanceof HTTPException ? error.getResponse() : c.json({ error: "DOMAIN_FAILURE" }, 500),
  );
  const response = await app.fetch(
    new Request(target, {
      method,
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(operationKey ? { "Idempotency-Key": operationKey } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    env,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as ExecutionContext,
  );
  await Promise.allSettled(pending);
  if (!response.ok) {
    if (response.status >= 500) fail(502, "AI_PROVIDER_ERROR");
    throw new HTTPException(response.status as 400, { res: response });
  }
  if (response.status === 204) return { completed: true };
  if (response.headers.get("content-type")?.includes("application/json")) return response.json();
  if (!response.headers.get("content-type")?.startsWith("text/")) {
    await response.body?.cancel();
    fail(422, "AI_CAPABILITY_UNSUPPORTED");
  }
  if (Number(response.headers.get("content-length")) > 65536) {
    await response.body?.cancel();
    fail(413, "AI_LIMIT_REACHED");
  }
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) return { text: "" };
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 65536) {
      await reader.cancel();
      fail(413, "AI_LIMIT_REACHED");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    text: new TextDecoder().decode(bytes),
    content_type: response.headers.get("content-type"),
  };
}
