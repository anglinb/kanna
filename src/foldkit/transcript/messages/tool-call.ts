import type { Html, HtmlBuilder } from "foldkit/html"
import { formatBashCommandTitle, toTitleCase } from "../../../client/lib/formatters"
import { stripWorkspacePath } from "../../../client/lib/pathUtils"
import { hydrateToolResult } from "../../../shared/tools"
import type { HydratedToolCall, HydratedTranscriptMessage, NormalizedToolCall, TranscriptEntry } from "../../../shared/types"
import { animatedShinyText } from "../../ui/animated-shiny-text"
import { ChevronRight, UserRound, X } from "../../ui/icons"
import { chatToolMessage, isChatToolCall } from "./chat-tool"
import { transcriptMarkdownChildren, type RowContext } from "./context"
import { displayToolMessage } from "./display-tool"
import { fileContentView } from "./file-content"
import { keys, Message } from "./model"
import { RequestPayloadsOnMount } from "./mounts"
import { isScheduleToolCall, scheduleToolMessage } from "./schedule-tool"
import { expandableRow, getToolIcon, metaCodeBlock, metaLabel, metaRow, verticalLineContainer } from "./shared"
import { textMessage } from "./simple"

/** A tool call row as the transcript holds it (React's `ProcessedToolCall`). */
export type ToolCall = Extract<HydratedTranscriptMessage, { kind: "tool" }>

/** A tool call as the transcript names it: the tool and the thing it acts on. */
type ToolTitleSource = NormalizedToolCall extends infer T
  ? T extends NormalizedToolCall ? Pick<T, "toolKind" | "toolName" | "input"> : never
  : never

/**
 * A tool call's one-line name, as its transcript row shows it ("Read
 * src/app.ts", "Find `x` in files"). Shared so anywhere else that names a
 * call (the Agents card's latest step) says it the same way.
 */
export function formatToolCallTitle(message: ToolTitleSource, localPath?: string | null): string {
  if (message.toolKind === "skill") {
    return message.input.skill ? `Read Skill – ${message.input.skill}` : "Read Skill"
  }
  if (message.toolKind === "glob") {
    return `Search files ${message.input.pattern === "**/*" ? "in all directories" : `matching ${message.input.pattern}`}`
  }
  if (message.toolKind === "grep") {
    const pattern = message.input.pattern
    const outputMode = message.input.outputMode
    if (outputMode === "count") {
      return `Count \`${pattern}\` occurrences`
    }
    if (outputMode === "content") {
      return `Find \`${pattern}\` in text`
    }
    return `Find \`${pattern}\` in files`
  }
  if (message.toolKind === "bash") {
    return message.input.description || (message.input.command ? formatBashCommandTitle(message.input.command) : "Bash")
  }
  if (message.toolKind === "web_search") {
    return message.input.query || "Web Search"
  }
  if (message.toolKind === "read_file") {
    return `Read ${stripWorkspacePath(message.input.filePath, localPath)}`
  }
  if (message.toolKind === "write_file") {
    return `Write ${stripWorkspacePath(message.input.filePath, localPath)}`
  }
  if (message.toolKind === "edit_file") {
    return `Edit ${stripWorkspacePath(message.input.filePath, localPath)}`
  }
  if (message.toolKind === "delete_file") {
    return `Delete ${stripWorkspacePath(message.input.filePath, localPath)}`
  }
  if (message.toolKind === "mcp_generic") {
    return `${toTitleCase(message.input.tool)} from ${toTitleCase(message.input.server)}`
  }
  if (message.toolKind === "subagent_task") {
    const agent = message.input.subagentType || message.toolName
    return message.input.description ? `${agent}: ${message.input.description}` : agent
  }
  return message.toolName
}

/** The payload ids a call left on the server: its input, its result body. */
export function trimmedPayloadIds(message: ToolCall): string[] {
  const ids: string[] = []
  if (message.inputTrimmed) ids.push(message.id)
  if (message.resultTrimmed && message.resultEntryId) ids.push(message.resultEntryId)
  return ids
}

export interface ToolCallOptions {
  /** Whether the chat is still streaming: an open call shimmers. */
  readonly isLoading: boolean
  readonly localPath?: string | null
}

