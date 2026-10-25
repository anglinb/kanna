import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../../client/lib/utils"
import type { SidebarThread } from "../../../client/lib/thread-sections"
import { toMessagePreview } from "../../../shared/message-preview"
import { CHAT_TOOL_NAMES } from "../../../shared/tools"
import { Loader2, MessageCircle } from "../../ui/icons"
import type { RowContext } from "./context"
import type { Message } from "./model"
import { RequestPayloadsOnMount } from "./mounts"
import { cardPayloadIds, resultRecord, text, TOOL_CARD_CAPTION_CLASS, TOOL_CARD_MARK_SLOT_CLASS, toolCardClasses, toolCardErrorText, toolCardPayload } from "./tool-card"
import type { ToolCall } from "./tool-call"

/**
 * ChatToolMessage.tsx: the card for a chat an agent started or messaged
 * (`create_chat`, `fork_chat`, `send_message`), where the tool call sits in
 * the transcript. Live, it is that chat's sidebar row (the host draws it:
 * `References.renderChatCard`); otherwise the card says what the call knows.
 */

export type ChatToolCall = Extract<ToolCall, { toolKind: "chat" | "unknown_tool" }>

/**
 * Whether a tool call is one this card draws. By kind, and by name for a call
 * recorded before the kind existed.
 */
export function isChatToolCall(message: ToolCall): message is ChatToolCall {
  return message.toolKind === "chat"
    || (message.toolKind === "unknown_tool" && CHAT_TOOL_NAMES.includes(message.toolName))
}

/** What the call did, in the words a person would use for doing it themselves. */
function describeCall(message: ChatToolCall, input: Record<string, unknown>, result: Record<string, unknown> | null): string {
  if (message.toolName === "fork_chat") return "Forked"
  if (message.toolName === "send_message") {
    if (input.delivery === "steer") return "Interrupted with"
    // Known only once the call returns: whether the message started a turn or
    // is waiting behind one.
    return result?.started === false ? "Queued" : "Sent"
  }
  return input.subchat === false ? "Started a chat" : "Started a sub-chat"
}

/** A new chat's id comes back in the result. A message names its chat going in. */
function chatToolTarget(message: ChatToolCall, input: Record<string, unknown>, result: Record<string, unknown> | null): string | null {
  return text(result?.chatId) ?? (message.toolName === "send_message" ? text(input.chatId) : null)
}

/** The chat a call reached, from the input and result the call carries inline. */
export function inlineChatToolTarget(message: ChatToolCall): string | null {
  if (message.isError) return null
  return chatToolTarget(message, message.input.payload ?? {}, resultRecord(message.rawResult))
}

/** What a call said to the chat it reached, as one line. */
export function inlineChatToolExcerpt(message: ChatToolCall): string | null {
  const sent = text(message.input.payload?.message)
  return sent ? toMessagePreview(sent) : null
}

export function chatToolMessage(message: ChatToolCall, context: RowContext, h: HtmlBuilder<Message>): Html {
  const { input, rawResult, result } = toolCardPayload(message, context)
  const chatId = chatToolTarget(message, input, result)
  const wanted = cardPayloadIds(message)
  const onMount = wanted.length > 0 ? [h.OnMount(RequestPayloadsOnMount({ entryIds: wanted }))] : []

  if (message.isError) {
    return h.p([h.Role("alert"), h.Class("text-sm text-destructive"), ...onMount], [toolCardErrorText(rawResult, "The chat could not be reached.")])
  }

  const sent = text(input.message)
  return chatCard({
    chatId,
    title: text(result?.title) ?? text(input.title) ?? (sent ? toMessagePreview(sent) : "Chat"),
    caption: [describeCall(message, input, result), sent ? toMessagePreview(sent) : null].filter(Boolean).join(" · "),
    pending: !message.resultEntryId,
    onMount,
  }, context, h)
}

/** What a quote says of a reply its chat sent while still working. */
export const INTERIM_REPLY_NOTE = "Not final"

/**
 * The line under a quoted chat's title, or null when the title is all there
 * is to say: another project, archived, not final, then what it was told.
 */
export function replyCaption(
  thread: (Pick<SidebarThread, "archived" | "projectId"> & { projectLabel: Pick<SidebarThread["projectLabel"], "text"> }) | null,
  currentProjectId: string | null,
  excerpt?: string | null,
  interim = false,
): string | null {
  const parts: string[] = []
  if (thread && currentProjectId && thread.projectId !== currentProjectId) parts.push(thread.projectLabel.text)
  if (thread?.archived) parts.push("Archived")
  if (interim) parts.push(INTERIM_REPLY_NOTE)
  if (excerpt) parts.push(excerpt)
  return parts.length > 0 ? parts.join(" · ") : null
}

/** A chat's row as the quote over a message (ChatReplyQuote). */
export function chatReplyQuote(
  options: { chatId: string | null; title: string; excerpt?: string | null; interim?: boolean; said?: string },
  context: RowContext,
  h: HtmlBuilder<Message>,
): Html {
  const thread = context.references?.thread(options.chatId) ?? null
  const currentProjectId = context.references?.currentProjectId ?? null
  return chatCard({
    chatId: options.chatId,
    title: options.title,
    caption: replyCaption(thread, currentProjectId, options.excerpt, options.interim ?? false),
    said: options.said ?? "Message from",
    quote: true,
  }, context, h)
}

/** The card itself, for a chat known only by its id (ChatCard). */
export function chatCard(
  options: {
    chatId: string | null
    /** What to call the chat while the sidebar cannot say. */
    title: string
    caption?: string | null
    /** The call that makes the chat has not returned. */
    pending?: boolean
    quote?: boolean
    /** Read out ahead of the title and not drawn. */
    said?: string
    onMount?: ReadonlyArray<import("foldkit/html").Attribute<Message>>
  },
  context: RowContext,
  h: HtmlBuilder<Message>,
): Html {
  const { chatId, title, caption, pending = false, quote = false, said } = options
  const references = context.references
  const thread = references?.thread(chatId) ?? null
  const classes = toolCardClasses(quote)

  if (thread && references?.canOpenChats && references.renderChatCard && chatId) {
    return references.renderChatCard({ chatId, thread, caption: caption ?? null, quote, said })
  }

  // Before the call returns there is no chat to show yet, and after it one
  // the sidebar has not heard of. Both draw the same card with what the call
  // itself knows, and nothing to open.
  return h.div([h.Class(cn(classes.box, classes.width)), ...(options.onMount ?? [])], [
    h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
      // Out of the layout, so the row's gap does not count it.
      said ? h.span([h.Class("sr-only")], [`${said} `]) : null,
      pending
        ? h.span([h.Class(TOOL_CARD_MARK_SLOT_CLASS)], [Loader2({ class: "size-3.5 animate-spin text-logo" }, h)])
        : MessageCircle({ class: "size-4 shrink-0 text-muted-foreground" }, h),
      h.span([h.Class(cn("min-w-0 truncate", !pending && "text-muted-foreground"))], [title]),
    ]),
    caption ? h.p([h.Class(TOOL_CARD_CAPTION_CLASS)], [caption]) : null,
  ])
}
