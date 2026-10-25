import { Effect } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import type { SidebarThread } from "../../client/lib/thread-sections"
import { normalizeChatId } from "../../client/lib/utils"
import { AppAction } from "../app/action"
import type { AppModel } from "../app/slice"
import * as ChatInput from "../core/stores/chatInput"
import { sidebarThread } from "./chatReference"
import * as ChatCard from "../ui/chat-hover-card"
import { Message } from "./message"
import type { Model } from "./model"

// The chat tabs' hover card (ChatTabs' `renderHoverCard`, which ChatPage
// filled with SidebarChatHoverCard): the chat card (ui/chat-hover-card.ts,
// the sidebar's and the transcript's too), beneath the tab under the
// pointer. ListHoverCard's machinery for a bar of tabs: one card for the
// bar, the safe triangle, a press on a tab dismissing its card, and the tab
// pressed being held dismissed when the bar is rebuilt under the pointer
// (`holdRowUnderPointerOnMount`).

type H = HtmlBuilder<Message>

/** On the card's element, so the bar's tracker can find it. */
const TAB_CARD_ATTRIBUTE = "data-chat-tab-card"
/** What the rows (the tabs) carry their key in. */
const ROW_ATTRIBUTE = "data-chat-id"
/** The card or an action in it telling the bar's tracker what it did. */
const SYNC_EVENT = "kanna:chat-tab-card-sync"
const BAR_SELECTOR = "[role=tablist][aria-label='Open chats']"
/** Set on the tab the card is up for (styled with `group-data-[hover-card-open]/tabhost`). */
export const HOVER_CARD_OPEN_ATTRIBUTE = "hover-card-open"

/** Just clear of the tab; the default distance is a sidebar's edge. */
const SIDE_OFFSET = 6

function findBar() {
  return document.querySelector<HTMLElement>(BAR_SELECTOR)
}

// TRACKER

/**
 * ListHoverCard's effect on the bar (the tab list): which tab the card is on.
 * Installed by the bar's own Mount (`TabListMount`); returns its cleanup.
 */
export function trackTabCard(list: HTMLElement, emit: (message: typeof Message.ChangedTabCardRow.Type) => void): () => void {
  return ChatCard.trackHoverRows(list, {
    rowAttribute: ROW_ATTRIBUTE,
    findCard: () => document.querySelector<HTMLElement>(`[${TAB_CARD_ATTRIBUTE}]`),
    syncEvent: SYNC_EVENT,
    // Opening a chat in another project rebuilds this navbar, card and all.
    holdRowUnderPointerOnMount: true,
  }, (key) => emit(Message.ChangedTabCardRow({ key })))
}

// COMMANDS

/** An action in the card dismisses it first: each takes you somewhere. */
export const DismissTabCard = Command.define("DismissChatTabCard", {
  messages: [Message.CompletedSideEffect],
  execute: Effect.sync(() => {
    ChatCard.syncHoverTracker(findBar(), SYNC_EVENT, { action: "dismiss" })
    return Message.CompletedSideEffect()
  }),
})

// UPDATE

type TabCardCommand = Command.Command<Message, never, unknown>

export interface TabCardStep {
  model: Model
  commands: ReadonlyArray<TabCardCommand>
  action: AppAction | null
}

/** The other surfaces' card data, whose fetches serve this card too (React's caches were one). */
function sharedCardData(model: Model, app: AppModel): ReadonlyArray<ChatCard.CardData> {
  return [app.sidebar.card, model.transcript.chatCard]
}

/** The page's handling of the card's Messages (`SidebarChatCard`'s actions, ChatPage's tab card props). */
export function updateTabCard(model: Model, message: Message, app: AppModel): TabCardStep | null {
  switch (message._tag) {
    case "ChangedTabCardRow":
      return {
        model: modifyFields(model, {
          tabCard: (card) => ({
            hovered: message.key,
            // A card that leaves stops waiting on its answers.
            card: message.key === null ? ChatCard.closedCard(card.card) : card.card,
          }),
        }),
        commands: [],
        action: null,
      }
    case "GotTabCardMessage":
      return cardBodyMessage(model, message.message, app)
    default:
      return null
  }
}

