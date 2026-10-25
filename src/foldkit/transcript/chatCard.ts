import { Effect, Option, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cn, generateUUID, normalizeChatId } from "../../client/lib/utils"
import type { AppModel } from "../app/slice"
import { chatOpenMenuEntries, renderChatOpenMenuItem, sidebarThread } from "../chat/chatReference"
import { chatRowMenuEntries, renderChatRowMenuItem, type ChatRowMenuContext } from "../chat/chatRowMenu"
import * as ChatInput from "../core/stores/chatInput"
import { editorLabel } from "../sidebar/derived"
import type { Message as SidebarMessage } from "../sidebar/message"
import { threadDetailLabel, threadRowContent } from "../sidebar/rows"
import * as ChatCard from "../ui/chat-hover-card"
import * as ContextMenu from "../ui/context-menu"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"
import type { LiveChatCard } from "./messages"
import { TOOL_CARD_CAPTION_CLASS, toolCardClasses } from "./messages/tool-card-classes"
import type { Model } from "./model"

// ChatCard's live form (components/messages/ChatToolMessage.tsx): a chat the
// sidebar knows, drawn as its row lifted out of the sidebar (the row's
// content, sidebar/rows.ts), under its right-click menu (ThreadRowMenu with
// the open-in items first). A click opens it as `useOpenChat` does. Beneath
// it on hover, the sidebar's chat card (SidebarChatHoverCard,
// ui/chat-hover-card.ts), whose actions open chats the same way.

type H = HtmlBuilder<Message>

export const cardMenuId = (chatId: string) => `transcript-chat-card-${chatId}`

// THE HOVER CARD

/** On a card's wrapper (the hover card's list): the id its tracker gave it. */
const CARD_HOVER_ATTRIBUTE = "data-chat-card-hover"
/** On the hover card's surface, with the same id, so the tracker can find it. */
const HOVER_CARD_ATTRIBUTE = "data-chat-card-hover-card"
const SYNC_EVENT = "kanna:chat-card-hover-sync"
/** What the card (the hover card's one row) carries its key in. */
const ROW_ATTRIBUTE = "data-chat-id"
/** Just clear of the card, as under a tab. */
const SIDE_OFFSET = 6

const listSelector = (instance: string) => `[${CARD_HOVER_ATTRIBUTE}="${instance}"]`

/**
 * On a live card's wrapper (ChatCard's `containerRef`): ListHoverCard's
 * tracking, with the card as its one row. Each card is its own list, named by
 * an id made here, since one chat can have two cards in a transcript.
 */
export const ChatCardHoverTracker = Mount.defineStream("TranscriptChatCardHoverTracker", {
  args: { chatId: Schema.String },
  messages: [Message.ChangedChatCardHover],
  execute: ({ element, chatId }) =>
    domStream<typeof Message.ChangedChatCardHover.Type>((emit) => {
      const instance = generateUUID()
      element.setAttribute(CARD_HOVER_ATTRIBUTE, instance)
      return ChatCard.trackHoverRows(element as HTMLElement, {
        rowAttribute: ROW_ATTRIBUTE,
        findCard: () => document.querySelector<HTMLElement>(`[${HOVER_CARD_ATTRIBUTE}="${instance}"]`),
        syncEvent: SYNC_EVENT,
      }, (key) => emit(Message.ChangedChatCardHover({ instance, chatId, key })))
    }),
})

/** An action in the hover card dismisses it first: each takes you somewhere. */
export const DismissChatCardHover = Command.define("DismissTranscriptChatCardHover", {
  args: { instance: Schema.String },
  messages: [Message.CompletedOpenUrl],
  execute: ({ instance }) => Effect.sync(() => {
    ChatCard.syncHoverTracker(document.querySelector(listSelector(instance)), SYNC_EVENT, { action: "dismiss" })
    return Message.CompletedOpenUrl()
  }),
})

/** The other surfaces' card data, whose fetches serve this card too (React's caches were one). */
export function sharedCardData(app: AppModel): ReadonlyArray<ChatCard.CardData> {
  return [app.sidebar.card, app.chatPage.tabCard.card]
}

/**
 * The hover card beneath the live card the pointer is on, if the sidebar
 * still knows its chat. Desktop only.
 */
