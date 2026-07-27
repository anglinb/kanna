import { type ComponentPropsWithRef, type ReactNode, useEffect, useState } from "react"
import { GitBranch } from "lucide-react"
import { PROVIDERS, type SidebarChatRow } from "../../../../shared/types"
import { formatDuration, formatPromptTimestamp } from "../../messages/ResultMessage"
import { PROVIDER_ICONS } from "../../provider-icons"
import { useHasFinePointer } from "../../../lib/pointer"
import type { SidebarThread } from "../../../lib/thread-sections"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"

/**
 * The card that appears beside a sidebar chat row on hover — the transcript
 * minimap's hover card, applied to the other list of turns you scan.
 *
 * A sidebar row can only afford a title and one glyph, so everything that says
 * *which* chat this is and *where it got to* has been squeezed out of it: the
 * branch, the harness, how long the turn has been running, what you asked and
 * what came back. The card is where that goes, on the one interaction that
 * costs nothing to attempt and nothing to dismiss.
 *
 * Deliberately instant (no open delay) and read-only: it's a peek while the
 * cursor travels the list, not a menu you aim for. Desktop only — hover is not
 * a gesture touch has, and a tap-to-reveal card would fight the row's tap.
 */

/** Harness names, from the catalog the provider picker reads. */
const PROVIDER_LABELS = new Map(PROVIDERS.map((provider) => [provider.id, provider.label]))

/** Bullet between the footer's facts. */
function MetaSeparator() {
  return <span aria-hidden className="opacity-60">•</span>
}

/**
 * A turn that has started and not yet ended. Read off timestamps rather than
 * `status` because it's the timestamps that have to agree with the duration:
 * a status of `running` with no start time can't be timed, and a start time
 * newer than the last end is a live turn whatever the status says.
 */
function getActiveTurnStartedAt(row: SidebarChatRow): number | null {
  if (row.lastTurnStartedAt == null) return null
  if (row.lastTurnEndedAt != null && row.lastTurnEndedAt >= row.lastTurnStartedAt) return null
  return row.lastTurnStartedAt
}

/**
 * The agent's last words, but only if they answer the prompt shown above them.
 *
 * A chat you just sent to still carries the *previous* turn's preview, and
 * pairing your new question with the old answer reads as though it had already
 * been answered. Once the prompt is newer than the reply, the card shows the
 * prompt alone until something comes back.
 *
 * Dated by `lastAgentMessagePreviewAt` where it exists, falling back to
 * `lastAgentMessageAt` for chats whose last text predates that field — a
 * slightly generous fallback (tool calls advance it) but never a wrong pairing
 * for anything written since.
 */
function getCurrentTurnReply(row: SidebarChatRow): string | null {
  if (!row.lastAgentMessagePreview) return null
  const repliedAt = row.lastAgentMessagePreviewAt ?? row.lastAgentMessageAt
  if (repliedAt == null) return null
  return repliedAt >= (row.lastMessageAt ?? 0) ? row.lastAgentMessagePreview : null
}

/**
 * How long the turn ran — elapsed so far while it's live, total once it has
 * landed. The bare duration, in the transcript's own format: sat beside the
 * clock time it's unambiguous, and "Worked for" spent a third of a narrow line
 * saying what the number already says.
 *
 * Null when the chat has never run a turn, or ran them all before turn starts
 * were recorded — the line drops the duration rather than showing one measured
 * from something that isn't the turn.
 */
function formatTurnDuration(row: SidebarChatRow, nowMs: number): string | null {
  const activeSince = getActiveTurnStartedAt(row)
  if (activeSince != null) return formatDuration(Math.max(0, nowMs - activeSince))
  if (row.lastTurnStartedAt == null || row.lastTurnEndedAt == null) return null
  return formatDuration(Math.max(0, row.lastTurnEndedAt - row.lastTurnStartedAt))
}

/**
 * Wall clock for the live duration, ticking only while a turn is actually
 * running. The sidebar's own `nowMs` moves once every 30s — right for "3h ago"
 * on a row, useless for a seconds counter someone is watching.
 */
function useTurnClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])

  return nowMs
}