/** One tool call: its own card for a display, chat or schedule tool; otherwise the expandable row. */
export function toolCallMessage(message: ToolCall, options: ToolCallOptions, context: RowContext, h: HtmlBuilder<Message>): Html {
  // Presence is the *existence* of a result entry, not its payload: a result
  // may arrive with its body left on the server, to be fetched only if the row
  // is opened.
  const hasResult = message.resultEntryId !== undefined
  const showLoadingState = !hasResult && options.isLoading
  const name = formatToolCallTitle(message, options.localPath)
  const isAgent = message.toolKind === "subagent_task"

  if (message.toolKind === "display") return displayToolMessage(message, context, h)
  if (isChatToolCall(message)) return chatToolMessage(message, context, h)
  if (isScheduleToolCall(message)) return scheduleToolMessage(message, context, h)

  // Warm the payload on hover so the body is usually already there by the time
  // the row is clicked. Pointer-only by nature; touch falls through to the
  // fetch the expanded view issues on mount.
  const payloadIds = trimmedPayloadIds(message)
  const icon = message.isError
    ? X({ class: "size-4 text-destructive" }, h)
    : isAgent
      ? UserRound({ class: "size-4 text-muted-icon" }, h)
      : getToolIcon(message.toolName)({ class: "size-4 text-muted-icon" }, h)

  return metaRow({ class: "w-full", attributes: payloadIds.length > 0 ? [h.OnMouseEnter(Message.WantedPayloads({ entryIds: payloadIds }))] : [] }, [
    expandableRow(keys.tool(message.id), context, [
      h.div([h.Class("w-5 h-5 relative flex items-center justify-center")], [icon]),
      metaLabel("h-5 text-left transition-opacity duration-200 truncate", [
        animatedShinyText({ animate: showLoadingState, shimmerWidth: Math.max(20, (name?.length ?? 33) * 3) }, [name], h),
      ], h),
    ], () => toolCallExpandedContent(message, options, context, h), h),
  ], h)
}

// ── ToolCallExpandedContent ──────────────────────────────────────────────

/** Inline base64 (`data`) or a server-stored file (`url`); one of the two. */
type ReadImageBlock = {
  type: "image"
  data?: string
  url?: string
  mimeType?: string
}

function extractReadImageBlocks(value: unknown): ReadImageBlock[] {
  const blocks = (
    value
    && typeof value === "object"
    && "content" in value
    && Array.isArray((value as { content?: unknown }).content)
  )
    ? (value as { content: unknown[] }).content
    : Array.isArray(value)
      ? value
      : []

  return blocks.flatMap((block): ReadImageBlock[] => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "image") {
      return []
    }

    if ("url" in block && typeof block.url === "string" && block.url) {
      return [{
        type: "image",
        url: block.url,
        mimeType: "mimeType" in block && typeof block.mimeType === "string" ? block.mimeType : undefined,
      }]
    }

    if ("data" in block && typeof block.data === "string") {
      return [{
        type: "image",
        data: block.data,
        mimeType: "mimeType" in block && typeof block.mimeType === "string" ? block.mimeType : undefined,
      }]
    }

    if (
      "source" in block
      && block.source
      && typeof block.source === "object"
      && "type" in block.source
      && block.source.type === "base64"
      && "data" in block.source
      && typeof block.source.data === "string"
    ) {
      const source = block.source as { data: string; media_type?: unknown }
      return [{
        type: "image",
        data: source.data,
        mimeType: typeof source.media_type === "string" ? source.media_type : undefined,
      }]
    }

    return []
  })
}

/**
 * Fold fetched entries back onto the row. The row carries what a collapsed
 * header needs; the fetched entries carry the bodies.
 */
function resolveToolCallPayloads(row: ToolCall, fetchedCall: TranscriptEntry | undefined, fetchedResult: TranscriptEntry | undefined): ToolCall {
  const call = fetchedCall?.kind === "tool_call" ? fetchedCall.tool : undefined
  const resultContent = fetchedResult?.kind === "tool_result" ? fetchedResult.content : undefined
  if (!call && resultContent === undefined) return row

  const normalized = (call ?? row) as NormalizedToolCall
  return {
    ...row,
    ...(call ? { input: call.input } : {}),
    ...(resultContent !== undefined
      ? {
        result: hydrateToolResult(normalized, resultContent),
        rawResult: resultContent,
      }
      : {}),
  } as ToolCall
}