export function chatCardHoverCard(model: Model, app: AppModel, nowMs: number, h: H): Html {
  const hover = model.chatCardHover
  if (!hover || !app.sidebar.hasFinePointer || normalizeChatId(hover.chatId) !== hover.key) return null
  const thread = sidebarThread(app, hover.chatId)
  if (!thread) return null
  return h.submodel({
    slotId: "chat-card-hover-card",
    model: model.chatCard,
    view: ChatCard.HoverCard,
    viewInputs: {
      key: `chat-card-hover-card-${hover.instance}`,
      id: `radix-chat-card-hover-card-${hover.instance}`,
      markers: [[ChatCard.LIST_HOVER_CARD_ATTRIBUTE, ""], [HOVER_CARD_ATTRIBUTE, hover.instance]],
      rowKey: hover.key,
      listSelector: listSelector(hover.instance),
      rowAttribute: ROW_ATTRIBUTE,
      syncEvent: SYNC_EVENT,
      side: "bottom",
      sideOffset: SIDE_OFFSET,
      thread,
      draft: ChatInput.chatDraft(app.stores.chatInput, thread.row.chatId) || null,
      nowMs,
      shared: sharedCardData(app),
    },
    toParentMessage: (message: ChatCard.CardMessage) => Message.GotChatCardMessage({ message }),
  })
}

export function cardMenuOf(model: Model, chatId: string): ContextMenu.Model {
  return model.cardMenus[chatId] ?? ContextMenu.init({ id: cardMenuId(chatId) })
}

/** The card's menu, as ThreadRowMenu got it from the chat page's reference actions. */
export function cardMenuContext(app: AppModel, chatId: string, thread: LiveChatCard["thread"]): ChatRowMenuContext {
  return {
    thread,
    archived: thread.archived,
    editorLabel: editorLabel(app),
    hasDraft: ChatInput.chatHasDraft(app.stores.chatInput, chatId),
    leadingItems: chatOpenMenuEntries(app, chatId),
  }
}

export function liveChatCard(model: Model, app: AppModel, card: LiveChatCard, nowMs: number, h: H): Html {
  const { chatId, thread, caption, quote, said } = card
  const classes = toolCardClasses(quote)
  const menu = cardMenuContext(app, chatId, thread)
  // The row's content has no handlers of its own: drawn with this builder.
  const sidebarH = h as unknown as HtmlBuilder<SidebarMessage>
  return h.div([h.Class(classes.width), h.OnMount(ChatCardHoverTracker({ chatId }))], [
    h.submodel({
      slotId: cardMenuId(chatId),
      model: cardMenuOf(model, chatId),
      view: ContextMenu.view,
      viewInputs: {
        items: chatRowMenuEntries(menu),
        renderItem: (value: string) => renderChatOpenMenuItem(value, app, h) ?? renderChatRowMenuItem(value, menu, h) ?? [],
        toView: ({ trigger, portal }: ContextMenu.RenderInfo) => h.div([
          ...trigger,
          h.Role("button"),
          h.Tabindex(0),
          // What the hover card finds the card under the pointer by.
          h.DataAttribute("chat-id", normalizeChatId(chatId)),
          h.OnClick(Message.ClickedChatCard({ chatId })),
          h.OnKeyDownSelfPreventDefault((key) => (key === "Enter" || key === " " ? Option.some(Message.ClickedChatCard({ chatId })) : Option.none())),
          h.Class(cn(
            classes.box,
            classes.lit,
            "cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "transition-[scale] duration-150 ease-snappy active:scale-[0.985] motion-reduce:transition-none motion-reduce:active:scale-100",
          )),
        ], [
          h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
            // Out of the layout, so the row's gap does not count it.
            said ? h.span([h.Class("sr-only")], [`${said} `]) : null,
            ...threadRowContent(thread, {
              showStatus: true,
              // A card is one chat someone pointed at: its title never recedes.
              dimIdleTitles: false,
              delegatorMark: false,
              detailLabel: threadDetailLabel(thread, "project-scoped", nowMs, sidebarH),
            }, sidebarH),
          ]),
          caption ? h.p([h.Class(TOOL_CARD_CAPTION_CLASS)], [caption]) : null,
          portal,
        ]),
      },
      toParentMessage: (message: ContextMenu.Message) => Message.GotCardMenuMessage({ chatId, message }),
    }),
  ])
}
