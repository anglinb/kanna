import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"
import { Effect, Result, Schema } from "effect"

/** A command that could not be started, or whose output could not be read. */
export class CommandSpawnError extends Schema.TaggedError<CommandSpawnError>()(
  "@kanna/server/process-utils/CommandSpawnError",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

function spawnErrorMessage(command: string, error: unknown) {
  if (!(error instanceof Error)) {
    return `Failed to start ${command}`
  }
  if ("code" in error && error.code === "ENOENT") {
    return `Command not found: ${command}`
  }
  return error.message || `Failed to start ${command}`
}

const spawnError = (command: string, cause: unknown) =>
  new CommandSpawnError({ command, message: spawnErrorMessage(command, cause), cause })

/**
 * Start `command` detached from this process (an editor, a file manager, a
 * browser) and succeed once it has started. It is never waited on or killed.
 */
export const spawnDetached = Effect.fn("ProcessUtils.spawnDetached")(function* (command: string, args: string[]) {
  yield* Effect.annotateCurrentSpan("command", command)
  // Listeners go on in the same tick as the spawn: node reports a missing
  // command as an `error` event right after `spawn` returns.
  yield* Effect.callback<void, CommandSpawnError>((resume) => {
    const started = Result.try(() => spawn(command, args, { stdio: "ignore", detached: true }))
    if (Result.isFailure(started)) {
      resume(Effect.fail(spawnError(command, started.failure)))
      return
    }
    const child = started.success
    const handleError = (error: Error) => resume(Effect.fail(spawnError(command, error)))
    child.once("error", handleError)
    child.once("spawn", () => {
      child.off("error", handleError)
      child.unref()
      resume(Effect.void)
    })
  })
})

export interface CommandOutput {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run `argv` to completion and collect what it printed on the streams asked
 * for. The process is killed if the caller is interrupted before it exits.
 */
export const runCommand = Effect.fn("ProcessUtils.runCommand")(function* (
  argv: ReadonlyArray<string>,
  options: {
    readonly cwd?: string
    readonly env?: Record<string, string | undefined>
    readonly stdout?: boolean
    readonly stderr?: boolean
  } = {},
) {
  const command = argv[0] ?? ""
  yield* Effect.annotateCurrentSpan("command", command)
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn([...argv], {
        cwd: options.cwd,
        env: options.env,
        stdin: "ignore",
        stdout: options.stdout ? "pipe" : "ignore",
        stderr: options.stderr ? "pipe" : "ignore",
      }),
      catch: (cause) => spawnError(command, cause),
    }),
    (child) => Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }),
  )
  const [, stdout, stderr] = yield* Effect.tryPromise({
    try: () => Promise.all([child.exited, readText(child.stdout), readText(child.stderr)]),
    catch: (cause) => new CommandSpawnError({ command, message: `Failed to read the output of ${command}`, cause }),
  })
  return { exitCode: child.exitCode, stdout, stderr } satisfies CommandOutput
}, Effect.scoped)

function readText(stream: ReadableStream<Uint8Array> | number | undefined) {
  return stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve("")
}

/** Whether `argv` runs and exits 0. A command that can't start is a no. */
const succeeds = Effect.fn("ProcessUtils.succeeds")(function* (argv: ReadonlyArray<string>) {
  return yield* runCommand(argv).pipe(
    Effect.map((output) => output.exitCode === 0),
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(false)),
  )
})

/**
 * Whether `command` is on the login shell's PATH, asked of `sh` on every
 * platform (the updaters' check). Blocks while the shell runs. Probes run in
 * bulk use `commandExists`.
 */
export const hasCommand = Effect.fn("ProcessUtils.hasCommand")(function* (command: string) {
  return yield* Effect.sync(() => spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0)
})

/**
 * `hasCommand` without blocking the event loop — for probes run in bulk.
 *
 * Windows has no `sh`, so asking it there would report every command missing
 * and quietly grey out the whole menu; `where` is the equivalent lookup.
 */
export const commandExists = Effect.fn("ProcessUtils.commandExists")(function* (command: string) {
  if (process.platform === "win32") {
    return yield* succeeds(["where", command])
  }
  return yield* succeeds(["sh", "-lc", `command -v ${command}`])
})

/** `canOpenMacApp` without blocking the event loop. */
export const macAppExists = Effect.fn("ProcessUtils.macAppExists")(function* (appName: string) {
  return yield* succeeds(["open", "-Ra", appName])
})

/**
 * Per-user bin dirs installers target without necessarily reaching the
 * sh login PATH: the native Claude Code installer uses ~/.local/bin but adds
 * its PATH line to the interactive shell rc (~/.zshrc on macOS), which
 * `sh -lc` never reads. Checked as a fallback when the login shell misses.
 */
const USER_BIN_DIRS = [".local/bin", ".bun/bin", ".npm-global/bin"]

function findInUserBinDirs(command: string, homeDir: string): string | null {
  for (const dir of USER_BIN_DIRS) {
    const candidate = path.join(homeDir, dir, command)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // missing or not executable — keep looking
    }
  }
  return null
}

