import { fail } from "./types";
export interface SearchPlan {
  terms: string[];
  filters: string[];
  bindings: (string | number)[];
}
export function compileSearch(query: string): SearchPlan {
  if (query.length > 1000) fail(400, "Search query is too long");
  const plan: SearchPlan = { terms: [], filters: [], bindings: [] };
  const tokens = query.match(/-?(?:[a-z]+:)?"[^"]*"|-?[^\s"]+/g) ?? [];
  if (tokens.length > 30 || tokens.join(" ").replace(/\s/g, "") !== query.trim().replace(/\s/g, ""))
    fail(400, "Invalid search syntax");
  for (let token of tokens) {
    const excluded = token.startsWith("-");
    if (excluded) token = token.slice(1);
    const split = /^([a-z]+):(.*)$/.exec(token),
      key = split?.[1],
      value = split?.[2] ?? token;
    if (!value || value.length > 256) fail(400, "Invalid search term");
    const negative = excluded ? "NOT " : "";
    if (key === "is") {
      const field = {
        read: "is_read",
        unread: "is_read",
        starred: "is_starred",
        spam: "is_spam",
      }[value];
      if (!field) fail(400, "Unsupported is filter");
      plan.filters.push(negative + "m." + field + "=?");
      plan.bindings.push(value === "unread" ? 0 : 1);
    } else if (key === "has" && value === "attachment") {
      plan.filters.push(negative + "m.has_attachments=1");
    } else if (key === "after" || key === "before") {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        fail(400, "Invalid search date");
      plan.filters.push(negative + "(m.received_at" + (key === "after" ? ">=" : "<") + "?)");
      plan.bindings.push(Date.parse(value) / 1000);
    } else {
      const field = key
        ? { from: "from_address", to: "to_addresses", subject: "subject" }[key]
        : undefined;
      if (key && !field) fail(400, "Unsupported search field");
      const phrase = value.startsWith('"');
      const prefix = !phrase && value.endsWith("*");
      const term = (phrase ? value.slice(1, -1) : prefix ? value.slice(0, -1) : value).replaceAll(
        '"',
        '""',
      );
      if (!term) fail(400, "Empty search term");
      // Each term is evaluated at message scope, so AND also matches terms in different body chunks.
      const expression = (field ? field + ":" : "") + '"' + term + '"' + (prefix ? "*" : "");
      plan.terms.push((excluded ? "-" : "") + expression);
    }
  }
  return plan;
}
