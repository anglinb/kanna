import type { Html, HtmlBuilder } from "foldkit/html"
import { drawnMessageSource } from "../../../client/lib/message-source"
import { cn } from "../../../client/lib/utils"
import { stripSystemMessages } from "../../../shared/message-preview"
import type { ReportSection } from "../../../shared/report-sections"
import { PROVIDERS, type AgentProvider, type MessageSource, type QueuedChatMessage } from "../../../shared/types"
import { buttonClass } from "../../ui/button"
import { ArrowUp, X } from "../../ui/icons"
import { userMessageAttachments } from "./attachments"
import { CLAMP_LINES, clampedMessageText, foldSurfaceAttributes } from "./clamped"
import type { RowContext } from "./context"
import { keys, Message } from "./model"
import { formatUntil } from "./schedule-tool"
import { adoptionNotice, isAdoptionNotice, replyQuoteRow, reportMarker, sourceQuote, sourcedSections } from "./sourced"

/**
 * QueuedUserMessage.tsx: a message waiting for the turn to end, in the
 * dashed outline of something still waiting, with Send now and Remove. A
 * press dims the row until the transcript says its command settled
 * (`settledQueued`); the presses are `RequestedQueueAction` OutMessages.
 */

/** The dashed outline that says a message is waiting, on either side of the column. */
const QUEUED_BUBBLE_CLASS = "rounded-2xl border border-dashed border-border bg-transparent prose prose-sm prose-invert text-left text-primary"

/** What both controls share. */
const QUEUED_CONTROL_CLASS = "transition-[color,background-color,scale] duration-150 ease-snappy active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100"

export function sendNowButton(onSendNow: Message, disabled: boolean, h: HtmlBuilder<Message>, label = "Send now"): Html {
  return h.button([
    h.Type("button"),
    h.AriaLabel(label),
    ...(disabled ? [h.Disabled(true)] : []),
    h.Class(buttonClass({
      variant: "default",
      size: "none",
      class: cn(
        QUEUED_CONTROL_CLASS,
        // The circle is 24px. The `before` layer takes the press.
        "relative shrink-0 rounded-full size-[24px] bg-muted text-muted-foreground border border-primary/10 group-hover:!text-primary hover:bg-muted/60 before:absolute before:-inset-1 before:rounded-full before:content-['']",
      ),
    })),
    h.OnClick(onSendNow),
  ], [ArrowUp({ class: "size-3.5" }, h)])
}

/** Takes the message out of the queue. On the bubble's corner that faces the middle of the column. */
export function removeButton(corner: "start" | "end", onRemove: Message, disabled: boolean, h: HtmlBuilder<Message>, label = "Remove from queue"): Html {
  return h.button([
    h.Type("button"),
    h.AriaLabel(label),
    ...(disabled ? [h.Disabled(true)] : []),
    h.Class(buttonClass({
      variant: "none",
      size: "none",
      class: cn(
        QUEUED_CONTROL_CLASS,
        // The circle is 18px. The `before` layer is what takes the press.
        "!p-0.5 border rounded-full text-xs font-medium text-muted-foreground hover:text-foreground gap-0.5 absolute top-0 bg-surface -translate-y-[28%] before:absolute before:-inset-1.5 before:rounded-full before:content-['']",
        corner === "start" ? "left-0 -translate-x-[28%]" : "right-0 translate-x-[28%]",
      ),
    })),
    h.OnClick(onRemove),
  ], [X({ class: "size-3" }, h)])
}

/** Dims while a press is being carried out. */
const QUEUED_ROW_CLASS = "flex flex-col gap-2 py-2 transition-opacity duration-150 ease-out motion-reduce:transition-none"

export function queuedUserMessage(message: QueuedChatMessage, context: RowContext, h: HtmlBuilder<Message>): Html {
  const busy = Boolean(context.model.busy[`queued:${message.id}`])
  const remove = Message.ClickedQueued({ messageId: message.id, action: "remove" })
  const sendNow = Message.ClickedQueued({ messageId: message.id, action: "send-now" })
  // A sender this client does not draw waits as the user's own.
  const source = drawnMessageSource(message.source)
  if (source?.kind === "report") return queuedReport(message, source, busy, remove, sendNow, context, h)
  return source
    ? queuedSourcedMessage(message, source, busy, remove, sendNow, context, h)
    : queuedTypedMessage(message, busy, remove, sendNow, context, h)
}

function queuedTypedMessage(message: QueuedChatMessage, busy: boolean, remove: Message, sendNow: Message, context: RowContext, h: HtmlBuilder<Message>): Html {
  // What the sent message will show: without the parts meant for the agent.
  const content = stripSystemMessages(message.content)
  const clampKey = keys.clamp(`queued:${message.id}`)
  return h.div([h.Class(cn(QUEUED_ROW_CLASS, "items-end", busy && "opacity-60"))], [
    ...userMessageAttachments(message.attachments, "end", context, h),
    h.div([h.Class("flex max-w-[85%] sm:max-w-[80%] flex-col items-end")], [
      // Rendered even for an attachment-only message: the bubble carries Send now and Remove.
      h.div([h.Class("relative group")], [
        h.div([
          ...foldSurfaceAttributes(clampKey, context, h),
          h.Class(cn(QUEUED_BUBBLE_CLASS, "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2.5 pl-3.5 pr-1.5 py-1.5")),
        ], [
          h.div([h.Class("min-w-0")], content
            ? clampedMessageText(content, clampKey, CLAMP_LINES.typed, "clip", context, h)
            : [h.p([h.Class("text-muted-foreground")], ["Queued"])]),
          sendNowButton(sendNow, busy, h),
        ]),
        removeButton("start", remove, busy, h),
      ]),
    ]),
  ])
}

