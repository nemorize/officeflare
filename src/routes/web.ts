import { html } from "hono/html";
import { getLocale } from "../../shared/i18n/index.ts";

export function renderPage(title: string) {
  return html`<!doctype html>
    <html lang="${getLocale()}">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
      </head>
      <body>
        <h1>${title}</h1>
      </body>
    </html>`;
}
