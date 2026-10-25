import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { Message } from "./message"

type H = HtmlBuilder<Message>

// Pieces of ChatPreferenceControls.tsx (a React file) the sidebar's two
// popovers draw with: the view switcher and the machine switcher.

/** PopoverMenuItem: a flush, divider-separated row inside an InputPopover. */
export function popoverMenuItem(options: { onClick: Message; selected: boolean; icon: Html; label: ReadonlyArray<Html | string>; trailing?: Html | null; disabled?: boolean }, h: H): Html {
  return h.button([
    h.OnClick(options.onClick),
    ...(options.disabled ? [h.Disabled(true)] : []),
    h.Class(cn(
      "w-full flex items-center gap-2 text-left [&>svg]:shrink-0 px-3 py-2 transition-colors",
      options.selected ? "bg-muted" : "hover:bg-muted/50",
      options.disabled && "opacity-40 cursor-not-allowed",
    )),
  ], [
    options.icon,
    h.div([h.Class("min-w-0 flex-1")], [
      h.div([h.Class("text-sm font-medium")], options.label),
    ]),
    options.trailing ?? null,
  ])
}

/** InputPopover's trigger classes, with the caller's. */
export function inputPopoverTriggerClass(triggerClassName: string) {
  return cn(
    "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
    "hover:bg-muted/50",
    triggerClassName,
  )
}
