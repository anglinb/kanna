import { Schema } from "effect"
import type { ProjectQuickAction } from "../../shared/protocol"
import type { UsageLimitsSnapshot } from "../../shared/types"
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
  /** The resolved keybindings the page's shortcuts answer to, as JSON. */
  bindings: Schema.String,
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

  // Terminals and diffs
  MadeTerminalId: { purpose: TerminalPurpose, projectId: Schema.String, chatKey: Schema.NullOr(Schema.String), terminalId: Schema.String },
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
