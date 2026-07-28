import { type ComponentPropsWithRef, type ReactNode, useCallback, useState } from "react"
import { TurnCardMessage, TurnCardMetaRow, TurnCardTimingRow } from "../../ui/turn-card"
import { GitBranch, PencilLine } from "lucide-react"
import { getRepoUrlLabel } from "../../../../shared/git-url"
import { PROVIDERS, type SidebarChatRow } from "../../../../shared/types"
import { formatPromptTimestamp } from "../../messages/ResultMessage"
import { PROVIDER_ICONS } from "../../provider-icons"
import { toMessagePreview } from "../../../../shared/message-preview"
import type { ChatJumpRole } from "../../../lib/chat-navigation"
import { useHasFinePointer } from "../../../lib/pointer"
import { cn } from "../../../lib/utils"
import type { SidebarThread } from "../../../lib/thread-sections"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../../ui/hover-card"

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
 * The two messages it shows are also the two places in the chat you most often
 * want to be, so both are clickable: the prompt lands you on the question, the
 * reply on the answer. It stays instant despite now being a target — the peek
 * is the point, and the cost is real but small: a cursor crossing the sidebar
 * raises cards it doesn't want, and briefly puts one over the transcript.
 *
 * Desktop only — hover is not a gesture touch has, and a tap-to-reveal card
 * would fight the row's tap.
 */

