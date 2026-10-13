import type { ApiOptions } from "./api-client";

export type DriveRole = "owner" | "editor" | "commenter" | "viewer";
export interface DrivePerson {
  id: string;
  display_name: string | null;
  email_address: string;
  has_profile_image?: boolean;
  profile_image_version?: string | null;
}
export interface DriveItem {
  id: string;
  name: string;
  kind: "file" | "folder";
  parent_id: string | null;
  owner_user_id: string;
  owner?: DrivePerson;
  effective_role?: DriveRole | null;
  actions?: { create: boolean; update: boolean; delete: boolean; download: boolean; copy: boolean; comment: boolean; internal_share: boolean; public_share: boolean };
  description: string;
  version: number;
  current_version_id: string | null;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  starred?: boolean;
  size?: number | null;
  content_type?: string | null;
  current_version?: {
    id: string;
    size: number;
    content_type: string;
    sha256: string | null;
  } | null;
}
export interface DrivePage {
  items: DriveItem[];
  next_cursor: string | null;
}
export interface DriveQuota {
  used_bytes: number;
  reserved_bytes: number;
  quota_bytes: number;
  available_bytes: number;
  status?: "active" | "read_only" | "suspended";
}
export interface DriveCapabilities {
  max_file_bytes: number; trash_retention_days: number; permissions: string[];
  account_status: "active" | "read_only" | "suspended"; write_locked: boolean;
  internal_sharing_enabled: boolean; public_sharing_enabled: boolean;
  public_link_password_required: boolean; public_link_max_days: number;
}
export interface DriveGrant {
  item_id: string;
  user_id: string;
  display_name: string | null;
  email_address: string;
  has_profile_image?: boolean;
  profile_image_version?: string | null;
  role: Exclude<DriveRole, "owner">;
  expires_at: number | null;
  inherited: number;
  source_name: string;
}
export interface DriveLink {
  id: string;
  allow_download: number;
  password_protected: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}
export interface DriveVersion {
  id: string;
  size: number;
  content_type: string;
  created_at: number;
  current: boolean;
}
export interface DriveComment {
  id: string;
  parent_id: string | null;
  author_user_id: string;
  author_name: string;
  body: string;
  resolved: boolean;
  version: number;
  created_at: number;
}
export interface DriveActivity {
  seq: number;
  actor_name: string | null;
  link_id: string | null;
  action: string;
  details: Record<string, unknown>;
  created_at: number;
}
export type DriveApi = <T>(path: string, options?: ApiOptions) => Promise<T>;
export const driveSize = (item: DriveItem) =>
  item.current_version?.size ?? item.size ?? 0;
export const driveType = (item: DriveItem) =>
  item.current_version?.content_type ??
  item.content_type ??
  "application/octet-stream";
export const canEdit = (item: DriveItem) =>
  item.actions?.update ?? (item.effective_role === "owner" || item.effective_role === "editor");
export const canComment = (item: DriveItem) =>
  item.actions?.comment ?? (item.effective_role === "owner" || item.effective_role === "editor" || item.effective_role === "commenter");
