import { marked } from "marked";

const escapeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function configureDriveViewerMarkdown() {
  // Flyfish's Markdown renderer uses this Marked instance. Remove remote image
  // URLs before the generated markup can reach a browser HTML parser.
  marked.use({
    renderer: {
      html: ({ text }) => escapeText(text),
      image: ({ href, text }) =>
        /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+={0,2}$/i.test(href)
          ? false
          : escapeText(text),
    },
  });
}
