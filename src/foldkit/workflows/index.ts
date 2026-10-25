import { Option, Schema } from "effect"
import { Command, Mount, Submodel, Subscription } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { deriveSubagentDetails, deriveSubagentToolIds, latestWorkflows, orderTaskLog } from "../../client/components/chat-ui/widgets/derive"
import { cn } from "../../client/lib/utils"
import type { SubagentActivity, TranscriptEntry } from "../../shared/types"
import type { AppModel, SliceReturn, SliceViewInputs } from "../app/slice"
import type { KannaSocketService } from "../core/socket"
import type { Child } from "../ui/attributes"
import * as ContextMenu from "../ui/context-menu"
import { MessageSquare, Square, Workflow } from "../ui/icons"
import { domStream } from "../ui/overlay/stream"
import { applyHover, HOVER_CARD_SURFACE_CLASSNAME, HoverMessage, Hovered } from "../widgets/hoverCard"
import { PartsMessage, type WidgetRowMenu } from "../widgets/parts"
import { agentHoverCardContent, taskHoverCardContent, taskKindName, tasksWidget, type TaskRowActions } from "../widgets/tasks"
import { workflowAgentCardContent, workflowWidget } from "../widgets/workflow"
import { buildData, LIVE_LOOP_AT, LIVE_TICK_MS, liveWorkflow } from "./data"

// The workflows gallery at /workflows (app/WorkflowsGalleryPage.tsx): every
// state the Tasks and Workflow widgets can be in, side by side, on made-up
// data. The widgets are the column's own (widgets/tasks.ts, workflow.ts);
// only their input is invented. Nothing here talks to the server: Stop
// flips a row to "Stopping…" locally and leaves it there.

const SECOND = 1_000
const MINUTE = 60 * SECOND

// MODEL

const MenuTarget = Schema.Struct({ list: Schema.String, control: Schema.String, taskId: Schema.String })

export const Model = Schema.Struct({
  /** When the page opened: every made-up time is before it. */
  t0: Schema.Number,
  /** The widgets' clock, ticked each second. */
  now: Schema.Number,
  live: Schema.Struct({ loop: Schema.Number, step: Schema.Number, runStart: Schema.Number }),
  /** Each stop control's tasks asked to stop (useGalleryStopControl's state), by control. */
  stops: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** Each Tasks card's Show more, by its list. */
  showAll: Schema.Record(Schema.String, Schema.Boolean),
  hovered: Hovered,
  menu: ContextMenu.Model,
  menuTarget: Schema.NullOr(MenuTarget),
})
export type Model = typeof Model.Type

export function init(): Model {
  const now = Date.now()
  return {
    t0: now,
    now,
    live: { loop: 0, step: 0, runStart: now },
    stops: { log: ["agent-stopping"], workflowStopping: ["wf-stopping"] },
    showAll: {},
    hovered: {},
    menu: ContextMenu.init({ id: "workflows-row" }),
    menuTarget: null,
  }
}

// MESSAGE

export const Message = defineMessageUnion({
  TickedLive: { now: Schema.Number },
  TickedClock: { now: Schema.Number },
  ClickedShowAll: { list: Schema.String, shown: Schema.Boolean },
  ClickedStop: { control: Schema.String, taskId: Schema.String },
  ClickedJump: {},
  GotHoverMessage: { message: HoverMessage },
  GotPartsMessage: { message: PartsMessage },
  PressedMenuTrigger: { target: MenuTarget, pointerType: Schema.String, button: Schema.Number, x: Schema.Number, y: Schema.Number },
  RequestedMenu: { target: MenuTarget },
  PressedRowKebab: { target: MenuTarget, x: Schema.Number, y: Schema.Number },
  GotMenuMessage: { message: ContextMenu.Message },
})
export type Message = typeof Message.Type

type H = HtmlBuilder<Message>
type Return = SliceReturn<Model, Message>
type Cmd = Command.Command<Message, never, KannaSocketService>

// UPDATE

function stop(model: Model, control: string, taskId: string): Model {
  return modifyFields(model, { stops: (stops) => ({ ...stops, [control]: [...new Set([...(stops[control] ?? []), taskId])] }) })
}

function menuStep(model: Model, step: ReturnType<typeof ContextMenu.update>) {
  return {
    model: modifyFields(model, { menu: () => step.model }),
    commands: (step.commands ?? []).map((command) => Command.mapMessage(command, (message: ContextMenu.Message) => Message.GotMenuMessage({ message }))) as unknown as Cmd[],
    outMessage: step.outMessage,
  }
}

