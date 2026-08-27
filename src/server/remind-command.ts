/**
 * `kanna remind` — the agent-facing half of chat reminders.
 *
 * Same shape as `link-pr`: a shell command, because a shell is the one
 * affordance every provider shares, talking to the already-running server over
 * the loopback API with the per-start instance token. A single round trip —
 * the waiting happens server-side, in a schedule that outlives this process and
 * the agent that ran it.
 *
 * The chat is identified by `KANNA_CHAT_ID` when the provider sets it, and
 * otherwise inferred server-side from the working directory (see
 * `resolveAskingChat`). `--chat` overrides both.
 */

import { CLI_COMMAND } from "../shared/branding"
import {
  formatReminderDelay,
  REMINDERS_API_PATH_PREFIX,
  REMINDERS_API_TOKEN_HEADER,
} from "../shared/reminders"
import { SECRET_CHAT_ID_ENV_VAR } from "../shared/secrets"
import { readInstanceFile } from "./instance-file"

export interface RemindArgs {
  /** Cancel the pending reminder; ignores every other field. */
  clear: boolean
  /** A delay: `30m`, `2h`, `1h30m`, or a bare number of minutes. */
  in: string | null
  /** An absolute time, ISO 8601. */
  at: string | null
  /** Posted into the chat when it fires. Null resurfaces the chat silently. */
  message: string | null
  chatId: string | null
}

export interface RemindDeps {
  log: (message: string) => void
  warn: (message: string) => void
  fetchImpl?: typeof fetch
  cwd?: () => string
  env?: Record<string, string | undefined>
  readInstance?: typeof readInstanceFile
}

export function parseRemindArgs(argv: string[]): RemindArgs {
  let clear = false
  let inValue: string | null = null
  let at: string | null = null
  let message: string | null = null
  let chatId: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--clear" || arg === "--cancel") {
      clear = true
      continue
    }
    if (arg === "--in" || arg === "--at" || arg === "--chat" || arg === "--message") {
      const next = argv[index + 1]
      if (!next) throw new Error(`Missing value for ${arg}`)
      if (arg === "--in") inValue = next
      else if (arg === "--at") at = next
      else if (arg === "--chat") chatId = next
      else message = next
      index += 1
      continue
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unexpected argument for ${CLI_COMMAND} remind: ${arg}`)
    }
    if (message === null) {
      message = arg
      continue
    }
    throw new Error(`Unexpected argument for ${CLI_COMMAND} remind: ${arg}`)
  }

  if (!clear && !inValue && !at) {
    throw new Error(`Say when: ${CLI_COMMAND} remind --in 30m "<what to do then>"`)
  }

  return { clear, in: inValue, at, message, chatId }
}

interface RemindResponse {
  ok?: boolean
  cleared?: boolean
  dueAt?: number
  delayMs?: number
  prompt?: string
  error?: string
}

/** Exit codes: 0 scheduled/cleared, 1 error. */
export async function runRemindCommand(args: RemindArgs, deps: RemindDeps): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const cwd = (deps.cwd ?? (() => process.cwd()))()
  const env = deps.env ?? process.env

  const instance = await (deps.readInstance ?? readInstanceFile)()
  const overrideUrl = env.KANNA_URL?.trim() || null
  const overrideToken = env.KANNA_TOKEN?.trim() || null

  // Same rule as `ask-secret`: the instance token is only ever presented to the
  // instance that minted it. An agent controls its own environment, so letting
  // an overridden KANNA_URL borrow the token from ~/.kanna/instance.json would
  // hand the capability to queue prompts into any chat to whatever endpoint the
  // agent named.
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
      + `Start ${CLI_COMMAND} and try again.`,
    )
    return 1
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}${REMINDERS_API_PATH_PREFIX}`
  const chatId = args.chatId ?? env[SECRET_CHAT_ID_ENV_VAR] ?? null

  let payload: RemindResponse
  try {
    const response = await fetchImpl(`${endpoint}/${args.clear ? "clear" : "set"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [REMINDERS_API_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({
        cwd,
        chatId,
        ...(args.clear ? {} : { in: args.in, at: args.at, prompt: args.message }),
      }),
    })
    payload = (await response.json()) as RemindResponse
    if (!response.ok) {
      deps.warn(payload.error ?? `Request failed with status ${response.status}`)
      return 1
    }
  } catch (error) {
    deps.warn(`Could not reach ${CLI_COMMAND}: ${(error as Error).message}`)
    return 1
  }

  if (args.clear) {
    deps.log("Reminder cancelled.")
    return 0
  }

  const when = payload.dueAt ? new Date(payload.dueAt).toLocaleString() : "later"
  const delay = payload.delayMs ? ` (in ${formatReminderDelay(payload.delayMs)})` : ""
  deps.log(`Reminder set for ${when}${delay}.`)
  if (payload.prompt) {
    deps.log("")
    deps.log("When it fires, this chat will be woken with:")
    deps.log(`  ${payload.prompt}`)
    deps.log("")
    deps.log(
      "You do not need to wait or poll for it — end your turn. Kanna will start a new turn "
      + "in this chat at that time, even if it is restarted in the meantime.",
    )
  } else {
    deps.log("The chat will be flagged unread then, without starting a turn.")
  }
  return 0
}

/** Shown by `kanna --help`. */
export function remindHelpLines(): string[] {
  return [
    `  ${CLI_COMMAND} remind --in <delay> [<message>]`,
    "                                 Wake this chat later with <message>",
    "      --in <30m|2h|1h30m|1d>     How long to wait (a bare number means minutes)",
    "      --at <iso-timestamp>       Absolute time instead of a delay",
    "      --clear                    Cancel this chat's pending reminder",
    "      --chat <id>                Target chat (default: $KANNA_CHAT_ID, else inferred from cwd)",
  ]
}
