import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import { formatTokens, summarizeWorkflow, workflowAgentElapsed, type WorkflowSummary } from "../../client/components/chat-ui/widgets/derive"
import type { SubagentActivity, WorkflowAgent, WorkflowAgentState } from "../../shared/types"
import { formatPromptTimestamp } from "../transcript/messages/simple"
import type { Child } from "../ui/attributes"
import { buttonClass } from "../ui/button"
import { Loader2, Square, Workflow as WorkflowIcon } from "../ui/icons"
import { TURN_CARD_ROW_INSET, turnCardMetaRow, turnCardMetaSeparator } from "../ui/turn-card"
import { listHoverAttributes, listHoverCard, type HoverMessage } from "./hoverCard"
import { swapIn, widgetGroup, widgetSection, widgetStatic } from "./parts"
import { formatElapsed, TASK_STATUS_ICON } from "./tasks"

// WorkflowWidget (widgets/WorkflowWidget.tsx): Claude workflows, one
// section per run: a tile per agent, and one line saying where the run is,
// how long it has taken and what it has used. An agent's detail is on its
// tile's hover card. Generic over the host's Message.

const AGENT_STATE_LABEL: Record<WorkflowAgentState, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
}

const TILE_CLASS: Record<WorkflowAgentState, string> = {
  queued: "bg-muted-foreground/15",
  running: "bg-muted-foreground/55 kanna-tile-pulse",
  done: "bg-success",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/[0.07]",
}

/** Past this many the grid would outgrow the card; the rest is a count. */
const MAX_TILES = 200

/** "5/7": agents done of agents so far. */
export function formatWorkflowCount(summary: WorkflowSummary): string | undefined {
  if (summary.total === 0) return undefined
  return `${summary.done}/${summary.total}`
}

const OUTCOME_WORD: Record<Exclude<SubagentActivity["status"], "running">, string> = {
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
}

function workflowStatus<M>(workflow: SubagentActivity, summary: WorkflowSummary, phases: readonly { index: number }[], stopping: boolean, h: HtmlBuilder<M>): ReadonlyArray<Child> {
  const tally = `${summary.done} of ${summary.total} done${summary.failed ? `, ${summary.failed} failed` : ""}`
  if (workflow.status !== "running") {
    return [summary.total > 0 ? `${OUTCOME_WORD[workflow.status]} · ${tally}` : OUTCOME_WORD[workflow.status]]
  }
  if (stopping) return ["Stopping…"]
  if (summary.total === 0) return ["Starting…"]
  if (!summary.currentPhase) return [tally]
  const number = phases.findIndex((phase) => phase.index === summary.currentPhase!.index) + 1
  return [h.span([h.Class("text-muted-foreground/70")], [`Phase ${number} of ${phases.length}`]), ` ${summary.currentPhase.title}`]
}

/** What a Workflow card asks of its host. */
export interface WorkflowHost<M> {
  /** One hover list per run: `list(workflowId)`. */
  list: (workflowId: string) => string
  hovered: Readonly<Record<string, string>>
  toHover: (message: HoverMessage) => M
  stopping: ReadonlySet<string>
  onStop: (workflowId: string) => M
  now: number
}

/** The run as a grid of tiles, one per agent, in the order the script runs them. */
export function workflowTiles<M>(options: { agents: readonly WorkflowAgent[]; summary: WorkflowSummary; ended: boolean; attributes?: ReadonlyArray<import("foldkit/html").Attribute<M>> }, h: HtmlBuilder<M>): Html {
  const { agents, summary, ended } = options
  const label = `${summary.done} of ${summary.total} agents done${summary.failed ? `, ${summary.failed} failed` : ""}`
  const shown = agents.slice(0, MAX_TILES)
  return h.div([
    h.Role("img"),
    h.AriaLabel(label),
    h.Class(cn("-m-[1.5px] flex flex-wrap items-center transition-opacity duration-200 ease-snappy", ended && "opacity-60")),
    ...(options.attributes ?? []),
  ], [
    ...shown.map((agent) => h.keyed("span")(String(agent.index), [h.DataAttribute("row-key", String(agent.index)), h.Class("group/tile p-[1.5px]")], [
      h.span([h.Class(cn(
        "block size-3 rounded-[3px] transition-[background-color,opacity,scale] duration-200 ease-snappy group-hover/tile:relative group-hover/tile:z-10 group-hover/tile:ring-1 group-hover/tile:ring-foreground group-hover/tile:ring-offset-1 group-hover/tile:ring-offset-background dark:group-hover/tile:ring-offset-card",
        TILE_CLASS[agent.state],
      ))], []),
    ])),
    agents.length > shown.length
      ? h.span([h.Class("pl-1 text-[10px] leading-none tabular-nums text-muted-foreground")], [`+${agents.length - shown.length}`])
      : null,
  ])
}

