import type { ReactNode } from "react"
import { Archive, RotateCcw, Split } from "lucide-react"
import type { SidebarThread } from "../../../lib/thread-sections"
import { cn, normalizeChatId } from "../../../lib/utils"
import { Button } from "../../ui/button"
import { useChatDraft, useChatInputStore } from "../../../stores/chatInputStore"
import { ThreadRowContent } from "../ThreadRowContent"
import { ChatHoverCard } from "./ChatHoverCard"
import { ChatRowMenu } from "./Menus"

/**
 * The canonical sidebar chat row: right-click menu, click target, status glyph /
 * harness icon, title, and hover-revealed Fork/Archive. Used by both sidebar
 * tabs; each passes `detailLabel` from `getThreadDetailLabel` with its own
 * scope — the Chats tab spans projects, the Projects tab is already inside one.
 *
 * A div rather than a button so the hover-action Buttons can nest inside it.
 */
export function ThreadRow({
  thread,
  isActive,
  archived = false,
  editorLabel,
  detailLabel,
  dimIdleTitles = true,
  onSelect,
  onSelectMessage,
  onCreateChat,
  onRenameChat,
  onShareChat,
  onCopyPath,
  onOpenExternalPath,
  onForkChat,
  onArchiveChat,
  onRestoreChat,
  onDeleteChat,
}: {
  thread: SidebarThread
  isActive: boolean
  /** Archived rows swap Fork/Archive for Restore and get the archived menu. */
  archived?: boolean
  editorLabel: string
  /** From `getThreadDetailLabel`; a node only for transient chrome (keycap). */
  detailLabel: ReactNode
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
   * Opens the chat scrolled to one message — what the hover card's prompt and
   * reply do when clicked. Optional: without it the card's previews are inert
   * text and a click anywhere on it just opens the chat (the archived list,
   * which has no transcript to land in, passes nothing).
   */
  onSelectMessage?: (chatId: string, messageId: string) => void
  onCreateChat: (projectId: string) => void
  onRenameChat: (chat: SidebarThread["row"]) => void
  onShareChat: (chatId: string) => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
  onForkChat: (chat: SidebarThread["row"]) => void
  onArchiveChat: (chat: SidebarThread["row"]) => void
  onRestoreChat: (chatId: string) => void
  onDeleteChat: (chat: SidebarThread["row"]) => void
}) {
  // Read once here and handed to both the row and its card: the icon slot and
  // the card's last line are two readings of the same unsent sentence.
  const draft = useChatDraft(thread.row.chatId)
  const clearDraft = useChatInputStore((state) => state.clearDraft)
  const hoverActions = archived ? (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
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
          className="h-6 w-6 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
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
        className="h-6 w-6 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
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
      onClearDraft={draft ? () => clearDraft(thread.row.chatId) : undefined}
      onArchive={archived ? () => {} : () => onArchiveChat(thread.row)}
      onDelete={() => onDeleteChat(thread.row)}
    >
      {/* Sidebar rows only: the palette renders `ThreadRowContent` directly and
          gets no card — it's already a detail view you opened on purpose. */}
      <ChatHoverCard
        thread={thread}
        draft={draft}
        onSelectMessage={onSelectMessage}
        onSelectChat={onSelect}
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
            hasDraft={draft.length > 0}
            detailLabel={detailLabel}
            hoverActions={hoverActions}
          />
        </div>
      </ChatHoverCard>
    </ChatRowMenu>
  )
}
