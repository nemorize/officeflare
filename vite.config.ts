import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";
import { driveViewerRenderers } from "./shared/drive-preview.ts";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defaultLocale, messageTemplate, isStaticMessageKey } from "./shared/i18n/index.ts";
import { localSecretSettings } from "./scripts/local-secrets.ts";

function localizedHtml(): Plugin {
  return {
    name: "localized-html",
    transformIndexHtml(html) {
      return html.replace(/\{\{i18n:([\w.]+)\}\}/g, (_, key: string) => {
        if (key !== "locale" && !isStaticMessageKey(key))
          throw new Error(`Unknown HTML translation: ${key}`);
        const value = key === "locale" ? defaultLocale : messageTemplate(key);
        return value
          .replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  // Wrangler keeps building the API Worker for the existing deployment pipeline.
  // In development the plugin runs that same Worker alongside Vite's live UI.
  plugins: [
    react(),
    localizedHtml(),
    fileViewerRenderers({
      renderers: driveViewerRenderers,
      copyAssets: { baseDir: "file-viewer", publicDir: ".wrangler/file-viewer-assets" },
      chunkStrategy: "none",
      inject: false,
    }),
    ...(command === "serve"
      ? [
          cloudflare({
            config(config) {
              config.secrets = localSecretSettings(config, process.env.CLOUDFLARE_ENV);
            },
          }),
        ]
      : []),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  // The design renderer ships ESM entry points that import these CommonJS helpers.
  optimizeDeps: { include: ["ag-psd", "saxes"] },
  server: { host: "127.0.0.1", port: 8787, strictPort: true },
  build: {
    outDir: "dist/client",
    rolldownOptions: {
      input: {
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        driveViewer: fileURLToPath(new URL("./drive-viewer.html", import.meta.url)),
      },
    },
  },
}));
