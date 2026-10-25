import { foldRuns } from "../../client/lib/fold-runs"
import { SPECIAL_TOOL_NAMES } from "../../client/app/derived"
import type { HydratedTranscriptMessage } from "../../shared/types"
import { isChatToolCall, isScheduleToolCall, promptBoundaryOrigin, type SingleRow, type ToolCall, type TranscriptRow } from "./messages"
import type { SessionHandoff, SessionRestore } from "./messages"

// KannaTranscript's row resolver (src/client/app/KannaTranscript.tsx): which
// messages draw a row, which fold into a tool group, and the flags each row
// is drawn with. Pure code in a React file, so copied (comments kept); the
// row shapes are the messages module's (`SingleRow`, `ToolGroupRow`), which
// match React's `ResolvedTranscriptRow`.

const SPECIAL_TOOL_NAME_SET = new Set<string>(SPECIAL_TOOL_NAMES)

interface TranscriptMessageRenderState {
  isFirstSystem: boolean
  isModelChange: boolean
  handoff?: SessionHandoff
  restored?: SessionRestore
  isFirstAccount: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  nextPromptTimestamp?: string
  /** On a result: who sent the prompt that follows, when not the user. */
  nextPromptOrigin?: string
  /** On a prompt nobody typed that no result's boundary introduces: it draws its own. */
  showsOwnBoundary?: boolean
  shouldRender: boolean
}

function isCollapsibleToolCall(message: HydratedTranscriptMessage) {
  if (message.kind !== "tool") return false
  // A chat's card or a schedule's stands on its own like a chart does: folded
  // into "3 tool calls" it would hide the one thing it is there to show.
  if (message.toolKind === "ask_user_question" || message.toolKind === "display") return false
  if (isChatToolCall(message as ToolCall) || isScheduleToolCall(message as ToolCall)) return false
  return !SPECIAL_TOOL_NAME_SET.has(message.toolName)
}

function getTranscriptMessageRenderState(
  message: HydratedTranscriptMessage,
  state: Omit<TranscriptMessageRenderState, "shouldRender">,
): TranscriptMessageRenderState {
  let shouldRender = !message.hidden

  if (shouldRender) {
    switch (message.kind) {
      case "system_init":
        shouldRender = state.isFirstSystem || state.isModelChange || state.handoff !== undefined || state.restored !== undefined
        break
      case "handoff_boundary":
        // Not rendered as its own row — the switch surfaces on the next
        // session_init ("Codex").
        shouldRender = false
        break
      case "session_restored":
        // Not rendered as its own row — the repair surfaces on the next
        // session_init ("Session Repaired").
        shouldRender = false
        break
      case "account_info":
        shouldRender = state.isFirstAccount
        break
      case "tool":
        shouldRender = message.toolKind !== "todo_write" || state.isLatestTodoWrite
        break
      case "result":
        shouldRender = !state.hideResult
        break
      case "context_window_updated":
        shouldRender = false
        break
      case "status":
        shouldRender = state.isFinalStatus
        break
      default:
        shouldRender = true
        break
    }
  }

  return { ...state, shouldRender }
}

function buildTranscriptMessageRenderStates(
  messages: ReadonlyArray<HydratedTranscriptMessage>,
  latestToolIds: Record<string, string | null>,
) {
  // The transcript always arrives whole, so the first system/account row here
  // is genuinely the chat's first.
  const firstSystemIndex = messages.findIndex((entry) => entry.kind === "system_init")
  const firstAccountIndex = messages.findIndex((entry) => entry.kind === "account_info")

  // Timestamp of the next visible user prompt after each message (undefined when none follows).
  const nextPromptTimestamps = new Array<string | undefined>(messages.length)
  // And who sent it, when the user did not: the boundary above it says so.
  const nextPromptOrigins = new Array<string | undefined>(messages.length)
  let upcomingPromptTimestamp: string | undefined
  let upcomingPromptOrigin: string | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    nextPromptTimestamps[index] = upcomingPromptTimestamp
    nextPromptOrigins[index] = upcomingPromptOrigin
    const message = messages[index]!
    if (message.kind === "user_prompt" && !message.hidden) {
      upcomingPromptTimestamp = message.timestamp
      upcomingPromptOrigin = promptBoundaryOrigin(message)
    }
  }

  // Successful results of turns that showed nothing: background task
  // notifications wake the agent for a turn that often writes no text and
  // calls no tools, and each one would otherwise leave a bare "Worked for 3ms".
  const emptyTurnResults = new Array<boolean>(messages.length).fill(false)
  let turnHasContent = false
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.kind === "user_prompt") {
      turnHasContent = false
    } else if ((message.kind === "assistant_text" || message.kind === "tool") && !message.hidden) {
      turnHasContent = true
    } else if (message.kind === "result") {
      emptyTurnResults[index] = message.success && !turnHasContent
      turnHasContent = false
    }
  }

  // A prompt's time boundary is the divider that closed the turn before it, so
  // a prompt with no such divider has none: the chat's first message, or one
  // after a turn that was stopped or failed. That is fine for a prompt the
  // user typed. One an agent or a schedule sent has to say so, so it draws a
  // boundary of its own.
  const ownBoundaries = new Array<boolean>(messages.length).fill(false)
  let boundaryAhead = false
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.kind === "result") {
      const hidden = message.hidden
        || emptyTurnResults[index]
        || messages[index + 1]?.kind === "context_cleared"
        || messages[index - 1]?.kind === "context_cleared"
      // A failed result draws an error, not a time.
      if (!hidden && message.success) boundaryAhead = true
    } else if (message.kind === "user_prompt" && !message.hidden) {
      ownBoundaries[index] = message.source !== undefined && !boundaryAhead
      boundaryAhead = false
    }
  }

  // Mark session inits whose model differs from the previous session's model.
  const modelChanges = new Array<boolean>(messages.length).fill(false)
  let previousModel: string | undefined
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.kind !== "system_init") continue
    modelChanges[index] = previousModel !== undefined && message.model !== previousModel
    previousModel = message.model
  }

  // Attach each handoff boundary to the next session init: the switch renders
  // as that init's destination harness label rather than as its own row.
  // Session restores surface the same way ("Session Repaired").
  const handoffs = new Array<SessionHandoff | undefined>(messages.length)
  const restores = new Array<SessionRestore | undefined>(messages.length)
  let pendingHandoff: SessionHandoff | undefined
  let pendingRestore: SessionRestore | undefined
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.kind === "handoff_boundary") {
      pendingHandoff = { fromProvider: message.fromProvider, toProvider: message.toProvider }
      continue
    }
    if (message.kind === "session_restored") {
      pendingRestore = { provider: message.provider }
      continue
    }
    if (message.kind === "system_init") {
      if (pendingHandoff) {
        handoffs[index] = pendingHandoff
        pendingHandoff = undefined
      }
      if (pendingRestore) {
        restores[index] = pendingRestore
        pendingRestore = undefined
      }
    }
  }

  return messages.map<TranscriptMessageRenderState>((message, index) => {
    const previousMessage = messages[index - 1]
    const nextMessage = messages[index + 1]
    return getTranscriptMessageRenderState(message, {
      isFirstSystem: firstSystemIndex === index,
      isModelChange: modelChanges[index] ?? false,
      handoff: handoffs[index],
      restored: restores[index],
      isFirstAccount: firstAccountIndex === index,
      isLatestTodoWrite: message.id === latestToolIds.TodoWrite,
      hideResult: emptyTurnResults[index]
        || nextMessage?.kind === "context_cleared"
        || previousMessage?.kind === "context_cleared",
      isFinalStatus: index === messages.length - 1,
      nextPromptTimestamp: message.kind === "result" ? nextPromptTimestamps[index] : undefined,
      nextPromptOrigin: message.kind === "result" ? nextPromptOrigins[index] : undefined,
      showsOwnBoundary: ownBoundaries[index] || undefined,
    })
  })
}

