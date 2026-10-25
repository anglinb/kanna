import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { ChatPreview, ChatTouchedFilesResult } from "../../shared/types"
import type { PairSessionState } from "../../client/lib/pairSession"
import { AppAction } from "../app/action"
import { opaque } from "../core/schema"
import * as Connection from "../core/stores/connection"
import { SidebarView } from "../core/stores/sidebarView"
import * as ContextMenu from "../ui/context-menu"
import * as Dialog from "../ui/dialog"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"
import { HoverList, MenuTarget } from "./model"

export const Message = defineMessageUnion({
  // The clock and the device (KannaSidebar's interval, useHasFinePointer, the phone media query)
  TickedClock: { nowMs: Schema.Number },
  ChangedFinePointer: { matches: Schema.Boolean },
  ChangedPhoneLayout: { matches: Schema.Boolean },
  ChangedStandalone: { matches: Schema.Boolean },

  // Header, footer, navigation
  ClickedCollapseSidebar: {},
  ClickedExpandSidebar: {},
  /** A button that goes to a path: Projects, Settings, Terminal, Back. */
  ClickedLink: { path: Schema.String },
  ClickedSearch: {},
  ClickedAddProject: {},
  ClickedNewChat: {},
  ClickedExitFocus: {},
  ClickedHistoryBack: {},
  ClickedHistoryForward: {},
  /** Leaving a project's page with no history behind it: to the menu, in its place. */
  FoundNoHistoryToLeave: {},
  GotViewSwitcherMessage: { message: Popover.Message },
  ChoseSidebarView: { view: SidebarView },

  // Chat rows
  ClickedChat: { chatId: Schema.String, archived: Schema.Boolean },
  /** A Cmd/Ctrl-click on a chat row, heard (in capture) before the row's own click. */
  PressedChatInBackground: { chatId: Schema.String },
  ClickedForkChat: { chatId: Schema.String },
  ClickedArchiveChat: { chatId: Schema.String },
  ClickedRestoreChat: { chatId: Schema.String },

  // Sections (Chats view, channel list)
  ToggledSection: { scope: Schema.String, sectionKey: Schema.String, expanded: Schema.Boolean },

  // Projects view
  ToggledProjectGroup: { projectId: Schema.String },
  ToggledExpandedGroup: { projectId: Schema.String },
  ClickedNewProjectChat: { localPath: Schema.String },
  PressedProjectHeader: { projectId: Schema.String, pointerId: Schema.Number, y: Schema.Number },
  /** The drag passed its 2px activation distance. */
  ActivatedProjectDrag: { activeHeight: Schema.Number },
  MovedProjectDrag: { deltaY: Schema.Number, overId: Schema.NullOr(Schema.String) },
  ReleasedProjectDrag: {},
  CancelledProjectDrag: {},

  // Channels view
  ClickedChannel: { projectId: Schema.String },
  ClickedPeekNewChat: { projectId: Schema.String },
  ClickedPeekShowMore: { projectId: Schema.String },
  ClickedPeekChat: { chatId: Schema.String },

  // The one right-click menu
  PressedMenuTrigger: { target: MenuTarget, pointerType: Schema.String, button: Schema.Number, x: Schema.Number, y: Schema.Number },
  RequestedMenu: { target: MenuTarget },
  MovedOnMenuTrigger: { pointerType: Schema.String },
  /** The "…" button: open the menu below it, as a right click there would. */
  ClickedMoreButton: { target: MenuTarget, buttonId: Schema.String },
  MeasuredMoreButton: { target: MenuTarget, x: Schema.Number, y: Schema.Number },
  GotRowMenuMessage: { message: ContextMenu.Message },

  // Tooltips
  GotTooltipMessage: { key: Schema.String, message: Tooltip.Message },

  // Hover cards (ListHoverCard)
  ChangedHoveredRow: { list: HoverList, key: Schema.NullOr(Schema.String) },
  /** A card is up for a chat, or its row's key moved: fetch what the cache lacks (React's two effects). */
  RequestedCardLoad: { chatId: Schema.String, kind: Schema.Literals(["files", "preview"]), cacheKey: Schema.String },
  SucceededLoadPreview: { chatId: Schema.String, cacheKey: Schema.String, preview: opaque<ChatPreview>("ChatPreview") },
  SucceededLoadTouchedFiles: { chatId: Schema.String, cacheKey: Schema.String, result: opaque<ChatTouchedFilesResult>("ChatTouchedFilesResult") },
  /** A card's fetch failed: it stays without, quietly (the card is a peek). */
  FailedLoadCard: {},
  ClickedCardMessage: { list: HoverList, chatId: Schema.String, role: Schema.Literals(["prompt", "reply"]) },
  ClickedCardChat: { list: HoverList, chatId: Schema.String, archived: Schema.Boolean },
  ClickedCardSetupGit: { list: HoverList, chatId: Schema.String },
  ClickedCardRepo: { list: HoverList, url: Schema.String },
  ClickedCardFile: { list: HoverList, localPath: Schema.String, filePath: Schema.String },
  /** The channel card asked to close: Escape, a click outside. */
  DismissedChannelCard: {},

  // The project's archived chats dialog
  GotArchivedDialogMessage: { message: Dialog.Message },
  ClickedArchivedDialogChat: { chatId: Schema.String },
  ClickedArchivedDialogRestore: { chatId: Schema.String },

  // Keyboard (KannaSidebar's window listeners)
  ChangedNumberJumpHints: { show: Schema.Boolean },
  PressedCreateChatShortcut: {},
  PressedAddProjectShortcut: {},
  PressedToggleFocusShortcut: {},
  PressedJumpShortcut: { chatId: Schema.String },
  PressedEscapeToLeaveFocus: {},

  // Resizing
  PressedResizeHandle: { pointerX: Schema.Number },
  MovedResize: { pointerX: Schema.Number },
  ReleasedResize: {},
  DoubleClickedResizeHandle: {},
  PressedResizeKey: { key: Schema.String },

  // The peek (useEdgePeek)
  ChangedPeek: { peeking: Schema.Boolean },

  // Effects the card asks for when what it shows calls for them
  RequestedConnectionLoad: {},
  RequestedPairSession: {},
  GotConnectionMessage: { message: Connection.Message },
  ReceivedPairSession: { session: opaque<PairSessionState>("PairSessionState") },
  ClickedRetryPair: {},
  FinishedPairStart: { session: opaque<PairSessionState>("PairSessionState") },
  ClickedCopyPairLink: { text: Schema.String },
  CopiedPairLink: {},
  ElapsedPairCopied: { version: Schema.Number },
  ElapsedPairPoll: { version: Schema.Number },

  // The machine switcher
  GotMachineSwitcherMessage: { message: Popover.Message },
  ClosedMachineSwitcher: {},
  ChoseMachine: { subdomain: Schema.NullOr(Schema.String), name: Schema.String, appOrigin: Schema.NullOr(Schema.String) },
  ClickedManageFleet: {},
  ClickedSetupCloud: {},
  GotPairDialogMessage: { message: Dialog.Message },
  ElapsedSwitchPending: { version: Schema.Number },

  /** A send started while the Archived view was up: that visit is over. */
  ObservedSendStarted: {},
  /** The rest of a sequence of root actions (one OutMessage carries one). */
  ContinuedActions: { actions: Schema.Array(AppAction) },

  /** A DOM side effect ran (storage write, a dispatched event, a window opened). */
  CompletedSideEffect: {},
})
export type Message = typeof Message.Type
