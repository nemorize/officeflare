import { Hono } from "hono";
import { html } from "hono/html";
import type { AppEnv } from "../auth/types";

const web = new Hono<AppEnv>();

export function renderPage(title: string) {
  return html`<!doctype html>
    <html lang="en">
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

web.get("/", (c) => c.html(renderPage("Officeflare")));

export default web;
