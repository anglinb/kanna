import type { ReactNode } from "react"
import { Archive, Clock, Code, Copy, EyeOff, FolderOpen, Github, Mail, MailOpen, Pencil, PencilOff, RotateCcw, Split, SquarePen, Trash2, UserRoundPlus } from "lucide-react"
import { getRepoUrlLabel } from "../../../../shared/git-url"
import { formatReminderDue, REMINDER_PRESETS } from "../../../lib/reminder-presets"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../../ui/context-menu"

/**
 * "Open on GitHub" (or GitLab, or whatever host the remote names), sitting with
 * the other Open-in items.
 *
 * Renders nothing without a URL — a project with no `origin`, or one whose
 * remote is a bare path, has no page to open, and a permanently disabled row in
 * every menu would cost more than it explains.
 *
 * Opens in *this* browser rather than through `system.openExternal`: that
 * command opens things on the machine the project lives on, which is the wrong
 * screen the moment that machine isn't the one you're sitting at.
 */
export function OpenRepoMenuItem({ repoUrl }: { repoUrl?: string }) {
  if (!repoUrl) return null

  return (
    <ContextMenuItem
      onSelect={(event) => {
        event.preventDefault()
        window.open(repoUrl, "_blank", "noopener,noreferrer")
      }}
    >
      <Github className="h-3.5 w-3.5" />
      <span className="text-xs font-medium">Open on {getRepoUrlLabel(repoUrl)}</span>
    </ContextMenuItem>
  )
}

export function ProjectSectionMenu({
  editorLabel,
  repoUrl,
  onRename,
  onCopyPath,
  onShowArchived,
  onOpenInFinder,
  onOpenInEditor,
  onHide,
  children,
}: {
  editorLabel: string
  /** The project's forge page; absent when it has no browsable origin. */
  repoUrl?: string
  onRename: () => void
  onCopyPath: () => void
  onShowArchived: () => void
  onOpenInFinder: () => void
  onOpenInEditor: () => void
  onHide: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onRename()
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Rename</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onCopyPath()
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Copy Path</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onShowArchived()
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Show Archived</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Show in Finder</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInEditor()
          }}
        >
          <Code className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in {editorLabel}</span>
        </ContextMenuItem>
        <OpenRepoMenuItem repoUrl={repoUrl} />
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onHide()
          }}
        >
          <EyeOff className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Hide</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ChatRowMenu({
  canFork,
  archived,
  editorLabel,
  repoUrl,
  unread,
  reminderAt,
  onNewChat,
  onRename,
  onShare,
  onCopyPath,
  onOpenInFinder,
  onOpenInEditor,
  onFork,
  onArchive,
  onRestore,
  onClearDraft,
  onSetUnread,
  onSetReminder,
  onClearReminder,
  onDelete,
  children,
}: {
  canFork?: boolean
  /** Archived chats swap the Archive item for a leading Restore item. */
  archived?: boolean
  editorLabel: string
  /** The project's forge page; absent when it has no browsable origin. */
  repoUrl?: string
  /** Current unread state — decides whether the item reads "Unread" or "Read". */
  unread?: boolean
  /** When this chat's pending reminder fires, if it has one. */
  reminderAt?: number
  /** Starts a fresh chat in this chat's project. */
  onNewChat: () => void
  onRename: () => void
  onShare: () => void
  onCopyPath: () => void
  onOpenInFinder: () => void
  onOpenInEditor: () => void
  onFork: () => void
  onArchive: () => void
  onRestore?: () => void
  /**
   * Throws away the chat's unsent draft. Absent when there is no draft, which
   * is most rows — a section that only ever appears when there's something to
   * clear beats a permanently greyed-out item in every menu.
   */
  onClearDraft?: () => void
  /**
   * Flip the unread flag. Absent on surfaces with no socket to send it (the
   * archived list, tests), which simply get no item — same contract as
   * `onClearDraft`.
   */
  onSetUnread?: (unread: boolean) => void
  /** Schedule a reminder at an absolute time. Absent hides the submenu. */
  onSetReminder?: (dueAt: number) => void
  onClearReminder?: () => void
  onDelete: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Draft leads: its own section, for something only this chat has and
            only while it has it — so when it's there, it's what you opened the
            menu for. */}
        {onClearDraft ? (
          <>
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onClearDraft()
              }}
            >
              <PencilOff className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">Clear Draft</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}

        {archived && onRestore ? (
          <>
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onRestore()
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">Restore</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}

        {/* Triage: what you do to a row you are not opening right now. Leads
            the chat actions because that is the common case for a right-click
            on a row you just glanced at. */}
        {onSetUnread ? (
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onSetUnread(!unread)
            }}
          >
            {unread ? <MailOpen className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />}
            <span className="text-xs font-medium">
              {unread ? "Mark as Read" : "Mark as Unread"}
            </span>
          </ContextMenuItem>
        ) : null}
        {onSetReminder ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Clock className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">
                {reminderAt ? `Reminder ${formatReminderDue(reminderAt, Date.now())}` : "Remind Me"}
              </span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {REMINDER_PRESETS.map((preset) => (
                <ContextMenuItem
                  key={preset.label}
                  onSelect={(event) => {
                    event.preventDefault()
                    onSetReminder(preset.resolve(Date.now()))
                  }}
                >
                  <span className="text-xs font-medium">{preset.label}</span>
                </ContextMenuItem>
              ))}
              {reminderAt && onClearReminder ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={(event) => {
                      event.preventDefault()
                      onClearReminder()
                    }}
                  >
                    <span className="text-xs font-medium">Cancel Reminder</span>
                  </ContextMenuItem>
                </>
              ) : null}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        {onSetUnread || onSetReminder ? <ContextMenuSeparator /> : null}

        {/* Chat actions */}
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onRename()
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Rename</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onShare()
          }}
        >
          <UserRoundPlus className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Share</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canFork}
          onSelect={(event) => {
            event.preventDefault()
            if (!canFork) return
            onFork()
          }}
        >
          <Split className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Fork</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Project actions */}
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onNewChat()
          }}
        >
          <SquarePen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">New Chat</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onCopyPath()
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Copy Path</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in Finder</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInEditor()
          }}
        >
          <Code className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in {editorLabel}</span>
        </ContextMenuItem>
        <OpenRepoMenuItem repoUrl={repoUrl} />

        <ContextMenuSeparator />

        {/* Chat lifecycle */}
        {!archived ? (
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onArchive()
            }}
          >
            <Archive className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Archive Chat</span>
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onDelete()
          }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Delete Chat</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
