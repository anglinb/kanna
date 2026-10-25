import type { Html, HtmlBuilder } from "foldkit/html"
import { waitingOnLabel } from "../../../client/lib/waiting-on"
import { cn } from "../../../client/lib/utils"
import type { HydratedTranscriptMessage, MessageSource, WaitingOn } from "../../../shared/types"
import { animatedShinyText } from "../../ui/animated-shiny-text"
import { Check, Circle, CircleSlash, ListChecks, Loader2, Minimize, UserRound, X } from "../../ui/icons"
import { transcriptMarkdownChildren, type RowContext } from "./context"
import { keys, Message } from "./model"
import { expandableRow, metaContent, metaLabel, metaRow, verticalLineContainer } from "./shared"

/**
 * The rows with little or no state of their own: an agent's text
 * (TextMessage), Interrupted, raw JSON, the account row, the compaction
 * markers and summary, a status, the turn's processing and draining lines,
 * the time boundary and a failed result (ResultMessage), and the todo list
 * (TodoWriteMessage).
 */

type Of<K extends HydratedTranscriptMessage["kind"]> = Extract<HydratedTranscriptMessage, { kind: K }>

// ── TextMessage ──────────────────────────────────────────────────────────

/** An agent's words, as the transcript draws them: full-width markdown, no avatar and no name. */
export function assistantText(text: string, key: string, context: RowContext, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4")], transcriptMarkdownChildren(text, key, context, h))
}

export function textMessage(message: Of<"assistant_text">, context: RowContext, h: HtmlBuilder<Message>): Html {
  return assistantText(message.text, message.id, context, h)
}

// ── InterruptedMessage ───────────────────────────────────────────────────

export function interruptedMessage(h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex items-center justify-end gap-2 text-sm text-muted-foreground")], [
    h.div([h.Class("inline-flex gap-1.5 items-center justify-center whitespace-nowrap text-sm font-medium bg-surface text-foreground/60 border border-border h-9 pl-1 pr-4 rounded-full")], [
      CircleSlash({ class: "h-4 w-4 ml-1.5" }, h),
      h.em([], ["Interrupted"]),
    ]),
  ])
}

// ── RawJsonMessage ───────────────────────────────────────────────────────

export function rawJsonMessage(json: string, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex gap-3 justify-start")], [
    h.div([h.Class("flex-1 max-w-[90%]")], [
      h.pre([h.Class("text-xs font-mono whitespace-pre-wrap break-words bg-muted rounded-lg p-3 overflow-auto max-h-96")], [json]),
    ]),
  ])
}

// ── AccountInfoMessage ───────────────────────────────────────────────────

export function accountInfoMessage(message: Of<"account_info">, context: RowContext, h: HtmlBuilder<Message>): Html {
  return metaRow({ class: "hidden" }, [
    expandableRow(keys.account(message.id), context, [
      h.div([h.Class("size-5 flex justify-center items-center ")], [UserRound({ class: "h-4 w-4 text-muted-foreground" }, h)]),
      metaLabel(undefined, ["Account"], h),
    ], () => verticalLineContainer("my-4 text-xs", [
      h.pre([h.Class("font-mono whitespace-pre-wrap break-all bg-muted border border-border rounded-lg p-2 max-h-64 overflow-auto")], [JSON.stringify(message.accountInfo, null, 2)]),
    ], h), h),
  ], h)
}

// ── CompactBoundaryMessage ───────────────────────────────────────────────

function zigZagLine(h: HtmlBuilder<Message>, size = 4): Html {
  return h.svg([h.Class("flex-1"), h.Attribute("viewBox", `0 0 100 ${size}`), h.Attribute("preserveAspectRatio", "none"), h.Style({ height: `${size}px` })], [
    h.pattern([h.Id("zigzag"), h.Attribute("width", String(size)), h.Attribute("height", String(size)), h.Attribute("patternUnits", "userSpaceOnUse")], [
      h.path([
        h.Attribute("d", `M0 ${size} L${size / 2} 0 L${size} ${size}`),
        h.Attribute("fill", "none"),
        h.Attribute("stroke", "currentColor"),
        h.Attribute("stroke-width", "0.5"),
        h.Class("text-muted-foreground/30"),
        h.Style({ stroke: "currentColor" }),
      ]),
    ]),
    h.rect([h.Attribute("width", "100%"), h.Attribute("height", String(size)), h.Attribute("fill", "url(#zigzag)"), h.Class("text-muted-foreground/30")]),
  ])
}

