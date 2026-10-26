import { Effect, Option, Schema } from "effect"
import { Command, Render, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { copyTextToClipboard } from "../../../client/lib/clipboard"
import type { AskUserQuestionAnswerMap, AskUserQuestionItem, TranscriptEntry } from "../../../shared/types"
import type { ChartToolPayload } from "../../../shared/display-tools"
import type { VisualizationArtifact } from "../../../shared/visualization"
import { AppAction } from "../../app/action"
import * as Stores from "../../app/stores"
import * as Viewer from "../../core/stores/viewer"
import { opaque } from "../../core/schema"
import { CodeCopy, LocalLinkTarget } from "../../markdown"
import * as Select from "../../ui/select"
import * as Tooltip from "../../ui/tooltip"

/**
 * The state a transcript's rows hold of their own, for every row at once,
 * keyed by row: what is open, which copy button shows its check, a question
 * being answered, a plan being adjusted, fetched tool payloads, a chart's
 * legend, a visualization's frame. React kept each in the row component's
 * `useState`; here the transcript holds one Model and every row reads its
 * part by key (see `keys` below), so a row that scrolls out of the window
 * and back finds its state as it left it.
 *
 * Nothing in it is the transcript's data: rows come in as view inputs.
 */

// ── Keys ─────────────────────────────────────────────────────────────────

/** Where a row's state lives in `open` and the other records. One place, so views and update agree. */
export const keys = {
  /** A tool call's ExpandableRow. */
  tool: (id: string) => `tool:${id}`,
  /** A folded run of tool calls (CollapsedToolGroup), by the row's id (its first message's). */
  group: (id: string) => `group:${id}`,
  /** A system_init row's ExpandableRow. */
  system: (id: string) => `system:${id}`,
  /** One of a system row's sections: Tools, Agents, Commands, MCP Servers, Raw Message. */
  systemSection: (id: string, title: string) => `system:${id}:${title}`,
  /** An MCP server's tool list in a system row. */
  mcpServer: (id: string, server: string) => `system:${id}:mcp:${server}`,
  account: (id: string) => `account:${id}`,
  compactSummary: (id: string) => `summary:${id}`,
  /** An Agent's result toggle. */
  subagentResult: (id: string) => `subagent-result:${id}`,
  /** A prompt's clamped text (`part` for each bubble of a sourced message). */
  clamp: (id: string, part: number | string = 0) => `clamp:${id}:${part}`,
  /** A plan's Show More. */
  plan: (toolId: string) => `plan:${toolId}`,
} as const

// ── Model ────────────────────────────────────────────────────────────────

const Flags = Schema.Record(Schema.String, Schema.Boolean)

/** A question card's answers before it is submitted (AskUserQuestionMessage's useState). */
export const QuestionState = Schema.Struct({
  currentIndex: Schema.Number,
  answers: Schema.Record(Schema.String, Schema.String),
  customInputs: Schema.Record(Schema.String, Schema.String),
  submitted: Schema.NullOr(opaque<AskUserQuestionAnswerMap>("AskUserQuestionAnswerMap")),
})
export type QuestionState = typeof QuestionState.Type

export const EMPTY_QUESTION: QuestionState = { currentIndex: 0, answers: {}, customInputs: {}, submitted: null }

/** A plan's edit box (ExitPlanModeMessage's useState). */
export const PlanState = Schema.Struct({ editing: Schema.Boolean, draft: Schema.String })
export type PlanState = typeof PlanState.Type

export const EMPTY_PLAN: PlanState = { editing: false, draft: "" }

/** RawMessageSection's fetch. */
export const DebugRawState = Schema.Struct({
  state: Schema.Literals(["idle", "loading", "error"]),
  body: Schema.NullOr(Schema.String),
})
export type DebugRawState = typeof DebugRawState.Type

export const AggregateMode = Schema.Literals(["avg", "bottom_quartile", "median", "top_quartile", "min", "max", "sum", "count"])
export type AggregateMode = typeof AggregateMode.Type

/** A chart's legend and the point under the pointer (useChartModel and recharts' tooltip). */
export const ChartState = Schema.Struct({
  hidden: Schema.Array(Schema.String),
  active: Schema.NullOr(Schema.String),
  /** Where the pointer is over the chart, px from its top left, rounded (recharts' relative coordinate). */
  hover: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  /** The render area's size, once measured and rounded (ResponsiveContainer). */
  size: Schema.NullOr(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
  /** The tooltip's box, once drawn: where it goes depends on it. */
  tooltip: Schema.NullOr(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
  /** The data table's (full size): how each row and each column is summed up. */
  rowAggregate: AggregateMode,
  columnAggregate: AggregateMode,
  /** The table's first column, as dragged (128-360px). */
  firstColumnWidth: Schema.Number,
  /** The table's scroll viewport, measured. */
  tableViewport: Schema.Number,
})
export type ChartState = typeof ChartState.Type

export const EMPTY_CHART: ChartState = { hidden: [], active: null, hover: null, size: null, tooltip: null, rowAggregate: "avg", columnAggregate: "avg", firstColumnWidth: 176, tableViewport: 0 }

/** An attachments strip's scroll edges (AttachmentsCard's measure). */
export const StripState = Schema.Struct({ moreLeft: Schema.Boolean, moreRight: Schema.Boolean, scrollbarHeight: Schema.Number })
export type StripState = typeof StripState.Type

export const EMPTY_STRIP: StripState = { moreLeft: false, moreRight: false, scrollbarHeight: 0 }

const Heights = Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]))