/**
 * The text of an Agent result. The SDK returns the subagent's final message
 * as content blocks; older entries and other providers hold a plain string.
 */
export function subagentResultText(value: unknown): string {
  if (typeof value === "string") return value
  const blocks = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)
      ? (value as { content: unknown[] }).content
      : null
  if (!blocks) return value == null ? "" : JSON.stringify(value, null, 2)
  return blocks
    .flatMap((block) => (
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : []
    ))
    .join("\n\n")
}

/** An Agent's input, in words rather than JSON: who ran, what it was told. */
function subagentInput(message: Extract<ToolCall, { toolKind: "subagent_task" }>, h: HtmlBuilder<Message>): Html {
  const prompt = message.input.prompt
  if (!prompt) return null
  return h.div([], [
    h.span([h.Class("font-medium text-muted-foreground")], ["Prompt"]),
    h.div([h.Class("my-1 text-xs whitespace-pre-wrap bg-muted border border-border rounded-lg p-2 max-h-64 overflow-auto w-full")], [prompt]),
  ])
}

/**
 * An Agent's result behind a toggle, rendered as markdown when opened.
 * Closed by default: the result repeats the subagent's last message.
 */
function subagentResult(id: string, text: string, isError: boolean | undefined, context: RowContext, h: HtmlBuilder<Message>): Html {
  const key = keys.subagentResult(id)
  const expanded = Boolean(context.model.open[key])
  return h.div([], [
    h.button([
      h.OnClick(Message.ToggledOpen({ key })),
      h.Class("group/subagent-result cursor-pointer flex items-center gap-1 font-medium text-muted-foreground hover:opacity-60 transition-opacity"),
    ], [
      h.span([], [isError ? "Error" : "Result"]),
      ChevronRight({ class: `h-4 w-4 text-muted-icon transition-all duration-200 ${expanded ? "rotate-90" : ""}` }, h),
    ]),
    expanded
      ? h.div([h.Class("my-1 bg-muted border border-border rounded-lg p-3 max-h-[60vh] overflow-auto w-full")], [
        h.div([h.Class("text-pretty prose prose-sm dark:prose-invert max-w-full space-y-4")], transcriptMarkdownChildren(text, `subagent:${id}`, context, h)),
      ])
      : null,
  ])
}

export function readResultImages(images: ReadonlyArray<ReadImageBlock>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex flex-col gap-3")], images.map((image, index) => {
    const mimeType = image.mimeType || "image/png"
    return h.div([h.Class("overflow-hidden rounded-lg border border-border bg-muted/20")], [
      h.img([
        h.Src(image.url ?? `data:${mimeType};base64,${image.data ?? ""}`),
        h.Loading("lazy"),
        h.Alt(`Read result ${index + 1}`),
        h.Class("max-h-[50vh] w-full object-contain bg-background"),
      ]),
    ])
  }))
}

/** What a subagent did, shown inside its Agent row: text and tool calls, in order. */
export function subagentTranscript(messages: ReadonlyArray<HydratedTranscriptMessage>, options: ToolCallOptions, context: RowContext, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex flex-col gap-3")], messages.map((message) => {
    if (message.kind === "assistant_text") return textMessage(message, context, h)
    if (message.kind === "tool") return toolCallMessage(message, options, context, h)
    return null
  }))
}