export function update(model: Model, message: Message, _app: AppModel): Return {
  return Message.match<Return>(message, {
    TickedLive: ({ now }) => {
      const live = model.live
      if (live.step + 1 < LIVE_LOOP_AT) return { model: modifyFields(model, { live: () => ({ ...live, step: live.step + 1 }) }) }
      return { model: modifyFields(model, { live: () => ({ loop: live.loop + 1, step: 0, runStart: now }) }) }
    },
    TickedClock: ({ now }) => ({ model: modifyFields(model, { now: () => now }) }),
    ClickedShowAll: ({ list, shown }) => ({ model: modifyFields(model, { showAll: (showAll) => ({ ...showAll, [list]: shown }) }) }),
    ClickedStop: ({ control, taskId }) => ({ model: stop(model, control, taskId) }),
    ClickedJump: () => ({ model }),
    GotHoverMessage: ({ message: child }) => ({
      model: child._tag === "ChangedHoveredRow" ? modifyFields(model, { hovered: (hovered) => applyHover(hovered, child.list, child.key) }) : model,
    }),
    GotPartsMessage: () => ({ model }),
    PressedMenuTrigger: ({ target, pointerType, button, x, y }) => {
      const step = menuStep(model, ContextMenu.update(model.menu, ContextMenu.Message.PressedTrigger({ pointerType, button, x, y })))
      const next = pointerType === "touch" || pointerType === "pen" ? modifyFields(step.model, { menuTarget: () => target }) : step.model
      return { model: next, commands: step.commands }
    },
    RequestedMenu: ({ target }) => {
      const step = menuStep(modifyFields(model, { menuTarget: () => target }), ContextMenu.update(model.menu, ContextMenu.Message.RequestedContextMenu()))
      return { model: step.model, commands: step.commands }
    },
    PressedRowKebab: ({ target, x, y }) => {
      const pressed = ContextMenu.update(model.menu, ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x, y }))
      const opened = ContextMenu.update(pressed.model, ContextMenu.Message.RequestedContextMenu())
      const step = menuStep(modifyFields(model, { menuTarget: () => target }), opened)
      return { model: step.model, commands: [...menuStep(model, pressed).commands, ...step.commands] }
    },
    GotMenuMessage: ({ message: child }) => {
      const step = menuStep(model, ContextMenu.update(model.menu, child))
      const target = model.menuTarget
      if (step.outMessage?._tag === "Selected" && target && step.outMessage.value === "stop") {
        return { model: stop(step.model, target.control, target.taskId), commands: step.commands }
      }
      return { model: step.model, commands: step.commands }
    },
  })
}

// SUBSCRIPTIONS

/** None: the page's clocks run on its element (`RunClocks`), only while it is up. */
export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()(() => ({}))

/**
 * On the page: the live run's loop (a step every 1.2s, LiveWorkflow's
 * interval) and the widgets' second hand (useNow), for as long as the page
 * is on screen.
 */
const RunClocks = Mount.defineStream("WorkflowsGalleryClocks", {
  messages: [Message.TickedLive, Message.TickedClock],
  execute: () => domStream<typeof Message.TickedLive.Type | typeof Message.TickedClock.Type>((emit) => {
    const live = window.setInterval(() => emit(Message.TickedLive({ now: Date.now() })), LIVE_TICK_MS)
    const clock = window.setInterval(() => emit(Message.TickedClock({ now: Date.now() })), 1_000)
    return () => {
      window.clearInterval(live)
      window.clearInterval(clock)
    }
  }),
})

// VIEW

function rowMenu(model: Model, target: typeof MenuTarget.Type, label: string, h: H): WidgetRowMenu<Message> {
  const open = ContextMenu.isOpen(model.menu) && model.menuTarget !== null
    && model.menuTarget.list === target.list && model.menuTarget.taskId === target.taskId
  return {
    label,
    onKebab: ({ x, y }) => Message.PressedRowKebab({ target, x, y }),
    trigger: [
      h.DataAttribute("state", open ? "open" : "closed"),
      h.OnContextMenu(Message.RequestedMenu({ target })),
      h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX, clientY) =>
        Option.some(Message.PressedMenuTrigger({ target, pointerType, button, x: Math.trunc(clientX), y: Math.trunc(clientY) }))),
    ],
  }
}

