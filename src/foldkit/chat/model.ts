import { Schema } from "effect"
import * as Composer from "../composer"
import * as Terminal from "../terminal"
import * as Transcript from "../transcript"
import * as Viewer from "../viewer"
import * as Widgets from "../widgets"
import * as ContextMenu from "../ui/context-menu"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import { Watch } from "./message"

// The chat page's Model: the sub-slices, and what ChatPage kept in state and
// refs of its own.

const Wash = Schema.Struct({
  /** Something has scrolled under the navbar. */
  scrolled: Schema.Boolean,
  /** Just after a chat opened: the wash takes its state at once, no fade. */
  settling: Schema.Boolean,
  token: Schema.Number,
})

export const Model = Schema.Struct({
  transcript: Transcript.Model,
  composer: Composer.Model,
  widgets: Widgets.Model,
  viewer: Viewer.Model,
  terminal: Terminal.Model,

  /** window.innerWidth (useIsMobileViewport). */
  viewportWidth: Schema.Number,
  /** The page's own box (useLayoutWidth, useFixedTerminalHeight). */
  layoutWidth: Schema.Number,
  layoutHeight: Schema.Number,
  /** The navbar's height, published as `--chat-navbar-h`. Null until measured. */
  navbarHeight: Schema.NullOr(Schema.Number),
  /** The composer dock's height (useTranscriptPaddingBottom). */
  dockHeight: Schema.Number,

  /** The page as last observed; null before the first look. */
  watch: Schema.NullOr(Watch),
  lastGitRefreshProjectId: Schema.NullOr(Schema.String),
  /** The empty state as the page last showed it (`settledShowEmptyStateRef`). */
  settledShowEmptyState: Schema.Boolean,
  emptyStateTyping: Schema.Struct({
    /** The typing belongs to the empty state now on screen. */
    started: Schema.Boolean,
    count: Schema.Number,
    complete: Schema.Boolean,
  }),

  washes: Schema.Struct({ transcript: Wash, widgets: Wash }),
  washTokens: Schema.Number,

  title: Schema.Struct({
    /** The text field's value while renaming in place. */
    draft: Schema.NullOr(Schema.String),
    /** A name typed here, shown until the server's title catches up. */
    submitted: Schema.NullOr(Schema.String),
    /** The server's title when `submitted` was typed: moving on from it settles it. */
    submittedOver: Schema.NullOr(Schema.String),
  }),

  widgetsColumn: Schema.Struct({
    open: Schema.Boolean,
    switchKey: Schema.NullOr(Schema.String),
    sliding: Schema.Boolean,
    slideToken: Schema.Number,
    dragWidthPx: Schema.NullOr(Schema.Number),
    dragStart: Schema.NullOr(Schema.Struct({ pointerX: Schema.Number, widthPx: Schema.Number })),
  }),

  /** The chat column and the viewer's pane, in percent (the split's layout). */
  viewerSplit: Schema.Tuple([Schema.Number, Schema.Number]),

  /** Commands for terminals made by a quick action, sent once each opens. */
  pendingTerminalCommands: Schema.Record(Schema.String, Schema.String),

  tooltips: Schema.Struct({
    openIn: Tooltip.Model,
    terminal: Tooltip.Model,
    widgets: Tooltip.Model,
    picker: Tooltip.Model,
  }),
  menus: Schema.Struct({
    overflow: ContextMenu.Model,
    title: ContextMenu.Model,
  }),
  openSelect: Select.Model,
})
export type Model = typeof Model.Type

const wash = { scrolled: false, settling: true, token: 0 }

export function init(): Model {
  return {
    transcript: Transcript.init(),
    composer: Composer.init(),
    widgets: Widgets.init(),
    viewer: Viewer.init(),
    terminal: Terminal.init(),
    // React's useState initializer read the window the same way.
    viewportWidth: typeof window === "undefined" ? 0 : window.innerWidth,
    layoutWidth: 0,
    layoutHeight: 0,
    navbarHeight: null,
    dockHeight: 148,
    watch: null,
    lastGitRefreshProjectId: null,
    settledShowEmptyState: false,
    emptyStateTyping: { started: false, count: 0, complete: false },
    washes: { transcript: wash, widgets: wash },
    washTokens: 0,
    title: { draft: null, submitted: null, submittedOver: null },
    widgetsColumn: { open: false, switchKey: null, sliding: false, slideToken: 0, dragWidthPx: null, dragStart: null },
    viewerSplit: [100, 0],
    pendingTerminalCommands: {},
    tooltips: {
      openIn: Tooltip.init({ id: "chat-navbar-open-in" }),
      terminal: Tooltip.init({ id: "chat-navbar-terminal" }),
      widgets: Tooltip.init({ id: "chat-navbar-widgets" }),
      picker: Tooltip.init({ id: "chat-empty-state-project" }),
    },
    menus: {
      overflow: ContextMenu.init({ id: "chat-navbar-overflow" }),
      title: ContextMenu.init({ id: "chat-navbar-title" }),
    },
    openSelect: Select.init({ id: "chat-navbar-open-destination" }),
  }
}
