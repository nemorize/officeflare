/** Accept deployed HTTP URLs and Wrangler route targets, including path wildcards. */
export function applicationHostname(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || /\s/.test(value)) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !hostname ||
      hostname.includes("*") ||
      hostname.length > 253
    )
      return null;
    return hostname;
  } catch {
    return null;
  }
}