/** PageHeader (app/PageHeader.tsx). */
function pageHeader(options: { title: string; subtitle?: string }, h: H): Html {
  return h.div([h.Class(cn("w-full", "px-6 pt-16 mb-10"))], [
    h.div([h.Class(cn("flex items-center gap-1 mb-2"))], [
      h.div([h.Class("p-2 pl-0 rounded-lg")], [Workflow({ class: "h-6 w-6 text-muted-foreground" }, h)]),
      h.h1([h.Class("text-2xl font-semibold text-foreground")], [options.title]),
    ]),
    options.subtitle ? h.p([h.Class(cn("text-muted-foreground"))], [options.subtitle]) : null,
  ])
}

function example(options: { title: string; note?: string; key: string }, children: ReadonlyArray<Child>, h: H): Html {
  return h.keyed("div")(options.key, [h.Class("flex w-[370px] shrink-0 flex-col gap-2")], [
    h.div([h.Class("px-2")], [
      h.div([h.Class("text-sm font-medium text-foreground")], [options.title]),
      options.note ? h.div([h.Class("text-xs text-muted-foreground")], [options.note]) : null,
    ]),
    // The widget column's own padding, so cards sit as they do beside a chat.
    h.div([h.Class("px-2")], children),
  ])
}

function section(title: string, children: ReadonlyArray<Child>, h: H): Html {
  return h.section([h.Class("flex flex-col gap-4")], [
    h.h2([h.Class("px-2 text-base font-semibold text-foreground")], [title]),
    h.div([h.Class("flex flex-wrap items-start gap-x-6 gap-y-8")], children),
  ])
}

/** A hover card's content in the card's own surface, shown open. */
function staticCard(children: ReadonlyArray<Child>, h: H): Html {
  return h.div([h.Class(cn(HOVER_CARD_SURFACE_CLASSNAME, "animate-none"))], children)
}

const toHover = (message: HoverMessage) => Message.GotHoverMessage({ message })

function tasksCard(model: Model, options: { list: string; control: string; tasks: SubagentActivity[]; toolIds: ReadonlyMap<string, string>; entries: readonly TranscriptEntry[]; error?: string; now: number }, h: H): Html {
  return tasksWidget({
    tasks: options.tasks,
    toolIds: options.toolIds,
    entries: options.entries,
    host: {
      list: options.list,
      hoveredKey: model.hovered[options.list] ?? null,
      toHover,
      stopping: new Set(model.stops[options.control] ?? []),
      error: options.error ?? null,
      showAll: model.showAll[options.list] ?? false,
      onShowAll: (shown) => Message.ClickedShowAll({ list: options.list, shown }),
      now: options.now,
      menu: (task, label, _actions: TaskRowActions) => rowMenu(model, { list: options.list, control: options.control, taskId: task.id }, label, h),
      onJump: () => Message.ClickedJump(),
    },
  }, h)
}

function workflowCard(model: Model, options: { key: string; control: string; workflows: SubagentActivity[]; now: number; groupKey?: string }, h: H): Html {
  return workflowWidget(options.workflows, {
    list: (workflowId) => `wf:${options.key}:${workflowId}`,
    hovered: model.hovered,
    toHover,
    stopping: new Set(model.stops[options.control] ?? []),
    onStop: (workflowId) => Message.ClickedStop({ control: options.control, taskId: workflowId }),
    now: options.now,
  }, h, options.groupKey)
}

/** The row menu's items, for whichever row it opened on. */
function menuView(model: Model, data: ReturnType<typeof buildData>, toolIds: ReadonlyMap<string, string>, h: H): Html {
  const target = model.menuTarget
  const task = target ? [...data.log, { id: "call_1", type: "subagent", label: "", status: "running" as const, startedAt: 0 }].find((candidate) => candidate.id === target.taskId) : undefined
  const isStopping = target ? (model.stops[target.control] ?? []).includes(target.taskId) : false
  const showInChat = Boolean(task && toolIds.has(task.id))
  const canStop = Boolean(task && task.status === "running" && task.stoppable && !isStopping)
  const items = [
    ...(showInChat ? [ContextMenu.item({ value: "show-in-chat" })] : []),
    ...(canStop ? [ContextMenu.item({ value: "stop", className: "text-destructive focus:text-destructive" })] : []),
  ]
  return h.submodel({
    slotId: "workflows-row-menu",
    model: model.menu,
    view: ContextMenu.view,
    viewInputs: {
      items,
      renderItem: (value) => value === "show-in-chat"
        ? [MessageSquare({ class: "size-3.5" }, h), h.span([], ["Show in Chat"])]
        : [Square({ class: "size-3.5" }, h), h.span([], [`Stop ${task ? taskKindName(task.type) : ""}`])],
      toView: ({ portal }) => portal,
    },
    toParentMessage: (message) => Message.GotMenuMessage({ message }),
  })
}

