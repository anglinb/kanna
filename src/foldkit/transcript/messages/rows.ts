import type { Html, HtmlBuilder } from "foldkit/html"
import { CHAT_SELECTION_ZONE_ATTRIBUTE } from "../../../client/app/chatFocusPolicy"
import { stripSystemMessages } from "../../../shared/message-preview"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { askUserQuestionMessage } from "./ask-user-question"
import type { RowContext } from "./context"
import { exitPlanModeMessage } from "./exit-plan-mode"
import type { Message } from "./model"
import {
  accountInfoMessage,
  compactBoundaryMessage,
  compactSummaryMessage,
  contextClearedMessage,
  formatPromptBoundary,
  interruptedMessage,
  promptOriginLabel,
  rawJsonMessage,
  resultMessage,
  statusMessage,
  textMessage,
  timeBoundary,
  todoWriteMessage,
} from "./simple"
import { sourcedMessage, sourcedSections } from "./sourced"
import { systemMessage, type SessionHandoff, type SessionRestore } from "./system"
import { toolCallMessage } from "./tool-call"
import { collapsedToolGroup } from "./tool-group"
import { userMessage } from "./user"

/**
 * One transcript row, as KannaTranscript's TranscriptSingleRow and
 * TranscriptToolGroup draw it: which component a message gets and with what.
 * The row shapes match React's `ResolvedSingleTranscriptRow` and
 * `ResolvedToolGroupTranscriptRow` (KannaTranscript.tsx), which the viewport
 * builds with `buildResolvedTranscriptRows`.
 */

export interface SingleRow {
  kind: "single"
  id: string
  message: HydratedTranscriptMessage
  index: number
  isLoading: boolean
  localPath?: string
  isFirstSystem: boolean
  isModelChange: boolean
  handoff?: SessionHandoff
  restored?: SessionRestore
  isFirstAccount: boolean
  isLatestAskUserQuestion: boolean
  isLatestExitPlanMode: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  nextPromptTimestamp?: string
  nextPromptOrigin?: string
  showsOwnBoundary?: boolean
}

export interface ToolGroupRow {
  kind: "tool-group"
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
}

export type TranscriptRow = SingleRow | ToolGroupRow

type Prompt = Extract<HydratedTranscriptMessage, { kind: "user_prompt" }>

/**
 * Whether a prompt draws anything of its own. One that is all
 * `<system-message>` has nothing for a reader, except the news that a
 * sub-chat was adopted away.
 */
export function promptHasBody(message: Prompt) {
  if (stripSystemMessages(message.content).length > 0 || (message.attachments?.length ?? 0) > 0) return true
  return message.source?.kind === "report" && sourcedSections(message.content, message.source).length > 0
}

/** What a prompt's time boundary says about who sent it: nothing when it has a bubble. */
export function promptBoundaryOrigin(message: Prompt) {
  return promptHasBody(message) ? undefined : promptOriginLabel(message.source)
}

/** What a single row draws, without the row's wrapper, or null. */
export function singleRowContent(row: SingleRow, flash: boolean, context: RowContext, h: HtmlBuilder<Message>): Html {
  const { message } = row
  if (message.kind === "user_prompt") {
    const bubble = !promptHasBody(message)
      ? null
      : message.source
        ? sourcedMessage({ id: message.id, content: message.content, source: message.source, attachments: message.attachments, steered: message.steered }, { flash }, context, h)
        : userMessage(message, { flash }, context, h)
    // 20px apart, the gap two transcript rows sit at, so the boundary reads as the row above.
    return row.showsOwnBoundary
      ? h.div([h.Class("flex flex-col gap-5")], [timeBoundary(formatPromptBoundary(message.timestamp, promptBoundaryOrigin(message)), h), bubble])
      : bubble
  }
  switch (message.kind) {
    case "unknown":
      return rawJsonMessage(message.json, h)
    case "system_init":
      return row.isFirstSystem || row.isModelChange || row.handoff || row.restored
        ? systemMessage(message, {
          rawJson: message.debugRaw,
          modelChanged: !row.isFirstSystem && row.isModelChange,
          handoff: row.isFirstSystem ? undefined : row.handoff,
          restored: row.isFirstSystem ? undefined : row.restored,
        }, context, h)
        : null
    case "account_info":
      return row.isFirstAccount ? accountInfoMessage(message, context, h) : null
    case "assistant_text":
      return textMessage(message, context, h)
    case "tool":
      if (message.toolKind === "ask_user_question") return askUserQuestionMessage(message, row.isLatestAskUserQuestion, context, h)
      if (message.toolKind === "exit_plan_mode") return exitPlanModeMessage(message, row.isLatestExitPlanMode, context, h)
      if (message.toolKind === "todo_write") return row.isLatestTodoWrite ? todoWriteMessage(message, h) : null
      return toolCallMessage(message, { isLoading: row.isLoading, localPath: row.localPath }, context, h)
    case "result":
      return row.hideResult ? null : resultMessage(message, { timestamp: row.nextPromptTimestamp, origin: row.nextPromptOrigin }, h)
    case "context_window_updated":
      return null
    case "interrupted":
      return interruptedMessage(h)
    case "compact_boundary":
      return compactBoundaryMessage(h)
    case "context_cleared":
      return contextClearedMessage(h)
    case "compact_summary":
      return compactSummaryMessage(message, context, h)
    case "status":
      return row.isFinalStatus ? statusMessage(message, h) : null
    default:
      return null
  }
}

/**
 * A row as KannaTranscriptRow draws it, wrapper included: `msg-<id>`,
 * `group relative`, the row's index and the chat's selection zone. Null when
 * the row draws nothing. `flash` lights a user prompt's bubble.
 */
export function transcriptRow(row: TranscriptRow, flash: boolean, context: RowContext, h: HtmlBuilder<Message>): Html {
  if (row.kind === "tool-group") {
    return h.div([h.Class("group relative"), h.Attribute(CHAT_SELECTION_ZONE_ATTRIBUTE, "")], [
      collapsedToolGroup(row.id, row.messages, { isLoading: row.isLoading, localPath: row.localPath }, context, h),
    ])
  }
  const rendered = singleRowContent(row, flash, context, h)
  if (!rendered) return null
  return h.div([
    h.Id(`msg-${row.message.id}`),
    h.Class("group relative"),
    h.DataAttribute("index", String(row.index)),
    h.Attribute(CHAT_SELECTION_ZONE_ATTRIBUTE, ""),
  ], [rendered])
}
