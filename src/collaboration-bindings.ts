import { CollaborationRoom } from "./collaboration/room";
import type { CollaborationAdapters } from "./collaboration/types";
import { wikiCollaboration } from "./wiki/collaboration";

// Composition root: registering a service never changes the collaboration engine.
export const collaborationAdapters: CollaborationAdapters = { wiki: wikiCollaboration };
export class CollaborationRoomDO extends CollaborationRoom {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, collaborationAdapters);
  }
}
