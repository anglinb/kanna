import { hydrateToolResult } from "../../shared/tools"
import type { HydratedToolCall, HydratedTranscriptMessage, NormalizedToolCall, TranscriptEntry } from "../../shared/types"

function createTimestamp(createdAt: number): string {
  return new Date(createdAt).toISOString()
}

function createBaseMessage(entry: TranscriptEntry) {
  return {
    id: entry._id,
    messageId: entry.messageId,
    timestamp: createTimestamp(entry.createdAt),
    hidden: entry.hidden,
  }
}

function hydrateToolCall(entry: Extract<TranscriptEntry, { kind: "tool_call" }>): HydratedToolCall {
  return {
    id: entry._id,
    messageId: entry.messageId,
    hidden: entry.hidden,
    kind: "tool",
    toolKind: entry.tool.toolKind,
    toolName: entry.tool.toolName,
    toolId: entry.tool.toolId,
    input: entry.tool.input as HydratedToolCall["input"],
    inputTrimmed: entry.trimmed,
    timestamp: createTimestamp(entry.createdAt),
  } as HydratedToolCall
}

/**
 * The structured result for the two tool kinds that need it.
 *
 * `structuredResult` is lifted server-side out of `debugRaw`. The `debugRaw`
 * fallback covers entries served by an older server that still shipped the raw
 * payload inline.
 */
function getStructuredToolResult(entry: Extract<TranscriptEntry, { kind: "tool_result" }>): unknown {
  if (entry.structuredResult !== undefined) return entry.structuredResult
  if (!entry.debugRaw) return undefined

  try {
    const parsed = JSON.parse(entry.debugRaw) as { tool_use_result?: unknown }
    return parsed.tool_use_result
  } catch {
    return undefined
  }
}

/** A tool call still waiting for its result: where it sits, and its wire form. */
interface PendingToolCall {
  index: number
  normalized: NormalizedToolCall
}

/**
 * What a hydration run leaves behind so the next one can pick up after it:
 * the entries it consumed and the tool calls still open at the end.
 */
interface HydrationState {
  entries: TranscriptEntry[]
  pendingToolCalls: Map<string, PendingToolCall>
}

const hydrationStates = new WeakMap<HydratedTranscriptMessage[], HydrationState>()

/**
 * Do `entries` begin with exactly the entries the previous run consumed?
 *
 * Entry objects keep their identity across pushes (the fold splices arrays,
 * it never copies entries), so a reference check is enough. An optimistic
 * prompt that the server's copy replaces fails the check at that index and
 * forces a full rebuild, which is the right answer for it.
 */
function isPrefix(previous: TranscriptEntry[], entries: TranscriptEntry[]): boolean {
  if (previous.length > entries.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== entries[index]) return false
  }
  return true
}

/**
 * Hydrate transcript entries into the messages the transcript renders.
 *
 * Pass the previous result back in and a push that only appended entries
 * hydrates the new ones alone. A streaming turn pushes a few times a second,
 * and rebuilding a few hundred messages (a `Date` each) on every push was a
 * measurable slice of each React commit. Anything that is not a pure append
 * (a chat switch, "load earlier", an optimistic prompt reconciled) falls back
 * to a full rebuild.
 *
 * A tool result never mutates a message that an earlier run returned; it
 * replaces that message with a copy. The row memos compare old and new
 * message objects, and a mutation in place would hide the result from them.
 */
