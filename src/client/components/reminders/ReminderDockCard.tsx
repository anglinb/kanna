import { Clock, LoaderCircle, X } from "lucide-react"
import { useState } from "react"
import { ChoiceCard } from "../ui/choice"

/**
 * The "you'll be reminded" line above the composer, shown only while the chat
 * has a pending reminder.
 *
 * Deliberately live state rather than a transcript entry: a reminder can still
 * be cancelled, and its countdown changes, neither of which a transcript entry
 * can express. The transcript gets its line when the reminder actually *fires*
 * (`ReminderNoticeMessage`) — that one is history and belongs there.
 *
 * Sits below `SecretRequestCard` in the dock and is quiet where that card is
 * loud: the agent is not blocked on this, so it must never push a prompt that
 * *is* blocking further from the eye.
 */
export function ReminderDockCard({
  dueAt,
  nowMs,
  onClear,
}: {
  dueAt: number | null
  /** Ticked by the owning hook so the countdown re-renders. */
  nowMs: number
  onClear: () => Promise<unknown>
}) {
  const [isBusy, setIsBusy] = useState(false)

  if (dueAt == null) return null

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-2">
      <ChoiceCard className="bg-background/80 backdrop-blur">
        <div className="flex items-center gap-2 px-3 py-2">
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-medium">
              {describeReminder(dueAt, nowMs)}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              This chat will pick the task back up on its own.
            </span>
          </div>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            title="Cancel this reminder"
            aria-label="Cancel this reminder"
            disabled={isBusy}
            onClick={() => {
              setIsBusy(true)
              void Promise.resolve(onClear()).finally(() => setIsBusy(false))
            }}
          >
            {isBusy
              ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              : <X className="h-3.5 w-3.5" />}
          </button>
        </div>
      </ChoiceCard>
    </div>
  )
}

/**
 * "Reminder in 25 minutes · 5:41 PM".
 *
 * Carries both the relative and the absolute time because they answer different
 * questions — "how long have I got" and "will I still be at my desk" — and the
 * line has room for both.
 */
function describeReminder(dueAt: number, nowMs: number): string {
  const clock = new Date(dueAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  const remaining = dueAt - nowMs
  // Due but not yet swept up by the scheduler's tick. Saying "in 0 minutes"
  // would read as broken; "any moment now" is both true and calmer.
  if (remaining <= 0) return `Reminder due any moment now · ${clock}`

  const minutes = Math.round(remaining / 60_000)
  if (minutes < 60) {
    return `Reminder in ${Math.max(1, minutes)} ${minutes === 1 ? "minute" : "minutes"} · ${clock}`
  }
  const hours = Math.round(remaining / 3_600_000)
  if (hours < 24) return `Reminder in ${hours} ${hours === 1 ? "hour" : "hours"} · ${clock}`

  const days = Math.round(hours / 24)
  const date = new Date(dueAt).toLocaleDateString(undefined, { weekday: "long" })
  return `Reminder in ${days} ${days === 1 ? "day" : "days"} · ${date} ${clock}`
}