/** A visualization's frame (VisualizationFrame's state). */
export const FrameState = Schema.Struct({
  document: Schema.NullOr(Schema.String),
  failed: Schema.Boolean,
  width: Schema.NullOr(Schema.Number),
  measured: Schema.NullOr(Schema.Number),
  known: Heights,
  loaded: Schema.Boolean,
})
export type FrameState = typeof FrameState.Type

export const Model = Schema.Struct({
  /** Every open/closed toggle, by `keys.*`. Absent is the React default (closed). */
  open: Flags,
  /** Which copy button shows its check: `key` names it, `block` a markdown code block within it. */
  copied: Schema.NullOr(Schema.Struct({ key: Schema.String, block: Schema.Number, version: Schema.Number })),
  copyVersion: Schema.Number,
  /** Whether a clamped text runs past its limit, by `keys.clamp`. False until measured. */
  overflows: Flags,
  questions: Schema.Record(Schema.String, QuestionState),
  plans: Schema.Record(Schema.String, PlanState),
  /** Tool payloads fetched by entry id (toolPayloadStore's cache). */
  payloads: Schema.Record(Schema.String, opaque<TranscriptEntry>("TranscriptEntry")),
  /** Asked for and not back yet, or queued to be asked for this tick. */
  inFlight: Flags,
  queued: Schema.Array(Schema.String),
  debugRaw: Schema.Record(Schema.String, DebugRawState),
  charts: Schema.Record(Schema.String, ChartState),
  strips: Schema.Record(Schema.String, StripState),
  /** Attachment previews that failed to load, by `${key}|${url}`. */
  broken: Flags,
  frames: Schema.Record(Schema.String, FrameState),
  /** Tooltips rows own (a visualization's Expand), by row key. Absent is closed. */
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
  /** A chart table's aggregate menus, by `selectKey`. Absent is closed. */
  selects: Schema.Record(Schema.String, Select.Model),
  /** A queued message's or a resume's press, while its command is out. */
  busy: Flags,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    open: {},
    copied: null,
    copyVersion: 0,
    overflows: {},
    questions: {},
    plans: {},
    payloads: {},
    inFlight: {},
    queued: [],
    debugRaw: {},
    charts: {},
    strips: {},
    broken: {},
    frames: {},
    tooltips: {},
    selects: {},
    busy: {},
  }
}

// ── Messages ─────────────────────────────────────────────────────────────

/**
 * What a collapse keeps on screen (React's `scopeRef`): the text alone, its
 * bubble (a typed prompt), or the bubble with its quote (a sourced part).
 */
export const ClampScope = Schema.Literals(["clip", "surface", "part"])
export type ClampScope = typeof ClampScope.Type

const Questions = opaque<ReadonlyArray<AskUserQuestionItem>>("AskUserQuestionItems")
const AnswerMap = opaque<AskUserQuestionAnswerMap>("AskUserQuestionAnswerMap")