export function processTranscriptMessages(
  entries: TranscriptEntry[],
  previousMessages?: HydratedTranscriptMessage[] | null
): HydratedTranscriptMessage[] {
  const previousState = previousMessages ? hydrationStates.get(previousMessages) : undefined
  const resume = previousMessages && previousState && isPrefix(previousState.entries, entries)
    ? { messages: previousMessages, state: previousState }
    : null

  if (resume && resume.state.entries.length === entries.length) {
    return resume.messages
  }

  const pendingToolCalls = new Map<string, PendingToolCall>(resume?.state.pendingToolCalls)
  const messages: HydratedTranscriptMessage[] = resume ? resume.messages.slice() : []
  const startIndex = resume ? resume.state.entries.length : 0

  for (let entryIndex = startIndex; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!
    switch (entry.kind) {
      case "user_prompt":
        messages.push({
          ...createBaseMessage(entry),
          kind: "user_prompt",
          content: entry.content,
          attachments: entry.attachments ?? [],
          steered: entry.steered,
        })
        break
      case "system_init":
        messages.push({
          ...createBaseMessage(entry),
          kind: "system_init",
          provider: entry.provider,
          model: entry.model,
          tools: entry.tools,
          agents: entry.agents,
          slashCommands: entry.slashCommands,
          mcpServers: entry.mcpServers,
          debugRaw: entry.debugRaw,
        })
        break
      case "account_info":
        messages.push({
          ...createBaseMessage(entry),
          kind: "account_info",
          accountInfo: entry.accountInfo,
        })
        break
      case "assistant_text":
        messages.push({
          ...createBaseMessage(entry),
          kind: "assistant_text",
          text: entry.text,
        })
        break
      case "tool_call": {
        pendingToolCalls.set(entry.tool.toolId, { index: messages.length, normalized: entry.tool })
        messages.push(hydrateToolCall(entry))
        break
      }
      case "tool_result": {
        const pendingCall = pendingToolCalls.get(entry.toolId)
        if (pendingCall) {
          const hydrated = { ...(messages[pendingCall.index] as HydratedToolCall) }
          // Recorded whether or not the body came with it: this is what marks
          // the call finished, and what the expanded view fetches by.
          hydrated.isError = entry.isError
          hydrated.resultEntryId = entry._id
          hydrated.resultTrimmed = entry.trimmed

          // A trimmed result has no body to hydrate — the expanded view fetches
          // it and hydrates there, so nothing is derived from an absent payload.
          if (!entry.trimmed) {
            const rawResult = (
              pendingCall.normalized.toolKind === "ask_user_question" ||
              pendingCall.normalized.toolKind === "exit_plan_mode"
            )
              ? getStructuredToolResult(entry) ?? entry.content
              : entry.content

            hydrated.result = hydrateToolResult(pendingCall.normalized, rawResult) as never
            hydrated.rawResult = rawResult
          }
          messages[pendingCall.index] = hydrated
          pendingToolCalls.delete(entry.toolId)
        }
        break
      }
      case "result":
        messages.push({
          ...createBaseMessage(entry),
          kind: "result",
          success: !entry.isError,
          cancelled: entry.subtype === "cancelled",
          result: entry.result,
          durationMs: entry.durationMs,
          costUsd: entry.costUsd,
        })
        break
      case "status":
        messages.push({
          ...createBaseMessage(entry),
          kind: "status",
          status: entry.status,
        })
        break
      case "context_window_updated":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_window_updated",
          usage: entry.usage,
        })
        break
      case "compact_boundary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_boundary",
        })
        break
      case "compact_summary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_summary",
          summary: entry.summary,
        })
        break
      case "context_cleared":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_cleared",
        })
        break
      case "handoff_boundary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "handoff_boundary",
          fromProvider: entry.fromProvider,
          toProvider: entry.toProvider,
        })
        break
      case "session_restored":
        messages.push({
          ...createBaseMessage(entry),
          kind: "session_restored",
          provider: entry.provider,
        })
        break
      case "interrupted":
        messages.push({
          ...createBaseMessage(entry),
          kind: "interrupted",
        })
        break
      default:
        messages.push({
          ...createBaseMessage(entry),
          kind: "unknown",
          json: JSON.stringify(entry, null, 2),
        })
        break
    }
  }

  hydrationStates.set(messages, { entries, pendingToolCalls })
  return messages
}
