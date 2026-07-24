import { spawn, spawnSync } from "node:child_process"

function formatSpawnError(command: string, error: unknown) {
  if (!(error instanceof Error)) {
    return new Error(`Failed to start ${command}`)
  }

  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined
  if (code === "ENOENT") {
    return new Error(`Command not found: ${command}`)
  }

  return new Error(error.message || `Failed to start ${command}`)
}

export function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true })
    } catch (error) {
      reject(formatSpawnError(command, error))
      return
    }

    const handleError = (error: Error) => {
      reject(formatSpawnError(command, error))
    }

    child.once("error", handleError)
    child.once("spawn", () => {
      child.off("error", handleError)
      child.unref()
      resolve()
    })
  })
}

export function hasCommand(command: string) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" })
  return result.status === 0
}

/**
 * Resolve a command to an absolute path using a login shell, so binaries the
 * server process's own PATH misses (npm globals, ~/.local/bin) are still
 * found — the server may have been launched from launchd/systemd/cron.
 */
export function resolveCommandPath(command: string): string | null {
  if (!/^[\w.-]+$/.test(command)) return null
  const result = spawnSync("sh", ["-lc", `command -v -- ${command}`], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  })
  if (result.status !== 0) return null
  const resolved = result.stdout?.trim().split("\n").pop()?.trim() ?? ""
  return resolved.startsWith("/") ? resolved : null
}

export function canOpenMacApp(appName: string) {
  const result = spawnSync("open", ["-Ra", appName], { stdio: "ignore" })
  return result.status === 0
}
