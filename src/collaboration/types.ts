import type * as Y from "yjs";
import type { CollaborationCapabilities } from "../../shared/collaboration";
export interface CollaborationActor {
  user_id: string;
  session_id: string;
  auth_version: number;
}
export interface CollaborationResource {
  id: string;
  service: string;
  resource_id: string;
  schema_key: string;
}
export interface CollaborationProjection {
  epoch: number;
  seq: number;
  state: Y.Doc;
}
export interface CollaborationAdapter {
  authorize(
    env: Env,
    actor: CollaborationActor,
    resource: CollaborationResource,
  ): Promise<CollaborationCapabilities>;
  initialize(resource: CollaborationResource): Y.Doc;
  validate(state: Y.Doc, resource: CollaborationResource): void;
  project(
    env: Env,
    resource: CollaborationResource,
    projection: CollaborationProjection,
  ): Promise<void>;
}
export type CollaborationAdapters = Readonly<Record<string, CollaborationAdapter>>;
