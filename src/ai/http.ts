import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { fail } from "./errors";

function errorResponse(error: Error): Response {
  if (error instanceof HTTPException) return error.getResponse();
  if (
    error instanceof SyntaxError ||
    /CHECK constraint failed|NOT NULL constraint failed|cannot store .* in .* column/i.test(
      error.message,
    )
  ) {
    try {
      fail(400, "AI_INVALID_INPUT");
    } catch (mapped) {
      return (mapped as HTTPException).getResponse();
    }
  }
  if (/UNIQUE constraint failed|FOREIGN KEY constraint failed/i.test(error.message)) {
    try {
      fail(409, "AI_CONFLICT");
    } catch (mapped) {
      return (mapped as HTTPException).getResponse();
    }
  }
  // Never log provider payloads, callback parameters or request bodies.
  console.error("AI/MCP request failed");
  try {
    fail(500, "AI_PROVIDER_ERROR");
  } catch (mapped) {
    return (mapped as HTTPException).getResponse();
  }
}

export function safeAPIError(error: Error, c: Context): Response {
  const response = errorResponse(error);
  return c.newResponse(response.body, {
    status: response.status as ContentfulStatusCode,
    headers: response.headers,
  });
}
