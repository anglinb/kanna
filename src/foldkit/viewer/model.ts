import { Schema } from "effect"
import type { TablePreviewData } from "../../client/components/messages/attachmentPreview"
import type { ChatViewerState } from "../core/stores/rightSidebar"
import { opaque } from "../core/schema"
import * as Messages from "../transcript/messages/model"
import * as Tooltip from "../ui/tooltip"
import * as Select from "../ui/select"
import * as Dialog from "../ui/dialog"
import type { MarkupModel } from "./markup"
import { PreviewModel } from "./previewModel"

// The viewer layer's Model: what ViewerLayer, ViewerSurface and the views it
// shows (AttachmentViewer, FileViewer, DiffViewer, ChartFullView,
// VisualizationFullView, ChatPreview, DelegatedList) kept in state. What is
// open is the stores' (`app.stores.viewer`, `rightSidebar.chatViewers`);
// this is the rest.
//
// Each view was its own component, so its state went with it when another
// kind of thing opened. Here the state of the card on screen is kept under
// its key (`card`), and the view reads it only while that key is the one
// showing: what a card left behind is never seen by the next.

export const PaneState = Schema.Literals(["closed", "docked", "expanded"])
export type PaneState = typeof PaneState.Type

/** A text-shaped file being read (AttachmentViewer's `useTextContent`, FileViewer's `useFileText`). */
export type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: string; truncated: boolean; table?: TablePreviewData }

export type SortState = { column: number; direction: "asc" | "desc" } | null

/** SortableTable's state: the sort, how many rows are drawn so far, and the grid filled in around them. */
export interface TableState {
  sort: SortState
  /** The rows drawn, a chunk at a time (`renderedRows`). */
  count: number
  fill: { columns: number; rows: number; clipWidth: number; height: number }
}

export const INITIAL_TABLE: TableState = { sort: null, count: 60, fill: { columns: 1, rows: 0, clipWidth: 0, height: 0 } }

/** One file's patch, as read (DiffViewer's PatchEntry). */
export interface PatchEntry {
  digest: string
  patch?: string
  error?: string
  loading: boolean
}

/** DiffViewer's state. */
export interface DiffState {
  projectId: string
  /** The file that was opened, and the open it came with: another open (or the same file again) jumps to it. */
  path: string
  openCount: number
  /** The spot a reload comes back to (`readReviewState`), held until you scroll or jump. */
  restore: { path: string; offset: number } | null
  patches: Record<string, PatchEntry>
  seen: ReadonlyArray<string>
  collapsed: ReadonlyArray<string>
  previewing: ReadonlyArray<string>
  loaded: ReadonlyArray<string>
  full: ReadonlyArray<string>
  activeIndex: number
  limit: number
  /** A scroll to a file waiting for it to be drawn: bumped by every jump. */
  jump: { path: string; seq: number } | null
  jumpSeq: number
  /** How far into the file at the top the list is. */
  offset: number
}

/** Download image / Mark up, on a visualization at full size. */
export interface VisualizationDialog {
  kind: "save" | "markup"
  /** The capture, by id in the capture registry (`visualizationCapture.ts`). */
  captureId: string
  /** The save dialog's fields. */
  name: string
  type: string
  saving: boolean
  error: string | null
}

export const Model = Schema.Struct({
  /** Every header control's tooltip, by id; made on first use. */
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
  /** "Choose where to open" selects, by id. */
  selects: Schema.Record(Schema.String, Select.Model),
  /**
   * The card on screen and what it was told when it mounted (`ViewerMotion`,
   * frozen per card as React's useState held it).
   */
  card: Schema.NullOr(Schema.Struct({ key: Schema.String, cardEnters: Schema.Boolean, bodyEnters: Schema.Boolean })),
  /** The pane as of the last render (ViewerLayer's `was`). */
  was: PaneState,
  /** What was last shown, kept while it animates out (usePresentedViewer). */
  lastShown: Schema.NullOr(Schema.Struct({ key: Schema.String, chatKey: Schema.String, viewer: opaque<ChatViewerState>("ChatViewerState") })),
  /** A close that has finished animating, by the shown key it closed. */
  finishedExit: Schema.NullOr(Schema.String),
  reducedMotion: Schema.Boolean,

  /** A view toggle's choice, by card key ("rendered" / "original", "preview" / "original"). */
  toggles: Schema.Record(Schema.String, Schema.String),
  /** ViewerPanes: the panes shown so far, by card key. */
  panes: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** Files read, by slot (`<card key>|<url>`). */
  texts: Schema.Record(Schema.String, opaque<LoadState>("LoadState")),
  /** Tables, by slot. */
  tables: Schema.Record(Schema.String, opaque<TableState>("TableState")),

  /** The diff list's state, while a review is the card. */
  diff: Schema.NullOr(opaque<DiffState>("DiffState")),
  /** ChatPage's diff view preferences (useChatPageSidebarActions' state). */
  diffRenderMode: Schema.Literals(["unified", "split"]),
  wrapLines: Schema.Boolean,

  /** The transcript rows' state the chart and visualization bodies are drawn with (`chartFullViewBody`, `visualizationFrame`). */
  rows: Messages.Model,
  visualizationDialog: Schema.NullOr(opaque<VisualizationDialog>("VisualizationDialog")),
  /** Mark up's state while it is open (markup.ts). */
  markup: Schema.NullOr(opaque<MarkupModel>("MarkupModel")),
  dialog: Dialog.Model,

  /** The chat previewer: a second chat, live, while a chat is the card. */
  preview: Schema.NullOr(PreviewModel),
  /** This layer counts as a page that can preview a chat (registerChatPreviewHost). */
  hostRegistered: Schema.Boolean,
})
export type Model = typeof Model.Type

export const SAVE_DIALOG_ID = "viewer-visualization-save"

export function init(): Model {
  return {
    tooltips: {},
    selects: {},
    card: null,
    was: "closed",
    lastShown: null,
    finishedExit: null,
    reducedMotion: false,
    toggles: {},
    panes: {},
    texts: {},
    tables: {},
    diff: null,
    diffRenderMode: "unified",
    wrapLines: false,
    rows: Messages.init(),
    visualizationDialog: null,
    markup: null,
    dialog: Dialog.init({ id: SAVE_DIALOG_ID }),
    preview: null,
    hostRegistered: false,
  }
}
