#!/usr/bin/env bun
// A Kanna server for the end-to-end runs: its own data dir and keybindings
// file, no cloud, no self-update, serving the client build named by
// E2E_CLIENT_DIR (the Foldkit build, or React's dist/client to check a
// scenario against the reference). Started by run.ts, one per run.
//
//   E2E_PORT, E2E_ROOT (data, keybindings and projects live under it), E2E_CLIENT_DIR

import path from "node:path"

process.env.KANNA_RUNTIME_PROFILE = "dev"
process.env.KANNA_DISABLE_SELF_UPDATE = "1"
process.env.KANNA_LOG_ANALYTICS = "0"

const root = process.env.E2E_ROOT
const clientDir = process.env.E2E_CLIENT_DIR
const port = Number(process.env.E2E_PORT)
if (!root || !clientDir || !Number.isFinite(port)) throw new Error("E2E_ROOT, E2E_CLIENT_DIR and E2E_PORT are required")
process.env.KANNA_DATA_ROOT_NAME = path.relative(process.env.HOME ?? "/", path.join(root, "kanna"))

const { startKannaServer } = await import("../../../src/server/server-bun")
const repo = path.resolve(import.meta.dirname, "../../..")

await startKannaServer({
  port,
  host: "127.0.0.1",
  strictPort: true,
  openBrowser: false,
  dataDir: path.join(root, "kanna", "data"),
  keybindingsPath: path.join(root, "kanna", "keybindings.json"),
  cloudEnabled: false,
  assetDirs: {
    client: clientDir,
    exportViewer: path.join(repo, "dist", "export-viewer"),
  },
})
console.log(`[e2e] server ready on http://127.0.0.1:${port}`)
