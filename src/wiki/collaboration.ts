import { CollaborationFault } from "../../shared/collaboration";
import { initialRichText, richTextValue, validateRichText } from "../../shared/rich-text";
import type { CollaborationAdapter } from "../collaboration/types";
import { actorCte, pageRank, pageFilter, permissionCondition, row, stmt } from "./store";
export const wikiCollaboration: CollaborationAdapter = {
  async authorize(env, actor, resource) {
    const permission = permissionCondition(actor.user_id, "wiki.access"),
      write = permissionCondition(actor.user_id, "wiki.pages.update"),
      history = permissionCondition(actor.user_id, "wiki.history.read"),
      restore = permissionCondition(actor.user_id, "wiki.history.restore");
    const page = await row<{
      role: number;
      can_write: number;
      can_history: number;
      can_restore: number;
    }>(
      env,
      `${actorCte} SELECT ${pageRank()} AS role,${write.sql} AS can_write,${history.sql} AS can_history,${restore.sql} AS can_restore
       FROM wiki_pages p JOIN wiki_spaces s ON s.id=p.space_id CROSS JOIN actor WHERE p.id=? AND p.resource_id=? AND ${pageFilter()} AND ${permission.sql}`,
      actor.user_id,
      ...write.args,
      ...history.args,
      ...restore.args,
      resource.resource_id,
      resource.id,
      ...permission.args,
    );
    return {
      read: !!page,
      write: !!page && page.role >= 3 && !!page.can_write,
      history: !!page && page.role >= 3 && !!page.can_history,
      restore: !!page && page.role >= 3 && !!page.can_restore,
    };
  },
  initialize: initialRichText,
  validate(state, resource) {
    if (resource.schema_key !== "rich-text.v1") throw new CollaborationFault("invalid_schema");
    validateRichText(state);
  },
  async project(env, resource, { state, epoch, seq }) {
    const value = richTextValue(state);
    await stmt(
      env,
      `UPDATE wiki_pages SET title=?,plain_text=?,projected_epoch=?,projected_seq=?,updated_at=unixepoch()
      WHERE id=? AND resource_id=? AND purged_at IS NULL AND (projected_epoch<? OR (projected_epoch=? AND projected_seq<?))`,
      value.title,
      value.text,
      epoch,
      seq,
      resource.resource_id,
      resource.id,
      epoch,
      epoch,
      seq,
    ).run();
  },
};
