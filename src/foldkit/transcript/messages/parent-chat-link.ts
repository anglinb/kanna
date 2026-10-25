import type { Html, HtmlBuilder } from "foldkit/html"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { chatCard, chatReplyQuote } from "./chat-tool"
import type { RowContext } from "./context"
import type { Message } from "./model"
import { REPLY_QUOTE_WIDTH_CLASS } from "./sourced"

/**
 * ParentChatLink.tsx: the way back from a sub-chat to the chat it reports
 * to, for when no message on screen provides one. The viewport draws it as
 * the first item of whatever is loaded, unless `messageNamingParent` finds
 * the opening message that already quotes the parent.
 */

/**
 * The loaded message whose quote already names the parent: the chat's opening
 * message, when the parent's agent sent it and nothing older is still to
 * load. Null when there is none, which is when the link has to stand alone.
 */
export function messageNamingParent(
  messages: readonly HydratedTranscriptMessage[],
  parentChatId: string | null,
  hasOlderMessages: boolean,
): string | null {
  // With older messages still to load, the first prompt held is not the opening.
  if (!parentChatId || hasOlderMessages) return null
  const opening = messages.find((message) => message.kind === "user_prompt" && !message.hidden)
  if (opening?.kind !== "user_prompt") return null
  return opening.source?.kind === "agent" && opening.source.chatId === parentChatId ? opening.id : null
}

export function parentChatLink(parentChatId: string, context: RowContext, h: HtmlBuilder<Message>): Html {
  // A parent the sidebar has not listed yet is not a deleted one. Wait to be
  // told before saying so.
  if (!context.references?.sidebarReady) return null
  const parent = context.references.thread(parentChatId)
  return h.div([h.Class(REPLY_QUOTE_WIDTH_CLASS)], [
    parent
      ? chatReplyQuote({ chatId: parentChatId, title: "Parent chat", said: "Parent chat:" }, context, h)
      // One the sidebar no longer has was deleted, and a row with nothing
      // behind it would promise a way back that is not there.
      : chatCard({ chatId: null, title: "Parent chat", caption: "No longer available", quote: true }, context, h),
  ])
}
