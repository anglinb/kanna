import { Schema } from "effect"
import type { ProjectQuickAction } from "../../shared/protocol"
import type { ChatPreview, ChatTouchedFilesResult, UsageLimitsSnapshot } from "../../shared/types"
import type { SendOptions } from "../core/chatSession"
import { opaque } from "../core/schema"
import { defineMessageUnion } from "foldkit/message"
import { AppAction } from "../app/action"
import * as Composer from "../composer"
import * as Terminal from "../terminal"
import * as Transcript from "../transcript"
import * as Viewer from "../viewer"
import * as Widgets from "../widgets"
import * as ContextMenu from "../ui/context-menu"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import { Message as SidebarMessage } from "../sidebar/message"
import * as DefaultModelsDialog from "./defaultModelsDialog"

// The chat page's Messages (app/slice.ts). Kept apart from index.ts so the
// Mounts (effects.ts) can name them without importing the slice.

/**
 * What the page last saw of the root Model, for the work ChatPage's effects
 * did when one of these changed: refreshing diffs, starting the empty
 * state's typing, handing the viewer the chat, focus. Reported by a Mount
 * keyed on them (effects.ts `ObservePage`), since the root tells a slice
 * nothing of its own accord.
 */
export const Watch = Schema.Struct({
  chatId: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(Schema.String),
  showRightSidebar: Schema.Boolean,
  isProcessing: Schema.Boolean,
  showEmptyState: Schema.Boolean,
  viewerOpen: Schema.Boolean,
  viewerExpanded: Schema.Boolean,
  showTerminalPane: Schema.Boolean,
  isMobile: Schema.Boolean,
  sidebarReady: Schema.Boolean,
  isDelegator: Schema.Boolean,
  /** What the viewer shows decides a docked pane's width (`viewerWidthClass`). */
  viewerWidthClass: Schema.NullOr(Schema.String),
  /** The resolved keybindings the page's shortcuts answer to, as JSON. */
  bindings: Schema.String,
  /** What the terminal's toggle animation reads as a switch: the chat, when the pane is per chat; else the project. */
  terminalSwitchKey: Schema.NullOr(Schema.String),
  shouldRenderTerminalLayout: Schema.Boolean,
  /** The project's terminal split, as JSON. */
  terminalMainSizes: Schema.String,
  /** The Chat Tabs setting: the bar's effects run while it is on. */
  chatTabsEnabled: Schema.Boolean,
  tabsCount: Schema.Number,
  /** The tabs to keep, as JSON, when some should be pruned (`tabsToKeep`). */
  pruneTabs: Schema.NullOr(Schema.String),
})
export type Watch = typeof Watch.Type

export const TooltipId = Schema.Literals(["openIn", "terminal", "widgets", "picker", "delegated"])
export type TooltipId = typeof TooltipId.Type

export const MenuId = Schema.Literals(["overflow", "title"])
export type MenuId = typeof MenuId.Type

export const WashId = Schema.Literals(["transcript", "widgets"])
export type WashId = typeof WashId.Type

export const ShortcutAction = Schema.Literals(["toggleEmbeddedTerminal", "toggleRightSidebar", "openInFinder", "openInEditor", "addSplitTerminal"])
export type ShortcutAction = typeof ShortcutAction.Type

/** Why a terminal id was made: what to do with the terminal once it has one. */
export const TerminalPurpose = Schema.Union([
  Schema.TaggedStruct("Toggle", {}),
  Schema.TaggedStruct("Split", {}),
  Schema.TaggedStruct("QuickAction", { command: Schema.String }),
])
export type TerminalPurpose = typeof TerminalPurpose.Type

/** A tab being dragged along the bar (chatTabs.ts). */
export const TabDrag = Schema.Struct({
  chatId: Schema.String,
  dx: Schema.Number,
  fromIndex: Schema.Number,
  overIndex: Schema.Number,
  /** The dragged tab's width, which the tabs it passes give way by. */
  width: Schema.Number,
})
export type TabDrag = typeof TabDrag.Type

/**
 * The sidebar's chat hover card beneath the tab under the pointer
 * (tabHoverCard.ts): which tab it is on, and what it has fetched. React's
 * caches were module-wide and shared with the sidebar's card; here the
 * sidebar's are read alongside these.
 */
