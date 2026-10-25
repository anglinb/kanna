import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../../client/lib/utils"
import { stripSystemMessages } from "../../../shared/message-preview"
import { ADOPTED_REPORT_STATUS, reportOutcome, splitReportSections, type ReportSection } from "../../../shared/report-sections"
import type { ChatAttachment, MessageSource } from "../../../shared/types"
import type { Child } from "../../ui/attributes"
import { CalendarClock, CornerUpRight, MessageCircle, Split, X } from "../../ui/icons"
import { userMessageAttachments } from "./attachments"
import { chatReplyQuote } from "./chat-tool"
import { CLAMP_LINES, clampedMessageText, foldSurfaceAttributes } from "./clamped"
import type { RowContext } from "./context"
import { keys, Message } from "./model"
import { formatScheduleTrigger, scheduleCardBox } from "./schedule-tool"
import { QUOTE_MARK_CENTER_PX, TOOL_QUOTE_CLASS } from "./tool-card"
import { USER_BUBBLE_CLASS } from "./user"

/**
 * SourcedMessage.tsx: a message that reached the chat as a prompt without
 * the user typing it (a sub-chat's report, another chat's agent, a
 * schedule). The bubble of a prompt on the agent's side of the column, with
 * a quote of where it came from over it; a report draws a line per sub-chat.
 */

/** What a sourced message shows, one part per bubble, or for a report one part per line. */
export function sourcedSections(content: string, source: MessageSource): ReportSection[] {
  if (source.kind !== "report") {
    const body = stripSystemMessages(content)
    return body ? [{ chatId: null, body, status: null }] : []
  }
  const only = source.chatIds.length === 1 ? source.chatIds[0]! : null
  return splitReportSections(content, source.chatIds).map((section) => ({ ...section, chatId: section.chatId ?? only }))
}

/** Where a message came from, as a quote over its bubble. */
export function sourceQuote(source: MessageSource, chatId: string | null, context: RowContext, h: HtmlBuilder<Message>): Html {
  const schedules = context.references?.schedules ?? null
  if (source.kind === "schedule") {
    const schedule = schedules?.schedules.find((candidate) => candidate.id === source.scheduleId)
    if (schedule && schedules) {
      // No preview of the schedule's message, as its own card has: the
      // message is what the bubble is showing.
      return scheduleCardBox({ schedule, caption: `Automation · ${formatScheduleTrigger(schedule.trigger)}`, quote: true }, context, h)
    }
    return h.div([h.Class(TOOL_QUOTE_CLASS)], [
      h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
        CalendarClock({ class: "size-4 shrink-0 text-muted-foreground" }, h),
        h.span([h.Class("min-w-0 truncate text-muted-foreground")], ["Automation"]),
      ]),
    ])
  }
  if (source.kind === "agent") return chatReplyQuote({ chatId: source.chatId, title: "Another agent" }, context, h)
  // A report draws its own line (`reportMarker`), not a quote.
  return chatReplyQuote({ chatId, title: chatId ? "Sub-chat" : "Sub-chats" }, context, h)
}

/** A chat's name in a sentence, opening the chat where there is one to open. */
function chatName(chatId: string | null | undefined, fallback: string, context: RowContext, h: HtmlBuilder<Message>): Html {
  const thread = context.references?.thread(chatId) ?? null
  if (!thread || !context.references?.canOpenChats || !chatId) return h.span([], [thread?.title ?? fallback])
  return h.button([
    h.Type("button"),
    h.OnClick(Message.ClickedChatLink({ chatId })),
    h.Class("cursor-pointer rounded-sm font-medium text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"),
  ], [thread.title])
}

/** The news that a sub-chat this chat was waiting on now reports to another. */
export function adoptionNotice(section: ReportSection, context: RowContext, h: HtmlBuilder<Message>): Html {
  return h.p([h.Class("not-prose flex min-w-0 items-start gap-2 text-sm leading-5 text-muted-foreground")], [
    Split({ class: "mt-0.5 size-4 shrink-0", attributes: [h.AriaHidden(true)] }, h),
    h.span([h.Class("min-w-0")], [
      chatName(section.chatId, "A sub-chat", context, h),
      " was adopted by ",
      chatName(section.adoptedByChatId, "another chat", context, h),
      ". Its result will not arrive here.",
    ]),
  ])
}

export function isAdoptionNotice(section: ReportSection) {
  return section.status === ADOPTED_REPORT_STATUS && !section.body
}

/** A quote's own width: what it says, to a limit that keeps a long excerpt from widening the message. */
export const REPLY_QUOTE_WIDTH_CLASS = "min-w-0 max-w-96"

/** The line between a quote and its bubble, in px. */
export const REPLY_LINE = { widthPx: 3, heightPx: 14, clearPx: 3 } as const
/** Where the line starts, from the quote's left edge: under the middle of the quote's leading mark. */
export const REPLY_LINE_LEFT_PX = QUOTE_MARK_CENTER_PX - REPLY_LINE.widthPx / 2