/** Exported for tests: the card body, without the tooltip machinery around it. */
export function ChatHoverCardContent({ thread }: { thread: SidebarThread }) {
  const row = thread.row
  const nowMs = useTurnClock(getActiveTurnStartedAt(row) != null)
  const label = thread.projectLabel
  const HarnessIcon = row.provider ? PROVIDER_ICONS[row.provider] : null
  const duration = formatTurnDuration(row, nowMs)
  const reply = getCurrentTurnReply(row)
  // When the turn landed, in the transcript's own format — "3:42 PM" today,
  // "Mon 3:42 PM" this week, the full date beyond that. Suppressed while a turn
  // is live: the only end time on hand then belongs to the *previous* turn.
  const endedAt = getActiveTurnStartedAt(row) != null || row.lastTurnEndedAt == null
    ? null
    : formatPromptTimestamp(new Date(row.lastTurnEndedAt).toISOString())


  return (
    <>
      {/* Where, before what — the project heads the card the way it trails the
          row, same glyph and same muted treatment (see `ProjectLabel`). */}
      <div className="flex items-center gap-1 text-[12px] tracking-wide text-muted-foreground">
        {/* `owner/repo` when the origin owner is known, the bare repo otherwise;
            a renamed project has neither, and shows the name you gave it. */}
        <span className="truncate">{label.repoPath ?? label.name}</span>
        {/* A bare repo name could be a repo we haven't resolved an owner for or
            one that has nowhere to push; say which. "origin" rather than
            "remote" on purpose — in Kanna a remote is a machine. */}
        {label.repoPath && !label.hasOwner ? (
          <>
            <MetaSeparator />
            <span className="shrink-0">No origin</span>
          </>
        ) : null}
        {/* Right-anchored like the footer's time, and named even when it's
            `main`: the card has the room, and a branch you have to infer from
            the *absence* of a glyph is a worse answer than the word. */}
        {label.currentBranch ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
            <GitBranch className="size-2.5 shrink-0" strokeWidth={2.5} />
            {label.currentBranch}
          </span>
        ) : null}
      </div>
      {/* The prompt leads the pair, as in the minimap card: it's the question
          the reply under it is the answer to. Falls back to the chat's title so
          a chat with no messages yet still says what it is. Matched margins
          above and below keep the pair a block between the two meta lines. */}
      <div className="mt-1.5 line-clamp-2 text-sm font-medium text-popover-foreground">
        {row.lastUserMessagePreview || thread.title}
      </div>
      {reply ? (
        <div className="mt-1 line-clamp-3 text-sm text-muted-foreground">{reply}</div>
      ) : null}
      {row.provider || duration || endedAt ? (
        <div className="mt-1.5 flex items-center gap-1 text-[12px] tracking-wide text-muted-foreground">
          {row.provider ? (
            // Glyph and name are one fact, so nothing separates them.
            <span className="flex min-w-0 shrink-0 items-center gap-1">
              {HarnessIcon ? <HarnessIcon className="size-3 shrink-0" /> : null}
              <span className="truncate">{PROVIDER_LABELS.get(row.provider) ?? row.provider}</span>
            </span>
          ) : null}
          {/* How long it ran and when it landed, anchored to the right edge
              rather than trailing the harness — a column you read down the list
              instead of a value you hunt along the line. A live turn has no
              landing time yet, so it shows the elapsed count alone. */}
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
            {duration ? <span>{duration}</span> : null}
            {duration && endedAt ? <MetaSeparator /> : null}
            {endedAt ? <span>{endedAt}</span> : null}
          </span>
        </div>
      ) : null}
    </>
  )
}

/**
 * Wraps a sidebar chat row in its hover card.
 *
 * The row it wraps is *also* a context-menu trigger, which hands its props and
 * ref down through `asChild`. Those have to keep reaching the row's element, so
 * this spreads what it receives onto the tooltip trigger rather than swallowing
 * it — right-clicking a row must still open its menu.
 *
 * On coarse pointers only the *content* is dropped: the trigger stays so that
 * pass-through holds, and with nothing to open, hovering does nothing.
 */
export function ChatHoverCard({
  thread,
  children,
  ...triggerProps
}: { thread: SidebarThread, children: ReactNode } & ComponentPropsWithRef<typeof TooltipTrigger>) {
  const hasFinePointer = useHasFinePointer()

  return (
    // `disableHoverableContent`: the card is a peek, not a target — letting the
    // pointer travel into it would keep a card open over the list it describes.
    <Tooltip delayDuration={0} disableHoverableContent>
      <TooltipTrigger asChild {...triggerProps}>{children}</TooltipTrigger>
      {!hasFinePointer ? null : (
        <TooltipContent
          side="right"
          // Top-aligned with the row rather than centred on it: the card is
          // several times the row's height, so centring floated it above the
          // thing it describes and left you tracing back to find which row.
          align="start"
          // Clears the row's right edge so the card reads as beside the sidebar
          // rather than inside it.
          sideOffset={15}
          collisionPadding={12}
          className="pointer-events-none w-80 rounded-lg border-border bg-popover/95 px-3 py-2 text-xs shadow-xl backdrop-blur-sm"
        >
          <ChatHoverCardContent thread={thread} />
        </TooltipContent>
      )}
    </Tooltip>
  )
}
