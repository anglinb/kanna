import { Schema } from "effect"
import type { OpenLocalLinkTarget } from "../../client/components/messages/shared"
import type { ChatJumpTarget } from "../../client/lib/chat-navigation"
import { opaque } from "../core/schema"
import * as ChatCard from "../ui/chat-hover-card"
import * as ContextMenu from "../ui/context-menu"
import * as Messages from "./messages/model"
import * as ScheduleCard from "../widgets/scheduleCard"

// The transcript viewport's Model: what ChatTranscriptViewport and the
// minimap kept in state (and, for the scroll-to-bottom button, what ChatPage
// kept for it), plus the rows' own state (messages/). The scroll position's
// bookkeeping (React's refs) is the viewport controller's (viewport.ts).

export const LINK_MENU_ID = "transcript-local-link"

export const Model = Schema.Struct({
  /** Every row's own state (messages/). Per chat: reset when another chat's viewport mounts. */
  messages: Messages.Model,
  /** The chat the per-chat state belongs to. */
  chatId: Schema.NullOr(Schema.String),

  /** ChatPage's `isAtEndRef`, and the scroll-to-bottom button it drives (shown 150ms after leaving the end). */
  isAtEnd: Schema.Boolean,
  showScrollToBottom: Schema.Boolean,
  scrollButtonToken: Schema.Number,

  /** Whether the list can scroll at all, and the scroll pane's width: the minimap's room. */
  overflows: Schema.Boolean,
  viewportWidth: Schema.Number,
  /** Which rows are on screen, as indices into the rows. */
  visibleRange: Schema.NullOr(Schema.Struct({ start: Schema.Number, end: Schema.Number })),

  /**
   * The row a jump last landed on, lit briefly (`flashRowId`): raised a frame
   * after it lands (so a second jump to the same row replays it), cleared
   * once it has played.
   */
  flash: Schema.NullOr(Schema.Struct({ rowId: Schema.String, token: Schema.Number, raised: Schema.Boolean })),
  flashTokens: Schema.Number,

  /** The jump this chat last spent: a later answer from the server may land on it again. */
  lastJump: Schema.NullOr(Schema.Struct({ requestId: Schema.Number, target: opaque<ChatJumpTarget>("ChatJumpTarget") })),
  /** A minimap jump to a turn before the window, until its row is loaded (`pendingUnloadedJumpRef`). */
  unloadedJump: Schema.NullOr(Schema.Struct({ messageId: Schema.String, seq: Schema.Number })),
  unloadedSeq: Schema.Number,

  minimap: Schema.Struct({
    height: Schema.Number,
    pointerY: Schema.NullOr(Schema.Number),
    heldTurnId: Schema.NullOr(Schema.String),
    finePointer: Schema.Boolean,
  }),

  /** A local link's right-click menu (OpenExternalContextMenuContent at the pointer). */
  linkMenu: ContextMenu.Model,
  linkMenuTarget: Schema.NullOr(opaque<OpenLocalLinkTarget>("OpenLocalLinkTarget")),
  /** Live chat cards' right-click menus (ThreadRowMenu), by chat; made on first use. */
  cardMenus: Schema.Record(Schema.String, ContextMenu.Model),
  /** Live schedule cards (the Schedules widget's row, menu and hover card), by schedule; made on first use. */
  scheduleCards: Schema.Record(Schema.String, ScheduleCard.Model),
  /**
   * The live chat card whose hover card is up (SidebarChatHoverCard beneath
   * it): which card, by the id its tracker gave it, and the chat it is on.
   */
  chatCardHover: Schema.NullOr(Schema.Struct({ instance: Schema.String, chatId: Schema.String, key: Schema.String })),
  /** That hover card's fetches and what it holds (ui/chat-hover-card.ts). */
  chatCard: ChatCard.CardData,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    messages: Messages.init(),
    chatId: null,
    isAtEnd: true,
    showScrollToBottom: false,
    scrollButtonToken: 0,
    overflows: false,
    viewportWidth: 0,
    visibleRange: null,
    flash: null,
    flashTokens: 0,
    lastJump: null,
    unloadedJump: null,
    unloadedSeq: 0,
    minimap: { height: 0, pointerY: null, heldTurnId: null, finePointer: false },
    linkMenu: ContextMenu.init({ id: LINK_MENU_ID }),
    linkMenuTarget: null,
    cardMenus: {},
    scheduleCards: {},
    chatCardHover: null,
    chatCard: ChatCard.initCardData(),
  }
}
