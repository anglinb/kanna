import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import { toMessagePreview } from "../../shared/message-preview"
import type { ChatSchedule, ScheduleRun } from "../../shared/types"
import { formatPromptTimestamp } from "../transcript/messages/simple"
import { formatScheduleState, formatScheduleTrigger, TRIGGER_ICON } from "../transcript/messages/schedule-tool"
import type { Child } from "../ui/attributes"
import { CalendarClock, Pencil } from "../ui/icons"
import { TURN_CARD_ROW_INSET, turnCardMetaRow, turnCardMetaSeparator } from "../ui/turn-card"
import { listHoverAttributes, listHoverCard, type HoverMessage } from "./hoverCard"
import { widgetCard, widgetList, widgetRow, type WidgetRowMenu } from "./parts"

// SchedulesWidget (widgets/SchedulesWidget.tsx): the schedules to do with
// this chat. A row says what a schedule is and when it runs next; its card
// says the rest. Edit starts the sentence that changes it in the composer.
// The card (`scheduleCard`) is generic over the host's Message: the
// transcript's live schedule card shows it too.

/** Runs a card lists, newest first. */
const CARD_RUNS = 5

/** Re-renders on a slow tick while something is counting down (useMinuteClock's 20s). */
export const MINUTE_CLOCK_MS = 20_000

/** The text Edit starts in the composer. The name is how the agent finds the schedule. */
export function scheduleEditPrompt(schedule: ChatSchedule): string {
  return `Update the schedule "${schedule.name}" to `
}

const RUN_OUTCOME: Record<ScheduleRun["outcome"], { label: string; className: string }> = {
  sent: { label: "Sent", className: "bg-emerald-500" },
  // Not a failure: the run before it was still going.
  skipped: { label: "Skipped", className: "bg-muted-foreground/40" },
  failed: { label: "Failed", className: "bg-destructive" },
}

/** What a schedule's card asks of its host. */
export interface ScheduleCardHost<M> {
  currentChatId: string | null
  now: number
  /** A chat's title, as the sidebar knows it. */
  chatTitle: (chatId: string) => string | undefined
  /** A run into another chat opens it, when the page can open chats. */
  onOpenChat?: (chatId: string) => M
  onEdit: M
}

