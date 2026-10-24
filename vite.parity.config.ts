import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { messageScrollerPatch } from "./vite-plugin-message-scroller"

// One of the two parity apps (src/parity), chosen by PARITY_APP: the React
// reference or the Foldkit candidate, each on the fixture backend and its own
// port. scripts/parity/run.ts starts both when they aren't already up.
export const PARITY_PORTS = { react: 4810, foldkit: 4811 } as const

const app = process.env.PARITY_APP === "foldkit" ? "foldkit" : "react"

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/parity", app),
  plugins: app === "react" ? [messageScrollerPatch(), react()] : [],
  publicDir: path.resolve(import.meta.dirname, "public"),
  server: {
    host: "127.0.0.1",
    port: PARITY_PORTS[app],
    strictPort: true,
    // Nothing to reload: the runner opens a fresh page per capture.
    hmr: false,
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/parity", app),
    emptyOutDir: true,
  },
})