export const Message = defineMessageUnion({
  /** Any open/closed toggle. */
  ToggledOpen: { key: Schema.String },
  SetOpen: { key: Schema.String, open: Schema.Boolean },
  /** A copy button: `block` is a markdown code block's index, -1 for anything else. */
  ClickedCopy: { key: Schema.String, block: Schema.Number, text: Schema.String },
  CompletedCopy: { key: Schema.String, block: Schema.Number, didCopy: Schema.Boolean },
  ElapsedCopied: { version: Schema.Number },
  ClickedCodeCopy: { key: Schema.String, copy: CodeCopy },
  ClickedLocalLink: { target: LocalLinkTarget },
  ClickedChatLink: { chatId: Schema.String },

  // Clamped text
  MeasuredClamp: { key: Schema.String, overflows: Schema.Boolean },
  PressedClampControl: { key: Schema.String, id: Schema.String, from: Schema.Number, byKeyboard: Schema.Boolean, lines: Schema.Number, scope: ClampScope },
  PressedFoldSurface: { key: Schema.String, id: Schema.String, from: Schema.Number, lines: Schema.Number, scope: ClampScope },
  CompletedClampMotion: {},

  // Tool payloads
  WantedPayloads: { entryIds: Schema.Array(Schema.String) },
  FlushedPayloadRequests: {},
  /** Opened a Raw Message section whose body is still to be fetched. */
  OpenedRawMessage: { key: Schema.String, entryId: Schema.String },

  // AskUserQuestion
  SelectedOption: { toolId: Schema.String, questions: Questions, questionKey: Schema.String, label: Schema.String, multiSelect: Schema.Boolean },
  AdvancedQuestion: { toolId: Schema.String, index: Schema.Number },
  ChangedCustomInput: { toolId: Schema.String, questionKey: Schema.String, value: Schema.String, multiSelect: Schema.Boolean },
  ClearedCustomInput: { toolId: Schema.String, questionKey: Schema.String },
  ClickedNextQuestion: { toolId: Schema.String, count: Schema.Number },
  ClickedPreviousQuestion: { toolId: Schema.String },
  SubmittedAnswers: { toolId: Schema.String, questions: Questions, answers: AnswerMap },

  // ExitPlanMode
  ClickedSuggestEdits: { toolId: Schema.String },
  ChangedPlanDraft: { toolId: Schema.String, value: Schema.String },
  CancelledPlanEdit: { toolId: Schema.String },
  ConfirmedPlan: { toolId: Schema.String, confirmed: Schema.Boolean, clearContext: Schema.optional(Schema.Boolean), message: Schema.optional(Schema.String) },
  CompletedFocus: {},

  // Display tools
  ToggledChartSeries: { key: Schema.String, series: Schema.String },
  HoveredChartSeries: { key: Schema.String, series: Schema.NullOr(Schema.String) },
  MovedOverChart: { key: Schema.String, pointer: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number })) },
  MeasuredChart: { key: Schema.String, width: Schema.Number, height: Schema.Number },
  MeasuredChartTooltip: { key: Schema.String, width: Schema.Number, height: Schema.Number },
  ClickedDownloadChartCsv: { csv: Schema.String, filename: Schema.String },
  CompletedDownload: {},
  ClickedExpandChart: { payload: opaque<ChartToolPayload>("ChartToolPayload") },
  /** The full-size chart's data table. */
  GotAggregateSelectMessage: { key: Schema.String, which: Schema.Literals(["row", "column"]), message: Select.Message },
  ResizedChartColumn: { key: Schema.String, width: Schema.Number },
  MeasuredChartTable: { key: Schema.String, width: Schema.Number },
  MeasuredStrip: { key: Schema.String, strip: StripState },
  FailedAttachmentPreview: { key: Schema.String, url: Schema.String },
  ClickedAttachment: { target: opaque<AttachmentTarget>("AttachmentTarget") },
  CompletedOpenInNewTab: {},

  // Visualizations
  GotFrameDocument: { key: Schema.String, document: Schema.String },
  FailedFrameDocument: { key: Schema.String },
  MeasuredFrameWidth: { key: Schema.String, width: Schema.Number },
  /** What is known of a document's heights by width: remembered, from the server, or just recorded. */
  KnewFrameHeights: { key: Schema.String, heights: Heights },
  ResizedFrame: { key: Schema.String, height: Schema.Number },
  LoadedFrame: { key: Schema.String },
  ClickedExpandVisualization: { artifact: opaque<VisualizationArtifact>("VisualizationArtifact") },
  GotTooltipMessage: { key: Schema.String, message: Tooltip.Message },
  PressedEscapeInFrame: { key: Schema.String, repeat: Schema.Boolean },

  // Queue and resume
  ClickedQueued: { messageId: Schema.String, action: Schema.Literals(["remove", "send-now"]) },
  ClickedResume: { key: Schema.String, action: Schema.Literals(["cancel", "now"]) },
  ClickedStop: {},
})
export type Message = typeof Message.Type

/**
 * An attachment a row opens: in the viewer, or (a file the viewer can't
 * show) in a new tab. `viewer` is null for the new tab.
 */
export interface AttachmentTarget {
  url: string
  viewer: Viewer.ViewerAttachment | null
}

/**
 * What the rows ask of the transcript. Answers, plan decisions, payload
 * fetches and queue presses go to the page's chat; the rest are app-wide
 * (`RequestedAppAction`: the viewer).
 */
export const OutMessage = defineMessageUnion({
  RequestedAppAction: { action: AppAction },
  /** `chat.getToolEntries` for these ids; answer with `receivedToolEntries` (or `failedToolEntries`). */
  RequestedToolEntries: { entryIds: Schema.Array(Schema.String) },
  /** `chat.getEntryDebugRaw`; answer with `receivedDebugRaw`. */
  RequestedDebugRaw: { entryId: Schema.String },
  /** React's `onAskUserQuestionSubmit(toolUseId, questions, answers)`. */
  SubmittedAskUserQuestion: { toolUseId: Schema.String, questions: Questions, answers: AnswerMap },
  /** React's `onExitPlanModeConfirm(toolUseId, confirmed, clearContext?, message?)`. */
  ConfirmedExitPlanMode: { toolUseId: Schema.String, confirmed: Schema.Boolean, clearContext: Schema.optional(Schema.Boolean), message: Schema.optional(Schema.String) },
  /** A local file link (OpenLocalLinkProvider's handler). */
  OpenedLocalLink: { target: LocalLinkTarget },
  /** A chat link or a chat's card (ChatReferenceActions.onOpenChat). */
  OpenedChat: { chatId: Schema.String },
  /** Remove or Send now on a queued message. The row dims until `settledQueued`. */
  RequestedQueueAction: { messageId: Schema.String, action: Schema.Literals(["remove", "send-now"]) },
  /** A usage-limit resume's Continue now / Don't continue. Dims until `settledResume`. */
  RequestedResumeAction: { action: Schema.Literals(["cancel", "now"]) },
  /** DrainingIndicator's Stop. */
  RequestedStop: {},
  /** Escape in a full-size visualization's frame, unused by it (`visualizationFrame`'s `reportsEscape`). */
  EscapedVisualization: { key: Schema.String, repeat: Schema.Boolean },
})
export type OutMessage = typeof OutMessage.Type

