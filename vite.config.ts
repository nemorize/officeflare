import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

export default defineConfig(({ command }) => ({
  // Wrangler keeps building the API Worker for the existing deployment pipeline.
  // In development the plugin runs that same Worker alongside Vite's live UI.
  plugins: [react(), ...(command === "serve" ? [cloudflare()] : [])],
  resolve: { alias: { "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 8787, strictPort: true },
  build: { outDir: "dist/client" },
}));
