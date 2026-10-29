export const driveSearchTypes = [
  { value: "", label: "All types" },
  { value: "folder", label: "Folders" },
  { value: "file", label: "Files" },
  { value: "application/pdf", label: "PDFs" },
  { value: "image/*", label: "Images" },
  { value: "video/*", label: "Videos" },
  { value: "audio/*", label: "Audio" },
  { value: "text/*", label: "Text files" },
];
export const driveSearchScopes = [
  { value: "all", label: "All accessible files" },
  { value: "my", label: "My drive" },
  { value: "shared", label: "Shared with me" },
  { value: "starred", label: "Starred" },
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
