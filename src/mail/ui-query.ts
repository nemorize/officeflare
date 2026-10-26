/** Physical folders excluded from the combined Inbox view. */
export const inboxExcludedFolders = ["sent", "archive", "spam", "trash", "drafts"] as const;
export const isInboxFolder = (folderId: string) => !inboxExcludedFolders.some(folder => folder === folderId);
export const inboxUnread = (folders: Record<string, { unread: number }>) =>
  Object.entries(folders).reduce((count, [id, folder]) => count + (isInboxFolder(id) ? folder.unread : 0), 0);
export const folderMoveLeavesMailView = (section: string, search: string, destination: string) =>
  section !== "inbox" || !!search || !isInboxFolder(destination);

/** Shared by bootstrap and the client so the first page has exactly one cache key. */
export function mailViewOptions(section: string, folder: string | undefined, search: string) {
  const options = new URLSearchParams({ limit: "50" });
  if (!search && (folder || !["inbox", "starred", "snoozed", "all", "scheduled"].includes(section))) options.set("folder_id", folder ?? section);
  if (section === "inbox" && !folder && !search) options.set("view", "inbox");
  if (section === "all" || section === "scheduled") { options.set("view", section === "scheduled" ? "outbox" : "all"); options.set("include_snoozed", "true"); }
  if (section === "starred" && !search) options.set("q", "is:starred");
  if (search) options.set("q", search);
  if (section === "snoozed") { options.set("snoozed_only", "true"); options.set("include_snoozed", "true"); }
  return options;
}
export function mailGrouped(section: string, search: string, conversation: boolean) {
  return conversation && !search && !["drafts", "scheduled"].includes(section);
}
