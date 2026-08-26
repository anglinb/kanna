/**
 * `kanna ask-secret <NAME>` — the agent-facing half of ask-for-secret.
 *
 * This is the one entry point every provider can reach, because every
 * provider has a shell. It posts a prompt to the running Kanna server, polls
 * until the user answers in the UI, and prints only the shell snippet that
 * loads the secret — never the secret.
 *
 * Polling (rather than one long-held request) keeps a fifteen-minute wait
 * from tripping over any socket idle timeout between here and the server.
 */

import { homedir } from "node:os"
import { CLI_COMMAND } from "../shared/branding"
import {
  isValidSecretName,
  SECRET_CHAT_ID_ENV_VAR,
  SECRETS_API_PATH_PREFIX,
  SECRETS_API_TOKEN_HEADER,
  type SecretRequestResolution,
  type SecretScope,
} from "../shared/secrets"
import { readInstanceFile } from "./instance-file"

export const ASK_SECRET_POLL_INTERVAL_MS = 1_000
/**
 * Chosen to sit inside a typical agent Bash timeout. Timing out is not a
 * failure: the prompt stays open and re-running resumes the same wait.
 */
export const ASK_SECRET_DEFAULT_TIMEOUT_MS = 300_000

export interface AskSecretArgs {
  name: string
  reason: string
  scope: SecretScope | null
  timeoutMs: number
  force: boolean
}

export interface AskSecretDeps {
  log: (message: string) => void
  warn: (message: string) => void
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  cwd?: () => string
  env?: Record<string, string | undefined>
  readInstance?: typeof readInstanceFile
}

