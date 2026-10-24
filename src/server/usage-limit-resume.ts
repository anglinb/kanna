import { Effect, Exit, Cause } from "effect"
import type { ChatRecord, StoreState } from "./events"
import type { GetAccountRateLimitsResponse } from "./codex-app-server-protocol"

/**
 * Chats whose turn stopped because the provider's usage ran out, continued
 * when it comes back.
 *
 * The agent marks such a chat (`ChatRecord.usageLimitResume`) with the time
 * the provider says the limit resets, and holds its queued messages. This
 * loop sends each marked chat a "carry on" once that time has passed. The
 * mark is on disk, so a restart in between still resumes on time. The user
 * can cancel it, or send it early, from the chat (`chat.usageLimitResume`).
 *
 * Claude and Codex say when a limit resets. Cursor, Grok Build and Pi do
 * not, so a chat on one of them that hits its limit stays failed, as before.
 */

/** After the reset time, before resuming: the provider's clock and ours differ a little. */
export const USAGE_LIMIT_RESUME_SLACK_MS = 60_000

/** How often the loop looks for chats that are due. A resume a minute late costs nothing. */
export const USAGE_LIMIT_RESUME_POLL_MS = 30_000

/** The wire-only prompt a resumed chat gets. The user sees the turn start, not this text. */
export const USAGE_LIMIT_RESUME_MESSAGE = `<system-message>
Your usage limit ran out partway through this task, so your turn stopped. The limit has reset. Continue the task you were on from where it left off.
Whatever you were doing last may not have completed — re-check the state of any file you were editing and any command you had running before assuming it finished.
</system-message>`

/** Codex names the cause of a failed turn; this is the one for running out of usage. */
export function isCodexUsageLimitFailure(resultText: string): boolean {
  return /usageLimitExceeded/i.test(resultText)
}

/**
 * When a Codex account that ran out can be used again (epoch ms), from its
 * rate limits: the latest reset among the windows that are full, since all of
 * them must reset. With none reported full, the earliest reset still ahead.
 * Null when Codex reports no reset time at all.
 */
export function codexUsageLimitResetAt(limits: GetAccountRateLimitsResponse | null, now: number): number | null {
  if (!limits) return null
  const snapshots = [limits.rateLimits, ...Object.values(limits.rateLimitsByLimitId ?? {})]
  const windows = snapshots.flatMap((snapshot) => snapshot ? [snapshot.primary, snapshot.secondary] : [])
    .flatMap((window) => window?.resetsAt != null ? [{ used: window.usedPercent ?? 0, at: window.resetsAt * 1000 }] : [])
  const full = windows.filter((window) => window.used >= 100)
  if (full.length > 0) return Math.max(...full.map((window) => window.at))
  const ahead = windows.filter((window) => window.at > now)
  return ahead.length > 0 ? Math.min(...ahead.map((window) => window.at)) : null
}

/** Marked chats whose time has come, soonest first. Deleted and archived chats wait. */
export function dueUsageLimitResumes(state: Pick<StoreState, "chatsById">, now: number): ChatRecord[] {
  return [...state.chatsById.values()]
    .filter((chat) => chat.usageLimitResume && chat.usageLimitResume.at <= now && !chat.deletedAt && !chat.archivedAt)
    .sort((left, right) => left.usageLimitResume!.at - right.usageLimitResume!.at)
}

export interface UsageLimitResumerDeps {
  readonly state: () => Pick<StoreState, "chatsById">
  /** Clears the mark and sends the "carry on". False when there was nothing to resume into. */
  readonly resume: (chatId: string) => Effect.Effect<boolean, unknown>
  readonly now?: () => number
}

/** One pass: resumes every chat that is due, one at a time. A chat that fails to resume does not stop the rest. */
export const resumeDueUsageLimitChats = Effect.fn("UsageLimitResume.resumeDue")(function* (deps: UsageLimitResumerDeps) {
  const due = dueUsageLimitResumes(deps.state(), (deps.now ?? Date.now)())
  const resumed: string[] = []
  for (const chat of due) {
    const attempt = yield* Effect.exit(deps.resume(chat.id))
    if (Exit.isSuccess(attempt)) {
      if (attempt.value) resumed.push(chat.id)
      continue
    }
    if (Cause.hasInterruptsOnly(attempt.cause)) return yield* Effect.interrupt
    yield* Effect.logWarning(`could not resume chat ${chat.id} after its usage limit reset:`, Cause.squash(attempt.cause))
  }
  if (resumed.length > 0) yield* Effect.logInfo(`resumed ${resumed.length} chat(s) whose usage limit reset`)
  return resumed
})

/** Checks now, then every `pollMs`, for as long as the scope it is forked into stays open. */
export const startUsageLimitResumer = (deps: UsageLimitResumerDeps, pollMs = USAGE_LIMIT_RESUME_POLL_MS) =>
  Effect.forever(resumeDueUsageLimitChats(deps).pipe(Effect.andThen(Effect.sleep(pollMs)))).pipe(
    Effect.forkScoped({ startImmediately: true }),
    Effect.withSpan("UsageLimitResume.start"),
  )