export function formatBytes(value: number) {
  if (!value) return "0 B";
  const unit = Math.min(
    4,
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
  );
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
export function driveDate(value: number, full = false) {
  return new Intl.DateTimeFormat(
    "en",
    full
      ? { dateStyle: "medium", timeStyle: "short" }
      : { month: "short", day: "numeric", year: "numeric" },
  ).format(new Date(value * 1000));
}
export function fileKind(item: DriveItem) {
  const type = driveType(item);
  if (item.kind === "folder")
    return { label: "Folder", icon: "folder" as const, tone: "folder" };
  if (type.startsWith("image/"))
    return { label: "Image", icon: "image" as const, tone: "image" };
  if (type === "application/pdf")
    return { label: "PDF", icon: "file" as const, tone: "pdf" };
  if (/spreadsheet|csv|excel/.test(type))
    return { label: "Spreadsheet", icon: "table" as const, tone: "sheet" };
  if (type.startsWith("text/"))
    return { label: "Text document", icon: "file" as const, tone: "text" };
  if (/zip|compressed|archive/.test(type))
    return { label: "Archive", icon: "archive" as const, tone: "archive" };
  if (type.startsWith("video/"))
    return { label: "Video", icon: "image" as const, tone: "video" };
  return { label: "File", icon: "file" as const, tone: "file" };
}
export const previewKind = (item: DriveItem) => {
  if (driveSize(item) > 20 * 1024 * 1024) return null;
  const type = driveType(item).split(";")[0]!.toLowerCase();
  if (
    [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/avif",
    ].includes(type)
  )
    return "image";
  if (type === "application/pdf") return "pdf";
  if (
    type.startsWith("text/") ||
    ["application/json", "application/xml"].includes(type)
  )
    return "text";
  return null;
};
export function selectDriveItems(
  ids: string[],
  selected: Set<string>,
  id: string,
  anchor: string | null,
  range: boolean,
  additive: boolean,
) {
  const next = additive || range ? new Set(selected) : new Set<string>();
  if (range && anchor && ids.includes(anchor) && ids.includes(id)) {
    const start = ids.indexOf(anchor),
      end = ids.indexOf(id);
    for (const key of ids.slice(Math.min(start, end), Math.max(start, end) + 1))
      next.add(key);
  } else if (additive && next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
export function driveLocation(path: string) {
  const folder = /^\/drive\/folders\/([A-Za-z0-9_-]{1,100})$/.exec(path)?.[1];
  const view = path.split("/")[2] ?? "my";
  return {
    folder: folder ?? null,
    view: folder
      ? "all"
      : ["shared", "recent", "starred", "trash"].includes(view)
        ? view
        : "my",
  };
}
export function publicShareUrl(token: string, origin: string) {
  if (!/^ofd_[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("Invalid share token.");
  return `${origin}/share/drive/${token}`;
}
export interface UploadSession {
  id: string;
  item_id: string;
  mode: "single" | "multipart";
  status: string;
  part_bytes: number;
}
export interface UploadEntry {
  id: string;
  file: File;
  parent: string | null;
  item?: DriveItem;
  upload?: UploadSession;
  state: "queued" | "uploading" | "done" | "error" | "cancelled";
  sent: number;
  error?: string;
}
export async function uploadDriveFile(
  api: DriveApi,
  entry: UploadEntry,
  signal: AbortSignal,
  update: (patch: Partial<UploadEntry>) => void,
) {
  const partBytes = 8 * 1024 * 1024;
  let upload = entry.upload;
  const request = <T>(path: string, options?: ApiOptions) =>
    api<T>(path, {
      ...options,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
  if (!upload) {
    upload = (
      await request<{ upload: UploadSession }>("/api/drive/uploads", {
        method: "POST",
        body: {
          size: entry.file.size,
          content_type: entry.file.type || "application/octet-stream",
          mode: entry.file.size <= partBytes ? "single" : "multipart",
          ...(entry.item
            ? { item_id: entry.item.id, version: entry.item.version }
            : { name: entry.file.name, parent_id: entry.parent }),
        },
      })
    ).upload;
    update({ upload });
  }
  const session = await request<{
    upload: UploadSession;
    parts: { part_number: number; size: number }[];
  }>(`/api/drive/uploads/${upload.id}`);
  if (session.upload.status !== "completed") {
    if (upload.mode === "single") {
      if (session.upload.status !== "ready")
        await request(`/api/drive/uploads/${upload.id}/content`, {
          method: "PUT",
          body: entry.file,
        });
      update({ sent: entry.file.size });
    } else {
      const completed = new Set(session.parts.map((part) => part.part_number));
      let sent = session.parts.reduce((sum, part) => sum + part.size, 0);
      update({ sent });
      for (
        let index = 0;
        index < Math.ceil(entry.file.size / partBytes);
        index++
      ) {
        if (completed.has(index + 1)) continue;
        const chunk = entry.file.slice(
          index * partBytes,
          Math.min(entry.file.size, (index + 1) * partBytes),
        );
        await request(`/api/drive/uploads/${upload.id}/parts/${index + 1}`, {
          method: "PUT",
          body: chunk,
        });
        sent += chunk.size;
        update({ sent });
      }
    }
  }
  const result = await request<{ item: DriveItem }>(
    `/api/drive/uploads/${upload.id}/complete`,
    { method: "POST", body: {} },
  );
  update({ state: "done", sent: entry.file.size });
  return result.item;
}
export function folderPaths(files: { webkitRelativePath: string }[]) {
  const paths = new Set<string>();
  for (const file of files) {
    const segments = file.webkitRelativePath.split("/").filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === ".."))
      throw new Error("Invalid folder path.");
    for (let count = 1; count < segments.length; count++)
      paths.add(segments.slice(0, count).join("/"));
  }
  return [...paths].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
}