function cardBodyMessage(model: Model, message: ChatCard.CardMessage, app: AppModel): TabCardStep {
  const step = ChatCard.updateCard(model.tabCard.card, message, sharedCardData(model, app))
  const next = step.data === model.tabCard.card ? model : modifyFields(model, { tabCard: (card) => ({ ...card, card: step.data }) })
  const own = Command.mapMessages(step.commands, (child: ChatCard.CardMessage) => Message.GotTabCardMessage({ message: child })) as ReadonlyArray<TabCardCommand>
  const intent = step.intent
  if (!intent) return { model: next, commands: own, action: null }
  const commands = [DismissTabCard(), ...own]
  switch (intent.kind) {
    // Opening a chat at one end of its last exchange.
    case "openAt":
      return { model: next, commands, action: AppAction.OpenChatAt({ chatId: intent.chatId, jump: intent.role }) }
    // The draft's action: the chat plainly, or an archived one by its own route.
    case "open":
      return {
        model: next,
        commands,
        action: intent.archived
          ? AppAction.OpenArchivedChat({ chatId: intent.chatId })
          : AppAction.Navigate({ path: `/chat/${intent.chatId}`, replace: false }),
      }
    case "setupGit":
      return { model: next, commands, action: AppAction.SetupGit({ chatId: intent.chatId }) }
    case "openFile":
      return { model: next, commands, action: AppAction.OpenExternalPath({ action: "open_editor", localPath: intent.localPath }) }
    case "dismiss":
      return { model: next, commands, action: null }
  }
}

/**
 * A sidebar push that changed the row the open card shows reruns the card's
 * fetch effects (React's ran on `row`); for the chat page's `observe`.
 */
export function refreshTabCard(model: Model, previousApp: AppModel, app: AppModel): { model: Model; commands: ReadonlyArray<TabCardCommand> } {
  const key = model.tabCard.hovered
  if (!key || !app.sidebar.hasFinePointer || previousApp.stores.sidebar.data === app.stores.sidebar.data) return { model, commands: [] }
  const chatId = app.stores.chatTabs.tabs.find((tab) => normalizeChatId(tab.chatId) === key)?.chatId
  if (!chatId) return { model, commands: [] }
  const row = sidebarThread(app, chatId)?.row
  if (!ChatCard.rowChanged(sidebarThread(previousApp, chatId)?.row, row)) return { model, commands: [] }
  const refreshed = ChatCard.refreshForRow(model.tabCard.card, row, sharedCardData(model, app))
  return {
    model: modifyFields(model, { tabCard: (card) => ({ ...card, card: refreshed.data }) }),
    commands: Command.mapMessages(refreshed.commands, (child: ChatCard.CardMessage) => Message.GotTabCardMessage({ message: child })) as ReadonlyArray<TabCardCommand>,
  }
}

// VIEW

/** Whether the card is up, and for which tab: on a tab whose chat the sidebar knows, with a fine pointer. */
export function openTabCardKey(model: Model, app: AppModel, threads: ReadonlyMap<string, SidebarThread>): string | null {
  const key = model.tabCard.hovered
  if (!key || !app.sidebar.hasFinePointer) return null
  return threadForKey(threads, key) ? key : null
}

function threadForKey(threads: ReadonlyMap<string, SidebarThread>, key: string): SidebarThread | undefined {
  for (const [chatId, thread] of threads) {
    if (normalizeChatId(chatId) === key) return thread
  }
  return undefined
}

/**
 * The card, as Radix's Popover.Content renders it in its portal: a popper
 * wrapper, then the `role="dialog"` surface with the bridge over the gap to
 * its tab. Nothing while no tab has it.
 */
export function tabHoverCardView(model: Model, app: AppModel, threads: ReadonlyMap<string, SidebarThread>, h: H): Html | null {
  const key = openTabCardKey(model, app, threads)
  const thread = key ? threadForKey(threads, key) : undefined
  if (!key || !thread) return null
  return h.submodel({
    slotId: "chat-tab-card-body",
    model: model.tabCard.card,
    view: ChatCard.HoverCard,
    viewInputs: {
      key: "chat-tab-hover-card",
      id: "radix-chat-tab-hover-card",
      markers: [[ChatCard.LIST_HOVER_CARD_ATTRIBUTE, ""], [TAB_CARD_ATTRIBUTE, ""]],
      rowKey: key,
      listSelector: BAR_SELECTOR,
      rowAttribute: ROW_ATTRIBUTE,
      syncEvent: SYNC_EVENT,
      side: "bottom",
      sideOffset: SIDE_OFFSET,
      thread,
      draft: ChatInput.chatDraft(app.stores.chatInput, thread.row.chatId) || null,
      nowMs: app.sidebar.nowMs,
      shared: sharedCardData(model, app),
    },
    toParentMessage: (message: ChatCard.CardMessage) => Message.GotTabCardMessage({ message }),
  })
}
