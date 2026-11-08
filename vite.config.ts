import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import type { Plugin } from "vite";
import { defaultLocale, messageTemplate, isStaticMessageKey } from "./shared/i18n/index.ts";

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

// PDF.js needs its own worker plus local fonts/CMaps/decoders for reliable previews.
function pdfPreviewAssets(): Plugin {
  const root = fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url));
  const liberationRoot = fileURLToPath(
    new URL("./vendor/liberation-fonts/2.1.5/", import.meta.url),
  );
  // Preserve PDF.js's expected filenames while using unmodified OFL fonts and their license.
  function sourcePath(relative: string) {
    const liberation = relative.match(
      /^standard_fonts\/(LiberationSans-[\w-]+\.ttf|LICENSE_LIBERATION)$/,
    );
    return liberation ? `${liberationRoot}${liberation[1]}` : `${root}${relative}`;
  }
  let assetVersion = "";
  let isBuild = false;
  const folders = ["cmaps", "standard_fonts", "wasm", "iccs"];
  return {
    name: "drive-pdf-preview-assets",
    async configResolved(config) {
      isBuild = config.command === "build";
      assetVersion = JSON.parse(await readFile(`${root}package.json`, "utf8")).version;
    },
    async buildStart() {
      if (!isBuild) return;
      this.emitFile({
        type: "asset",
        fileName: `pdfjs/${assetVersion}/LICENSE`,
        source: await readFile(`${root}LICENSE`),
      });
      for (const folder of folders)
        for (const name of await readdir(`${root}${folder}`)) {
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${assetVersion}/${folder}/${name}`,
            source: await readFile(sourcePath(`${folder}/${name}`)),
          });
        }
    },
    configureServer(server) {
      server.middlewares.use(`/pdfjs/${assetVersion}/`, async (req, res, next) => {
        const relative = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        if (!/^(cmaps|standard_fonts|wasm|iccs)\/[\w.-]+$/.test(relative)) return next();
        try {
          const bytes = await readFile(sourcePath(relative));
          res.setHeader(
            "Content-Type",
            relative.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
          );
          res.end(bytes);
        } catch {
          next();
        }
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
    pdfPreviewAssets(),
    ...(command === "serve" ? [cloudflare()] : []),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 8787, strictPort: true },
  build: { outDir: "dist/client" },
}));
