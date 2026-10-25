import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cn, normalizeChatId } from "../../client/lib/utils"
import type { AppModel } from "../app/slice"
import { chatOpenMenuEntries, renderChatOpenMenuItem } from "../chat/chatReference"
import { chatRowMenuEntries, renderChatRowMenuItem, type ChatRowMenuContext } from "../chat/chatRowMenu"
import * as ChatInput from "../core/stores/chatInput"
import { editorLabel } from "../sidebar/derived"
import type { Message as SidebarMessage } from "../sidebar/message"
import { threadDetailLabel, threadRowContent } from "../sidebar/rows"
import * as ContextMenu from "../ui/context-menu"
import { Message } from "./message"
import type { LiveChatCard } from "./messages"
import { TOOL_CARD_CAPTION_CLASS, toolCardClasses } from "./messages/tool-card-classes"
import type { Model } from "./model"

// ChatCard's live form (components/messages/ChatToolMessage.tsx): a chat the
// sidebar knows, drawn as its row lifted out of the sidebar (the row's
// content, sidebar/rows.ts), under its right-click menu (ThreadRowMenu with
// the open-in items first). A click opens it as `useOpenChat` does. The
// sidebar's hover card over it is not drawn here yet (see the slice report).

type H = HtmlBuilder<Message>

export const cardMenuId = (chatId: string) => `transcript-chat-card-${chatId}`

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
  return h.div([h.Class(classes.width)], [
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