/**
 * Resolve a command to an absolute path using a login shell, so binaries the
 * server process's own PATH misses (npm globals, ~/.local/bin) are still
 * found — the server may have been launched from launchd/systemd/cron.
 * Falls back to well-known per-user bin dirs the login shell may not cover.
 */
export function resolveCommandPath(command: string, homeDir = homedir()): string | null {
  if (!/^[\w.-]+$/.test(command)) return null

  // Fast path: the login shell below is a synchronous spawn that blocks the
  // event loop for ~5 ms (up to 24 ms observed here), and callers like
  // diff-store's `gh` runner hit this per invocation. `Bun.which` is ~0.045 ms.
  // It only sees the server's own PATH — which is exactly the gap the login
  // shell exists to cover — so it is a fast path, not a replacement.
  // Deliberately not memoized: callers that need to re-resolve after an install
  // (provider-auth's `fresh` option) must not be served a stale path.
  // PATH is passed explicitly because Bun.which otherwise reads the startup
  // environment and misses what `inheritShellPath` added.
  const direct = Bun.which(command, { PATH: process.env.PATH ?? "" })
  if (direct) return direct

  const result = spawnSync("sh", ["-lc", `command -v -- ${command}`], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  })
  if (result.status === 0) {
    const resolved = result.stdout?.trim().split("\n").pop()?.trim() ?? ""
    if (resolved.startsWith("/")) return resolved
  }
  return findInUserBinDirs(command, homeDir)
}

const SHELL_PATH_MARKER = "__KANNA_SHELL_PATH__"
export const SHELL_ENV_IMPORTED_ENV_VAR = "KANNA_SHELL_ENV_IMPORTED"
const SHELL_PATH_TIMEOUT_MS = 5_000

/**
 * `current` in its own order, then every `shell` entry it lacks. Appending
 * rather than replacing means a command the server already found keeps
 * resolving to the same binary (e.g. `bun run dev`'s node_modules/.bin).
 */
export function mergePathLists(current: string, shell: string) {
  const entries = [...current.split(path.delimiter), ...shell.split(path.delimiter)]
  return [...new Set(entries.filter(Boolean))].join(path.delimiter)
}

/** The PATH between the two markers, ignoring whatever the rc files print. */
export function parseShellPathOutput(output: string) {
  const [, between] = output.split(SHELL_PATH_MARKER)
  return between?.trim() || null
}

/**
 * Add the user's interactive login shell PATH to this process's PATH.
 *
 * Agents inherit `process.env` whole, and a server started by launchd, a
 * detached `kanna`, or the desktop app gets a PATH that skips ~/.zshrc, where
 * installers like to put ~/.local/bin. Skills then fail with "command not
 * found" for CLIs that work in the user's terminal. `resolveCommandPath`
 * covers the few binaries Kanna runs itself; this covers what agents run.
 *
 * `-i` is what reads ~/.zshrc. `printenv` rather than `$PATH` so fish, which
 * joins list variables with spaces, prints the same thing.
 */
export const inheritShellPath = Effect.fn("ProcessUtils.inheritShellPath")(function* () {
  if (process.platform === "win32") return
  // The Mac app already started this process with the whole login-shell
  // environment (macos/src/shell-env.ts); a heavy ~/.zshrc costs
  // seconds, so don't pay for it twice.
  if (process.env[SHELL_ENV_IMPORTED_ENV_VAR] === "1") return
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
  const output = yield* readLoginShellPath(shell).pipe(
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed("")),
  )
  const shellPath = parseShellPathOutput(output)
  if (!shellPath) return
  process.env.PATH = mergePathLists(process.env.PATH ?? "", shellPath)
})

const readLoginShellPath = Effect.fn("ProcessUtils.readLoginShellPath")(function* (shell: string) {
  const script = `echo ${SHELL_PATH_MARKER}; printenv PATH; echo ${SHELL_PATH_MARKER}`
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn([shell, "-ilc", script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        // oh-my-zsh otherwise asks whether to update, and nobody can answer.
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
      }),
      catch: (cause) => spawnError(shell, cause),
    }),
    (child) => Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }),
  )
  // A slow or hung rc file must not stall boot: kill the shell and read
  // whatever it printed before it died.
  yield* Effect.sleep(SHELL_PATH_TIMEOUT_MS).pipe(
    Effect.andThen(Effect.sync(() => child.kill("SIGKILL"))),
    Effect.forkScoped,
  )
  return yield* Effect.tryPromise({
    try: () => new Response(child.stdout).text(),
    catch: (cause) => new CommandSpawnError({ command: shell, message: `Failed to read the output of ${shell}`, cause }),
  })
}, Effect.scoped)

/** Whether macOS knows an app by this name. Blocks, like `hasCommand`. */
export const canOpenMacApp = Effect.fn("ProcessUtils.canOpenMacApp")(function* (appName: string) {
  return yield* Effect.sync(() => spawnSync("open", ["-Ra", appName], { stdio: "ignore" }).status === 0)
})
