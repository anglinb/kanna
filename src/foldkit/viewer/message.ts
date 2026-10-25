import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { OpenLocalLinkTarget } from "../../client/components/messages/shared"
import * as Composer from "../composer"
import * as ChatSession from "../core/chatSession"
import type { ChatViewerState } from "../core/stores/rightSidebar"
import { opaque } from "../core/schema"
import { Message as TranscriptMessage } from "../transcript/message"
import * as Messages from "../transcript/messages/model"
import * as Dialog from "../ui/dialog"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import { PaneState, type LoadState, type TableState } from "./model"

const Direction = Schema.Literals(["next", "previous"])

export const Message = defineMessageUnion({
  // THE LAYER AND ITS CARD

  /** A card mounted, with the motion it was told to play (`ViewerMotion`, held for its life). */
  MountedCard: { key: Schema.String, cardEnters: Schema.Boolean, bodyEnters: Schema.Boolean },
  /**
   * The pane as this render left it (ViewerLayer's layout effect on
   * `paneState`, usePresentedViewer's on what is shown): `shownKey` names
   * what is on screen, null once it is closed.
   */
  RenderedPane: {
    state: PaneState,
    shownKey: Schema.NullOr(Schema.String),
    chatKey: Schema.String,
    viewer: Schema.NullOr(opaque<ChatViewerState>("ChatViewerState")),
  },
  /** A closed card has finished leaving. */
  FinishedExit: { key: Schema.String },
  ChangedReducedMotion: { reduced: Schema.Boolean },
  /** This page can preview a chat (the layer mounted with a chat context). */
  MountedPreviewHost: {},

  /** Escape, heard at the window, that the pane is to answer (ViewerSurface's handler). */
  PressedEscape: {},
  /** j/k or ]/[ (ViewerSurface's keydown handler). */
  PressedNavigationKey: { direction: Direction },
  ClickedNavigation: { direction: Direction },
  /** The card's Close: Escape's step back, or the pane shut where it has a floor. */
  ClickedClose: {},
  ClickedShut: {},
  ClickedBack: {},
  ClickedToggleExpanded: {},

  GotTooltipMessage: { id: Schema.String, message: Tooltip.Message },
  GotSelectMessage: { id: Schema.String, message: Select.Message },

  // VIEWS AND PANES

  /** A ViewerToggle's choice, for the card under `cardKey`; `previous` was showing, and stays mounted. */
  ChoseView: { cardKey: Schema.String, value: Schema.String, previous: Schema.String },
  /** A file read for a view (`useTextContent`, `useFileText`). */
  LoadedText: { slot: Schema.String, state: opaque<LoadState>("LoadState") },

  // ATTACHMENTS

  ClickedCopyLink: { url: Schema.String },
  ClickedOpenInNewTab: { url: Schema.String },
  ClickedSortColumn: { slot: Schema.String, column: Schema.Number },
  /** SortableTable's next chunk of rows, a frame after the last. */
  DrewRowChunk: { slot: Schema.String, count: Schema.Number },
  /** The empty grid around a table, as it was measured. */
  MeasuredTableFill: { slot: Schema.String, fill: opaque<TableState["fill"]>("TableFill") },

  // FILES

  ClickedShowChanges: { projectId: Schema.String, path: Schema.String },
  ClickedWrapLines: {},
  /** "Open in …" for a file: `value` is an OpenAppValue, from the icon or the list. */
  ChoseOpenDestination: { path: Schema.String, line: Schema.NullOr(Schema.Number), value: Schema.String },
  ClickedOpenInEditor: { path: Schema.String, line: Schema.NullOr(Schema.Number) },
  /** A file link in what the viewer shows (a markdown preview's). */
  ClickedLocalLink: { target: opaque<OpenLocalLinkTarget>("OpenLocalLinkTarget") },

  // DIFFS

  /** The review mounted, with the spot this tab left it at (`readReviewState`). */
  MountedReview: { projectId: Schema.String, path: Schema.String, openCount: Schema.Number, restore: Schema.NullOr(opaque<RestoredReview>("RestoredReview")) },
  /** Files that came within reach of the view (the IntersectionObserver). */
  SawFiles: { paths: Schema.Array(Schema.String) },
  /** What the view needs read, as it stands (the effect that loads patches). */
  NeededPatches: { loads: Schema.Array(Schema.Struct({ path: Schema.String, full: Schema.Boolean, digest: Schema.String })) },
  ReceivedPatch: { key: Schema.String, digest: Schema.String, patch: Schema.String },
  FailedPatch: { key: Schema.String, digest: Schema.String, error: Schema.String },
  /** The list scrolled: the file at the top, and how far into it. */
  ScrolledReview: { index: Schema.Number, offset: Schema.Number },
  /** A jump landed: the list is at the file. */
  LandedJump: { seq: Schema.Number, index: Schema.Number, path: Schema.String, offset: Schema.Number },
  /** A restored spot was let go (you scrolled, clicked or typed). */
  ReleasedRestore: {},
  /** A new open of the review: the store's openCount or path moved. */
  ReopenedReview: { path: Schema.String, openCount: Schema.Number },
  /** Everything was committed or unchecked: nothing left to review. */
  EmptiedReview: {},
  ChoseDiffMode: { mode: Schema.Literals(["unified", "split"]) },
  ToggledCollapsed: { path: Schema.String },
  ToggledPreview: { path: Schema.String, value: Schema.String },
  ClickedLoadHeld: { path: Schema.String },
  ToggledFullFile: { path: Schema.String },
  ClickedRetryPatch: { path: Schema.String, full: Schema.Boolean },
  ClickedLoadMore: {},

  // CHART AND VISUALIZATION

  GotRowsMessage: { message: Messages.Message },
  ClickedDownloadImage: {},
  ClickedMarkup: {},
  /** The capture is drawing (it starts on the click), and its dialog opens. */
  StartedCapture: { kind: Schema.Literals(["save", "markup"]), captureId: Schema.String },
  /** Escape the full-size frame handed back: `close` when it is the pane's to answer. */
  CheckedFrameEscape: { close: Schema.Boolean },
  ChangedImageName: { value: Schema.String },
  ChoseImageType: { value: Schema.String },
  SubmittedSaveImage: {},
  SucceededSaveImage: {},
  FailedSaveImage: { error: Schema.String },
  ClickedCancelSave: {},
  GotDialogMessage: { message: Dialog.Message },
  /** Mark up: the image came back attached to the composer, or the markup was cancelled. */
  ClosedMarkup: { attached: Schema.Boolean },
  LoadedMarkupSource: { captureId: Schema.String, width: Schema.Number, height: Schema.Number },
  FailedMarkupSource: { captureId: Schema.String, error: Schema.String },
  MeasuredMarkupStage: { width: Schema.Number, height: Schema.Number },
  ChoseMarkupTool: { tool: Schema.String },
  ChoseMarkupColor: { color: Schema.String },
  /** A stroke, arrow or box finished on the canvas. */
  AddedMark: { mark: Schema.Unknown },
  PlacedTextDraft: { at: Schema.Struct({ x: Schema.Number, y: Schema.Number }), size: Schema.Number },
  ChangedTextDraft: { value: Schema.String },
  /** The label goes in: `id` names the one to commit (its field's blur), null for whichever is open. */
  CommittedTextDraft: { id: Schema.NullOr(Schema.Number) },
  CancelledTextDraft: {},
  ClickedUndoMarkup: {},
  ClickedClearMarkup: {},
  ClickedAttachMarkup: {},
  SucceededAttachMarkup: {},
  FailedAttachMarkup: { error: Schema.String },

  // THE CHAT PREVIEWER

  /** `chatId` names the session a Command was for; null from its subscriptions, which only ever run for the current one. */
  GotPreviewSessionMessage: { chatId: Schema.NullOr(Schema.String), message: ChatSession.Message },
  GotPreviewTranscriptMessage: { chatId: Schema.NullOr(Schema.String), message: TranscriptMessage },
  GotPreviewComposerMessage: { chatId: Schema.NullOr(Schema.String), message: Composer.Message },
  /** The previewed chat mounted (ChatPreviewSession): its session starts. */
  MountedPreviewSession: { chatId: Schema.String, fadesIn: Schema.Boolean },
  /** The chat it previewed is gone: shut the pane past it. */
  LostPreviewedChat: {},
  ClickedOpenPreviewInTab: { chatId: Schema.String },
  ResizedPreviewDock: { chatId: Schema.String, height: Schema.Number },
  DroppedPreviewFiles: { chatId: Schema.String },

  CompletedSideEffect: {},
})
export type Message = typeof Message.Type

/** What `readReviewState` brings back. */
export interface RestoredReview {
  path: string
  offset: number
  collapsed: string[]
  previewing: string[]
  full: string[]
  loaded: string[]
}