/** A sub-chat's report that arrived mid-turn: a line per sub-chat in the dashed outline. */
function queuedReport(message: QueuedChatMessage, source: Extract<MessageSource, { kind: "report" }>, busy: boolean, remove: Message, sendNow: Message, context: RowContext, h: HtmlBuilder<Message>): Html {
  const sections = sourcedSections(message.content, source)
  // Nothing to read: still needs its controls, and still says who it is from.
  const silent = sections.length === 0
  const lines: ReportSection[] = silent
    ? (source.chatIds.length > 0 ? source.chatIds : [null]).map((chatId) => ({ chatId, body: "", status: null }))
    : sections
  return h.div([h.Class(cn(QUEUED_ROW_CLASS, "items-start", busy && "opacity-60"))], [
    ...userMessageAttachments(message.attachments, "start", context, h),
    h.div([h.Class("relative group min-w-0 max-w-[85%] sm:max-w-[80%]")], [
      h.div([h.Class("grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 rounded-xl border border-dashed border-border py-1.5 pl-1.5 pr-3.5")], [
        sendNowButton(sendNow, busy, h),
        h.div([h.Class("flex min-w-0 flex-col items-start gap-1")], lines.map((section) => isAdoptionNotice(section)
          ? adoptionNotice(section, context, h)
          : reportMarker(section, silent ? { outcome: "reported" } : {}, context, h))),
      ]),
      removeButton("end", remove, busy, h),
    ]),
  ])
}

/** An automation's or another chat's message that arrived mid-turn, as it will be once delivered, waiting. */
function queuedSourcedMessage(message: QueuedChatMessage, source: MessageSource, busy: boolean, remove: Message, sendNow: Message, context: RowContext, h: HtmlBuilder<Message>): Html {
  const body = sourcedSections(message.content, source)[0]?.body ?? ""
  const clampKey = keys.clamp(`queued:${message.id}`)
  return h.div([h.Class(cn(QUEUED_ROW_CLASS, "items-start", busy && "opacity-60"))], [
    ...userMessageAttachments(message.attachments, "start", context, h),
    h.div([h.Class("flex min-w-0 max-w-[85%] flex-col items-start sm:max-w-[80%]")], [
      replyQuoteRow(sourceQuote(source, null, context, h), h),
      h.div([h.Class("relative group min-w-0 max-w-full")], [
        h.div([
          ...foldSurfaceAttributes(clampKey, context, h),
          h.Class(cn(QUEUED_BUBBLE_CLASS, "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-end gap-2.5 py-1.5 pl-1.5 pr-3.5")),
        ], [
          sendNowButton(sendNow, busy, h),
          h.div([h.Class("min-w-0")], body
            ? clampedMessageText(body, clampKey, CLAMP_LINES.sent, "clip", context, h)
            : [h.p([h.Class("text-muted-foreground")], ["Queued"])]),
        ]),
        removeButton("end", remove, busy, h),
      ]),
    ]),
  ])
}

// ── UsageLimitResumeRow ──────────────────────────────────────────────────

/** "3:05 PM", or "Tue 3:05 PM" when it is not today. */
function formatResumeTime(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
}

/**
 * The "carry on" Kanna sends when a usage limit resets, waiting like a queued
 * message (UsageLimitResumeRow.tsx). `key` names it for its busy state
 * (`settledResume`); presses are `RequestedResumeAction`.
 */
export function usageLimitResumeRow(resume: { at: number; provider: AgentProvider }, key: string, context: RowContext, h: HtmlBuilder<Message>): Html {
  const busy = Boolean(context.model.busy[key])
  const provider = PROVIDERS.find((candidate) => candidate.id === resume.provider)?.label ?? resume.provider
  return h.div([h.Class(cn("flex flex-col items-start gap-2 py-2 transition-opacity duration-150 ease-out motion-reduce:transition-none", busy && "opacity-60"))], [
    h.div([h.Class("relative group min-w-0 max-w-[85%] sm:max-w-[80%]")], [
      h.div([h.Class("grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 rounded-2xl border border-dashed border-border py-1.5 pl-1.5 pr-3.5 text-sm")], [
        sendNowButton(Message.ClickedResume({ key, action: "now" }), busy, h, "Continue now"),
        h.div([h.Class("min-w-0")], [
          h.p([h.Class("text-primary")], [`Continues when ${provider} usage resets`]),
          h.p([h.Class("text-[12px] text-muted-foreground tabular-nums")], [`${formatResumeTime(resume.at, context.now)} · ${formatUntil(resume.at, context.now)}`]),
        ]),
      ]),
      removeButton("end", Message.ClickedResume({ key, action: "cancel" }), busy, h, "Don't continue automatically"),
    ]),
  ])
}