// ── Commands ─────────────────────────────────────────────────────────────

const COPIED_FEEDBACK_MS = 2000

export const CopyText = Command.define("CopyTranscriptText", {
  args: { key: Schema.String, block: Schema.Number, text: Schema.String },
  messages: [Message.CompletedCopy],
  execute: ({ key, block, text }) =>
    Effect.tryPromise(() => copyTextToClipboard(text)).pipe(
      Effect.catch((error) => Effect.sync(() => {
        console.error("[CopyButton] Copy failed:", error)
        return false
      })),
      Effect.map((didCopy) => Message.CompletedCopy({ key, block, didCopy })),
    ),
})

export const WaitCopied = Command.define("WaitTranscriptCopied", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedCopied],
  execute: ({ version }) => Effect.sleep(COPIED_FEEDBACK_MS).pipe(Effect.as(Message.ElapsedCopied({ version }))),
})

/** One request per tick, as toolPayloadStore batches its prefetches. */
export const FlushPayloadRequests = Command.define("FlushPayloadRequests", {
  messages: [Message.FlushedPayloadRequests],
  execute: Effect.sleep(0).pipe(Effect.as(Message.FlushedPayloadRequests())),
})

/** Single select moves on 150ms after the pick, so the check is seen landing. */
export const AdvanceQuestion = Command.define("AdvanceQuestion", {
  args: { toolId: Schema.String, index: Schema.Number },
  messages: [Message.AdvancedQuestion],
  execute: ({ toolId, index }) => Effect.sleep(150).pipe(Effect.as(Message.AdvancedQuestion({ toolId, index }))),
})

export const DownloadCsv = Command.define("DownloadChartCsv", {
  args: { csv: Schema.String, filename: Schema.String },
  messages: [Message.CompletedDownload],
  execute: ({ csv, filename }) => Effect.sync(() => {
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
    return Message.CompletedDownload()
  }),
})

export const OpenInNewTab = Command.define("OpenAttachmentInNewTab", {
  args: { url: Schema.String },
  messages: [Message.CompletedOpenInNewTab],
  execute: ({ url }) => Effect.sync(() => {
    window.open(new URL(url, document.baseURI || window.location.href).toString(), "_blank", "noopener,noreferrer")
    return Message.CompletedOpenInNewTab()
  }),
})

// ClampedMessageText's open and close: eased max-height from where it was to where it lands.

/** Opening is the reader's request being met, so it gets a beat. Closing is them done with it. */
const EXPAND_MS = 200
const COLLAPSE_MS = 160
/** `--ease-snappy`, the app's curve, as a value: this one runs from script. */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)"
/** About a screen. Past it the text is on its way off the page before the eye has caught the move. */
const MAX_EASED_DISTANCE_PX = 800

/**
 * How long the text takes to open or close, or null to simply be there.
 * Copied from ClampedMessageText.tsx; see there for why.
 */
export function clampTransitionMs({ expanding, from, to, reducedMotion, byKeyboard, startsAboveView }: {
  expanding: boolean
  from: number
  to: number
  reducedMotion: boolean
  byKeyboard: boolean
  startsAboveView: boolean
}): number | null {
  if (reducedMotion || byKeyboard) return null
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null
  if (Math.abs(to - from) > MAX_EASED_DISTANCE_PX) return null
  if (!expanding && startsAboveView) return null
  return expanding ? EXPAND_MS : COLLAPSE_MS
}

/** Whether an element's top is hidden above the transcript's view, under its header included. */
function startsAboveView(element: HTMLElement): boolean {
  const scroller = element.closest<HTMLElement>("[data-slot='message-scroller-viewport']")
  const viewTop = scroller
    ? scroller.getBoundingClientRect().top + (Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0)
    : 0
  return element.getBoundingClientRect().top < viewTop
}

const runningClampAnimations = new Map<string, Animation>()

