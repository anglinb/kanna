import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../../client/lib/utils"
import { toMessagePreview } from "../../../shared/message-preview"
import { SCHEDULE_TOOL_NAMES } from "../../../shared/tools"
import type { ChatSchedule, ScheduleTrigger } from "../../../shared/types"
import type { Icon } from "../../ui/icon"
import { CalendarClock, Clock, Loader2, Repeat } from "../../ui/icons"
import type { RowContext } from "./context"
import type { Message } from "./model"
import { RequestPayloadsOnMount } from "./mounts"
import { cardPayloadIds, text, TOOL_CARD_CAPTION_CLASS, TOOL_CARD_CLASS, TOOL_CARD_MARK_SLOT_CLASS, TOOL_CARD_WIDTH_CLASS, toolCardClasses, toolCardErrorText, toolCardPayload } from "./tool-card"
import type { ToolCall } from "./tool-call"

/**
 * ScheduleToolMessage.tsx: the card for a schedule an agent set, changed or
 * deleted. Live (the schedule is the open chat's, and the host draws it:
 * `References.renderScheduleCard`) it is the Schedules widget's row in a
 * card; otherwise the card says what the call asked for.
 */

type ScheduleToolCall = Extract<ToolCall, { toolKind: "schedule" | "unknown_tool" }>

/** By kind, and by name for a call recorded before the kind existed. */
export function isScheduleToolCall(message: ToolCall): message is ScheduleToolCall {
  return message.toolKind === "schedule"
    || (message.toolKind === "unknown_tool" && SCHEDULE_TOOL_NAMES.includes(message.toolName))
}

// From SchedulesWidget.tsx (a React file), copied.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export const TRIGGER_ICON: Record<ScheduleTrigger["kind"], Icon> = {
  once: Clock,
  interval: Repeat,
  daily: CalendarClock,
}