/** Harness names, from the catalog the provider picker reads. */
const PROVIDER_LABELS = new Map(PROVIDERS.map((provider) => [provider.id, provider.label]))

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
 * How much conversation is in this chat — "1 turn", "24 turns".
 *
 * The size of the whole thing, not the length of its last turn: the two
 * messages above this line are already the latest turn, and a chat you're
 * deciding whether to open is better described by how far it has gone than by
 * how long its most recent run took (which the minimap reports per turn
 * anyway, where it's about a turn you can actually see).
 *
 * Null on chats whose turns all predate the counter — the line drops the fact
 * rather than claiming a chat with history has run none.
 */
function formatTurnCount(row: SidebarChatRow): string | null {
  if (!row.turnCount) return null
  return `${row.turnCount} turn${row.turnCount === 1 ? "" : "s"}`
}

/** Exported for tests: the card body, without the hover-card machinery around it. */
export function ChatHoverCardContent({
  thread,
  draft = "",
  onSelectMessage,
  onSelectChat,
  onOpenRepo,
  onSetupGit,
}: {
  thread: SidebarThread
  draft?: string
  /** Absent when the card is read-only (archived rows). */
  onSelectMessage?: (role: ChatJumpRole) => void
  /** Opens the chat without aiming at a message — what the draft does. */
  onSelectChat?: () => void
  /** Opens the project's forge page. Ignored when the repo has no URL. */
  onOpenRepo?: () => void
  /** Offers to `git init` the project. Ignored unless it's known not to be a repo. */
  onSetupGit?: () => void
}) {
  const row = thread.row
  const label = thread.projectLabel
  const HarnessIcon = row.provider ? PROVIDER_ICONS[row.provider] : null
  const turns = formatTurnCount(row)
  const reply = getCurrentTurnReply(row)
  // When the turn landed, in the transcript's own format — "3:42 PM" today,
  // "Mon 3:42 PM" this week, the full date beyond that. Suppressed while a turn
  // is live: the only end time on hand then belongs to the *previous* turn.
  const endedAt = getActiveTurnStartedAt(row) != null || row.lastTurnEndedAt == null
    ? null
    : formatPromptTimestamp(new Date(row.lastTurnEndedAt).toISOString())
  // Both blocks are clickable whenever the surface offers the jump at all. The
  // card doesn't identify the messages and doesn't need to: it shows a chat's
  // latest prompt and latest reply by definition, and the transcript resolves
  // those from its own rows the way the minimap does.
  const canJump = Boolean(onSelectMessage)


  return (
    <>
      {/* Branch leads, repo trails. Down a list of chats it's the branch that
          differs — the repo is usually the same one over and over — so the
          varying fact reads down the left edge and the constant one anchors
          right, the same shape as the footer's harness and time. */}
      <TurnCardMetaRow>
        {/* Named even when it's `main`: the card has the room, and a branch you
            have to infer from the *absence* of a glyph is a worse answer than
            the word. Absent only on a detached HEAD, where the repo simply
            slides over. */}
        {label.currentBranch ? (
          <span className="flex min-w-0 items-center gap-1">
            <GitBranch className="size-2.5 shrink-0" strokeWidth={2.5} />
            <span className="truncate">{label.currentBranch}</span>
          </span>
        ) : label.hasGitRepo === false && onSetupGit ? (
          // A project with no repo has no branch to name, so the slot the
          // branch would have taken says what's missing instead — and offers
          // the same one-click fix the chat navbar's "Setup Git" does, since
          // the card is where you're already looking when you notice.
          //
          // Only on a definite `false`: while the server hasn't looked yet,
          // every row would briefly claim its repo didn't exist.
          <button
            type="button"
            onClick={onSetupGit}
            // Underlined-on-hover like the repo link opposite it, not filled
            // like the message rows: both are inline words in a meta line.
            className="flex min-w-0 cursor-pointer items-center gap-1 rounded-sm transition-colors hover:text-foreground hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <GitBranch className="size-2.5 shrink-0" strokeWidth={2.5} />
            <span className="truncate">Setup Git</span>
          </button>
        ) : null}
        {/* `owner/repo` when the origin owner is known, the bare repo otherwise;
            a renamed project has neither, and shows the name you gave it. Both
            sides may truncate rather than either being pinned: flexbox takes it
            out of the longer one first, which is nearly always the branch. */}
        <span className="ml-auto flex min-w-0 items-center gap-1 pl-2">
          {/* When the repo has a page, the name *is* the link to it — one
              click, one destination, the convention a repo path already
              carries on the web. Opening it in an app is the row's right-click
              menu's job; a second menu here would only duplicate it. */}
          {onOpenRepo && label.repoUrl ? (
            <button
              type="button"
              aria-label={`Open on ${getRepoUrlLabel(label.repoUrl)}`}
              onClick={onOpenRepo}
              // No padding of its own: it sits inline in a row that already
              // carries the inset, and a fill here would push the repo name out
              // of line with the two messages below it. Underline does the work
              // a hover fill does elsewhere — it's a link, not a menu row.
              className="truncate cursor-pointer rounded-sm transition-colors hover:text-foreground hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {label.repoPath ?? label.name}
            </button>
          ) : (
            <span className="truncate">{label.repoPath ?? label.name}</span>
          )}
        </span>
      </TurnCardMetaRow>
      {/* The exchange, as one block with matched margins above and below so it
          sits between the two meta lines rather than joining either. */}
      <div className="mt-1 space-y-1">
        {/* The prompt leads, as in the minimap card: it's the question the reply
            under it is the answer to. Falls back to the chat's title so a chat
            with no messages yet still says what it is. A draft displaces it —
            see below. */}
        {draft ? null : (
          <TurnCardMessage
            className="line-clamp-2 text-sm font-medium text-popover-foreground"
            label="Jump to this prompt"
            onSelect={canJump ? () => onSelectMessage?.("prompt") : undefined}
          >
            {toMessagePreview(row.lastUserMessagePreview || thread.title)}
          </TurnCardMessage>
        )}
        {/* Cut to a single line once a draft is here: what you were about to
            say outranks how the last answer began, and three lines of reply
            would push it to the bottom of a card you opened for the draft. */}
        {reply ? (
          <TurnCardMessage
            className={cn("text-sm text-muted-foreground", draft ? "line-clamp-1" : "line-clamp-3")}
            label="Jump to this reply"
            onSelect={canJump ? () => onSelectMessage?.("reply") : undefined}
          >
            {toMessagePreview(reply)}
          </TurnCardMessage>
        ) : null}
        {/* An unsent draft ends the card, in the prompt's own weight but
            italic and pencilled: it is the next thing said in this chat, not
            the last. It takes the sent prompt's place rather than sitting
            alongside it — the prompt is already answered by the reply above,
            and what you want back is the sentence you walked away from.
            The glyph is inline rather than a flex sibling, so a wrapped second
            line runs the full width instead of indenting to clear it. */}
        {draft ? (
          // Unlike the two messages, a draft has no entry to land on — it was
          // never sent. So it just opens the chat, where the composer is
          // already holding it.
          <TurnCardMessage
            className="line-clamp-2 text-sm font-medium italic text-popover-foreground"
            label="Open this chat"
            onSelect={onSelectChat}
          >
            <PencilLine className="mr-1 inline size-3 shrink-0 -translate-y-px" strokeWidth={2.5} />
            {toMessagePreview(draft)}
          </TurnCardMessage>
        ) : null}
      </div>
      {/* The harness on the left, the chat's size and when it last landed on
          the right. Turns rather than the last turn's duration, which the
          minimap already reports per turn and which said nothing about the
          chat: how much conversation is in here is the thing a sidebar row
          can't show and you'd want before opening it. */}
      <TurnCardTimingRow
        detail={turns}
        timestamp={endedAt}
        leading={row.provider ? (
          // Glyph and name are one fact, so nothing separates them.
          <>
            {HarnessIcon ? <HarnessIcon className="size-3 shrink-0" /> : null}
            <span className="truncate">{PROVIDER_LABELS.get(row.provider) ?? row.provider}</span>
          </>
        ) : null}
      />
    </>
  )
}

/**
 * Wraps a sidebar chat row in its hover card.
 *
 * The row it wraps is *also* a context-menu trigger, which hands its props and
 * ref down through `asChild`. Those have to keep reaching the row's element, so
 * this spreads what it receives onto the hover-card trigger rather than
 * swallowing it — right-clicking a row must still open its menu.
 *
 * Open state is held here rather than left to the primitive because two things
 * have to close the card that hovering knows nothing about: opening the context
 * menu (a card floating over the menu it triggered), and picking a destination
 * (the cursor is still on the row afterwards, so an uncontrolled card would sit
 * over the chat it just took you to).
 *
 * On coarse pointers only the *content* is dropped: the trigger stays so that
 * pass-through holds, and with nothing to open, hovering does nothing.
 */
export function ChatHoverCard({
  thread,
  draft = "",
  onSelectMessage,
  onSelectChat,
  onSetupGit,
  children,
  ...triggerProps
}: {
  thread: SidebarThread
  /** The chat's unsent draft (`useChatDraft`), read by the row that owns it. */
  draft?: string
  /** Opens this chat at one end of its last exchange. Omitted = read-only card. */
  onSelectMessage?: (chatId: string, role: ChatJumpRole) => void
  /** Opens the chat plainly — the draft's action, and the row's. */
  onSelectChat?: (chatId: string) => void
  /** Prompts to `git init` this chat's project — the navbar's "Setup Git". */
  onSetupGit?: (chatId: string) => void
  children: ReactNode
} & ComponentPropsWithRef<typeof HoverCardTrigger>) {
  const hasFinePointer = useHasFinePointer()
  const [open, setOpen] = useState(false)
  const repoUrl = thread.projectLabel.repoUrl

  const handleSelectMessage = useCallback((role: ChatJumpRole) => {
    setOpen(false)
    onSelectMessage?.(thread.chatId, role)
  }, [onSelectMessage, thread.chatId])

  const handleSelectChat = useCallback(() => {
    setOpen(false)
    onSelectChat?.(thread.chatId)
  }, [onSelectChat, thread.chatId])

  // Opened by this browser, not through `system.openExternal` — that command
  // opens things on the machine the project lives on, which is the wrong screen
  // whenever that machine isn't this one.
  const handleOpenRepo = useCallback(() => {
    if (!repoUrl) return
    setOpen(false)
    window.open(repoUrl, "_blank", "noopener,noreferrer")
  }, [repoUrl])

  // Closed before the confirm opens: the dialog takes the pointer, so a card
  // left standing would hang over the transcript for as long as it's up.
  const handleSetupGit = useCallback(() => {
    setOpen(false)
    onSetupGit?.(thread.chatId)
  }, [onSetupGit, thread.chatId])

  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      // Both instant. The card appears the moment you point at a row, and
      // vanishes the moment you stop — closing on a timer to cover the walk
      // across the gap would leave a card hanging over the transcript every
      // time you merely passed a row on the way somewhere else. The gap is
      // spanned by geometry instead: see the bridge on the content below.
      openDelay={0}
      closeDelay={0}
    >
      <HoverCardTrigger
        asChild
        {...triggerProps}
        onContextMenu={(event) => {
          triggerProps.onContextMenu?.(event)
          setOpen(false)
        }}
        onClick={(event) => {
          triggerProps.onClick?.(event)
          setOpen(false)
        }}
      >
        {children}
      </HoverCardTrigger>
      {!hasFinePointer ? null : (
        <HoverCardContent
          side="right"
          // Top-aligned with the row rather than centred on it: the card is
          // several times the row's height, so centring floated it above the
          // thing it describes and left you tracing back to find which row.
          align="start"
          // Clears the row's right edge so the card reads as beside the sidebar
          // rather than inside it.
          sideOffset={15}
          collisionPadding={12}
          // The card is portalled into the body, but React events bubble the
          // *React* tree — where this content sits inside the row's
          // context-menu trigger. Without this, a right-click anywhere on the
          // card raises the row's menu at the pointer, which is out over the
          // transcript, a long way from the row it is about.
          onContextMenu={(event) => event.stopPropagation()}
          className={cn(
            // `px-1.5` rather than the `px-3` this looks like: the other half
            // lives on each row (`CARD_ROW_INSET`), so text still lands 12px
            // from the edge while a row's hover fill can run wider than it.
            "w-80 rounded-lg border-border bg-popover/95 px-1.5 py-2 text-xs shadow-xl backdrop-blur-sm",
            // The bridge: an invisible strip of the card laid over the gap
            // between the row and the card, so the pointer never leaves the
            // card's hitbox on its way there and no close timer is needed to
            // cover the crossing.
            //
            // Wider than the 15px `sideOffset` and so overlapping the row's
            // last few pixels — a hairline of dead space from subpixel
            // placement would drop the pointer for a frame and close the card
            // mid-walk. The overlap lands in the row's own right padding, well
            // clear of its hover buttons.
            //
            // Full height rather than just the row's band: `align="start"`
            // stops holding once a card near the bottom of the screen gets
            // shifted up to fit, and those rows have to stay reachable too.
            "relative before:absolute before:inset-y-0 before:w-5 before:content-['']",
            "data-[side=right]:before:-left-5 data-[side=left]:before:-right-5",
          )}
        >
          <ChatHoverCardContent
            thread={thread}
            draft={draft}
            onSelectMessage={onSelectMessage ? handleSelectMessage : undefined}
            onSelectChat={onSelectChat ? handleSelectChat : undefined}
            onOpenRepo={handleOpenRepo}
            onSetupGit={onSetupGit ? handleSetupGit : undefined}
          />
        </HoverCardContent>
      )}
    </HoverCard>
  )
}
