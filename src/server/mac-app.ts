/**
 * The Kanna Mac app (macos/) and the CLI keep each other running. The app is
 * a window around the globally installed `kanna`: opening it starts
 * `kanna --no-open` (or adopts one a terminal already started), and running
 * `kanna` in a terminal opens the app instead of a browser tab. This file is
 * the CLI's half of that arrangement.
 */

import process from "node:process"
import { Effect } from "effect"
import { runCommand } from "./process-utils"

export const MAC_APP_BUNDLE_ID = "sh.kanna.mac"
/** Registered by the app (macos/electron-builder.yml). `open?url=` names the server to show. */
export const MAC_APP_URL_SCHEME = "kanna-app"

/** The app sets this so a server it started does not outlive a crashed app. */
export const EXIT_WITH_PARENT_ENV_VAR = "KANNA_EXIT_WITH_PARENT"

export function macAppOpenUrl(localUrl: string) {
  return `${MAC_APP_URL_SCHEME}://open?url=${encodeURIComponent(localUrl)}`
}

/**
 * Show `localUrl` in the Mac app when it is installed. Succeeds with false when it
 * is not (or off macOS), so the caller falls back to the browser. `open -b`
 * exits non-zero when no app has the bundle id, which is the whole check.
 */
export const openInMacApp = Effect.fn("MacApp.open")(function* (
  localUrl: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin") return false
  return yield* runCommand(["open", "-b", MAC_APP_BUNDLE_ID, macAppOpenUrl(localUrl)]).pipe(
    Effect.map((output) => output.exitCode === 0),
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(false)),
  )
})

/**
 * A server the app started should go when the app goes, crash included. A
 * crashed parent does not signal its children, so poll for the parent. The
 * supervisor and its child both watch: the supervisor for the app, the child
 * for a supervisor that was killed outright.
 *
 * Poll the parent's pid, not `process.ppid`: Bun reads that once at start,
 * so it never turns into launchd's 1 when the parent dies.
 *
 * A plain unref'd interval rather than an Effect schedule: the watch must not
 * keep the process alive on its own, and an Effect sleep holds a ref'd timer.
 */
export function exitWithParent(
  onOrphaned: () => void,
  env: Record<string, string | undefined> = process.env,
  parent: number = process.ppid,
) {
  if (env[EXIT_WITH_PARENT_ENV_VAR] !== "1" || parent <= 1) return
  setInterval(() => {
    if (!isAlive(parent)) onOrphaned()
  }, 2_000).unref()
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it's there, just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
