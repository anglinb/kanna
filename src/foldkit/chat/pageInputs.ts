import type { Html } from "foldkit/html"
import type { ProjectQuickAction } from "../../shared/protocol"
import type { UsageLimitsSnapshot } from "../../shared/types"
import type { ProjectTerminalLayout } from "../core/stores/terminalLayout"
import type { SliceViewInputs } from "../app/slice"
import type { NewChatDelegate } from "./newChatDelegate"

// What the chat page hands its sub-slices (transcript/, composer/, widgets/,
// viewer/, terminal/) on top of the root Model: the page's own state, which
// ChatPage passed down as props. Backward compatible with `SliceViewInputs`:
// a sub-slice that reads only `app` keeps working; one that wants the page
// reads `page` (and, for the transcript, calls `emptyState`).
//
// Import the types only (`import type`): this module is the contract, and a
// value import of chat/ from a sub-slice would be a cycle.

export interface ChatPageContext {
  chatId: string | null
  projectId: string | null
  /** Below 768px wide: the widget column is a sheet, the viewer covers the chat. */
  isMobile: boolean

  // The transcript (ChatTranscriptViewport's props from ChatPage)
  /** The new chat page: the transcript shows the empty state (`emptyState()`) instead of rows. */
  showEmptyState: boolean
  typedEmptyStateText: string
  isEmptyStateTypingComplete: boolean
  // The composer (ChatInputDock's props)
  /**
   * The new chat page's delegate control and target (`ComposerDelegate`),
   * or null where there is none. While it has a target the page takes the
   * composer's send (`AppAction.Chat(SubmittedMessage)`) and sends it to the
   * delegator instead; the control's pick is `Delegate.ChangedPreference`.
   */
  delegate: NewChatDelegate | null

  /** Room left at the transcript's end for the composer docked over it. */
  transcriptPaddingBottom: number
  /** Files are being dragged over the page: the transcript shows its drop overlay. */
  isPageFileDragActive: boolean
  /** The navbar's path, for the empty state's project and links. */
  projectPath: string | null

  // The widget column (WidgetsSidebar's props)
  /** The column is on screen (open, or peeking): its widgets load. */
  widgetsActive: boolean
  /** The new chat page is up (WidgetsSidebar's `isNewChat`). */
  isNewChat: boolean
  /**
   * What the column shows that the page loads for it (so the reads happen
   * once, when React's widgets made them): QuickActionsWidget's list for
   * this project (null until read), and UsageWidgets' snapshot (the
   * `usage-limits` topic, refreshed while the column is open).
   */
  widgetsData: {
    quickActions: ReadonlyArray<ProjectQuickAction> | null
    quickActionsError: string | null
    usageLimits: UsageLimitsSnapshot | null
    usageRefreshing: boolean
  }

  // The viewer (ViewerLayer's props)
  viewer: {
    /** There is a pane beside the chat (desktop); on a phone the viewer covers the chat. */
    paneAvailable: boolean
    /** Expanded over the workspace, as the layer is placed now. */
    expanded: boolean
    /** ViewerLayer's className from ChatPage. */
    className: string | undefined
  }

  // The terminal (TerminalWorkspaceShell's props)
  terminal: {
    layout: ProjectTerminalLayout
    /** The pane's height in px, fixed while it animates; 0 until measured. */
    fixedHeight: number
    /** Bumped when the pane opens by a toggle: the terminal takes focus. */
    focusRequestVersion: number
    /** Commands to type into new terminals once they open (quick actions). */
    pendingCommandsByTerminalId: Readonly<Record<string, string>>
    /** Per chat (`paneVisibility.terminal`), or null when the pane follows the project. */
    chatKey: string | null
  }
}

/** The view inputs the chat page gives each sub-slice. */
export interface ChatPageSliceInputs extends SliceViewInputs {
  page: ChatPageContext
  /**
   * The transcript only: the new chat page's empty state (the hero line, the
   * project picker, the project's chats), rendered by the chat page. Call it
   * where ChatTranscriptViewport rendered it: after the local-link menu's
   * trigger, before the drop overlay and the scroll-to-bottom button, when
   * `page.showEmptyState`. It runs in the chat page's boundary, so its
   * handlers are the chat page's.
   */
  emptyState?: () => Html
}
