/**
 * Chat reminders — "wake this chat up later", shared by client and server.
 *
 * A chat carries at most one pending reminder. When it comes due the server
 * marks the chat unread and, if the reminder carries a prompt, posts that
 * prompt into the chat — which starts (or queues) a turn exactly as if the
 * user had typed it. Setting a second reminder replaces the first: "remind me
 * about this chat" has one answer.
 *
 * Two ways in, one mechanism: the sidebar's right-click menu, and the agent
 * itself via `kanna remind --in 30m "check the metrics again"`.
 *
 * No Bun/node imports here: this file is imported by both sides.
 */

/** Loopback-only HTTP surface for the `kanna remind` CLI. */
export const REMINDERS_API_PATH_PREFIX = "/__local/reminders"

/** The same per-start instance token the secrets and pull-requests APIs use. */
export const REMINDERS_API_TOKEN_HEADER = "x-kanna-token"

/**
 * Furthest out a reminder may be set. Less a policy than a typo guard: `--in
 * 1000d` is likelier to be a slip than an intention, and a scheduler that
 * rebuilds its work list from the store on every tick has no business carrying
 * items for years.
 */
export const MAX_REMINDER_DELAY_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Truncation point for the stored prompt. It becomes a chat message, so it is
 * bounded for the same reason any other prompt is — but generously: an agent
 * leaving itself a note wants room for the context it will have forgotten.
 */
export const MAX_REMINDER_PROMPT_LENGTH = 4_000

/** Who set it. Only used for wording — the firing path is identical. */
export type ReminderSource = "user" | "agent"

/**
 * What a reminder set from the sidebar posts when it fires.
 *
 * The menu's promise is "come back to this later and pick it up", so the
 * default carries a prompt rather than only flagging the chat unread. It tells
 * the agent to re-check state first because whatever it believed at the end of
 * the last turn may be minutes or days stale by the time this arrives.
 */
export const DEFAULT_REMINDER_PROMPT =
  "This is a scheduled reminder to pick this task back up. Check where things actually "
  + "stand now before continuing — time has passed and the state may have moved. If it "
  + "turns out everything here is already done, just say so instead of finding new work."

export interface ChatReminder {
  /** Epoch ms at which the reminder fires. */
  dueAt: number
  /**
   * Posted into the chat when it fires, starting a turn. Absent means the
   * reminder only resurfaces the chat (marks it unread) without waking the
   * agent — what the sidebar's plain "Remind Me" does.
   */
  prompt?: string
  createdAt: number
  createdBy: ReminderSource
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Reads a human delay — `30m`, `2h`, `1h30m`, `1d` — into milliseconds.
 *
 * A bare number is minutes, because "remind me in 30" means thirty minutes to
 * everyone who has ever said it out loud. Returns null for anything it cannot
 * read, so callers can report the input back rather than silently guessing.
 */
export function parseReminderDelay(input: string): number | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, "")
  if (!text) return null
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * UNIT_MS.m)
  // Anchored so trailing junk ("30mx") fails rather than parsing the prefix.
  if (!/^(?:\d+(?:\.\d+)?[smhd])+$/.test(text)) return null
  let total = 0
  for (const [, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) {
    total += Number(value) * (UNIT_MS[unit] ?? 0)
  }
  return Math.round(total)
}

/** `90m` → "1h 30m". For CLI confirmations and the sidebar's tooltip. */
export function formatReminderDelay(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`
  const totalMinutes = Math.round(ms / 60_000)
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  return parts.join(" ")
}

export type ResolvedReminderDueAt =
  | { ok: true; dueAt: number }
  | { ok: false; error: string }

/**
 * Turns whichever of `--in` / `--at` / a raw timestamp the caller supplied into
 * an absolute due time, with one set of rules for the CLI and the HTTP API.
 *
 * Both sides run on the same machine over loopback, so resolving relative
 * delays against the server's clock rather than the caller's costs nothing and
 * removes a class of skew from the picture entirely.
 */
export function resolveReminderDueAt(args: {
  now: number
  /** A delay in `parseReminderDelay` syntax. */
  in?: string | null
  /** An absolute time, ISO 8601 or epoch ms. */
  at?: string | number | null
  /** An already-absolute epoch ms, from a client that did its own arithmetic. */
  dueAt?: number | null
}): ResolvedReminderDueAt {
  const provided = [args.in, args.at, args.dueAt].filter(
    (value) => value !== null && value !== undefined && value !== "",
  )
  if (provided.length === 0) {
    return { ok: false, error: "Say when: --in <30m|2h|1d> or --at <time>." }
  }
  if (provided.length > 1) {
    return { ok: false, error: "Pass only one of --in and --at." }
  }

  let dueAt: number
  if (args.in !== null && args.in !== undefined && args.in !== "") {
    const delay = parseReminderDelay(args.in)
    if (delay === null) {
      return {
        ok: false,
        error: `Could not read '${args.in}' as a delay. Use 30m, 2h, 1h30m, 1d, or a plain number of minutes.`,
      }
    }
    if (delay <= 0) return { ok: false, error: "A reminder has to be in the future." }
    dueAt = args.now + delay
  } else if (args.dueAt !== null && args.dueAt !== undefined) {
    dueAt = args.dueAt
  } else {
    const at = args.at as string | number
    dueAt = typeof at === "number" ? at : Date.parse(at)
    if (!Number.isFinite(dueAt)) {
      return { ok: false, error: `Could not read '${String(at)}' as a time. Use an ISO 8601 timestamp.` }
    }
  }

  if (!Number.isFinite(dueAt)) return { ok: false, error: "Invalid reminder time." }
  if (dueAt <= args.now) return { ok: false, error: "A reminder has to be in the future." }
  if (dueAt - args.now > MAX_REMINDER_DELAY_MS) {
    return {
      ok: false,
      error: `A reminder can be at most ${formatReminderDelay(MAX_REMINDER_DELAY_MS)} out.`,
    }
  }
  return { ok: true, dueAt: Math.round(dueAt) }
}

/** Trims and bounds a prompt. Empty (or all-whitespace) becomes undefined. */
export function normalizeReminderPrompt(prompt: string | null | undefined): string | undefined {
  const text = prompt?.trim()
  if (!text) return undefined
  return text.length > MAX_REMINDER_PROMPT_LENGTH
    ? text.slice(0, MAX_REMINDER_PROMPT_LENGTH)
    : text
}