/** One agent's card: its phase and state, model, label, prompt, usage and how it ended. */
export function workflowAgentCardContent<M>(options: { agent: WorkflowAgent; phaseTitle?: string; now: number }, h: HtmlBuilder<M>): ReadonlyArray<Child> {
  const { agent, phaseTitle, now } = options
  const elapsed = workflowAgentElapsed(agent, now)
  const state = AGENT_STATE_LABEL[agent.state]
  const hasUsage = agent.toolCalls !== undefined || agent.tokens !== undefined
  return [
    turnCardMetaRow({}, [
      h.span([h.Class("truncate")], [phaseTitle ?? `Agent ${agent.index}`]),
      turnCardMetaSeparator(h),
      h.span([h.Class("shrink-0")], [agent.cached ? "Cached" : state]),
      ...(agent.model ? [turnCardMetaSeparator(h), h.span([h.Class("truncate")], [agent.model])] : []),
      agent.startedAt !== undefined
        ? h.span([h.Class("ml-auto shrink-0 pl-2 tabular-nums")], [
          `${formatPromptTimestamp(new Date(agent.startedAt).toISOString())}${elapsed !== null ? ` · ${formatElapsed(elapsed)}` : ""}`,
        ])
        : null,
    ], h),
    h.div([h.Class(cn("mt-1 line-clamp-3 text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET))], [agent.label]),
    agent.promptPreview ? h.div([h.Class(cn("mt-0.5 line-clamp-[6] whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET))], [agent.promptPreview]) : null,
    hasUsage || agent.error || agent.resultPreview ? h.div([h.Class("-mx-1.5 mt-2 border-t border-border/60"), h.AriaHidden(true)], []) : null,
    hasUsage
      ? turnCardMetaRow({ class: "mt-1.5" }, [
        h.span([], [`${(agent.toolCalls ?? 0).toLocaleString()} tool call${agent.toolCalls === 1 ? "" : "s"}`]),
        ...(agent.tokens ? [turnCardMetaSeparator(h), h.span([], [`${formatTokens(agent.tokens)} tokens`])] : []),
      ], h)
      : null,
    agent.error
      ? h.div([h.Class(cn("mt-0.5 line-clamp-4 whitespace-pre-wrap text-[12px] text-destructive", TURN_CARD_ROW_INSET))], [agent.error])
      : agent.resultPreview
        ? h.div([h.Class(cn("mt-0.5 line-clamp-4 whitespace-pre-wrap text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET))], [
          h.span([h.Class("text-muted-foreground/70")], ["Result"]),
          ` ${agent.resultPreview}`,
        ])
        : null,
  ]
}

function workflowSection<M>(workflow: SubagentActivity, host: WorkflowHost<M>, h: HtmlBuilder<M>): Html {
  const progress = workflow.workflow ?? { phases: [], agents: [] }
  const summary = summarizeWorkflow(progress)
  const running = workflow.status === "running"
  const stopping = running && host.stopping.has(workflow.id)
  const outcome = TASK_STATUS_ICON[workflow.status]
  const elapsed = formatElapsed((workflow.endedAt ?? host.now) - workflow.startedAt)
  const list = host.list(workflow.id)
  const hoveredKey = host.hovered[list]
  const hoveredAgent = hoveredKey ? progress.agents.find((agent) => String(agent.index) === hoveredKey) : undefined
  const count = formatWorkflowCount(summary)

  const actions: ReadonlyArray<Child> | null = running
    ? workflow.stoppable
      ? [h.button([
        h.Class(buttonClass({ variant: "ghost", size: "none", class: "size-6 justify-center rounded-md p-0 text-muted-foreground transition-[color,scale] duration-150 ease-snappy hover:text-destructive active:scale-[0.97]" })),
        h.Type("button"),
        ...(stopping ? [h.Disabled(true)] : []),
        h.AriaLabel("Stop workflow"),
        h.Title("Stop workflow"),
        h.OnClick(host.onStop(workflow.id)),
      ], [swapIn({ swapKey: stopping ? "stopping" : "stop" }, [stopping ? Loader2({ class: "size-4 animate-spin" }, h) : Square({ class: "size-4" }, h)], h)])]
      : null
    : [h.span([h.Class("flex size-6 items-center justify-center")], [
      swapIn({ swapKey: workflow.status }, [outcome.Icon({ class: cn("size-4", outcome.className), attributes: [h.Role("img"), h.AriaLabel(outcome.label)] }, h)], h),
    ])]

  return widgetSection({
      key: workflow.id,
      icon: WorkflowIcon({}, h),
      title: [progress.name ?? workflow.label],
      ...(count !== undefined ? { count } : {}),
      actions,
      body: [
        // Always a body, even before the first agent: the status line has the run's time.
        h.div([], [
          widgetStatic({ class: "flex flex-col gap-2" }, [
            summary.total > 0
              ? workflowTiles({ agents: progress.agents, summary, ended: !running, attributes: listHoverAttributes(list, host.toHover, h) }, h)
              : null,
            h.div([h.Class("flex min-w-0 items-center gap-1 text-xs text-muted-foreground")], [
              h.span([h.Class("min-w-0 truncate")], workflowStatus(workflow, summary, progress.phases, stopping, h)),
              h.span([h.Class("ml-auto shrink-0 pl-2 tabular-nums")], [`${elapsed}${summary.tokens > 0 ? ` · ${formatTokens(summary.tokens)} tokens` : ""}`]),
            ]),
          ], h),
          hoveredAgent
            ? listHoverCard({
              list,
              rowKey: String(hoveredAgent.index),
              toMessage: host.toHover,
              // Beside the body, level with the tile: the tiles sit mid-card.
              alignToAncestor: 2,
            }, workflowAgentCardContent({
              agent: hoveredAgent,
              ...(progress.phases.find((phase) => phase.index === hoveredAgent.phaseIndex)?.title !== undefined
                ? { phaseTitle: progress.phases.find((phase) => phase.index === hoveredAgent.phaseIndex)!.title }
                : {}),
              now: host.now,
            }, h), h)
            : null,
        ]),
      ],
    }, h)
}

/** The runs to show, oldest first: one section each in one card. */
export function workflowWidget<M>(workflows: readonly SubagentActivity[], host: WorkflowHost<M>, h: HtmlBuilder<M>, key?: string): Html {
  return widgetGroup({ ...(key !== undefined ? { key } : {}) }, workflows.map((workflow) => workflowSection(workflow, host, h)), h)
}
