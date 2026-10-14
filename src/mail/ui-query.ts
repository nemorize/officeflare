/** Shared by bootstrap and the client so the first page has exactly one cache key. */
export function mailViewOptions(section: string, folder: string | undefined, search: string) {
  const options = new URLSearchParams({ limit: "50" });
  if (!search && (folder || !["starred", "snoozed", "all", "scheduled"].includes(section))) options.set("folder_id", folder ?? section);
  if (section === "all" || section === "scheduled") { options.set("view", section === "scheduled" ? "outbox" : "all"); options.set("include_snoozed", "true"); }
  if (section === "starred" && !search) options.set("q", "is:starred");
  if (search) options.set("q", search);
  if (section === "snoozed") { options.set("snoozed_only", "true"); options.set("include_snoozed", "true"); }
  return options;
}
export function mailGrouped(section: string, search: string, conversation: boolean) {
  return conversation && !search && !["drafts", "scheduled"].includes(section);
}
