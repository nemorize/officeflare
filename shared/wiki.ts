export const wikiRoles = ["viewer", "commenter", "editor", "manager"] as const;
export type WikiRole = (typeof wikiRoles)[number];
export interface WikiSpace {
  id: string;
  name: string;
  description: string;
  kind: "team" | "personal";
  owner_user_id: string;
  version: number;
  acl_version: number;
  tree_version: number;
  created_at: number;
  archived_at: number | null;
  role: number;
}
export interface WikiPage {
  id: string;
  space_id: string;
  parent_id: string | null;
  resource_id: string;
  title: string;
  icon: string;
  sort_order: number;
  permission_mode: "inherit" | "restricted";
  version: number;
  projected_epoch: number;
  projected_seq: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  purged_at: number | null;
  role: number;
  favorite?: number;
}
export interface WikiComment {
  id: string;
  page_id: string;
  author_user_id: string;
  author_name: string;
  body: string;
  resolved_at: number | null;
  version: number;
  created_at: number;
}