export function parseAskSecretArgs(argv: string[]): AskSecretArgs {
  let name: string | null = null
  let reason = ""
  let scope: SecretScope | null = null
  let timeoutMs = ASK_SECRET_DEFAULT_TIMEOUT_MS
  let force = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--reason") {
      const next = argv[index + 1]
      if (!next) throw new Error("Missing value for --reason")
      reason = next
      index += 1
      continue
    }
    if (arg === "--scope") {
      const next = argv[index + 1]
      if (next !== "project" && next !== "global") {
        throw new Error("--scope must be 'project' or 'global'")
      }
      scope = next
      index += 1
      continue
    }
    if (arg === "--timeout") {
      const next = argv[index + 1]
      const seconds = Number(next)
      if (!next || !Number.isFinite(seconds) || seconds <= 0) {
        throw new Error("--timeout takes a number of seconds")
      }
      timeoutMs = seconds * 1000
      index += 1
      continue
    }
    if (arg === "--force") {
      force = true
      continue
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unexpected argument for ${CLI_COMMAND} ask-secret: ${arg}`)
    }
    if (name === null) {
      name = arg
      continue
    }
    throw new Error(`Unexpected argument for ${CLI_COMMAND} ask-secret: ${arg}`)
  }

  if (!name) {
    throw new Error(`Usage: ${CLI_COMMAND} ask-secret <NAME> --reason "why you need it"`)
  }
  if (!isValidSecretName(name)) {
    throw new Error(
      `Invalid secret name '${name}' — use letters, digits and underscores, starting with a letter or underscore (e.g. OPENAI_API_KEY)`,
    )
  }

  return { name, reason, scope, timeoutMs, force }
}

interface CreateResponse {
  status?: string
  requestId?: string
  existing?: boolean
  scope?: SecretScope
  path?: string
  loadCommand?: string
  error?: string
}

/**
 * Exit codes: 0 saved, 1 error, 2 still waiting (timed out), 3 declined.
 * Non-zero is informational for the agent, not a crash.
 */
export async function runAskSecretCommand(
  args: AskSecretArgs,
  deps: AskSecretDeps,
): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const cwd = (deps.cwd ?? (() => process.cwd()))()
  const env = deps.env ?? process.env

  const instance = await (deps.readInstance ?? readInstanceFile)()
  const overrideUrl = env.KANNA_URL?.trim() || null
  const overrideToken = env.KANNA_TOKEN?.trim() || null

  // The instance token is only ever presented to the instance that minted it.
  // An agent controls its own environment, so pairing these matters: letting
  // an overridden KANNA_URL borrow the token from ~/.kanna/instance.json
  // would hand the capability to enumerate secrets and queue prompts to
  // whatever endpoint the agent named.
  const baseUrl = overrideUrl ?? instance?.url
  const token = overrideUrl ? overrideToken : overrideToken ?? instance?.token

  if (overrideUrl && !overrideToken) {
    deps.warn(
      "KANNA_URL is set without KANNA_TOKEN. The token from ~/.kanna/instance.json is not sent "
      + "to an overridden URL — set KANNA_TOKEN explicitly if that endpoint is really yours.",
    )
    return 1
  }

  if (!baseUrl || !token) {
    deps.warn(
      `No running ${CLI_COMMAND} server found (looked for ~/.kanna/instance.json). `
      + `Ask the user to start ${CLI_COMMAND}, or ask them for the value directly.`,
    )
    return 1
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}${SECRETS_API_PATH_PREFIX}`
  const headers = {
    "content-type": "application/json",
    [SECRETS_API_TOKEN_HEADER]: token,
  }

  let created: CreateResponse
  try {
    const response = await fetchImpl(`${endpoint}/requests`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: args.name,
        reason: args.reason,
        cwd,
        scope: args.scope,
        force: args.force,
        // Only set when Kanna spawned this agent with a per-chat environment;
        // the server falls back to cwd matching when it is absent.
        chatId: env[SECRET_CHAT_ID_ENV_VAR] ?? null,
      }),
    })
    created = (await response.json()) as CreateResponse
    if (!response.ok) {
      deps.warn(created.error ?? `Request failed with status ${response.status}`)
      return 1
    }
  } catch (error) {
    deps.warn(`Could not reach ${CLI_COMMAND}: ${(error as Error).message}`)
    return 1
  }

  if (created.status === "saved") {
    printSaved(deps.log, args.name, {
      status: "saved",
      scope: created.scope,
      path: created.path,
      loadCommand: created.loadCommand,
    }, created.existing === true)
    return 0
  }

  const requestId = created.requestId
  if (!requestId) {
    deps.warn("Server did not return a request id")
    return 1
  }

  deps.log(`Waiting for the user to enter ${args.name} in ${CLI_COMMAND}…`)

  const deadline = now() + args.timeoutMs
  while (now() < deadline) {
    await sleep(ASK_SECRET_POLL_INTERVAL_MS)

    let resolution: SecretRequestResolution
    try {
      const response = await fetchImpl(`${endpoint}/requests/${encodeURIComponent(requestId)}`, {
        headers: { [SECRETS_API_TOKEN_HEADER]: token },
      })
      if (!response.ok) {
        deps.warn(`Polling failed with status ${response.status}`)
        return 1
      }
      resolution = (await response.json()) as SecretRequestResolution
    } catch (error) {
      // A transient blip shouldn't abandon a prompt the user may be mid-typing.
      continue
    }

    if (resolution.status === "pending") continue

    if (resolution.status === "saved") {
      printSaved(deps.log, args.name, resolution, false)
      return 0
    }

    if (resolution.status === "cancelled") {
      deps.warn(
        `The user declined to provide ${args.name}. Do not ask again for it — `
        + "continue without it or pick a different approach.",
      )
      return 3
    }

    deps.warn(`The prompt for ${args.name} expired without an answer.`)
    return 2
  }

  deps.warn(
    `Timed out waiting for ${args.name}, but the prompt is still open in ${CLI_COMMAND}. `
    + `Re-run \`${CLI_COMMAND} ask-secret ${args.name}\` to keep waiting (it resumes the same prompt).`,
  )
  return 2
}

function printSaved(
  log: (message: string) => void,
  name: string,
  resolution: SecretRequestResolution,
  existing: boolean,
) {
  const scopeLabel = resolution.scope === "global" ? "global" : "project"
  log(
    existing
      ? `${name} is already stored (${scopeLabel} scope).`
      : `${name} saved (${scopeLabel} scope).`,
  )
  if (resolution.gitignoreUpdated) {
    log("Added .kanna/secrets/ to .gitignore.")
  }
  log("")
  log("Load it into a shell with:")
  log(`  ${resolution.loadCommand}`)
  log("")
  log(
    `Then use $${name} in that same command. Never cat, read, echo or grep the file — `
    + "the value is deliberately kept out of your context.",
  )
}

/** Shown by `kanna --help`. */
export function askSecretHelpLines(): string[] {
  return [
    `  ${CLI_COMMAND} ask-secret <NAME>   Ask the user for a secret, saved outside your context`,
    "      --reason <text>            Why you need it (shown to the user)",
    "      --scope project|global     Suggested scope; the user still chooses",
    "      --timeout <seconds>        How long to wait (default 300)",
    "      --force                    Prompt again even if already stored",
  ]
}

/** Absolute path to this CLI, for agents whose PATH lacks a global install. */
export function resolveCliPathHint(): string {
  return new URL("../../bin/kanna", import.meta.url).pathname.replace(homedir(), "~")
}
