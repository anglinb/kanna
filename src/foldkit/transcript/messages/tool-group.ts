import type { Html, HtmlBuilder } from "foldkit/html"
import { foldedRunLabel, type FoldCategory } from "../../../client/lib/fold-runs"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import type { Child } from "../../ui/attributes"
import { animatedShinyText } from "../../ui/animated-shiny-text"
import { ChevronRight } from "../../ui/icons"
import type { RowContext } from "./context"
import { keys, Message } from "./model"
import { RequestPayloadsOnPointerEnter } from "./mounts"
import { metaLabel, metaRow } from "./shared"
import { toolCallMessage, trimmedPayloadIds, type ToolCall, type ToolCallOptions } from "./tool-call"

/** CollapsedToolGroup.tsx: a run of tool calls folded into "3 reads, 2 edits". */

const TOOL_CATEGORIES: Record<string, FoldCategory> = {
  read_file: { key: "read", singular: "read", plural: "reads" },
  edit_file: { key: "edit", singular: "edit", plural: "edits" },
  write_file: { key: "write", singular: "write", plural: "writes" },
  delete_file: { key: "delete", singular: "delete", plural: "deletes" },
  bash: { key: "bash", singular: "command", plural: "commands" },
  grep: { key: "grep", singular: "search", plural: "searches" },
  glob: { key: "glob", singular: "glob", plural: "globs" },
  subagent_task: { key: "task", singular: "agent", plural: "agents" },
  web_search: { key: "websearch", singular: "web search", plural: "web searches" },
  skill: { key: "skill", singular: "skill", plural: "skills" },
  todo_write: { key: "todo", singular: "todo update", plural: "todo updates" },
}

const OTHER_CATEGORY: FoldCategory = { key: "other", singular: "tool call", plural: "tool calls" }

export function toolGroupLabel(messages: ReadonlyArray<HydratedTranscriptMessage>): string {
  return foldedRunLabel(messages, (message) => TOOL_CATEGORIES[(message as ToolCall).toolKind] ?? OTHER_CATEGORY)
}

/**
 * A folded run of tool calls. `groupId` is the row's id (its first
 * message's); whether it is open is the Model's (`keys.group`).
 */
export function collapsedToolGroup(
  groupId: string,
  messages: ReadonlyArray<HydratedTranscriptMessage>,
  options: ToolCallOptions,
  context: RowContext,
  h: HtmlBuilder<Message>,
): Html {
  const label = toolGroupLabel(messages)
  // In progress = no result entry has arrived yet. Deliberately not "has no
  // result payload": a finished call may leave its payload on the server.
  const anyInProgress = messages.some((message) => (message as ToolCall).resultEntryId === undefined)
  // One request for the whole group: expanding it mounts every member at once.
  const entryIds = messages.flatMap((message) => trimmedPayloadIds(message as ToolCall))
  return collapsedGroup({
    key: keys.group(groupId),
    label: [label],
    loading: anyInProgress && options.isLoading,
    count: messages.length,
    pointerEnterPayloads: entryIds.length > 0 ? entryIds : undefined,
  }, () => messages.map((message) => toolCallMessage(message as ToolCall, options, context, h)), context, h)
}

/**
 * A run of rows folded into one line, with the chevron that opens it.
 * `count` is how many rows it holds; past five, a second Collapse closes it
 * from the bottom.
 */
export function collapsedGroup(
  options: { key: string; label: ReadonlyArray<string>; loading?: boolean; count: number; pointerEnterPayloads?: ReadonlyArray<string> },
  children: () => ReadonlyArray<Child>,
  context: RowContext,
  h: HtmlBuilder<Message>,
): Html {
  const expanded = Boolean(context.model.open[options.key])
  const loading = options.loading ?? false
  return metaRow({ class: "w-full", attributes: options.pointerEnterPayloads ? [h.OnMount(RequestPayloadsOnPointerEnter({ entryIds: options.pointerEnterPayloads }))] : [] }, [
    h.div([h.Class("flex flex-col w-full")], [
      h.button([
        h.OnClick(Message.SetOpen({ key: options.key, open: !expanded })),
        h.AriaExpanded(expanded),
        h.Class(`group cursor-pointer grid grid-cols-[auto_1fr] items-center gap-1 text-sm ${!expanded && !loading ? "hover:opacity-60 transition-opacity" : ""}`),
      ], [
        h.div([h.Class("grid grid-cols-[auto_1fr] items-center gap-1.5")], [
          h.div([h.Class("w-5 h-5 relative flex items-center justify-center")], [
            ChevronRight({ class: `h-4.5 w-4.5 text-muted-icon transition-all duration-200 ${expanded ? "rotate-90" : ""}` }, h),
          ]),
          metaLabel("text-left", [animatedShinyText({ animate: loading }, options.label, h)], h),
        ]),
      ]),
      expanded
        ? h.div([h.Class("my-4 flex flex-col gap-3")], [
          ...children(),
          options.count > 5
            ? h.button([
              h.OnClick(Message.SetOpen({ key: options.key, open: false })),
              h.Class("cursor-pointer grid grid-cols-[auto_1fr] items-center gap-1 text-xs hover:opacity-80 transition-opacity"),
            ], [
              h.div([h.Class("grid grid-cols-[auto_1fr] items-center gap-1.5")], [
                h.div([h.Class("w-5 h-5 relative flex items-center justify-center")], [
                  ChevronRight({ class: "h-4.5 w-4.5 text-muted-icon -rotate-90" }, h),
                ]),
                metaLabel("text-left", ["Collapse"], h),
              ]),
            ])
            : null,
        ])
        : null,
    ]),
  ], h)
}