export const MoveClamp = Command.define("MoveClampedText", {
  args: { id: Schema.String, expanding: Schema.Boolean, from: Schema.Number, byKeyboard: Schema.Boolean, lines: Schema.Number, scope: ClampScope },
  messages: [Message.CompletedClampMotion],
  execute: ({ id, expanding, from, byKeyboard, lines, scope: scopeKind }) => Effect.gen(function* () {
    yield* Render.afterCommit
    const clip = document.getElementById(id)
    const content = clip?.firstElementChild as HTMLElement | null | undefined
    if (!clip || !content) return Message.CompletedClampMotion()
    runningClampAnimations.get(id)?.cancel()
    runningClampAnimations.delete(id)
    const surface = clip.closest<HTMLElement>("[data-fold-surface]")
    const scope = scopeKind === "surface" && surface
      ? surface
      : scopeKind === "part" && surface?.parentElement?.parentElement
        ? surface.parentElement.parentElement
        : clip
    const to = expanding ? content.offsetHeight : Number.parseFloat(getComputedStyle(clip).lineHeight) * lines
    const ms = clampTransitionMs({
      expanding,
      from,
      to,
      reducedMotion: typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      byKeyboard,
      startsAboveView: !expanding && startsAboveView(scope),
    })
    if (ms === null || typeof clip.animate !== "function") {
      if (!expanding) scope.scrollIntoView({ block: "nearest" })
      return Message.CompletedClampMotion()
    }
    runningClampAnimations.set(id, clip.animate(
      [
        { maxHeight: `${from}px`, overflow: "hidden" },
        { maxHeight: `${to}px`, overflow: "hidden" },
      ],
      { duration: ms, easing: EASE_OUT },
    ))
    return Message.CompletedClampMotion()
  }),
})

/** Focus a plan's edit box when it opens (ExitPlanModeMessage's effect). */
export const FocusPlanDraft = Command.define("FocusPlanDraft", {
  args: { toolId: Schema.String },
  messages: [Message.CompletedFocus],
  execute: ({ toolId }) => Effect.gen(function* () {
    yield* Render.afterCommit
    const textarea = document.querySelector<HTMLTextAreaElement>(`[data-plan-draft="${CSS.escape(toolId)}"]`)
    textarea?.focus()
    return Message.CompletedFocus()
  }),
})

// ── Update ───────────────────────────────────────────────────────────────

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

function questionOf(model: Model, toolId: string): QuestionState {
  return model.questions[toolId] ?? EMPTY_QUESTION
}

function withQuestion(model: Model, toolId: string, next: QuestionState): Model {
  return { ...model, questions: { ...model.questions, [toolId]: next } }
}

function planOf(model: Model, toolId: string): PlanState {
  return model.plans[toolId] ?? EMPTY_PLAN
}

function withPlan(model: Model, toolId: string, next: PlanState): Model {
  return { ...model, plans: { ...model.plans, [toolId]: next } }
}

export function chartOf(model: Model, key: string): ChartState {
  return model.charts[key] ?? EMPTY_CHART
}

function withChart(model: Model, key: string, next: ChartState): Model {
  return { ...model, charts: { ...model.charts, [key]: next } }
}

export function frameOf(model: Model, key: string): FrameState {
  return model.frames[key] ?? emptyFrame()
}

/** Where a chart table's aggregate menu keeps its state. */
export function selectKey(key: string, which: "row" | "column") {
  return `${key}:${which}-aggregate`
}

export function selectOf(model: Model, key: string, which: "row" | "column"): Select.Model {
  const id = selectKey(key, which)
  return model.selects[id] ?? Select.init({ id: `transcript-select-${id.replace(/[^\w-]/g, "_")}` })
}

export function tooltipOf(model: Model, key: string): Tooltip.Model {
  return model.tooltips[key] ?? Tooltip.init({ id: `transcript-tooltip-${key.replace(/[^\w-]/g, "_")}`, delayDuration: 0 })
}

/** The effective answers to one question: a typed one or the picked ones. Copied from AskUserQuestionMessage. */
export function effectiveAnswers(state: QuestionState, questionKey: string, multiSelect: boolean): string[] {
  const custom = state.customInputs[questionKey]?.trim()
  const selected = state.answers[questionKey] || ""
  if (multiSelect) {
    return [selected, custom]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(", ").filter(Boolean))
  }
  const value = custom || selected
  return value ? [value] : []
}

export function questionKey(question: AskUserQuestionItem): string {
  return question.id || question.question
}

