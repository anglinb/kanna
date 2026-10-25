import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../../client/lib/utils"
import type { Child } from "../../ui/attributes"
import { buttonClass } from "../../ui/button"
import type { Icon } from "../../ui/icon"
import {
  ArrowDownToLine,
  Check,
  CheckLine,
  ChevronRight,
  Copy,
  File,
  FilePen,
  FilePlusCorner,
  FileSearchCorner,
  FileX,
  ListTodo,
  Map,
  MessageCircleQuestion,
  Pencil,
  Radar,
  Search,
  SquareX,
  Terminal,
  ToyBrick,
  Workflow,
} from "../../ui/icons"
import type { RowContext } from "./context"
import { Message } from "./model"

/**
 * The pieces every meta row shares (components/messages/shared.tsx): the
 * row, its icon slot, label and text, the expandable row with its chevron,
 * code blocks with a copy button, pills, and the vertical line an expanded
 * row's body hangs from.
 */

// Tool icon mapping - shared between ToolCallMessage and SystemMessage
export const toolIcons: Record<string, Icon> = {
  Task: ListTodo,
  TaskOutput: ListTodo,
  Bash: Terminal,
  Glob: Search,
  Grep: Search,
  ExitPlanMode: Map,
  Read: File,
  Edit: FilePen,
  Write: FilePlusCorner,
  Delete: FileX,
  NotebookEdit: Pencil,
  WebFetch: ArrowDownToLine,
  TodoWrite: CheckLine,
  WebSearch: Search,
  KillShell: SquareX,
  AskUserQuestion: MessageCircleQuestion,
  Skill: FileSearchCorner,
  EnterPlanMode: Map,
  // As the Tasks and Workflow widgets draw them.
  Workflow,
  Monitor: Radar,
}

export const defaultToolIcon: Icon = ToyBrick

/** Get icon for a tool. */
export function getToolIcon(toolName: string): Icon {
  return Object.hasOwn(toolIcons, toolName) ? toolIcons[toolName]! : defaultToolIcon
}

/** Container for meta-style messages (system, tool, result). */
export function metaRow(options: { class?: string; attributes?: ReadonlyArray<Attribute<Message>> }, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class(cn("flex gap-3 justify-start items-center", options.class)), ...(options.attributes ?? [])], children)
}

/** The 20px slot a tool row's mark sits in, its 16px icon centred. */
export function metaIconSlot(children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("w-5 h-5 relative flex shrink-0 items-center justify-center")], children)
}

/** Content row with consistent text styling. */
export function metaContent(className: string | undefined, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class(cn("flex items-center gap-1.5 text-xs", className))], children)
}

/** Bold label text. */
export function metaLabel(className: string | undefined, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class(cn("font-medium text-foreground/80", className))], children)
}

/** Muted text. */
export function metaText(children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class("text-muted-foreground")], children)
}

/**
 * Expandable row with chevron. `expandedContent` is a renderer, so a closed
 * row runs none of it, as React only mounted it once opened.
 */
export function expandableRow(
  key: string,
  context: RowContext,
  children: ReadonlyArray<Child>,
  expandedContent: () => Child,
  h: HtmlBuilder<Message>,
): Html {
  const expanded = Boolean(context.model.open[key])
  return h.div([h.Class("flex flex-col w-full")], [
    h.button(
      [
        h.OnClick(Message.ToggledOpen({ key })),
        h.Class(`group/expandable-row cursor-pointer grid grid-cols-[auto_1fr] items-center gap-1 text-sm ${!expanded ? "hover:opacity-60 transition-opacity" : ""}`),
      ],
      [
        h.div([h.Class("grid grid-cols-[auto_1fr] items-center gap-1.5")], children),
        ChevronRight({ class: `h-4.5 w-4.5 text-muted-icon translate-y-[0.5px] transition-all duration-200 opacity-0 group-hover/expandable-row:opacity-100 ${expanded ? "rotate-90 opacity-100" : ""}` }, h),
      ],
    ),
    expanded ? expandedContent() : null,
  ])
}

/**
 * `<CopyButton text className checkClassName …>` (ui/copy-button.tsx), its
 * check shown while the Model's `copied` names `key`.
 */
export function copyButton(
  options: { key: string; text: string; class?: string; checkClass?: string; copyClass?: string; title?: string; copiedTitle?: string },
  context: RowContext,
  h: HtmlBuilder<Message>,
): Html {
  const copied = context.model.copied?.key === options.key && context.model.copied.block === -1
  const label = copied ? options.copiedTitle ?? options.title : options.title
  const icon = copied
    ? Check({ class: options.checkClass ?? "h-4 w-4 text-green-400" }, h)
    : Copy({ class: options.copyClass ?? "h-4 w-4" }, h)
  return h.button(
    [
      h.Class(buttonClass({
        variant: "ghost",
        size: "icon",
        class: cn(options.class, !copied && "hover:text-foreground", copied && "hover:!bg-transparent hover:!border-transparent"),
      })),
      ...(label === undefined ? [] : [h.Title(label), h.AriaLabel(label)]),
      h.OnClick(Message.ClickedCopy({ key: options.key, block: -1, text: options.text })),
    ],
    [icon],
  )
}

/** Code block for expanded content. */
export function metaCodeBlock(label: Child, text: string, copyKey: string, context: RowContext, h: HtmlBuilder<Message>): Html {
  return h.div([], [
    h.span([h.Class("font-medium text-muted-foreground")], [label]),
    h.div([h.Class("relative group/codeblock")], [
      h.pre([h.Class("my-1 text-xs font-mono whitespace-no-wrap break-all bg-muted border border-border  rounded-lg p-2 max-h-64 overflow-auto w-full")], [text]),
      copyButton({
        key: copyKey,
        text,
        class: "absolute top-[4px] right-[4px] z-10 h-6.5 w-6.5 rounded-sm text-muted-foreground opacity-0 group-hover/codeblock:opacity-100 transition-opacity",
        checkClass: "h-3.5 w-3.5 text-green-400",
      }, context, h),
    ]),
  ])
}

/** Pill/badge for tags. */
export function metaPill(icon: Icon | undefined, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>, className?: string): Html {
  return h.span([h.Class(cn("inline-flex items-center gap-1 px-2 py-1 bg-muted border border-border  rounded-full", className))], [
    icon ? icon({ class: "h-3 w-3 text-muted-foreground" }, h) : null,
    ...children,
  ])
}

/** Container with vertical line on the left. */
export function verticalLineContainer(className: string | undefined, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>, attributes: ReadonlyArray<Attribute<Message>> = []): Html {
  return h.div([h.Class(cn("grid grid-cols-[auto_1fr] gap-2 min-w-0", className)), ...attributes], [
    h.div([h.Class(" min-w-5 flex flex-col relative items-center justify-center")], [
      h.div([h.Class("min-h-full w-[1px] bg-muted-foreground/20")], []),
    ]),
    h.div([h.Class("-ml-[1px] min-w-0 overflow-hidden")], children),
  ])
}
