import { memo, type ReactNode } from "react"
import { Archive, RotateCcw, Split } from "lucide-react"
import type { ChatTouchedFilesResult } from "../../../../shared/types"
import type { ChatJumpRole } from "../../../lib/chat-navigation"
import { getThreadDetailLabel, type ThreadDetailScope } from "../../../lib/thread-detail-label"
import type { SidebarThread } from "../../../lib/thread-sections"
import { cn, normalizeChatId } from "../../../lib/utils"
import { Button } from "../../ui/button"
import { useChatHasDraft, useChatInputStore } from "../../../stores/chatInputStore"
import { ThreadRowContent } from "../ThreadRowContent"
import { ChatHoverCard } from "./ChatHoverCard"
import { ChatRowMenu } from "./Menus"

interface ThreadRowProps {
  thread: SidebarThread
  isActive: boolean
  /** Archived rows swap Fork/Archive for Restore and get the archived menu. */
  archived?: boolean
  editorLabel: string
  /**
   * Which question the trailing slot answers — see `getThreadDetailLabel`. The
   * row resolves it itself rather than taking a finished node, so its props stay
   * comparable and `memo` can skip a row whose chat did not move. A node prop
   * would be a new element on every render and would defeat that outright.
   */
  detailScope: ThreadDetailScope
  /** Anchor for the age label; the sidebar advances it on a slow interval. */
  nowMs: number
  /** Transient chrome that replaces the slot — the number-jump keycap. */
  detailLabelOverride?: ReactNode
  /**
   * Fade idle/read titles (see `ThreadRowContent`). The Projects tab keeps it —
   * a project's chat list is a long backlog where read rows should recede. The
   * Chats tab turns it off: its rows are already filtered into
   * In Progress / Review / recent-day sections, so the *section* carries the
   * emphasis and dimming inside one would just fight it.
   */
  dimIdleTitles?: boolean
  onSelect: (chatId: string) => void
  /**
   * Opens the chat at one end of its last exchange — what the hover card's
   * prompt and reply do when clicked. Optional: without it those previews are
   * inert text (the archived list passes nothing).
   */
  onSelectMessage?: (chatId: string, role: ChatJumpRole) => void
  /**
   * Prompts to `git init` the chat's project — offered by the hover card when
   * the project turns out not to be a repo. Optional on the same terms as
   * `onSelectMessage`: the archived list passes nothing.
   */
  onSetupGit?: (chatId: string) => void
  /**
   * Fetches the files the chat changed, for its hover card. Optional like the
   * two above — a surface with no socket of its own (tests, the archived list)
   * simply shows no file list.
   */
  onLoadTouchedFiles?: (chatId: string) => Promise<ChatTouchedFilesResult>
  onCreateChat: (projectId: string) => void
  onRenameChat: (chat: SidebarThread["row"]) => void
  onShareChat: (chatId: string) => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
  onForkChat: (chat: SidebarThread["row"]) => void
  onArchiveChat: (chat: SidebarThread["row"]) => void
  onRestoreChat: (chatId: string) => void
  onDeleteChat: (chat: SidebarThread["row"]) => void
}

/**
 * The canonical sidebar chat row: right-click menu, click target, status glyph /
 * harness icon, title, and hover-revealed Fork/Archive. Used by both sidebar
 * tabs; each passes the `detailScope` its list calls for — the Chats tab spans
 * projects, the Projects tab is already inside one.
 *
 * A div rather than a button so the hover-action Buttons can nest inside it.
 *
 * Memoized, and worth keeping that way. There is one of these per chat, each
 * carrying a context menu and a hover card, and the sidebar snapshot is pushed
 * throughout every turn. Without the memo a single chat streaming a reply
 * re-rendered every row in the app.
 */
