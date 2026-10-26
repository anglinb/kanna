import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import { deriveSubagentDetails, formatTokens, summarizeWorkflow, type SubagentDetails } from "../../client/components/chat-ui/widgets/derive"
import type { SubagentActivity, TranscriptEntry } from "../../shared/types"
import { formatPromptTimestamp } from "../transcript/messages/simple"
import { formatToolCallTitle } from "../transcript/messages/tool-call"
import type { Child } from "../ui/attributes"
import type { Icon } from "../ui/icon"
import { Check, Loader2, Network, Radar, Square, X } from "../ui/icons"
import { TURN_CARD_ROW_INSET, turnCardMetaRow, turnCardMetaSeparator } from "../ui/turn-card"
import { listHoverAttributes, listHoverCard, type HoverMessage } from "./hoverCard"
import { swapIn, WIDGET_ROW_REVEAL_CLASS, widgetCard, widgetError, widgetList, widgetMoreRow, widgetRow, type PartsMessage, type WidgetRowMenu } from "./parts"

// TasksWidget (widgets/TasksWidget.tsx) and task-status-icon.ts: what runs
// on the chat's behalf, as a log that runs across turns. Generic over the
// host's Message: the widget column draws it, and so does /workflows.

/** The mark for how a task stands, by status. */
export interface StatusIcon {
  Icon: Icon
  className: string
  label: string
}

export const TASK_STATUS_ICON: Record<SubagentActivity["status"], StatusIcon> = {
  // Grey: work in progress is the normal state here, not something to flag.
  running: { Icon: Loader2, className: "animate-spin text-muted-foreground", label: "Running" },
  completed: { Icon: Check, className: "text-success", label: "Done" },
  failed: { Icon: X, className: "text-destructive", label: "Failed" },
  // Someone chose to end it: not an outcome to flag in red or green.
  stopped: { Icon: Square, className: "text-muted-foreground", label: "Stopped" },
}

/** A monitor waits on something else rather than works toward an end: it watches. */
const MONITOR_RUNNING_ICON: StatusIcon = { Icon: Radar, className: "text-muted-foreground", label: "Watching" }
const STOPPING_ICON: StatusIcon = { Icon: Loader2, className: "animate-spin text-muted-foreground", label: "Stopping" }