function runRow<M>(run: ScheduleRun, host: ScheduleCardHost<M>, h: HtmlBuilder<M>): Html {
  const outcome = RUN_OUTCOME[run.outcome]
  // A run into another chat names it and opens it.
  const elsewhere = run.chatId && run.chatId !== host.currentChatId ? run.chatId : null
  const title = elsewhere ? host.chatTitle(elsewhere) : undefined
  const content: ReadonlyArray<Child> = [
    h.span([h.AriaHidden(true), h.Class(cn("size-1.5 shrink-0 rounded-full", outcome.className))], []),
    h.span([h.Class("shrink-0 text-popover-foreground")], [outcome.label]),
    title !== undefined ? h.span([h.Class("min-w-0 truncate")], [title]) : null,
    h.span([h.Class("ml-auto shrink-0 pl-2 tabular-nums")], [formatPromptTimestamp(new Date(run.at).toISOString())]),
  ]
  const className = cn("flex w-full min-w-0 items-center gap-1.5 rounded-md text-left text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET)
  const key = `${run.at}:${run.outcome}`
  if (title === undefined || !elsewhere || !host.onOpenChat) return h.keyed("div")(key, [h.Class(className)], content)
  return h.keyed("button")(key, [h.Type("button"), h.OnClick(host.onOpenChat(elsewhere)), h.Class(cn(className, "cursor-pointer hover:bg-muted"))], content)
}

/** A schedule's card: its message, where it goes, its runs, and Edit. */
export function scheduleCard<M>(schedule: ChatSchedule, host: ScheduleCardHost<M>, h: HtmlBuilder<M>): ReadonlyArray<Child> {
  const target = schedule.target
  const runs = [...(schedule.runs ?? [])].reverse().slice(0, CARD_RUNS)
  const destination = target.kind === "new_chat"
    ? "Starts a new chat each run"
    : target.chatId === host.currentChatId
      ? "Sends to this chat"
      : `Sends to ${host.chatTitle(target.chatId) ?? "another chat"}`
  return [
    turnCardMetaRow({}, [
      h.span([h.Class("truncate")], [formatScheduleTrigger(schedule.trigger)]),
      turnCardMetaSeparator(h),
      h.span([h.Class("shrink-0")], [
        schedule.enabled && schedule.nextRunAt != null
          ? `Next ${formatPromptTimestamp(new Date(schedule.nextRunAt).toISOString())}`
          : formatScheduleState(schedule, host.now),
      ]),
    ], h),
    h.div([h.Class(cn("mt-1 line-clamp-2 text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET))], [schedule.name]),
    h.div([h.Class(cn("line-clamp-[6] whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET))], [toMessagePreview(schedule.content)]),
    turnCardMetaRow({ class: "mt-1" }, [
      h.span([h.Class("truncate")], [destination]),
      ...(schedule.maxRuns ? [turnCardMetaSeparator(h), h.span([h.Class("shrink-0")], [String(schedule.runCount), " of ", String(schedule.maxRuns), " runs"])] : []),
    ], h),
    // Edge to edge, as the chat card's rule is: the card pads by 6px.
    h.div([h.Class("-mx-1.5 mt-2 border-t border-border/60"), h.AriaHidden(true)], []),
    h.div([h.Class("mt-1.5")], runs.length > 0
      ? runs.map((run) => runRow(run, host, h))
      : [h.div([h.Class(cn("text-[12px] text-muted-foreground/70", TURN_CARD_ROW_INSET))], ["No runs yet"])]),
    h.div([h.Class("-mx-1.5 mt-2 border-t border-border/60"), h.AriaHidden(true)], []),
    // The card's one action, full width so it is the same target every time.
    h.button([
      h.Type("button"),
      h.OnClick(host.onEdit),
      h.Class(cn(
        "mt-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md text-left text-[12px] text-muted-foreground hover:bg-muted hover:text-popover-foreground",
        "transition-[scale] duration-150 ease-snappy active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
        TURN_CARD_ROW_INSET,
      )),
    ], [Pencil({ class: "size-3 shrink-0" }, h), h.span([], ["Edit by asking the agent"])]),
  ]
}

/** What the Schedules card asks of its host. */
export interface SchedulesHost<M> {
  list: string
  hoveredKey: string | null
  toHover: (message: HoverMessage) => M
  menu: (schedule: ChatSchedule) => WidgetRowMenu<M>
  card: (schedule: ChatSchedule) => ScheduleCardHost<M>
  now: number
}

export function schedulesWidget<M>(schedules: readonly ChatSchedule[], host: SchedulesHost<M>, h: HtmlBuilder<M>): Html {
  const active = schedules.filter((schedule) => schedule.enabled && schedule.nextRunAt != null).length
  const hovered = host.hoveredKey ? schedules.find((schedule) => schedule.id === host.hoveredKey) : undefined
  return widgetCard({
    icon: CalendarClock({}, h),
    title: ["Schedules"],
    count: active === schedules.length ? String(schedules.length) : `${active} of ${schedules.length} on`,
    body: [
      widgetList({ attributes: listHoverAttributes(host.list, host.toHover, h) }, schedules.map((schedule) => {
        const Icon = TRIGGER_ICON[schedule.trigger.kind]
        const on = schedule.enabled && schedule.nextRunAt != null
        return widgetRow({
          key: schedule.id,
          rowKey: schedule.id,
          // A schedule that will not run again recedes.
          muted: !on,
          icon: Icon({}, h),
          title: schedule.name,
          subtitle: formatScheduleTrigger(schedule.trigger),
          meta: formatScheduleState(schedule, host.now),
          menu: host.menu(schedule),
        }, h)
      }), h),
      hovered ? listHoverCard({ list: host.list, rowKey: hovered.id, toMessage: host.toHover }, scheduleCard(hovered, host.card(hovered), h), h) : null,
    ],
  }, h)
}
