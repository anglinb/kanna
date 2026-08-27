import { useCallback, useEffect, useMemo, useState } from "react"
import { DEFAULT_REMINDER_PROMPT } from "../../shared/reminders"
import type { SidebarProjectGroup } from "../../shared/types"
import type { KannaSocket } from "./socket"

export interface ChatReminderState {
  /** When the active chat's pending reminder fires, or null when it has none. */
  dueAt: number | null
  /** Re-rendered on a tick so the countdown stays honest without a reload. */
  nowMs: number
  set: (dueAt: number) => Promise<unknown>
  clear: () => Promise<unknown>
}

/**
 * How often the countdown re-renders. A minute: the label is rounded to
 * minutes, so anything faster redraws the same characters.
 */
const TICK_MS = 60_000

/**
 * The active chat's pending reminder, read straight off the sidebar snapshot
 * rather than fetched — the same trick `useLinkedPullRequest` uses, and for the
 * same reason. `reminderAt` already rides the sidebar row (see
 * `read-models.ts`), the sidebar is a subscription this app always has open,
 * and a chat-scoped topic would be a second copy of one number with its own
 * staleness.
 */
export function useChatReminder(
  socket: KannaSocket,
  activeChatId: string | null,
  projectGroups: SidebarProjectGroup[],
): ChatReminderState {
  const dueAt = useMemo(() => {
    if (!activeChatId) return null
    for (const group of projectGroups) {
      for (const chat of [...group.chats, ...(group.archivedChats ?? [])]) {
        if (chat.chatId === activeChatId) return chat.reminderAt ?? null
      }
    }
    return null
  }, [activeChatId, projectGroups])

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    // No pending reminder, no countdown to drive — don't hold a timer for
    // every chat that will never show one.
    if (dueAt == null) return
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [dueAt])

  const set = useCallback(
    (nextDueAt: number) => activeChatId
      ? socket.command({
        type: "chat.setReminder",
        chatId: activeChatId,
        dueAt: nextDueAt,
        prompt: DEFAULT_REMINDER_PROMPT,
      })
      : Promise.resolve(undefined),
    [activeChatId, socket],
  )

  const clear = useCallback(
    () => activeChatId
      ? socket.command({ type: "chat.clearReminder", chatId: activeChatId })
      : Promise.resolve(undefined),
    [activeChatId, socket],
  )

  return { dueAt, nowMs, set, clear }
}
