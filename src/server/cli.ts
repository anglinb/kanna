import process from "node:process"
import { getRuntimeProfile, LOG_PREFIX } from "../shared/branding"
import { openUrl, runCli } from "./cli-runtime"
import { CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, CLI_UI_UPDATE_RESTART_EXIT_CODE } from "./restart"
import { installNightlyBuild } from "./nightly"
import { getReleaseChannel } from "./rc-channel"
import { startKannaServer } from "./server"

// Read version from package.json at the package root
const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
const VERSION: string = pkg.version ?? "0.0.0"

// Last-resort backstop: log escaped rejections (e.g. from requests Bun
// idle-timed-out mid-handler) instead of letting them crash the process.
process.on("unhandledRejection", (reason) => {
  console.error(`${LOG_PREFIX} unhandled rejection:`, reason)
})

const argv = process.argv.slice(2)
let resolveExitAction: ((action: "ui_restart" | "exit") => void) | null = null

// Stable updates come from npm; rc builds come from the fork's GitHub
// Releases. The nightly channel builds upstream's main, so it is offered only
// on the stable profile — an rc build already *is* the fork's fast channel,
// and installing a nightly over one would swap it for an upstream build.
const isReleaseCandidate = getRuntimeProfile() === "rc"
const releaseChannel = getReleaseChannel()

const result = await runCli(argv, {
  version: VERSION,
  bunVersion: Bun.version,
  startServer: async (options) => {
    const started = await startKannaServer(options)
    if (started.updateManager && options.update) {
      started.updateManager.onChange((snapshot) => {
        if (snapshot.status !== "restart_pending") return
        console.log(`${LOG_PREFIX} update installed, shutting down current process for restart`)
        resolveExitAction?.("ui_restart")
      })
    }

    return started
  },
  fetchLatestVersion: releaseChannel.fetchLatestVersion,
  installVersion: releaseChannel.installVersion,
  installNightly: isReleaseCandidate ? undefined : () => installNightlyBuild({ log: console.log }),
  openUrl,
  log: console.log,
  warn: console.warn,
})

if (result.kind === "exited") {
  process.exit(result.code)
}

if (result.kind === "restarting") {
  process.exit(result.reason === "startup_update" ? CLI_STARTUP_UPDATE_RESTART_EXIT_CODE : CLI_UI_UPDATE_RESTART_EXIT_CODE)
}

const exitAction = await new Promise<"ui_restart" | "exit">((resolve) => {
  resolveExitAction = resolve

  const shutdown = () => {
    resolve("exit")
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
})

await result.stop()
if (exitAction === "ui_restart") {
  console.log(`${LOG_PREFIX} current process stopped, handing restart back to supervisor`)
}
process.exit(exitAction === "ui_restart" ? CLI_UI_UPDATE_RESTART_EXIT_CODE : 0)
