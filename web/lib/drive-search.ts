import { t } from "../../shared/i18n/index.ts";
export const driveSearchTypes = [
  { value: "", label: t("libDriveSearch.allTypes") },
  { value: "folder", label: t("libDriveSearch.folders") },
  { value: "file", label: t("libDriveSearch.files") },
  { value: "application/pdf", label: t("libDriveSearch.pdfs") },
  { value: "image/*", label: t("libDriveSearch.images") },
  { value: "video/*", label: t("libDriveSearch.videos") },
  { value: "audio/*", label: t("libDriveSearch.audio") },
  { value: "text/*", label: t("libDriveSearch.textFiles") },
];
export const driveSearchScopes = [
  { value: "all", label: t("libDriveSearch.allAccessibleFiles") },
  { value: "my", label: t("libDriveSearch.myDrive") },
  { value: "shared", label: t("libDriveSearch.sharedWithMe") },
  { value: "starred", label: t("libDriveSearch.starred") },
];
export interface DriveSearchFields {
  q: string;
  type: string;
  owner: string;
  scope: string;
  after: string;
  before: string;
}
export function readDriveSearch(params: URLSearchParams): DriveSearchFields {
  const scope = params.get("scope") ?? "all";
  return {
    q: params.get("q") ?? "",
    type: params.get("content_type") || params.get("kind") || "",
    owner: params.get("owner") ?? "",
    scope: driveSearchScopes.some((option) => option.value === scope) ? scope : "all",
    after: params.get("after") ?? "",
    before: params.get("before") ?? "",
  };
}
export function driveSearchParams(fields: DriveSearchFields) {
  const params = new URLSearchParams();
  for (const key of ["q", "owner", "after", "before"] as const) {
    const value = fields[key].trim();
    if (value) params.set(key, value);
  }
  if (fields.type === "file" || fields.type === "folder") params.set("kind", fields.type);
  else if (fields.type) {
    params.set("kind", "file");
    params.set("content_type", fields.type);
  }
  if (params.size || fields.scope !== "all") params.set("scope", fields.scope);
  return params;
}
export function isDriveSearch(params: URLSearchParams) {
  return ["q", "scope", "content_type", "owner", "after", "before"].some(
    (key) => !!params.get(key),
  );
}
