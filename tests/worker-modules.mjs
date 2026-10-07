import { readdirSync } from "node:fs";
// Wrangler emits SQL Text modules alongside the entrypoint; include them in workerd fixtures.
export const workerModules = [
  { type: "ESModule", path: "dist/index.js" },
  ...readdirSync("dist")
    .filter((file) => file.endsWith(".sql"))
    .map((file) => ({ type: "Text", path: "dist/" + file })),
];