export function toolCallExpandedContent(row: ToolCall, options: ToolCallOptions, context: RowContext, h: HtmlBuilder<Message>): Html {
  const fetchedCall = row.inputTrimmed ? context.model.payloads[row.id] : undefined
  const fetchedResult = row.resultTrimmed && row.resultEntryId ? context.model.payloads[row.resultEntryId] : undefined
  const message = resolveToolCallPayloads(row, fetchedCall, fetchedResult)
  const isAwaitingPayload = (row.inputTrimmed && !fetchedCall)
    || (row.resultTrimmed && row.resultEntryId !== undefined && !fetchedResult)
  // Mounting the body is the signal that the payloads are wanted.
  const wanted = trimmedPayloadIds(row)
  const onMount = wanted.length > 0 ? [h.OnMount(RequestPayloadsOnMount({ entryIds: wanted }))] : []

  if (isAwaitingPayload) {
    // Reserving the row rather than rendering half a body: the fields are
    // in flight, and flashing empty code blocks first would reflow twice.
    return verticalLineContainer("my-4 text-sm", [h.span([h.Class("text-muted-foreground")], ["Loading…"])], h, onMount)
  }

  const hasResult = message.resultEntryId !== undefined
  const isReadTool = message.toolKind === "read_file"
  const isWriteTool = message.toolKind === "write_file"
  const isEditTool = message.toolKind === "edit_file"
  const isDeleteTool = message.toolKind === "delete_file"
  const isAgentTool = message.toolKind === "subagent_task"

  const resultText = (() => {
    if (typeof message.result === "string") return message.result
    if (!message.result) return ""
    if (typeof message.result === "object" && message.result !== null && "content" in message.result) {
      const content = (message.result as { content?: unknown }).content
      if (typeof content === "string") return content
    }
    return JSON.stringify(message.result, null, 2)
  })()

  const readImages = (() => {
    if (!isReadTool) return [] as ReadImageBlock[]
    if (message.result && typeof message.result === "object" && "blocks" in message.result) {
      const blocks = (message.result as { blocks?: unknown }).blocks
      if (Array.isArray(blocks)) {
        const hydrated = extractReadImageBlocks(blocks)
        if (hydrated.length > 0) return hydrated
      }
    }
    return extractReadImageBlocks(message.rawResult)
  })()

  const inputText = (() => {
    switch (message.toolKind) {
      case "bash":
        return message.input.command
      case "write_file":
      case "delete_file":
        return message.input.content
      default:
        return JSON.stringify(message.input, null, 2)
    }
  })()

  const inputBlock = (): Html => {
    if (message.toolKind === "edit_file") {
      return fileContentView({ content: "", isDiff: true, oldString: message.input.oldString, newString: message.input.newString }, h)
    }
    if (message.toolKind === "delete_file") return fileContentView({ content: message.input.content ?? "" }, h)
    if (message.toolKind === "subagent_task") return subagentInput(message, h)
    if (isReadTool || isWriteTool) return null
    const label = message.toolKind === "bash"
      ? h.span([h.Class("flex items-center gap-2 w-full")], [
        h.span([], ["Command"]),
        message.input.timeoutMs ? h.span([h.Class("text-muted-foreground")], [`timeout: ${String(message.input.timeoutMs)}ms`]) : null,
        message.input.runInBackground ? h.span([h.Class("text-muted-foreground")], ["background"]) : null,
      ])
      : "Input"
    return metaCodeBlock(label, inputText ?? "", `input:${message.id}`, context, h)
  }

  return verticalLineContainer("my-4 text-sm", [
    h.div([h.Class("flex flex-col gap-2")], [
      inputBlock(),
      message.toolKind === "subagent_task" && message.children && message.children.length > 0
        ? subagentTranscript(message.children, options, context, h)
        : null,
      hasResult && isReadTool && !message.isError
        ? readImages.length > 0
          ? h.div([], [
            h.span([h.Class("font-medium text-muted-foreground")], ["Image"]),
            h.div([h.Class("mt-1")], [readResultImages(readImages, h)]),
          ])
          : fileContentView({ content: resultText }, h)
        : null,
      isWriteTool && !message.isError ? fileContentView({ content: (message as Extract<ToolCall, { toolKind: "write_file" }>).input.content ?? "" }, h) : null,
      hasResult && isAgentTool ? subagentResult(message.id, subagentResultText(message.rawResult ?? message.result), message.isError, context, h) : null,
      hasResult && !isReadTool && !isAgentTool && !(isWriteTool && !message.isError) && !(isEditTool && !message.isError) && !(isDeleteTool && !message.isError)
        ? metaCodeBlock(message.isError ? "Error" : "Result", resultText, `result:${message.id}`, context, h)
        : null,
    ]),
  ], h, onMount)
}

export type { HydratedToolCall }
