/**
 * The transcript's message rows: every row a chat's transcript draws, from
 * a hydrated message (`HydratedTranscriptMessage`, as
 * `processTranscriptMessages` makes it), with the same DOM as
 * src/client/components/messages/* and KannaTranscript's row switch.
 *
 * ── Shape ────────────────────────────────────────────────────────────────
 *
 * A Submodel. Its Model holds the state rows keep of their own, keyed by
 * row (what is open, copy checks, a question's picks before Submit, a plan's
 * draft, fetched tool payloads, chart legends, visualization frames, queued
 * presses in flight), so the viewport holds ONE Model for all rows:
 *
 *   Model:    messages: Messages.Model                 init: Messages.init()
 *   Message:  GotMessagesMessage: { message: Messages.Message }
 *   update:   Update.foldChild({ update: Messages.update, … ,
 *               foldOutMessage: Messages.OutMessage.match({ … }) })
 *   view:     per row,
 *     h.submodel({
 *       slotId: row.id, model: model.messages, view: Messages.view,
 *       viewInputs: { item: { kind: "row", row, flash }, options, now, …references },
 *       toParentMessage: (message) => GotMessagesMessage({ message }),
 *     })
 *
 * Reset it on a chat switch (`Messages.init()`): entry ids and keys are
 * per chat, as React's payload store and row state were.
 *
 * ── Rows (`view`'s `item`) ───────────────────────────────────────────────
 *
 *   { kind: "row", row, flash? }   one transcript row, wrapper included
 *                                  (`msg-<id>`, data-index, selection zone).
 *                                  `row` is React's ResolvedTranscriptRow
 *                                  (`SingleRow | ToolGroupRow`, rows.ts).
 *   { kind: "queued", message }    a queued prompt (QueuedUserMessage)
 *   { kind: "usage-limit", resume, key }   UsageLimitResumeRow
 *   { kind: "processing", status?, waitingOn? }   ProcessingMessage
 *   { kind: "draining" }           DrainingIndicator
 *   { kind: "parent-chat-link", parentChatId }    ParentChatLink
 *
 * The view functions behind these (`transcriptRow`, `toolCallMessage`,
 * `userMessage`, …) are exported too, for a host that draws inside its own
 * boundary with this module's Message type.
 *
 * ── What the rows ask of the host (OutMessage) ───────────────────────────
 *
 *   SubmittedAskUserQuestion { toolUseId, questions, answers }
 *                       → `chat.respondTool` as onAskUserQuestionSubmit
 *   ConfirmedExitPlanMode { toolUseId, confirmed, clearContext?, message? }
 *                       → as onExitPlanModeConfirm
 *   RequestedToolEntries { entryIds }
 *                       → `chat.getToolEntries` for the page's chat; answer
 *                         with `receivedToolEntries(model, entryIds, entries)`
 *                         or `failedToolEntries(model, entryIds)`. Batched per
 *                         tick, an id is never asked for twice.
 *   RequestedDebugRaw { entryId }
 *                       → `chat.getEntryDebugRaw`; answer with
 *                         `receivedDebugRaw(model, entryId, Option)`
 *   OpenedLocalLink { target }      a local file link (needs
 *                                   `options.interceptLocalLinks`)
 *   OpenedChat { chatId }           a chat link, report line or name
 *                                   (needs `canOpenChats`)
 *   RequestedQueueAction { messageId, action }   then `settledQueued`
 *   RequestedResumeAction { action }             then `settledResume`
 *   RequestedStop {}                DrainingIndicator's Stop
 *   RequestedAppAction { action }   the viewer: an attachment, a chart or a
 *                                   visualization at full size
 *
 * ── View inputs ──────────────────────────────────────────────────────────
 *
 *   options      React's TranscriptRenderOptions plus which providers exist
 *                (`RenderOptions`, context.ts). Default: live, no local-link
 *                handler, no raw-JSON loader.
 *   now          wall clock, ms (schedule "in 4m", resume times)
 *   References (all optional; absent = outside a chat page: plain cards):
 *   canOpenChats, sidebarThread(chatId), sidebarReady, currentProjectId,
 *   schedules, renderChatCard(card), renderScheduleCard(card): the sidebar
 *   row a live chat card is (ThreadRowContent, its menu and hover card) and
 *   a schedule card's menu and hover card belong to the sidebar and widgets
 *   slices, so the host draws them.
 *
 * ── Not here ─────────────────────────────────────────────────────────────
 *
 *   The full-size chart and visualization are cards of the viewer
 *   (ViewerSurface), which the viewer slice draws. For the chart, the card's
 *   body is here (`chartFullViewBody`: the chart and its data table, with
 *   the aggregate menus and the resizable first column; its state is this
 *   Model's, under the key the viewer gives it) and so is its toolbar's
 *   action (`downloadChartTable`). For the visualization, the frame
 *   (`visualizationFrame`); Download image and Mark up
 *   (VisualizationSaveDialog, VisualizationMarkup) are the viewer's.
 *
 * ── Fixtures ─────────────────────────────────────────────────────────────
 *
 *   fixture.ts holds the messages the parity galleries draw
 *   (src/parity/{react,foldkit}/gallery/messages-*), through
 *   `processTranscriptMessages`, with rows built as the resolver would.
 */
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import type { SidebarThread } from "../../../client/lib/thread-sections"
import type { AgentProvider, QueuedChatMessage, WaitingOn } from "../../../shared/types"
import { rowContext, type LiveChatCard, type LiveScheduleCard, type References, type RenderOptions, type ScheduleReferences } from "./context"
import type { Message, Model } from "./model"
import { parentChatLink } from "./parent-chat-link"
import { queuedUserMessage, usageLimitResumeRow } from "./queued"
import { transcriptRow, type TranscriptRow } from "./rows"
import { drainingIndicator, processingMessage } from "./simple"

