import type { RowContext } from "./context"
import type { ToolCall } from "./tool-call"

/**
 * What the cards for Kanna's own tool calls share (tool-card.ts): a chat's
 * card and a schedule's. The class strings and measurements are React's,
 * re-exported; `toolCardPayload` reads a call's input and result from the
 * Model's fetched payloads instead of `useToolPayload`.
 */
export {
  asRecord,
  QUOTE_GEOMETRY,
  QUOTE_MARK_CENTER_PX,
  resultRecord,
  text,
  TOOL_CARD_CAPTION_CLASS,
  TOOL_CARD_CLASS,
  TOOL_CARD_MARK_SLOT_CLASS,
  TOOL_CARD_WIDTH_CLASS,
  TOOL_QUOTE_CLASS,
  toolCardClasses,
  toolCardErrorText,
} from "./tool-card-classes"
import { asRecord, resultRecord } from "./tool-card-classes"

type CardToolCall = Extract<ToolCall, { toolKind: "chat" | "schedule" | "unknown_tool" | "display" }>

/** The payload ids a card needs fetched to read its call (useToolCardPayload's requests). */
export function cardPayloadIds(message: CardToolCall): string[] {
  const ids: string[] = []
  if (message.inputTrimmed) ids.push(message.id)
  if (message.resultTrimmed && message.resultEntryId) ids.push(message.resultEntryId)
  return ids
}

/**
 * A call's input and result, wherever they are kept. Inline for a call
 * recorded with its own tool kind. Fetched for one recorded before that kind
 * existed: it was filed as an unknown tool, with both left in the payload
 * sidecar.
 */
export function toolCardPayload(message: Extract<ToolCall, { toolKind: "chat" | "schedule" | "unknown_tool" }>, context: RowContext) {
  const fetchedCall = message.inputTrimmed ? context.model.payloads[message.id] : undefined
  const fetchedResult = message.resultTrimmed && message.resultEntryId ? context.model.payloads[message.resultEntryId] : undefined
  const fetchedInput = fetchedCall?.kind === "tool_call" ? asRecord(asRecord(fetchedCall.tool.input)?.payload) : null
  const rawResult = fetchedResult?.kind === "tool_result" ? fetchedResult.content : message.rawResult
  return {
    input: message.input.payload ?? fetchedInput ?? {},
    rawResult,
    result: message.isError ? null : resultRecord(rawResult),
  }
}