/** A quote over the bubble it belongs to, with a short line joining them. */
export function replyQuoteRow(quote: Child, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex min-w-0 max-w-full flex-col items-start")], [
    h.div([h.Class(REPLY_QUOTE_WIDTH_CLASS)], [quote]),
    h.span([h.AriaHidden(true), h.Class("my-[3px] h-[14px] w-[3px] rounded-full bg-border"), h.Style({ "margin-left": `${REPLY_LINE_LEFT_PX}px` })], []),
  ])
}

/**
 * One sub-chat's part of a report, as its parent draws it: a line in the
 * look of a tool call's row, naming the chat and what happened. A click
 * opens the sub-chat.
 */
export function reportMarker(section: ReportSection, options: { outcome?: string; flash?: boolean }, context: RowContext, h: HtmlBuilder<Message>): Html {
  const thread = context.references?.thread(section.chatId) ?? null
  const chatId = section.chatId
  const failed = section.status === "failed"
  const label = `${thread?.title || "A sub-chat"} ${options.outcome ?? reportOutcome(section.status)}`
  const content = h.span([h.Class("grid min-w-0 grid-cols-[auto_1fr] items-center gap-1.5")], [
    // A tool row's mark slot, mark and words (ToolCallMessage).
    h.span([h.Class("relative flex h-5 w-5 items-center justify-center")], [
      failed
        ? X({ class: "size-4 text-destructive", attributes: [h.AriaHidden(true)] }, h)
        : MessageCircle({ class: "size-4 text-muted-icon", attributes: [h.AriaHidden(true)] }, h),
    ]),
    h.span([h.Class("h-5 min-w-0 truncate text-left font-medium text-foreground/80")], [label]),
  ])
  const rowClass = cn("not-prose flex min-w-0 max-w-full rounded-md text-sm", options.flash && "kanna-jump-flash")
  if (!thread || !context.references?.canOpenChats || !chatId) return h.div([h.Class(rowClass)], [content])
  return h.button([
    h.Type("button"),
    h.OnClick(Message.ClickedChatLink({ chatId })),
    h.Class(cn(rowClass, "cursor-pointer outline-none transition-opacity hover:opacity-60 focus-visible:ring-2 focus-visible:ring-ring")),
  ], [content])
}

/** One part of a delivered message: its quote, the line, and its bubble. */
function sourcedPart(id: string, index: number, section: ReportSection, source: MessageSource, steered: boolean, flash: boolean, context: RowContext, h: HtmlBuilder<Message>): Html {
  const clampKey = keys.clamp(id, index)
  return h.div([h.Class("flex min-w-0 max-w-[85%] flex-col items-start sm:max-w-[80%]")], [
    replyQuoteRow(sourceQuote(source, section.chatId, context, h), h),
    h.div([h.Class("flex min-w-0 max-w-full items-center gap-2")], [
      h.div([
        ...foldSurfaceAttributes(clampKey, context, h),
        h.Class(cn(USER_BUBBLE_CLASS, "px-3.5 py-1.5", flash && "kanna-jump-flash")),
      ], clampedMessageText(section.body, clampKey, CLAMP_LINES.sent, "part", context, h)),
      // After the bubble and turned around, where a typed prompt has it before.
      steered
        ? h.span([h.AriaLabel("Sent mid-turn"), h.Role("img"), h.Title("Sent mid-turn"), h.Class("shrink-0 text-muted-foreground")], [
          CornerUpRight({ class: "h-4 w-4" }, h),
        ])
        : null,
    ]),
  ])
}

export function sourcedMessage(
  message: { id: string; content: string; source: MessageSource; attachments?: ChatAttachment[]; steered?: boolean },
  options: { flash?: boolean },
  context: RowContext,
  h: HtmlBuilder<Message>,
): Html {
  const { source } = message
  const attachments = message.attachments ?? []
  const sections = sourcedSections(message.content, source)
  const flash = options.flash ?? false

  if (source.kind === "report") {
    return h.div([h.Class("flex flex-col items-start gap-2")], [
      ...userMessageAttachments(attachments, "start", context, h),
      ...sections.map((section) => isAdoptionNotice(section)
        // 2px in, so its 16px mark is centred where a line's 20px slot centres its own.
        ? h.div([h.Class("max-w-[85%] pl-0.5 sm:max-w-[80%]")], [adoptionNotice(section, context, h)])
        : reportMarker(section, { flash }, context, h)),
    ])
  }

  return h.div([h.Class("flex flex-col items-start gap-2")], [
    ...userMessageAttachments(attachments, "start", context, h),
    ...sections.map((section, index) => sourcedPart(message.id, index, section, source, Boolean(message.steered) && index === 0, flash, context, h)),
  ])
}
