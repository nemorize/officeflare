import * as Y from "yjs";
import { decodeBytes, MAX_STATE_BYTES } from "../../shared/collaboration";
import { initialRichText, richTextValue, validateRichText } from "../../shared/rich-text";
import type { WikiPage } from "../../shared/wiki";
import { fail } from "../ai/errors";
import { hash } from "../ai/store";
import type { AIEnv, AIPrincipal, ObjectValue } from "../ai/types";
import { domainRequest } from "./domain";
import { wikiCollaboration } from "../wiki/collaboration";

export function validateWikiChanges(args: ObjectValue) {
  const doc = initialRichText();
  try {
    wikiCollaboration.edit!(doc, {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.text !== undefined ? { text: args.text } : {}),
    });
    validateRichText(doc);
  } catch {
    fail(400, "AI_INVALID_INPUT");
  } finally {
    doc.destroy();
  }
}

function actor(principal: AIPrincipal) {
  if (principal.kind !== "user") fail(403, "AI_FORBIDDEN");
  return {
    user_id: principal.userId,
    session_id: principal.sessionId,
    auth_version: principal.authVersion,
  };
}
function room(env: AIEnv, page: WikiPage) {
  return env.COLLABORATION_ROOM.get(env.COLLABORATION_ROOM.idFromName(page.resource_id));
}
export async function wikiPage(env: AIEnv, principal: AIPrincipal, pageId: string) {
  const { page } = (await domainRequest(
    env,
    principal,
    "/api/wiki/pages/" + encodeURIComponent(pageId),
  )) as { page: WikiPage };
  const result = await room(env, page).inspect(page.resource_id, actor(principal), "content");
  if (result.status !== 200 || !("state" in result)) fail(404, "AI_NOT_FOUND");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, decodeBytes(result.state, MAX_STATE_BYTES));
    const { title, text } = richTextValue(doc);
    return { ...page, title, text, epoch: result.epoch, seq: result.seq };
  } finally {
    doc.destroy();
  }
}
async function editPage(
  env: AIEnv,
  principal: AIPrincipal,
  page: WikiPage,
  args: ObjectValue,
  operation: string,
) {
  const changes = {
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.text !== undefined ? { text: args.text } : {}),
  };
  if (!Object.keys(changes).length) fail(400, "AI_INVALID_INPUT");
  const result = await room(env, page).edit(page.resource_id, actor(principal), {
    operation_id: await hash(["wiki.edit", operation]),
    epoch: Number(args.epoch),
    seq: Number(args.seq),
    changes,
  });
  if (result.status === 412) fail(409, "AI_APPROVAL_STALE");
  if (result.status === 409) fail(409, "AI_CONFLICT");
  if (result.status === 403) fail(403, "AI_FORBIDDEN");
  if (result.status === 404) fail(404, "AI_NOT_FOUND");
  if (result.status !== 200) fail(400, "AI_INVALID_INPUT");
  return { page: await wikiPage(env, principal, page.id) };
}
export async function createWikiPage(
  env: AIEnv,
  principal: AIPrincipal,
  args: ObjectValue,
  operation: string,
) {
  const { page } = (await domainRequest(
    env,
    principal,
    "/api/wiki/spaces/" + encodeURIComponent(String(args.space_id)) + "/pages",
    "POST",
    { parent_id: args.parent_id ?? null },
    operation,
  )) as { page: WikiPage };
  return editPage(
    env,
    principal,
    page,
    { title: args.title, text: args.text, epoch: 1, seq: 0 },
    operation,
  );
}
export async function updateWikiPage(
  env: AIEnv,
  principal: AIPrincipal,
  args: ObjectValue,
  operation: string,
) {
  const page = await wikiPage(env, principal, String(args.page_id));
  return editPage(env, principal, page, args, operation);
}