function galleryView(model: Model, h: H): Html {
  const t0 = model.t0
  const data = buildData(t0)
  const { workflows, log, entries } = data
  const mixedLog = orderTaskLog(log)
  const mixedToolIds = deriveSubagentToolIds(entries, mixedLog)
  const allRunning = orderTaskLog(log.filter((task) => task.status === "running").slice(0, 3))
  const someRunning = orderTaskLog([log[1]!, log[6]!, log[7]!])
  const allFinished = orderTaskLog(log.filter((task) => task.status !== "running").slice(0, 4))
  const codexStyle = orderTaskLog([
    { id: "call_1", type: "subagent", label: "Review the diff", status: "running", startedAt: data.ago(40 * SECOND) },
    { id: "call_2", type: "subagent", label: "Write the migration", status: "completed", startedAt: data.ago(3 * MINUTE), endedAt: data.ago(1 * MINUTE) },
  ])
  const single = [log[0]!]
  const emptyIds = new Map<string, string>()
  const details = deriveSubagentDetails(entries, mixedToolIds)
  const agentDetails = details.get("agent-running")
  const midAgents = workflows.midRun.workflow!.agents
  const failedAgents = workflows.failed.workflow!.agents
  // The cards' own clock (useNow: something always runs here).
  const now = model.now

  return h.div([h.Class("h-full min-h-0 flex-1 overflow-y-auto"), h.OnMount(RunClocks())], [
    pageHeader({
      title: "Workflows",
      subtitle: "Every state of the Tasks and Workflow widgets, on made-up data. Hover rows and tiles for their cards.",
    }, h),
    h.div([h.Class("flex flex-col gap-12 px-4 pb-24")], [
      section("Workflow card", [
        example({ key: "live", title: "Live", note: "One run on a loop: tiles enter, states ease, the run completes and starts over." }, [
          // A new run each loop, so its first tiles enter again.
          workflowCard(model, { key: `live-${model.live.loop}`, control: "live", workflows: [liveWorkflow(model.live.step, model.live.runStart)], now, groupKey: `live-${model.live.loop}` }, h),
        ], h),
        example({ key: "starting", title: "Starting", note: "Running, no agents announced yet: the status line alone." }, [workflowCard(model, { key: "starting", control: "plain", workflows: [workflows.starting], now }, h)], h),
        example({ key: "running", title: "Running", note: "Queued, running, done and cached agents; the status line names the phase." }, [workflowCard(model, { key: "running", control: "plain", workflows: [workflows.midRun], now }, h)], h),
        example({ key: "stopping", title: "Stopping", note: "Stop clicked, the CLI hasn't answered yet: spinner in the button, Stopping… in the status line." }, [workflowCard(model, { key: "stopping", control: "workflowStopping", workflows: [workflows.stopping], now }, h)], h),
        example({ key: "unstoppable", title: "Running, can't stop", note: "Found by the Stop sweep, so no Stop button." }, [workflowCard(model, { key: "unstoppable", control: "plain", workflows: [workflows.notStoppable], now }, h)], h),
        example({ key: "two", title: "Two runs at once", note: "One section per run in the same card." }, [workflowCard(model, { key: "two", control: "plain", workflows: [workflows.midRun, workflows.second], now }, h)], h),
        example({ key: "completed", title: "Completed" }, [workflowCard(model, { key: "completed", control: "plain", workflows: [workflows.completed], now }, h)], h),
        example({ key: "failed", title: "Failed", note: "A failed agent and the skipped ones after it. Ended runs dim their tiles." }, [workflowCard(model, { key: "failed", control: "plain", workflows: [workflows.failed], now }, h)], h),
        example({ key: "stopped", title: "Stopped" }, [workflowCard(model, { key: "stopped", control: "plain", workflows: [workflows.stopped], now }, h)], h),
        example({ key: "unphased", title: "No phases", note: "Agents outside any phase: the status line counts them instead." }, [workflowCard(model, { key: "unphased", control: "plain", workflows: [workflows.unphased], now }, h)], h),
        example({ key: "large", title: "Large run", note: "230 agents: 200 tiles, then a count." }, [workflowCard(model, { key: "large", control: "plain", workflows: [workflows.large], now }, h)], h),
        example({ key: "latest", title: "Latest run only", note: "Nothing running: the card shows the newest finished run of the log." }, [
          workflowCard(model, { key: "latest", control: "plain", workflows: latestWorkflows(log.filter((task) => task.status !== "running")), now }, h),
        ], h),
      ], h),

      section("Tasks card", [
        example({ key: "log", title: "Log", note: "Running first, then finished, newest first; five rows, then Show more. One row is stopping." }, [
          tasksCard(model, { list: "tasks:log", control: "log", tasks: mixedLog, toolIds: mixedToolIds, entries, now }, h),
        ], h),
        example({ key: "all-running", title: "All running", note: 'Count reads "3 running".' }, [
          tasksCard(model, { list: "tasks:all-running", control: "plain", tasks: allRunning, toolIds: mixedToolIds, entries, now }, h),
        ], h),
        example({ key: "some-running", title: "Some running", note: 'Count reads "1 of 3 running".' }, [
          tasksCard(model, { list: "tasks:some-running", control: "plain", tasks: someRunning, toolIds: mixedToolIds, entries, now }, h),
        ], h),
        example({ key: "all-finished", title: "All finished", note: "Count is the bare total." }, [
          tasksCard(model, { list: "tasks:all-finished", control: "plain", tasks: allFinished, toolIds: mixedToolIds, entries, now }, h),
        ], h),
        example({ key: "stop-failed", title: "A stop that failed", note: "The error sits above the rows." }, [
          tasksCard(model, { list: "tasks:stop-failed", control: "error", tasks: single, toolIds: mixedToolIds, entries, error: "This task can't be stopped on its own. Stop the chat to end it.", now }, h),
        ], h),
        example({ key: "codex", title: "Codex / Grok subagents", note: "Keyed by tool call, no usage, can't be stopped on their own." }, [
          tasksCard(model, { list: "tasks:codex", control: "plain", tasks: codexStyle, toolIds: emptyIds, entries: [], now }, h),
        ], h),
      ], h),

      section("Hover cards, open", [
        agentDetails
          ? example({ key: "card-subagent", title: "Subagent", note: "Its spawn call is in the loaded transcript: prompt, steps, latest tool." }, [
            staticCard(agentHoverCardContent({ agent: log[1]!, details: agentDetails, ...(agentDetails.prompt ? { prompt: agentDetails.prompt } : {}), now: t0, canJump: true }, h), h),
          ], h)
          : null,
        example({ key: "card-monitor", title: "Monitor, running" }, [staticCard(taskHoverCardContent({ task: log[0]!, now: t0, canJump: true }, h), h)], h),
        example({ key: "card-workflow-row", title: "Workflow row" }, [staticCard(taskHoverCardContent({ task: workflows.midRun, now: t0, canJump: true }, h), h)], h),
        example({ key: "card-mcp", title: "MCP task, finished" }, [staticCard(taskHoverCardContent({ task: log[15]!, now: t0, canJump: false }, h), h)], h),
        example({ key: "card-agent-done", title: "Workflow agent, done", note: "Model, prompt, usage and result." }, [staticCard(workflowAgentCardContent({ agent: midAgents[0]!, phaseTitle: "Draft", now: t0 }, h), h)], h),
        example({ key: "card-agent-running", title: "Workflow agent, running" }, [staticCard(workflowAgentCardContent({ agent: midAgents[4]!, phaseTitle: "Score", now: t0 }, h), h)], h),
        example({ key: "card-agent-cached", title: "Workflow agent, cached" }, [staticCard(workflowAgentCardContent({ agent: midAgents[2]!, phaseTitle: "Draft", now: t0 }, h), h)], h),
        example({ key: "card-agent-failed", title: "Workflow agent, failed" }, [staticCard(workflowAgentCardContent({ agent: failedAgents[1]!, phaseTitle: "Research", now: t0 }, h), h)], h),
        example({ key: "card-agent-queued", title: "Workflow agent, queued" }, [staticCard(workflowAgentCardContent({ agent: midAgents[5]!, phaseTitle: "Score", now: t0 }, h), h)], h),
      ], h),
    ]),
    menuView(model, data, mixedToolIds, h),
  ])
}

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, _inputs, h) => galleryView(model, h))