function wantPayloads(model: Model, entryIds: ReadonlyArray<string>): Return {
  const fresh = entryIds.filter((entryId) => entryId && !model.payloads[entryId] && !model.inFlight[entryId])
  if (fresh.length === 0) return { model }
  const inFlight = { ...model.inFlight }
  for (const entryId of fresh) inFlight[entryId] = true
  const wasQueued = model.queued.length > 0
  return {
    model: { ...model, inFlight, queued: [...model.queued, ...fresh] },
    commands: wasQueued ? [] : [FlushPayloadRequests()],
  }
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ToggledOpen: ({ key }) => ({ model: modifyFields(model, { open: (open) => ({ ...open, [key]: !open[key] }) }) }),
    SetOpen: ({ key, open }) => ({ model: modifyFields(model, { open: (current) => ({ ...current, [key]: open }) }) }),

    ClickedCopy: ({ key, block, text }) => ({ model, commands: [CopyText({ key, block, text })] }),
    ClickedCodeCopy: ({ key, copy }) => ({ model, commands: [CopyText({ key, block: copy.block, text: copy.text })] }),
    CompletedCopy: ({ key, block, didCopy }) => {
      if (!didCopy) return { model }
      const version = model.copyVersion + 1
      return { model: { ...model, copyVersion: version, copied: { key, block, version } }, commands: [WaitCopied({ version })] }
    },
    ElapsedCopied: ({ version }) => ({ model: model.copied?.version === version ? { ...model, copied: null } : model }),
    ClickedLocalLink: ({ target }) => ({ model, outMessage: OutMessage.OpenedLocalLink({ target }) }),
    ClickedChatLink: ({ chatId }) => ({ model, outMessage: OutMessage.OpenedChat({ chatId }) }),

    MeasuredClamp: ({ key, overflows }) => (
      Boolean(model.overflows[key]) === overflows ? { model } : { model: modifyFields(model, { overflows: (all) => ({ ...all, [key]: overflows }) }) }
    ),
    PressedClampControl: ({ key, id, from, byKeyboard, lines, scope }) => {
      const expanding = !model.open[key]
      return {
        model: modifyFields(model, { open: (open) => ({ ...open, [key]: expanding }) }),
        commands: [MoveClamp({ id, expanding, from, byKeyboard, lines, scope })],
      }
    },
    PressedFoldSurface: ({ key, id, from, lines, scope }) => {
      // Only while folded: open, the bubble is text to read and select.
      if (model.open[key] || !model.overflows[key]) return { model }
      return {
        model: modifyFields(model, { open: (open) => ({ ...open, [key]: true }) }),
        commands: [MoveClamp({ id, expanding: true, from, byKeyboard: false, lines, scope })],
      }
    },
    CompletedClampMotion: () => ({ model }),

    WantedPayloads: ({ entryIds }) => wantPayloads(model, entryIds),
    FlushedPayloadRequests: () => (
      model.queued.length === 0
        ? { model }
        : { model: { ...model, queued: [] }, outMessage: OutMessage.RequestedToolEntries({ entryIds: model.queued }) }
    ),
    OpenedRawMessage: ({ key, entryId }) => {
      const opened = modifyFields(model, { open: (open) => ({ ...open, [key]: true }) })
      const current = model.debugRaw[entryId]
      if (current && (current.state !== "idle" || current.body !== null)) return { model: opened }
      return {
        model: modifyFields(opened, { debugRaw: (all) => ({ ...all, [entryId]: { state: "loading" as const, body: null } }) }),
        outMessage: OutMessage.RequestedDebugRaw({ entryId }),
      }
    },

    SelectedOption: ({ toolId, questions, questionKey: key, label, multiSelect }) => {
      const state = questionOf(model, toolId)
      if (multiSelect) {
        const current = state.answers[key] ? state.answers[key]!.split(", ").filter(Boolean) : []
        const next = current.includes(label) ? current.filter((option) => option !== label) : [...current, label]
        return { model: withQuestion(model, toolId, { ...state, answers: { ...state.answers, [key]: next.join(", ") } }) }
      }
      const next = { ...state, answers: { ...state.answers, [key]: label }, customInputs: { ...state.customInputs, [key]: "" } }
      // Auto-advance to the next question for single select.
      return {
        model: withQuestion(model, toolId, next),
        commands: state.currentIndex < questions.length - 1 ? [AdvanceQuestion({ toolId, index: state.currentIndex + 1 })] : [],
      }
    },
    AdvancedQuestion: ({ toolId, index }) => ({ model: withQuestion(model, toolId, { ...questionOf(model, toolId), currentIndex: index }) }),
    ChangedCustomInput: ({ toolId, questionKey: key, value, multiSelect }) => {
      const state = questionOf(model, toolId)
      const answers = value && !multiSelect ? { ...state.answers, [key]: "" } : state.answers
      return { model: withQuestion(model, toolId, { ...state, answers, customInputs: { ...state.customInputs, [key]: value } }) }
    },
    ClearedCustomInput: ({ toolId, questionKey: key }) => {
      const state = questionOf(model, toolId)
      return { model: withQuestion(model, toolId, { ...state, customInputs: { ...state.customInputs, [key]: "" } }) }
    },
    ClickedNextQuestion: ({ toolId, count }) => {
      const state = questionOf(model, toolId)
      return state.currentIndex < count - 1 ? { model: withQuestion(model, toolId, { ...state, currentIndex: state.currentIndex + 1 }) } : { model }
    },
    ClickedPreviousQuestion: ({ toolId }) => {
      const state = questionOf(model, toolId)
      return state.currentIndex > 0 ? { model: withQuestion(model, toolId, { ...state, currentIndex: state.currentIndex - 1 }) } : { model }
    },
    SubmittedAnswers: ({ toolId, questions, answers }) => {
      const state = questionOf(model, toolId)
      if (state.submitted) return { model }
      return {
        model: withQuestion(model, toolId, { ...state, submitted: answers }),
        outMessage: OutMessage.SubmittedAskUserQuestion({ toolUseId: toolId, questions, answers }),
      }
    },

    ClickedSuggestEdits: ({ toolId }) => ({
      model: withPlan(model, toolId, { ...planOf(model, toolId), editing: true }),
      commands: [FocusPlanDraft({ toolId })],
    }),
    ChangedPlanDraft: ({ toolId, value }) => ({ model: withPlan(model, toolId, { ...planOf(model, toolId), draft: value }) }),
    CancelledPlanEdit: ({ toolId }) => ({ model: withPlan(model, toolId, EMPTY_PLAN) }),
    ConfirmedPlan: ({ toolId, confirmed, clearContext, message: text }) => ({
      model,
      outMessage: OutMessage.ConfirmedExitPlanMode({
        toolUseId: toolId,
        confirmed,
        ...(clearContext !== undefined ? { clearContext } : {}),
        ...(text !== undefined ? { message: text } : {}),
      }),
    }),
    CompletedFocus: () => ({ model }),

    ToggledChartSeries: ({ key, series }) => {
      const chart = chartOf(model, key)
      const hidden = chart.hidden.includes(series) ? chart.hidden.filter((entry) => entry !== series) : [...chart.hidden, series]
      return { model: withChart(model, key, { ...chart, hidden }) }
    },
    HoveredChartSeries: ({ key, series }) => ({ model: withChart(model, key, { ...chartOf(model, key), active: series }) }),
    MovedOverChart: ({ key, pointer }) => {
      const chart = chartOf(model, key)
      if (chart.hover?.x === pointer?.x && chart.hover?.y === pointer?.y) return { model }
      return { model: withChart(model, key, { ...chart, hover: pointer }) }
    },
    MeasuredChartTooltip: ({ key, width, height }) => {
      const chart = chartOf(model, key)
      if (chart.tooltip?.width === width && chart.tooltip?.height === height) return { model }
      return { model: withChart(model, key, { ...chart, tooltip: { width, height } }) }
    },
    MeasuredChart: ({ key, width, height }) => {
      const chart = chartOf(model, key)
      if (chart.size?.width === width && chart.size?.height === height) return { model }
      return { model: withChart(model, key, { ...chart, size: { width, height } }) }
    },
    ClickedDownloadChartCsv: ({ csv, filename }) => ({ model, commands: [DownloadCsv({ csv, filename })] }),
    CompletedDownload: () => ({ model }),
    ClickedExpandChart: ({ payload }) => ({ model, outMessage: viewerAction({ kind: "chart", payload }, false) }),
    GotAggregateSelectMessage: ({ key, which, message: child }) => {
      const id = selectKey(key, which)
      const next = Select.update(selectOf(model, key, which), child)
      const withSelect = { ...model, selects: { ...model.selects, [id]: next.model } }
      const chart = chartOf(withSelect, key)
      const chosen = next.outMessage && Schema.is(AggregateMode)(next.outMessage.value) ? next.outMessage.value : null
      return {
        model: chosen ? withChart(withSelect, key, which === "row" ? { ...chart, rowAggregate: chosen } : { ...chart, columnAggregate: chosen }) : withSelect,
        commands: Command.mapMessages(next.commands, (message: Select.Message) => Message.GotAggregateSelectMessage({ key, which, message })),
      }
    },
    ResizedChartColumn: ({ key, width }) => {
      const chart = chartOf(model, key)
      const clamped = Math.min(360, Math.max(128, width))
      return chart.firstColumnWidth === clamped ? { model } : { model: withChart(model, key, { ...chart, firstColumnWidth: clamped }) }
    },
    MeasuredChartTable: ({ key, width }) => {
      const chart = chartOf(model, key)
      return chart.tableViewport === width ? { model } : { model: withChart(model, key, { ...chart, tableViewport: width }) }
    },
    MeasuredStrip: ({ key, strip }) => {
      const current = model.strips[key] ?? EMPTY_STRIP
      if (current.moreLeft === strip.moreLeft && current.moreRight === strip.moreRight && current.scrollbarHeight === strip.scrollbarHeight) return { model }
      return { model: modifyFields(model, { strips: (all) => ({ ...all, [key]: strip }) }) }
    },
    FailedAttachmentPreview: ({ key, url }) => ({ model: modifyFields(model, { broken: (all) => ({ ...all, [`${key}|${url}`]: true }) }) }),
    ClickedAttachment: ({ target }) => (
      target.viewer
        ? { model, outMessage: viewerAction({ kind: "attachment", attachment: target.viewer }, false) }
        : { model, commands: [OpenInNewTab({ url: target.url })] }
    ),
    CompletedOpenInNewTab: () => ({ model }),

    GotFrameDocument: ({ key, document }) => ({ model: { ...model, frames: { ...model.frames, [key]: { ...(model.frames[key] ?? emptyFrame()), document, failed: false } } } }),
    FailedFrameDocument: ({ key }) => ({ model: { ...model, frames: { ...model.frames, [key]: { ...(model.frames[key] ?? emptyFrame()), failed: true } } } }),
    MeasuredFrameWidth: ({ key, width }) => {
      const frame = model.frames[key] ?? emptyFrame()
      return frame.width === width ? { model } : { model: { ...model, frames: { ...model.frames, [key]: { ...frame, width } } } }
    },
    KnewFrameHeights: ({ key, heights }) => {
      const frame = model.frames[key] ?? emptyFrame()
      return { model: { ...model, frames: { ...model.frames, [key]: { ...frame, known: heights } } } }
    },
    ResizedFrame: ({ key, height }) => {
      const frame = model.frames[key] ?? emptyFrame()
      return frame.measured === height ? { model } : { model: { ...model, frames: { ...model.frames, [key]: { ...frame, measured: height } } } }
    },
    LoadedFrame: ({ key }) => ({ model: { ...model, frames: { ...model.frames, [key]: { ...(model.frames[key] ?? emptyFrame()), loaded: true } } } }),
    ClickedExpandVisualization: ({ artifact }) => ({ model, outMessage: viewerAction({ kind: "visualization", artifact }, true) }),
    PressedEscapeInFrame: ({ key, repeat }) => ({ model, outMessage: OutMessage.EscapedVisualization({ key, repeat }) }),
    GotTooltipMessage: ({ key, message: child }) => {
      const next = Tooltip.update(tooltipOf(model, key), child)
      return {
        model: { ...model, tooltips: { ...model.tooltips, [key]: next.model } },
        commands: Command.mapMessages(next.commands, (message: Tooltip.Message) => Message.GotTooltipMessage({ key, message })),
      }
    },

    ClickedQueued: ({ messageId, action }) => (
      model.busy[`queued:${messageId}`]
        ? { model }
        : { model: modifyFields(model, { busy: (busy) => ({ ...busy, [`queued:${messageId}`]: true }) }), outMessage: OutMessage.RequestedQueueAction({ messageId, action }) }
    ),
    ClickedResume: ({ key, action }) => (
      model.busy[key]
        ? { model }
        : { model: modifyFields(model, { busy: (busy) => ({ ...busy, [key]: true }) }), outMessage: OutMessage.RequestedResumeAction({ action }) }
    ),
    ClickedStop: () => ({ model, outMessage: OutMessage.RequestedStop() }),
  })

