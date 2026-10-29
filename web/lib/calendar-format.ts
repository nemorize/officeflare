export const plainDescription = (html = "") => {
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]*>/g, " ").trim();
  const doc = new DOMParser().parseFromString(
    html.replace(/<\/(p|div|li|h[1-6])>/gi, "</$1>\n").replace(/<br\s*\/?\s*>/gi, "\n"),
    "text/html",
  );
  return (doc.body.textContent ?? "").trim();
};
export const descriptionHtml = (text: string) =>
  text
    ? `<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("\n", "<br>")}</p>`
    : "";