export function statusIcon(task: SubagentActivity, stopping: boolean): StatusIcon {
  if (task.status === "running" && stopping) return STOPPING_ICON
  if (task.status === "running" && task.type === "monitor") return MONITOR_RUNNING_ICON
  return TASK_STATUS_ICON[task.status]
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Rows the Tasks log shows before "Show more". */
export const TASK_LOG_ROWS = 5

/** "3 of 5 running" while some run, "3 running" while all do, then the total. */
export function formatTasksCount(tasks: readonly SubagentActivity[]): string {
  const running = tasks.filter((task) => task.status === "running").length
  if (running === 0) return String(tasks.length)
  return running === tasks.length ? `${running} running` : `${running} of ${tasks.length} running`
}

const KIND_NAMES: Record<string, string> = {
  subagent: "Agent",
  monitor: "Monitor",
  shell: "Shell",
  workflow: "Workflow",
}

export function taskKindName(type: string): string {
  return KIND_NAMES[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}`
}

function countLabel(count: number, noun: string) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`
}

/** The row's title: the task it was given, not its kind. */
export function taskTitle(task: SubagentActivity, details: SubagentDetails | undefined): string {
  if (task.type === "workflow") return task.workflow?.name ?? task.label
  return details?.description ?? task.description ?? task.label
}

/** The line under a row's title. A subagent needs none but its summary; every other kind says what it is. */
export function taskSubtitle(task: SubagentActivity): string | undefined {
  if (task.type === "subagent") return task.summary
  const kind = taskKindName(task.type)
  if (task.type === "workflow") {
    const summary = summarizeWorkflow(task.workflow)
    if (summary.total === 0) return task.status === "running" ? `${kind} · Starting` : kind
    const phase = task.status === "running" && summary.currentPhase ? ` · ${summary.currentPhase.title}` : ""
    return `${kind} · ${summary.done} of ${summary.total} agents${phase}`
  }
  return task.summary ? `${kind} · ${task.summary}` : kind
}

/** A subagent's card: what it was asked, what it has done, when it started and for how long. */
export function agentHoverCardContent<M>(options: { agent: SubagentActivity; details: SubagentDetails; prompt?: string; now: number; canJump: boolean }, h: HtmlBuilder<M>): ReadonlyArray<Child> {
  const { agent, details, prompt, now, canJump } = options
  const running = agent.status === "running"
  const latest = details.latestTool ? formatToolCallTitle(details.latestTool) : null
  return [
    turnCardMetaRow({}, [
      h.span([h.Class("truncate")], [details.subagentType ?? agent.label]),
      turnCardMetaSeparator(h),
      h.span([h.Class("shrink-0")], [TASK_STATUS_ICON[agent.status].label]),
      h.span([h.Class("ml-auto shrink-0 pl-2 tabular-nums")], [
        formatPromptTimestamp(new Date(agent.startedAt).toISOString()), " · ", formatElapsed((agent.endedAt ?? now) - agent.startedAt),
      ]),
    ], h),
    details.description ? h.div([h.Class(cn("mt-1 line-clamp-3 text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET))], [details.description]) : null,
    prompt ? h.div([h.Class(cn("mt-0.5 line-clamp-[8] whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET))], [prompt.trim()]) : null,
    h.div([h.Class("-mx-1.5 mt-2 border-t border-border/60"), h.AriaHidden(true)], []),
    turnCardMetaRow({ class: "mt-1.5" }, [
      h.span([], [countLabel(details.toolCalls, "tool call")]),
      turnCardMetaSeparator(h),
      h.span([], [countLabel(details.messages, "message")]),
      ...(agent.usage?.totalTokens ? [turnCardMetaSeparator(h), h.span([], [formatTokens(agent.usage.totalTokens), " tokens"])] : []),
    ], h),
    latest
      ? h.div([h.Class(cn("truncate text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET))], [
        h.span([h.Class("text-muted-foreground/70")], [running ? "Now" : "Last"]),
        " ",
        latest,
      ])
      : running
        ? h.div([h.Class(cn("text-[12px] text-muted-foreground/70", TURN_CARD_ROW_INSET))], ["No steps yet"])
        : null,
    canJump ? turnCardMetaRow({ class: "mt-1" }, [h.span([], ["Click to show in chat"])], h) : null,
  ]
}

/** Any other task's card: its kind and state, what it was started to do, its latest status, what it used. */
export function taskHoverCardContent<M>(options: { task: SubagentActivity; now: number; canJump: boolean }, h: HtmlBuilder<M>): ReadonlyArray<Child> {
  const { task, now, canJump } = options
  const title = taskTitle(task, undefined)
  const workflow = task.type === "workflow" ? summarizeWorkflow(task.workflow) : null
  const phases = task.workflow?.phases ?? []
  const phaseNumber = workflow?.currentPhase ? phases.findIndex((phase) => phase.index === workflow.currentPhase!.index) + 1 : 0
  const status = task.status === "running" && task.type === "monitor" ? MONITOR_RUNNING_ICON : TASK_STATUS_ICON[task.status]
  const tokens = workflow?.tokens || task.usage?.totalTokens
  return [
    turnCardMetaRow({}, [
      h.span([h.Class("truncate")], [taskKindName(task.type)]),
      turnCardMetaSeparator(h),
      h.span([h.Class("shrink-0")], [status.label]),
      h.span([h.Class("ml-auto shrink-0 pl-2 tabular-nums")], [
        formatPromptTimestamp(new Date(task.startedAt).toISOString()), " · ", formatElapsed((task.endedAt ?? now) - task.startedAt),
      ]),
    ], h),
    h.div([h.Class(cn("mt-1 line-clamp-3 text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET))], [title]),
    task.description && task.description !== title
      ? h.div([h.Class(cn("mt-0.5 line-clamp-[6] whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET))], [task.description])
      : null,
    task.summary ? h.div([h.Class(cn("mt-1 line-clamp-4 whitespace-pre-wrap text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET))], [task.summary]) : null,
    ...((workflow && workflow.total > 0) || task.usage || tokens
      ? [
        h.div([h.Class("-mx-1.5 mt-2 border-t border-border/60"), h.AriaHidden(true)], []),
        turnCardMetaRow({ class: "mt-1.5" }, [
          workflow && workflow.total > 0
            ? h.span([], [String(workflow.done), " of ", countLabel(workflow.total, "agent"), " done"])
            : task.usage ? h.span([], [countLabel(task.usage.toolUses, "tool call")]) : null,
          ...(tokens ? [turnCardMetaSeparator(h), h.span([], [formatTokens(tokens), " tokens"])] : []),
        ], h),
        workflow?.currentPhase
          ? h.div([h.Class(cn("truncate text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET))], [
            h.span([h.Class("text-muted-foreground/70")], ["Phase ", String(phaseNumber), " of ", String(phases.length)]),
            " ",
            workflow.currentPhase.title,
          ])
          : null,
      ]
      : []),
    canJump ? turnCardMetaRow({ class: "mt-1" }, [h.span([], ["Click to show in chat"])], h) : null,
  ]
}

/**
 * What a task row's menu offers of its own: Show in Chat when the call that
 * started it is in the loaded transcript, and Stop while it runs and can be
 * stopped.
 */
export interface TaskRowActions {
  showInChat: boolean
  stop: boolean
}

export function taskRowActions(task: SubagentActivity, { canJump, isStopping }: { canJump: boolean; isStopping: boolean }): TaskRowActions {
  return { showInChat: canJump, stop: task.status === "running" && Boolean(task.stoppable) && !isStopping }
}

export const hasTaskRowActions = (actions: TaskRowActions) => actions.showInChat || actions.stop

/** What a Tasks card asks of its host. */
export interface TasksHost<M> {
  /** The hover card's list name. */
  list: string
  hoveredKey: string | null
  toHover: (message: HoverMessage) => M
  /** The parts' own Mounts (a status's cross-fade), lifted. */
  toParts: (message: PartsMessage) => M
  stopping: ReadonlySet<string>
  error: string | null
  showAll: boolean
  onShowAll: (shown: boolean) => M
  now: number
  /** A row's menu, when it offers something; null otherwise. */
  menu: (task: SubagentActivity, label: string, actions: TaskRowActions) => WidgetRowMenu<M> | null
  onJump: (toolId: string) => M
  /** A sub-chat's row opens its chat (when the page can). */
  onOpenChat?: (chatId: string) => M
  /** A sub-chat's title, as the sidebar knows it. */
  chatTitle?: (chatId: string) => string | undefined
  /** A sub-chat's harness, as the sidebar knows it. */
  chatHarness?: (chatId: string) => string | undefined
  /** The full prompt fetched for a subagent whose spawn call the transcript holds only as a header. */
  fetchedPrompt?: (entryId: string) => string | undefined
}

export function tasksWidget<M>(
  options: { tasks: readonly SubagentActivity[]; toolIds: ReadonlyMap<string, string>; entries: readonly TranscriptEntry[]; host: TasksHost<M> },
  h: HtmlBuilder<M>,
): Html {
  const { tasks, toolIds, entries, host } = options
  const details = deriveSubagentDetails(entries, toolIds)
  // Whatever is running always shows, however many that is.
  const collapsedCount = Math.max(TASK_LOG_ROWS, tasks.filter((task) => task.status === "running").length)
  const shown = host.showAll ? tasks : tasks.slice(0, collapsedCount)
  const hoveredTask = host.hoveredKey ? tasks.find((task) => task.id === host.hoveredKey) : undefined

  const row = (task: SubagentActivity, index: number): Html => {
    const isStopping = host.stopping.has(task.id)
    const { Icon, className, label } = statusIcon(task, isStopping)
    const toolId = toolIds.get(task.id)
    const reveal = index >= collapsedCount ? WIDGET_ROW_REVEAL_CLASS : undefined
    const icon = swapIn({ swapKey: isStopping ? "stopping" : task.status, toParts: host.toParts }, [
      Icon({ class: className, attributes: [h.Role("img"), h.AriaLabel(label)] }, h),
    ], h)
    const meta = isStopping ? "Stopping…" : formatElapsed((task.endedAt ?? host.now) - task.startedAt)
    const rowActions = taskRowActions(task, { canJump: Boolean(toolId), isStopping })
    if (task.chatId) {
      // A sub-chat's row: reads like a subagent's row and behaves like a chat's.
      const chatId = task.chatId
      const harness = host.chatHarness?.(chatId)
      const subtitle = [harness, task.summary].filter(Boolean).join(" · ")
      return widgetRow({
        key: task.id,
        rowKey: task.id,
        ...(reveal ? { class: reveal } : {}),
        icon,
        title: host.chatTitle?.(chatId) ?? task.label,
        ...(subtitle ? { subtitle } : {}),
        meta,
        ...(host.onOpenChat ? { onActivate: host.onOpenChat(chatId) } : {}),
        menu: host.menu(task, "Chat actions", rowActions),
      }, h)
    }
    const taskDetails = task.type === "subagent" ? details.get(task.id) : undefined
    const kind = taskKindName(task.type)
    const subtitle = taskSubtitle(task)
    return widgetRow({
      key: task.id,
      rowKey: task.id,
      ...(reveal ? { class: reveal } : {}),
      icon,
      title: taskTitle(task, taskDetails),
      ...(subtitle ? { subtitle } : {}),
      meta,
      // Opens the chat at the call that started it.
      ...(toolId ? { onActivate: host.onJump(toolId) } : {}),
      menu: hasTaskRowActions(rowActions) ? host.menu(task, `${kind} actions`, rowActions) : null,
    }, h)
  }

  const card = (): ReadonlyArray<Child> | null => {
    if (!hoveredTask) return null
    const canJump = toolIds.has(hoveredTask.id)
    if (hoveredTask.chatId) return taskHoverCardContent({ task: hoveredTask, now: host.now, canJump }, h)
    const taskDetails = hoveredTask.type === "subagent" ? details.get(hoveredTask.id) : undefined
    if (taskDetails) {
      const fetched = !taskDetails.prompt && taskDetails.spawn.trimmed ? host.fetchedPrompt?.(taskDetails.spawn._id) : undefined
      const prompt = taskDetails.prompt ?? fetched
      return agentHoverCardContent({ agent: hoveredTask, details: taskDetails, ...(prompt ? { prompt } : {}), now: host.now, canJump }, h)
    }
    return taskHoverCardContent({ task: hoveredTask, now: host.now, canJump }, h)
  }
  const cardContent = card()

  return widgetCard({
    // Static: the rows already spin for what is running.
    icon: Network({}, h),
    title: ["Tasks"],
    count: formatTasksCount(tasks),
    body: [
      widgetList({ attributes: listHoverAttributes(host.list, host.toHover, h) }, [
        host.error ? widgetError(host.error, h) : null,
        ...shown.map(row),
        tasks.length > collapsedCount
          ? widgetMoreRow({ count: tasks.length - collapsedCount, shown: host.showAll, onClick: host.onShowAll(!host.showAll), toParts: host.toParts }, h)
          : null,
      ], h),
      hoveredTask && cardContent ? listHoverCard({ list: host.list, rowKey: hoveredTask.id, toMessage: host.toHover }, cardContent, h) : null,
    ],
  }, h)
}
