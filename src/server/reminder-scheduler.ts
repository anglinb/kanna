/**
 * Fires chat reminders when they come due.
 *
 * One timer for the whole server, and no in-process schedule: every tick asks
 * the store which chats have a pending reminder. That is what makes reminders
 * survive a restart — the schedule lives in the event log, so a reminder set on
 * Friday still fires on Monday even though the process that took it is long
 * gone. Reminders that came due while the server was down fire on the first
 * tick after it comes back, which is the behaviour you want from something the
 * user described as "remind me": late is right, dropped is not.
 *
 * Firing is three things, in this order:
 *   1. mark the chat unread, so it resurfaces in the sidebar
 *   2. write a transcript divider saying a reminder fired
 *   3. post the reminder's prompt, which starts (or queues) a turn
 * The last is skipped for reminders with no prompt — those only resurface. The
 * divider comes first so the transcript reads in order, and so the prompt below
 * it is never mistaken for something the user typed.
 */

import { LOG_PREFIX } from "../shared/branding"
import type { ChatReminder, ReminderSource } from "../shared/reminders"
import type { ChatRecord } from "./events"

/** How often the loop wakes to see whether anything is due. */
const TICK_INTERVAL_MS = 15_000

export interface ReminderSchedulerDeps {
  listReminders: () => Array<{ chat: ChatRecord; reminder: ChatReminder }>
  /** Consume the reminder. Called before anything is posted. */
  clearReminder: (chatId: string) => Promise<void>
  /** Bring the chat back in the sidebar. */
  markUnread: (chatId: string) => Promise<void>
  /**
   * Write the transcript divider that explains the prompt about to appear.
   * Posted before the prompt so the two land in reading order.
   */
  recordNotice: (chatId: string, notice: {
    scheduledAt: number
    createdBy: ReminderSource
    wokeAgent: boolean
  }) => Promise<void>
  /** Post a prompt into the chat, starting or queueing a turn. */
  postPrompt: (chatId: string, prompt: string) => Promise<void>
  /** Something fired — re-push the sidebar. */
  onChanged: () => void
  now?: () => number
}

export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  /** Chats mid-fire, so a slow post can't be entered twice. */
  private readonly inFlight = new Set<string>()

  constructor(private readonly deps: ReminderSchedulerDeps) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        console.warn(`${LOG_PREFIX} reminder tick failed:`, error)
      })
    }, TICK_INTERVAL_MS)
    // Node/Bun keep the process alive for an interval; this one must not.
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Exposed for tests and for firing without waiting out the interval. */
  async tick(): Promise<void> {
    const now = this.now()
    let fired = false

    for (const { chat, reminder } of this.deps.listReminders()) {
      if (reminder.dueAt > now) continue
      if (this.inFlight.has(chat.id)) continue
      this.inFlight.add(chat.id)
      try {
        // Clear first. If the post throws, the reminder is still spent rather
        // than re-firing on every tick from here to the heat death of the
        // universe — the one failure mode worth designing against.
        await this.deps.clearReminder(chat.id)
        fired = true
        await this.deps.markUnread(chat.id)
        await this.deps.recordNotice(chat.id, {
          scheduledAt: reminder.createdAt,
          createdBy: reminder.createdBy,
          wokeAgent: Boolean(reminder.prompt),
        })
        if (reminder.prompt) {
          await this.deps.postPrompt(chat.id, reminder.prompt)
        }
        console.log(
          `${LOG_PREFIX} reminder fired for chat ${chat.id}`
          + `${reminder.prompt ? "" : " (no prompt — resurfaced only)"}`,
        )
      } catch (error) {
        console.warn(`${LOG_PREFIX} reminder failed to fire for chat ${chat.id}:`, error)
      } finally {
        this.inFlight.delete(chat.id)
      }
    }

    if (fired) this.deps.onChanged()
  }
}