/** "Every 5 min", "Daily at 09:00 · Mon, Wed", "Once". */
export function formatScheduleTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === "once") return "Once"
  if (trigger.kind === "interval") {
    const minutes = Math.round(trigger.everyMs / 60_000)
    if (minutes % 1_440 === 0) return minutes === 1_440 ? "Every day" : `Every ${minutes / 1_440} days`
    if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`
    return `Every ${minutes} min`
  }
  const days = trigger.weekdays?.length && trigger.weekdays.length < 7
    ? ` · ${[...trigger.weekdays].sort((a, b) => a - b).map((day) => WEEKDAYS[day]).join(", ")}`
    : ""
  return `Daily at ${trigger.timeOfDay}${days}`
}

/** How long until a time, to the minute: "in 4m", "in 2h 10m", "in 3d". Due or overdue reads "now". */
export function formatUntil(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return "now"
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `in ${hours}h ${minutes % 60}m` : `in ${hours}h`
  return `in ${Math.floor(hours / 24)}d`
}

/** Where a schedule stands, for the row's trailing slot: when it runs next, or why it will not. */
export function formatScheduleState(schedule: ChatSchedule, now: number): string {
  if (schedule.enabled && schedule.nextRunAt != null) return formatUntil(schedule.nextRunAt, now)
  return schedule.nextRunAt == null ? "Done" : "Paused"
}

/**
 * The trigger a call asked for, read from its input. For a card whose
 * schedule is not at hand: deleted since, or belonging to another chat.
 */
function requestedTrigger(input: Record<string, unknown>): ScheduleTrigger | null {
  if (typeof input.everyMinutes === "number") return { kind: "interval", everyMs: input.everyMinutes * 60_000 }
  if (typeof input.dailyAt === "string") {
    const weekdays = Array.isArray(input.weekdays) ? input.weekdays.filter((day): day is number => typeof day === "number") : undefined
    return { kind: "daily", timeOfDay: input.dailyAt, ...(weekdays?.length ? { weekdays } : {}) }
  }
  if (typeof input.inMinutes === "number" || typeof input.runAt === "string") return { kind: "once", at: 0 }
  return null
}

/**
 * A live schedule's card (ScheduleCardBox): the row and its caption. The
 * host's `renderScheduleCard` draws it with the widget's right-click menu
 * and hover card; without one, the box alone.
 */
export function scheduleCardBox(card: { schedule: ChatSchedule; caption: string; quote: boolean }, context: RowContext, h: HtmlBuilder<Message>): Html {
  if (context.references?.renderScheduleCard) return context.references.renderScheduleCard(card)
  const { schedule, caption, quote } = card
  const on = schedule.enabled && schedule.nextRunAt != null
  const icon = TRIGGER_ICON[schedule.trigger.kind]
  const classes = toolCardClasses(quote)
  return h.div([h.Class(classes.width)], [
    h.div([
      // What the hover card finds the card under the pointer by.
      h.DataAttribute("row-key", schedule.id),
      h.Class(cn(classes.box, classes.lit, "select-none")),
    ], [
      h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
        icon({ class: "size-4 shrink-0 text-muted-foreground" }, h),
        h.span([h.Class(cn("min-w-0 shrink truncate", !on && "text-muted-foreground"))], [schedule.name]),
        h.span([h.Class("ml-auto shrink-0 pl-3 text-xs tabular-nums text-muted-foreground")], [formatScheduleState(schedule, context.now)]),
      ]),
      h.p([h.Class(TOOL_CARD_CAPTION_CLASS)], [caption]),
    ]),
  ])
}

export function scheduleToolMessage(message: ScheduleToolCall, context: RowContext, h: HtmlBuilder<Message>): Html {
  const schedules = context.references?.schedules ?? null
  const { input, rawResult, result } = toolCardPayload(message, context)
  const deleted = message.toolName === "delete_schedule"
  const scheduleId = text(result?.scheduleId) ?? text(result?.deleted) ?? text(input.scheduleId)
  const schedule = !deleted && scheduleId ? schedules?.schedules.find((candidate) => candidate.id === scheduleId) ?? null : null
  const wanted = cardPayloadIds(message)
  const onMount = wanted.length > 0 ? [h.OnMount(RequestPayloadsOnMount({ entryIds: wanted }))] : []

  if (message.isError) {
    return h.p([h.Role("alert"), h.Class("text-sm text-destructive"), ...onMount], [toolCardErrorText(rawResult, "The schedule could not be changed.")])
  }

  // An id going in means a schedule that already existed.
  const verb = deleted ? "Deleted" : text(input.scheduleId) ? "Updated" : "Scheduled"

  if (schedule && schedules) {
    const caption = [verb, formatScheduleTrigger(schedule.trigger), toMessagePreview(schedule.content)].filter(Boolean).join(" · ")
    return scheduleCardBox({ schedule, caption, quote: false }, context, h)
  }

  const pending = !message.resultEntryId
  const sent = text(result?.message) ?? text(input.message)
  const trigger = requestedTrigger(input)
  const title = text(result?.name) ?? text(input.name) ?? (sent ? toMessagePreview(sent) : "Schedule")
  const caption = [verb, trigger ? formatScheduleTrigger(trigger) : null, sent ? toMessagePreview(sent) : null].filter(Boolean).join(" · ")
  const icon = trigger ? TRIGGER_ICON[trigger.kind] : CalendarClock
  return h.div([h.Class(cn(TOOL_CARD_CLASS, TOOL_CARD_WIDTH_CLASS)), ...onMount], [
    h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
      pending
        ? h.span([h.Class(TOOL_CARD_MARK_SLOT_CLASS)], [Loader2({ class: "size-3.5 animate-spin text-logo" }, h)])
        : icon({ class: "size-4 shrink-0 text-muted-foreground" }, h),
      h.span([h.Class(cn("min-w-0 truncate", !pending && "text-muted-foreground"))], [title]),
    ]),
    h.p([h.Class(TOOL_CARD_CAPTION_CLASS)], [caption]),
  ])
}
