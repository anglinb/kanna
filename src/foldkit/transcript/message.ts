import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { ChatJumpTarget } from "../../client/lib/chat-navigation"
import type { TranscriptEntry } from "../../shared/types"
import { opaque } from "../core/schema"
import * as ContextMenu from "../ui/context-menu"
import * as Messages from "./messages/model"
import * as ScheduleCard from "../widgets/scheduleCard"

// The transcript viewport's Messages. In their own module: the viewport's
// Mounts (viewport.ts, minimap.ts) report with them, and the Model and
// update import those.

const Layout = Schema.NullOr(Schema.Struct({ transcriptWidth: Schema.Number, offsetFromMessage: Schema.Number }))
const Range = Schema.NullOr(Schema.Struct({ start: Schema.Number, end: Schema.Number }))

export const Message = defineMessageUnion({
  GotMessagesMessage: { message: Messages.Message },
  GotLinkMenuMessage: { message: ContextMenu.Message },

  // From the viewport's controller
  /** A viewport mounted for this chat (it is keyed by chat): what was held for another chat goes. */
  MountedViewport: { chatId: Schema.NullOr(Schema.String) },
  /** The page's isAtEnd as the viewport reports it (onIsAtEndChange). */
  ChangedAtEnd: { isAtEnd: Schema.Boolean },
  ElapsedScrollButtonDelay: { token: Schema.Number },
  ChangedOverflow: { overflows: Schema.Boolean },
  ResizedViewport: { width: Schema.Number },
  ChangedVisibleRange: { range: Range },
  /** The message at the top of the viewport as the reader scrolls, with when (for the write's throttle). */
  ReportedReadAnchor: { messageId: Schema.String, atEnd: Schema.Boolean, layout: Layout, at: Schema.Number },
  RequestedLoadOlder: {},
  SpentJump: { requestId: Schema.Number, target: opaque<ChatJumpTarget>("ChatJumpTarget") },
  JumpedToRow: { rowId: Schema.String },
  RaisedFlash: { token: Schema.Number },
  ElapsedFlash: { token: Schema.Number },
  AppliedUnloadedJump: { seq: Schema.Number },
  CompletedViewportCommand: {},

  // The viewport's own controls
  ClickedScrollToBottom: {},
  ClickedLoadMore: {},

  // The minimap
  SelectedTurn: { turnId: Schema.String, rowId: Schema.NullOr(Schema.String), loaded: Schema.Boolean },
  MeasuredMinimap: { height: Schema.Number },
  ChangedFinePointer: { fine: Schema.Boolean },
  MovedOverMinimap: { y: Schema.Number },
  /** Off the strip: onto the card (which then holds the turn it was on), or anywhere else. */
  LeftMinimap: { heldTurnId: Schema.NullOr(Schema.String) },
  LeftMinimapCard: {},

  // The rows' fetches
  ReceivedToolEntries: { chatId: Schema.String, entryIds: Schema.Array(Schema.String), entries: Schema.Array(opaque<TranscriptEntry>("TranscriptEntry")) },
  FailedToolEntries: { chatId: Schema.String, entryIds: Schema.Array(Schema.String) },
  ReceivedDebugRaw: { chatId: Schema.String, entryId: Schema.String, body: Schema.NullOr(Schema.String), failed: Schema.Boolean },
  /** The local-link menu's trigger got its contextmenu (the menu opens at the link). */
  CompletedOpenLinkMenu: {},
  /** Where the right click that asked for the local-link menu was. */
  LocatedLinkMenu: { x: Schema.Number, y: Schema.Number },

  // A live chat card (chatCard.ts)
  ClickedChatCard: { chatId: Schema.String },
  GotCardMenuMessage: { chatId: Schema.String, message: ContextMenu.Message },
  GotScheduleCardMessage: { scheduleId: Schema.String, message: ScheduleCard.Message },
  CompletedOpenUrl: {},
})
export type Message = typeof Message.Type