function ThreadRowImpl({
  thread,
  isActive,
  archived = false,
  editorLabel,
  detailScope,
  nowMs,
  detailLabelOverride,
  dimIdleTitles = true,
  onSelect,
  onSelectMessage,
  onSetupGit,
  onLoadTouchedFiles,
  onCreateChat,
  onRenameChat,
  onShareChat,
  onCopyPath,
  onOpenExternalPath,
  onForkChat,
  onArchiveChat,
  onRestoreChat,
  onDeleteChat,
}: ThreadRowProps) {
  // Whether there *is* a draft, not what it says. The row shows a pencil and the
  // menu offers "Clear Draft"; neither needs the text, and subscribing to it
  // re-rendered this row on every keystroke in the composer. The card reads the
  // text itself, from inside its own open subtree.
  const hasDraft = useChatHasDraft(thread.row.chatId)
  const clearDraft = useChatInputStore((state) => state.clearDraft)
  const detailLabel = detailLabelOverride ?? getThreadDetailLabel(thread, detailScope, nowMs)
  const hoverActions = archived ? (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
      onClick={(event) => {
        event.stopPropagation()
        onRestoreChat(thread.row.chatId)
      }}
      title="Restore chat"
    >
      <RotateCcw className="size-3.5" />
    </Button>
  ) : (
    <>
      {thread.row.canFork ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
          onClick={(event) => {
            event.stopPropagation()
            onForkChat(thread.row)
          }}
          title="Fork chat"
        >
          <Split className="size-3.5" />
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
        onClick={(event) => {
          event.stopPropagation()
          onArchiveChat(thread.row)
        }}
        title="Archive chat"
      >
        <Archive className="size-3.5" />
      </Button>
    </>
  )

  return (
    <ChatRowMenu
      canFork={thread.row.canFork}
      archived={archived}
      editorLabel={editorLabel}
      repoUrl={thread.projectLabel.repoUrl}
      onNewChat={() => onCreateChat(thread.projectId)}
      onRestore={archived ? () => onRestoreChat(thread.row.chatId) : undefined}
      onRename={() => onRenameChat(thread.row)}
      onShare={() => onShareChat(thread.row.chatId)}
      onCopyPath={() => onCopyPath(thread.row.localPath)}
      onOpenInFinder={() => onOpenExternalPath("open_finder", thread.row.localPath)}
      onOpenInEditor={() => onOpenExternalPath("open_editor", thread.row.localPath)}
      onFork={() => onForkChat(thread.row)}
      onClearDraft={hasDraft ? () => clearDraft(thread.row.chatId) : undefined}
      onArchive={archived ? () => {} : () => onArchiveChat(thread.row)}
      onDelete={() => onDeleteChat(thread.row)}
    >
      {/* Sidebar rows only: the palette renders `ThreadRowContent` directly and
          gets no card — it's already a detail view you opened on purpose. */}
      <ChatHoverCard
        thread={thread}
        onSelectMessage={onSelectMessage}
        onSelectChat={onSelect}
        onSetupGit={onSetupGit}
        onLoadTouchedFiles={onLoadTouchedFiles}
        onOpenExternalPath={onOpenExternalPath}
      >
        <div
          // The marker the sidebar's scroll-to-active querySelector looks for.
          // When the Chats tab renders above the project groups, its copy is
          // found first and the sidebar scrolls up to it.
          data-chat-id={normalizeChatId(thread.chatId)}
          className={cn(
            "group flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg border px-2 py-1.5 max-md:py-1.5 text-left text-sm max-md:text-base active:scale-[0.985] transition-all",
            isActive
              ? "bg-muted hover:bg-muted border-border"
              : "border-border/0 hover:border-border hover:bg-muted/20 dark:hover:border-slate-400/10",
          )}
          onClick={() => onSelect(thread.chatId)}
        >
          <ThreadRowContent
            thread={thread}
            showStatus
            isActive={isActive}
            dimIdleTitles={dimIdleTitles}
            hasDraft={hasDraft}
            detailLabel={detailLabel}
            hoverActions={hoverActions}
          />
        </div>
      </ChatHoverCard>
    </ChatRowMenu>
  )
}

export const ThreadRow = memo(ThreadRowImpl)