export interface ResolveOptions {
  isLoading: boolean
  localPath?: string
  latestToolIds: Record<string, string | null>
}

/** React's `buildResolvedTranscriptRows`. */
export function buildResolvedTranscriptRows(messages: ReadonlyArray<HydratedTranscriptMessage>, options: ResolveOptions): TranscriptRow[] {
  const { isLoading, localPath, latestToolIds } = options
  const renderStates = buildTranscriptMessageRenderStates(messages, latestToolIds)
  const runs = foldRuns(messages as HydratedTranscriptMessage[], isCollapsibleToolCall, (index) => renderStates[index]?.shouldRender === true)
  const rows: TranscriptRow[] = []

  for (const run of runs) {
    if (run.type === "group") {
      // Row identity, keyed on the first message either way: a lone tool call
      // becomes a group the moment a second one arrives, and the row keeps its
      // identity as it absorbs later calls.
      rows.push({
        kind: "tool-group",
        id: String(run.items[0]?.id ?? run.startIndex),
        startIndex: run.startIndex,
        messages: run.items,
        isLoading: isLoading && run.items.some((message) => message.kind === "tool" && message.resultEntryId === undefined),
        localPath,
      })
      continue
    }

    const renderState = renderStates[run.index]
    if (!renderState || !renderState.shouldRender) continue
    const message = run.item
    const row: SingleRow = {
      kind: "single",
      id: message.id,
      message,
      index: run.index,
      isLoading: message.kind === "tool" && message.resultEntryId === undefined && isLoading,
      localPath,
      isFirstSystem: renderState.isFirstSystem,
      isModelChange: renderState.isModelChange,
      handoff: renderState.handoff,
      restored: renderState.restored,
      isFirstAccount: renderState.isFirstAccount,
      isLatestAskUserQuestion: message.id === latestToolIds.AskUserQuestion,
      isLatestExitPlanMode: message.id === latestToolIds.ExitPlanMode,
      isLatestTodoWrite: renderState.isLatestTodoWrite,
      hideResult: renderState.hideResult,
      isFinalStatus: renderState.isFinalStatus,
      nextPromptTimestamp: renderState.nextPromptTimestamp,
      nextPromptOrigin: renderState.nextPromptOrigin,
      showsOwnBoundary: renderState.showsOwnBoundary,
    }
    rows.push(row)
  }

  return rows
}

let cache: {
  messages: ReadonlyArray<HydratedTranscriptMessage>
  isLoading: boolean
  localPath: string | undefined
  latestToolIds: Record<string, string | null>
  rows: TranscriptRow[]
} | null = null

function sameToolIds(left: Record<string, string | null>, right: Record<string, string | null>) {
  if (left === right) return true
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

/**
 * The rows for these messages, built once per input: the view and the
 * slice's update both read them on every render and every scroll message,
 * and the messages array only changes when a snapshot lands.
 */
export function resolvedRows(messages: ReadonlyArray<HydratedTranscriptMessage>, options: ResolveOptions): TranscriptRow[] {
  if (cache
    && cache.messages === messages
    && cache.isLoading === options.isLoading
    && cache.localPath === options.localPath
    && sameToolIds(cache.latestToolIds, options.latestToolIds)) {
    return cache.rows
  }
  const rows = buildResolvedTranscriptRows(messages, options)
  cache = { messages, isLoading: options.isLoading, localPath: options.localPath, latestToolIds: options.latestToolIds, rows }
  return rows
}