function emptyFrame(): FrameState {
  return { document: null, failed: false, width: null, measured: null, known: [], loaded: false }
}

/** Open something in the viewer, as `openViewer(item, { expanded })` did. */
function viewerAction(item: Viewer.ViewerItem, expanded: boolean) {
  return OutMessage.RequestedAppAction({
    action: AppAction.Store({
      message: Stores.Message.GotViewerMessage({ message: Viewer.Message.OpenedItem({ item, expanded, byKey: false }) }),
    }),
  })
}

// ── Entry points for the parent ──────────────────────────────────────────

/** `chat.getToolEntries` came back: the entries it found, by id. */
export function receivedToolEntries(model: Model, requested: ReadonlyArray<string>, entries: ReadonlyArray<TranscriptEntry>): Model {
  const payloads = { ...model.payloads }
  for (const entry of entries) payloads[entry._id] = entry
  const inFlight = { ...model.inFlight }
  for (const entryId of requested) delete inFlight[entryId]
  return { ...model, payloads, inFlight }
}

/**
 * `chat.getToolEntries` failed. Swallowed on purpose, as toolPayloadStore
 * does: the row stays in its loading state, and forgetting the request lets
 * the next open retry.
 */
export function failedToolEntries(model: Model, requested: ReadonlyArray<string>): Model {
  return receivedToolEntries(model, requested, [])
}