export {
  ClampScope,
  EMPTY_CHART,
  EMPTY_PLAN,
  EMPTY_QUESTION,
  failedToolEntries,
  init,
  keys,
  Message,
  Model,
  OutMessage,
  receivedDebugRaw,
  receivedToolEntries,
  reset,
  settledQueued,
  settledResume,
  update,
  type AttachmentTarget,
} from "./model"
export { DEFAULT_RENDER_OPTIONS, rowContext, type LiveChatCard, type LiveScheduleCard, type References, type RenderOptions, type RowContext, type ScheduleReferences } from "./context"
export { promptBoundaryOrigin, promptHasBody, singleRowContent, transcriptRow, type SingleRow, type ToolGroupRow, type TranscriptRow } from "./rows"
export { formatToolCallTitle, subagentResultText, toolCallExpandedContent, toolCallMessage, type ToolCall } from "./tool-call"
export { collapsedGroup, collapsedToolGroup, toolGroupLabel } from "./tool-group"
export {
  accountInfoMessage,
  assistantText,
  compactBoundaryMessage,
  compactSummaryMessage,
  contextClearedMessage,
  drainingIndicator,
  formatDuration,
  formatPromptBoundary,
  formatPromptTimestamp,
  interruptedMessage,
  processingMessage,
  promptOriginLabel,
  rawJsonMessage,
  resultMessage,
  statusMessage,
  textMessage,
  timeBoundary,
  todoWriteMessage,
} from "./simple"
export { systemMessage, type SessionHandoff, type SessionRestore } from "./system"
export { userMessage, USER_BUBBLE_CLASS } from "./user"
export { adoptionNotice, isAdoptionNotice, replyQuoteRow, reportMarker, sourcedMessage, sourcedSections, sourceQuote, REPLY_QUOTE_WIDTH_CLASS } from "./sourced"
export { queuedUserMessage, usageLimitResumeRow } from "./queued"
export { messageNamingParent, parentChatLink } from "./parent-chat-link"
export { askUserQuestionMessage } from "./ask-user-question"
export { exitPlanModeMessage } from "./exit-plan-mode"
export { attachmentFileCard, attachmentImageCard, formatAttachmentSize, userMessageAttachments } from "./attachments"
export { chatCard, chatReplyQuote, chatToolMessage, inlineChatToolExcerpt, inlineChatToolTarget, isChatToolCall, replyCaption, INTERIM_REPLY_NOTE } from "./chat-tool"
export { formatScheduleState, formatScheduleTrigger, formatUntil, isScheduleToolCall, scheduleCardBox, scheduleToolMessage } from "./schedule-tool"
export { attachmentsCard, displayToolMessage } from "./display-tool"
// The chart and the frame are also what the viewer's full-size chart and
// visualization draw (ChartFullView, VisualizationFullView): `chartFigure`
// with its own key and class, `visualizationFrame` with its own key.
export { aggregateValues, AGGREGATE_OPTIONS, chartDataTable, chartFigure, chartFullViewBody, chartModel, chartTool, csvCell, downloadChartTable, formatChartCell, niceTicks, type AggregateMode, type ChartModel, type ChartTableData } from "./chart"
export { visualization, visualizationExpandButton, visualizationFrame, visualizationTheme } from "./visualization"
export { CLAMP_LINES, clampedMessageText, isFoldClick } from "./clamped"
export { fileContentView } from "./file-content"

/** What one embed draws. */
export type Item =
  | { kind: "row"; row: TranscriptRow; flash?: boolean }
  | { kind: "queued"; message: QueuedChatMessage }
  | { kind: "usage-limit"; resume: { at: number; provider: AgentProvider }; key: string }
  | { kind: "processing"; status?: string; waitingOn?: WaitingOn }
  | { kind: "draining" }
  | { kind: "parent-chat-link"; parentChatId: string }

/**
 * Functions are top-level (Foldkit runs them in the host's boundary, so a
 * live card's own handlers are the host's).
 */
export interface ViewInputs {
  item: Item
  options?: Partial<RenderOptions>
  now?: number
  canOpenChats?: boolean
  sidebarThread?: (chatId: string | null | undefined) => SidebarThread | null
  sidebarReady?: boolean
  currentProjectId?: string | null
  schedules?: ScheduleReferences | null
  renderChatCard?: (card: LiveChatCard) => Html
  renderScheduleCard?: (card: LiveScheduleCard) => Html
}

function referencesOf(inputs: ViewInputs): References | null {
  if (!inputs.sidebarThread && !inputs.canOpenChats && !inputs.schedules && !inputs.sidebarReady) return null
  return {
    canOpenChats: inputs.canOpenChats ?? false,
    thread: inputs.sidebarThread ?? (() => null),
    sidebarReady: inputs.sidebarReady ?? false,
    currentProjectId: inputs.currentProjectId ?? null,
    schedules: inputs.schedules ?? null,
    ...(inputs.renderChatCard ? { renderChatCard: inputs.renderChatCard } : {}),
    ...(inputs.renderScheduleCard ? { renderScheduleCard: inputs.renderScheduleCard } : {}),
  }
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const context = rowContext(model, inputs.options, referencesOf(inputs), inputs.now)
  const item = inputs.item
  switch (item.kind) {
    case "row":
      return transcriptRow(item.row, item.flash ?? false, context, h)
    case "queued":
      return queuedUserMessage(item.message, context, h)
    case "usage-limit":
      return usageLimitResumeRow(item.resume, item.key, context, h)
    case "processing":
      return processingMessage(item.status, item.waitingOn, h)
    case "draining":
      return drainingIndicator(h)
    case "parent-chat-link":
      return parentChatLink(item.parentChatId, context, h)
  }
})
