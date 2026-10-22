import { useState } from "react"
import { PROVIDERS, type AgentProvider } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { formatUntil, useMinuteClock } from "../chat-ui/widgets/SchedulesWidget"
import { RemoveButton, SendNowButton } from "./QueuedUserMessage"

/** "3:05 PM", or "Tue 3:05 PM" when it is not today. */
function formatResumeTime(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
}

/**
 * The "carry on" Kanna sends when a usage limit resets, waiting like a queued
 * message: the same dashed outline, Send now to resume at once, and Remove
 * to turn the resume off for this chat. Below the queue it holds, since it
 * goes first and they follow.
 */
export function UsageLimitResumeRow({ resume, onAction }: {
  resume: { at: number; provider: AgentProvider }
  /** May return the command's promise, which is how long the row stays dimmed. */
  onAction: (action: "cancel" | "now") => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const now = useMinuteClock(true)
  const provider = PROVIDERS.find((candidate) => candidate.id === resume.provider)?.label ?? resume.provider
  const carryOut = (action: "cancel" | "now") => () => {
    setBusy(true)
    void Promise.resolve(onAction(action)).finally(() => setBusy(false))
  }
  return (
    <div className={cn("flex flex-col items-start gap-2 py-2 transition-opacity duration-150 ease-out motion-reduce:transition-none", busy && "opacity-60")}>
      <div className="relative group min-w-0 max-w-[85%] sm:max-w-[80%]">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 rounded-2xl border border-dashed border-border py-1.5 pl-1.5 pr-3.5 text-sm">
          <SendNowButton onSendNow={carryOut("now")} disabled={busy} label="Continue now" />
          <div className="min-w-0">
            <p className="text-primary">Continues when {provider} usage resets</p>
            <p className="text-[12px] text-muted-foreground tabular-nums">
              {formatResumeTime(resume.at, now)} · {formatUntil(resume.at, now)}
            </p>
          </div>
        </div>
        <RemoveButton corner="end" onRemove={carryOut("cancel")} disabled={busy} label="Don't continue automatically" />
      </div>
    </div>
  )
}