export const TabCard = Schema.Struct({
  hovered: Schema.NullOr(Schema.String),
  previewCache: Schema.Record(Schema.String, opaque<ChatPreview>("ChatPreview")),
  touchedFilesCache: Schema.Record(Schema.String, opaque<ChatTouchedFilesResult>("ChatTouchedFilesResult")),
  heldPreview: Schema.NullOr(Schema.Struct({ chatId: Schema.String, preview: opaque<ChatPreview>("ChatPreview") })),
  heldTouchedFiles: Schema.NullOr(Schema.Struct({ chatId: Schema.String, result: opaque<ChatTouchedFilesResult>("ChatTouchedFilesResult") })),
  /** The keys the open card is waiting on: an answer for another is cached, not shown. */
  cardFilesKey: Schema.NullOr(Schema.String),
  cardPreviewKey: Schema.NullOr(Schema.String),
})
export type TabCard = typeof TabCard.Type

export const TabShortcut = Schema.Literals(["next", "previous", "close", "new"])
export type TabShortcut = typeof TabShortcut.Type

export const Message = defineMessageUnion({
  // The sub-slices
  GotTranscriptMessage: { message: Transcript.Message },
  GotComposerMessage: { message: Composer.Message },
  GotWidgetsMessage: { message: Widgets.Message },
  GotViewerMessage: { message: Viewer.Message },
  GotTerminalMessage: { message: Terminal.Message },

  // The page's own primitives
  GotTooltipMessage: { id: TooltipId, message: Tooltip.Message },
  GotMenuMessage: { id: MenuId, message: ContextMenu.Message },
  GotOpenSelectMessage: { message: Select.Message },

  // What the page sees of the root and the browser
  /** The page's view mounted; `token` tells this showing from an earlier one. */
  EnteredPage: { token: Schema.Number },
  LeftPage: { token: Schema.Number },
  ObservedPage: { watch: Watch, fresh: Schema.Boolean },
  ResizedWindow: { width: Schema.Number },
  MeasuredLayout: { width: Schema.Number, height: Schema.Number },
  MeasuredNavbar: { height: Schema.Number },
  MeasuredDock: { height: Schema.Number },
  ChangedWashScroll: { wash: WashId, scrolled: Schema.Boolean },
  StartedWash: { wash: WashId, token: Schema.Number },
  SettledWash: { wash: WashId, token: Schema.Number },
  TypedEmptyStateCharacter: { count: Schema.Number },
  /** Files are being dragged over the chat card (usePageFileDrop). */
  ChangedPageFileDrag: { active: Schema.Boolean },

  // The navbar
  ClickedBack: {},
  ClickedExpandSidebar: {},
  ClickedSearch: {},
  ClickedToggleTerminal: {},
  ClickedToggleWidgets: {},
  ClickedShareChat: {},
  /** A delegator's list button: on a phone it only opens the list (`overlay`). */
  ClickedDelegatedList: { chatId: Schema.String, overlay: Schema.Boolean },
  ClickedOpenPrimary: { value: Schema.String },
  /** A button that opens a context menu was clicked: measured, then opened below it. */
  ClickedMenuButton: { id: MenuId, selector: Schema.String },
  MeasuredMenuButton: { id: MenuId, x: Schema.Number, y: Schema.Number },

  // The tabs (chatTabs.ts)
  PressedTab: { chatId: Schema.String },
  ClickedCloseTab: { chatId: Schema.String },
  MiddleClickedTab: { chatId: Schema.String },
  ClickedTabMenuButton: { chatId: Schema.String },
  MeasuredTabMenuButton: { chatId: Schema.String, x: Schema.Number, y: Schema.Number },
  GotTabMenuMessage: { chatId: Schema.String, message: ContextMenu.Message },
  PressedTabShortcut: { shortcut: TabShortcut },
  StartedTabDrag: { chatId: Schema.String, fromIndex: Schema.Number, width: Schema.Number },
  MovedTabDrag: { dx: Schema.Number, overIndex: Schema.Number },
  DroppedTab: {},
  /** The tab the hover card is on, from the bar's pointer tracking (null: closed). */
  ChangedTabCardRow: { key: Schema.NullOr(Schema.String) },
  /** From the card's body, which is the sidebar's (`chatCardBody`). */
  GotTabCardMessage: { message: SidebarMessage },
  SucceededLoadTabCardFiles: { chatId: Schema.String, cacheKey: Schema.String, result: opaque<ChatTouchedFilesResult>("ChatTouchedFilesResult") },
  SucceededLoadTabCardPreview: { chatId: Schema.String, cacheKey: Schema.String, preview: opaque<ChatPreview>("ChatPreview") },
  FailedLoadTabCard: {},

  // The title
  ClickedTitle: {},
  PressedTitleKey: { key: Schema.String },
  ChangedTitleDraft: { value: Schema.String },
  BlurredTitle: {},
  PressedTitleInputKey: { key: Schema.String },
  ClickedProjectName: {},
  ClickedBranch: { url: Schema.String },

  // The empty state
  ClickedProjectPicker: {},
  ClickedSetup: {},
  StartedProjectChats: { nowMs: Schema.Number },
  ElapsedProjectChatsCascade: {},
  ChangedProjectChatsStuck: { stuck: Schema.Boolean },
  ChangedProjectChatsQuery: { value: Schema.String },
  ClickedProjectChat: { chatId: Schema.String },
  ClickedUsageCard: { provider: Schema.String },
  GotUsageTooltipMessage: { provider: Schema.String, message: Tooltip.Message },

  // Shortcuts and the mobile sheet
  PressedShortcut: { action: ShortcutAction },
  PressedEscapeOnSheet: {},
  ClickedCloseWidgets: {},

  // The widget column's resize handle
  PressedColumnHandle: { x: Schema.Number },
  MovedColumnHandle: { x: Schema.Number },
  ReleasedColumnHandle: {},
  DoubleClickedColumnHandle: {},
  PressedColumnHandleKey: { key: Schema.String },
  ElapsedColumnSlide: { token: Schema.Number },
  /** The peek: the closed column shown over the chat while the mouse is at the window's right edge. */
  ChangedWidgetsPeek: { peeking: Schema.Boolean },

  // What sub-slices ask of the page (`requests`)
  ClickedEditModels: {},
  GotDefaultModelsMessage: { message: DefaultModelsDialog.Message },
  RanQuickAction: { command: Schema.String },
  SentTerminalCommand: {},
  ElapsedTerminalDiffRefresh: { token: Schema.Number },

  // Terminals and diffs
  MadeTerminalId: { purpose: TerminalPurpose, projectId: Schema.String, chatKey: Schema.NullOr(Schema.String), terminalId: Schema.String },
  /**
   * A split's handle dragged (react-resizable-panels' drag): the first
   * panel's share, in percent, as it moves, and once more as it's let go.
   */
  DraggedSeparator: { split: Schema.Literals(["terminal", "viewer"]), first: Schema.Number, groupSizePx: Schema.Number, done: Schema.Boolean },
  /** A frame of the viewer's pane sliding open or shut. */
  SteppedViewerSplit: { token: Schema.Number, chat: Schema.Number, viewer: Schema.Number, done: Schema.Boolean },
  /** A frame of the terminal pane opening or closing (useTerminalToggleAnimation). */
  SteppedTerminalSplit: { token: Schema.Number, chat: Schema.Number, terminal: Schema.Number, done: Schema.Boolean },
  TickedDiffRefresh: {},

  // Sending to a delegator from the new chat page (newChatDelegate.ts)
  StampedDelegatedSend: { chatId: Schema.String, content: Schema.String, options: opaque<SendOptions>("SendOptions"), sentAt: Schema.Number },
  SucceededDelegatedSend: { chatId: Schema.String },
  FailedDelegatedSend: { chatId: Schema.String, content: Schema.String, error: Schema.String },

  // What the widget column shows, loaded by the page
  SucceededReadQuickActions: { projectId: Schema.String, actions: opaque<ReadonlyArray<ProjectQuickAction>>("ProjectQuickActions") },
  FailedReadQuickActions: { projectId: Schema.String, error: Schema.String },
  ReceivedUsageLimits: { snapshot: opaque<UsageLimitsSnapshot>("UsageLimitsSnapshot") },
  TickedUsageRefresh: {},
  CompletedRefreshUsage: { snapshot: Schema.NullOr(opaque<UsageLimitsSnapshot>("UsageLimitsSnapshot")) },

  /** One of several requests to the root from one update, handed up on its own turn. */
  ForwardedAppAction: { action: AppAction },
  CompletedSideEffect: {},
})
export type Message = typeof Message.Type