function boundary(label: string, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex items-center gap-3")], [
    zigZagLine(h),
    h.span([h.Class("text-[11px] tracking-widest text-muted-foreground uppercase flex-shrink-0")], [label]),
    zigZagLine(h),
  ])
}

export function compactBoundaryMessage(h: HtmlBuilder<Message>): Html {
  return boundary("Compacted", h)
}

export function contextClearedMessage(h: HtmlBuilder<Message>): Html {
  return boundary("Context Cleared", h)
}

// ── CompactSummaryMessage ────────────────────────────────────────────────

export function compactSummaryMessage(message: Of<"compact_summary">, context: RowContext, h: HtmlBuilder<Message>): Html {
  return metaRow({}, [
    expandableRow(keys.compactSummary(message.id), context, [
      h.div([h.Class("w-5 h-5 relative flex items-center justify-center")], [Minimize({ class: "h-4.5 w-4.5 text-muted-foreground" }, h)]),
      metaLabel(undefined, ["Summarized"], h),
    ], () => verticalLineContainer("my-4 text-xs", [
      h.div([h.Class("prose prose-sm dark:prose-invert max-w-none")], transcriptMarkdownChildren(message.summary, message.id, context, h)),
    ], h), h),
  ], h)
}

// ── StatusMessage ────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  compacting: "Compacting...",
}

export function statusMessage(message: Of<"status">, h: HtmlBuilder<Message>): Html {
  const label = STATUS_LABELS[message.status] || message.status
  return metaRow({ class: "grid grid-cols-[auto_1fr] items-center gap-1.5 text-sm animate-pulse" }, [
    h.div([h.Class("w-5 h-5 relative flex items-center justify-center")], [Minimize({ class: "h-4.5 w-4.5 text-muted-foreground" }, h)]),
    metaLabel("text-left transition-opacity duration-200 truncate", [label], h),
  ], h)
}

// ── ProcessingMessage ────────────────────────────────────────────────────

const PROCESSING_LABELS: Record<string, string> = {
  connecting: "Connecting...",
  acquiring_sandbox: "Booting...",
  initializing: "Initializing...",
  starting: "Starting...",
  running: "Running...",
  waiting_for_user: "Waiting...",
  failed: "Failed",
}

/** The line under a turn in progress. `waitingOn` goes with `waiting_on_subagent`: how many of what. */
export function processingMessage(status: string | undefined, waitingOn: WaitingOn | undefined, h: HtmlBuilder<Message>): Html {
  // Waiting on a subagent is a line of words and no more. Nothing is
  // happening in this chat for a spinner to stand for, and the shimmer on the
  // words already says the wait is live. With no mark before it the line
  // starts where the messages above it do.
  if (status === "waiting_on_subagent") {
    return metaRow({ class: "mt-3" }, [
      metaContent(undefined, [animatedShinyText({ class: "!mx-0 text-sm", shimmerWidth: 44 }, [waitingOnLabel(waitingOn)], h)], h),
    ], h)
  }
  const label = (status ? PROCESSING_LABELS[status] : undefined) || "Processing..."
  return metaRow({ class: "ml-[1px] mt-3" }, [
    metaContent(undefined, [
      status === "failed" ? X({ class: "size-4.5 text-red-500" }, h) : Loader2({ class: "size-4.5 animate-spin text-muted-icon" }, h),
      animatedShinyText({ class: "ml-[1px] text-sm", shimmerWidth: 44 }, [label], h),
    ], h),
  ], h)
}

// ── DrainingIndicator ────────────────────────────────────────────────────

/** "Running..." with Stop under the pointer (OutMessage `RequestedStop`). */
export function drainingIndicator(h: HtmlBuilder<Message>): Html {
  return metaRow({ class: "ml-[1px]" }, [
    metaContent(undefined, [
      h.div([h.Class("group/draining relative flex items-center gap-1.5")], [
        h.div([h.Class("flex items-center gap-1.5 group-hover/draining:opacity-0 transition-opacity")], [
          Loader2({ class: "size-4.5 animate-spin text-muted-icon" }, h),
          animatedShinyText({ class: "ml-[1px] text-sm", shimmerWidth: 44 }, ["Running..."], h),
        ]),
        h.button([
          h.OnClick(Message.ClickedStop()),
          h.Class("absolute inset-0 flex items-center gap-1.5 opacity-0 group-hover/draining:opacity-100 transition-opacity cursor-pointer"),
        ], [
          X({ class: "size-4.5 text-muted-foreground" }, h),
          h.span([h.Class("text-sm text-muted-foreground")], ["Stop"]),
        ]),
      ]),
    ], h),
  ], h)
}

