import path from "node:path"
import { defineConfig } from "vite"
import { foldkit } from "@foldkit/vite-plugin"

// The Foldkit web client as the server serves it (dist/foldkit-client), for
// the end-to-end runs against a real server (scripts/foldkit/e2e). Becomes
// vite.config.ts's build when the production entry switches.
export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/foldkit/entry"),
  plugins: [foldkit()],
  publicDir: path.resolve(import.meta.dirname, "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/foldkit-client"),
    emptyOutDir: true,
  },
})