/** `chat.getEntryDebugRaw` came back (null: nothing stored, drawn as an empty body), or failed. */
export function receivedDebugRaw(model: Model, entryId: string, result: Option.Option<string | null>): Model {
  const next: DebugRawState = Option.match(result, {
    onNone: () => ({ state: "error" as const, body: null }),
    onSome: (body) => ({ state: "idle" as const, body: body ?? "" }),
  })
  return { ...model, debugRaw: { ...model.debugRaw, [entryId]: next } }
}

/** The command a queued message's press sent has settled, either way: the row is usable again. */
export function settledQueued(model: Model, messageId: string): Model {
  const busy = { ...model.busy }
  delete busy[`queued:${messageId}`]
  return { ...model, busy }
}

/** As `settledQueued`, for a usage-limit resume row (`key` as given to its view). */
export function settledResume(model: Model, key: string): Model {
  const busy = { ...model.busy }
  delete busy[key]
  return { ...model, busy }
}

/**
 * Forget everything held for a chat, as React dropped its components and
 * its payload store on a chat switch (`useMemo` on the chat id).
 */
/**
 * The rows' state for a new showing. What the rows measured of the page
 * stays (a chart's size, whether a prompt overflows its clamp): the DOM it
 * describes is the same, and a measure that lands before the viewport's
 * own mount is only reported again when the size changes.
 */
export function reset(previous?: Model): Model {
  const fresh = init()
  if (!previous) return fresh
  const charts = Object.fromEntries(Object.entries(previous.charts).flatMap(([key, chart]) =>
    chart.size ? [[key, { ...EMPTY_CHART, size: chart.size, tableViewport: chart.tableViewport }]] : []))
  return { ...fresh, charts, overflows: previous.overflows }
}

