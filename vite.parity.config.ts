import path from "node:path"
import { defineConfig } from "vite"
import { foldkit } from "@foldkit/vite-plugin"

// The parity app (src/parity/foldkit): the Foldkit client on the fixture
// backend, with its gallery pages. scripts/parity/run.ts builds and serves it
// and compares it with the recorded baseline (.parity/baseline).
export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/parity/foldkit"),
  plugins: [foldkit()],
  publicDir: path.resolve(import.meta.dirname, "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/parity/foldkit"),
    emptyOutDir: true,
  },
})