// ── ResultMessage ────────────────────────────────────────────────────────

/**
 * Who a prompt came from when the user did not type it, as the time boundary
 * above it says: "3:42 PM from an automation". Undefined for the user's own.
 */
export function promptOriginLabel(source: MessageSource | undefined): string | undefined {
  if (!source) return undefined
  if (source.kind === "schedule") return "from an automation"
  if (source.kind === "report") return "from a sub-chat"
  return "from another agent"
}

/** "3:42 PM", or "3:42 PM from another agent". */
export function formatPromptBoundary(timestamp: string, origin?: string): string {
  const time = formatPromptTimestamp(timestamp)
  return origin ? `${time} ${origin}` : time
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function formatPromptTimestamp(timestamp: string, now: Date = new Date()): string {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })

  const dayDelta = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)

  // Today (or anything not in the past): just the time.
  if (dayDelta <= 0) return time
  if (dayDelta === 1) return `Yesterday ${time}`
  // Within the past week: weekday + time (e.g. "Mon 3:33 PM").
  if (dayDelta < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "short" })
    return `${weekday} ${time}`
  }
  // Older: full date + time (e.g. "Thu, Jul 16 at 1:23 PM").
  const fullDate = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
  return `${fullDate} at ${time}`
}

/** Compact turn duration, e.g. "820ms", "12s", "3m 4s", "1h 20m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }

  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`
  }

  if (minutes > 0) {
    return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`
  }

  return `${seconds}s`
}

/**
 * The rule between turns, with the time on it. It closes one turn and dates
 * the prompt that opens the next, so a prompt nobody typed is attributed
 * here, on the line that introduces it.
 */
export function timeBoundary(label: string, h: HtmlBuilder<Message>): Html {
  return metaRow({ class: "px-0.5 text-xs tracking-wide" }, [
    h.div([h.Class("w-full h-[1px] bg-border/70")], []),
    metaLabel("whitespace-nowrap text-[12px] tracking-wide text-muted-foreground/60 flex-shrink-0", [label], h),
    h.div([h.Class("w-full h-[1px] bg-border/70")], []),
  ], h)
}

export function resultMessage(
  message: Of<"result">,
  /** Timestamp of the user prompt that follows this turn, and who sent it when not the user. */
  next: { timestamp?: string; origin?: string },
  h: HtmlBuilder<Message>,
): Html {
  if (!message.success) {
    return h.div([h.Class("px-4 py-3 mx-2 my-1 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm")], [
      message.result || "An unknown error occurred.",
    ])
  }
  const label = next.timestamp
    ? formatPromptBoundary(next.timestamp, next.origin)
    : `${formatPromptTimestamp(message.timestamp)} · Worked for ${formatDuration(message.durationMs)}`
  return timeBoundary(label, h)
}

// ── TodoWriteMessage ─────────────────────────────────────────────────────

const TODO_STATUS = {
  completed: { icon: Check, iconClass: "text-emerald-500", textClass: "text-muted-foreground" },
  in_progress: { icon: Loader2, iconClass: "text-foreground animate-spin", textClass: "text-foreground font-medium" },
  pending: { icon: Circle, iconClass: "text-muted-foreground", textClass: "text-muted-foreground" },
} as const

type TodoCall = Extract<HydratedTranscriptMessage, { kind: "tool"; toolKind: "todo_write" }>

export function todoWriteMessage(message: TodoCall, h: HtmlBuilder<Message>): Html {
  const todos = message.input.todos
  if (!todos.length) return null
  return h.div([h.Class("w-full")], [
    h.div([h.Class("rounded-2xl border border-border overflow-hidden")], [
      h.h3([h.Class("font-medium text-foreground text-sm p-3 px-4 bg-card border-b border-border flex items-center gap-2")], [
        ListChecks({ class: "h-4 w-4 text-muted-foreground" }, h),
        "Progress",
      ]),
      h.div([], todos.map((todo, index) => {
        const isLast = index === todos.length - 1
        const { icon, iconClass, textClass } = TODO_STATUS[todo.status]
        return h.div([h.Class(cn("flex items-center gap-3 px-4 py-2.5 bg-surface", !isLast && "border-b border-border"))], [
          icon({ class: cn("h-4 w-4 flex-shrink-0", iconClass) }, h),
          h.span([h.Class(cn("text-sm", textClass))], [todo.status === "in_progress" ? (todo.activeForm || todo.content) : todo.content]),
        ])
      })),
    ]),
  ])
}
