import type { ReactNode } from "react"
import { Loader2, MessageCircle } from "lucide-react"
import type { SidebarChatRow } from "../../../shared/types"
import type { SidebarThread } from "../../lib/thread-sections"
import { cn } from "../../lib/utils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { PROVIDER_ICONS } from "./ChatPreferenceControls"

/**
 * Canonical inner content of a thread row — status glyph / harness icon,
 * title (shimmering while running), optional prompt preview, and the trailing
 * project label. Shared by the command palette's thread items and the
 * sidebar's Review / In Progress / Recents sections; the caller supplies the
 * flex row container (CommandItem in the palette, a button in the sidebar).
 */

function statusDotClass(archived: boolean) {
  return archived ? "text-muted-foreground/50" : "text-muted-foreground"
}

/**
 * Status glyph mirroring the sidebar chat rows: spinner while running, a blue
 * ping when waiting on the user, a green ping when unread. Returns null for
 * idle chats so callers can fall back to a default icon — for those,
 * `uncommittedWork` is carried by tinting that icon rather than by a dot,
 * so this slot only ever holds things that want your attention.
 */
export function renderChatStatusDot(chat: SidebarChatRow): ReactNode | null {
  if (chat.status === "starting" || chat.status === "running") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-logo" />
  }
  const color = chat.status === "waiting_for_user" ? "blue" : chat.unread ? "emerald" : null
  if (!color) return null
  return (
    <div className="relative flex size-4 shrink-0 items-center justify-center">
      <div
        className={cn(
          "absolute size-2.5 rounded-full animate-ping",
          color === "blue" ? "bg-blue-400/80" : "bg-emerald-400/80",
        )}
      />
      <div
        className={cn(
          "size-2.5 rounded-full ring-2 ring-muted/20 dark:ring-muted/50",
          color === "blue" ? "bg-blue-400" : "bg-emerald-400",
        )}
      />
    </div>
  )
}

export function ThreadRowContent({
  thread,
  showStatus = false,
  showPreview = false,
  isActive = false,
  trailingLabel,
  hoverActions,
}: {
  thread: SidebarThread
  /** Use the sidebar status glyph (ping dots / spinner) instead of the chat icon. */
  showStatus?: boolean
  /** Fill the middle with a faint preview of the latest user prompt. */
  showPreview?: boolean
  /** The chat currently open. Exempts the row from title dimming. */
  isActive?: boolean
  /**
   * Replaces the trailing project label — e.g. a relative age ("4h") in
   * project-scoped lists where the project would be redundant. `null` hides
   * the trailing label entirely; `undefined` keeps the project title. Accepts a
   * node so callers can render chrome there (the sidebar's number-jump keycap).
   */
  trailingLabel?: ReactNode
  /**
   * Hover actions swapped in place of the trailing label on desktop: the label
   * fades out while the icons are hovered. Desktop only — mobile has no real
   * hover (touch leaves rows stuck in :hover), so below `md` the actions are
   * dropped entirely and the trailing label is what mobile users see. The
   * reveal is scoped to the icon group itself (a right-anchored `peer/actions`),
   * so on desktop the actions only appear when the icons are hovered — not the
   * trailing label or the rest of the row. Don't nest inside a <button> row —
   * use a clickable div.
   */
  hoverActions?: ReactNode
}) {
  const statusDot = showStatus && !thread.archived ? renderChatStatusDot(thread.row) : null
  // Faint preview of the latest user prompt (already on the sidebar row). Fills
  // the space between the title and the trailing project/time, truncating tail.
  // Archived chats show "Archived" there instead.
  const previewText = showPreview
    ? (thread.archived ? "Archived" : thread.row.lastUserMessagePreview?.trim() || null)
    : null
  // No status dot → show the chat's harness icon (falls back to a chat bubble
  // when the provider is unknown). Archived chats keep their harness icon,
  // dimmed — the Archived section/subtitle carries the archived signal.
  const HarnessIcon = thread.row.provider ? PROVIDER_ICONS[thread.row.provider] : null
  // One relevance signal, two expressions: the chat has work sitting in its
  // project's dirty tree, so tint its harness icon with the brand colour and
  // keep the title at full contrast. Archived rows never qualify.
  const relevant = !thread.archived && Boolean(thread.row.uncommittedWork)
  const iconClass = cn("h-4 w-4", relevant ? "text-logo" : statusDotClass(thread.archived))
  // Anything with a status dot or a shimmer is already asking for attention and
  // must never dim; so must the chat you're looking at. What's left — idle,
  // read, and not part of the current diff — recedes.
  const needsAttention = thread.row.status !== "idle" || thread.row.unread
  const dimTitle = !isActive && !relevant && !needsAttention
  return (
    <>
      {statusDot ?? (HarnessIcon
        ? <HarnessIcon className={iconClass} />
        : <MessageCircle className={iconClass} />)}
      {thread.row.status === "running" || thread.row.status === "starting" ? (
        <AnimatedShinyText
          className="!mx-0 min-w-0 shrink truncate"
          animate={thread.row.status === "running"}
          shimmerWidth={Math.max(20, thread.title.length * 3)}
        >
          {thread.title}
        </AnimatedShinyText>
      ) : (
        <span className={cn("min-w-0 shrink truncate", dimTitle && "text-slate-500 dark:text-slate-400")}>
          {thread.title}
        </span>
      )}
      {previewText ? (
        // Grows to fill the middle and truncates its tail; -ml-1 offsets part
        // of the parent gap so it hugs the title.
        <span className="-ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground">{previewText}</span>
      ) : null}
      {hoverActions ? (
        // The label keeps its natural width and the title takes what's left —
        // but never less than half, because a `repo/branch` label is far longer
        // than the bare folder name this used to show. Proportional rather than
        // a fixed px cap: the sidebar is resizable.
        <span className="ml-auto relative flex h-6 min-w-12 max-w-[50%] shrink-0 items-center justify-end pl-3 text-xs">
          {/* z-10 + pointer-events-none on the label: while the label's opacity
              transition runs, opacity<1 creates a stacking context that would
              otherwise lift the later-DOM label above the icons and steal the
              hover mid-fade, oscillating the peer-hover state (flicker). */}
          <span className="peer/actions absolute inset-y-0 right-0 z-10 hidden md:flex items-center justify-end gap-0 md:opacity-0 md:hover:opacity-100">
            {hoverActions}
          </span>
          <span className="pointer-events-none flex min-w-0 items-center text-muted-foreground transition-opacity md:peer-hover/actions:opacity-0">
            {/* `truncate` has to sit on a block, not on the flex parent —
                text-overflow doesn't apply to a flex container, so putting it
                up there clips a long `repo/branch` with no ellipsis. */}
            <span className="min-w-0 truncate">
              {trailingLabel !== undefined ? trailingLabel ?? "" : thread.projectTitle}
            </span>
          </span>
        </span>
      ) : (
        // See above: natural width, capped at half the row.
        <span className="ml-auto flex max-w-[50%] shrink-0 items-center gap-1.5 pl-3 text-xs">
          {trailingLabel !== undefined ? (
            trailingLabel !== null ? (
              <span className="min-w-0 truncate text-muted-foreground">{trailingLabel}</span>
            ) : null
          ) : (
            <span className="min-w-0 truncate text-muted-foreground">{thread.projectTitle}</span>
          )}
        </span>
      )}
    </>
  )
}
