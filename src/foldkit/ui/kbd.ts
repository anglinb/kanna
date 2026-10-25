import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { Child, ExtraAttributes } from "./attributes"

export interface KbdOptions<Message> {
  class?: string
  attributes?: ExtraAttributes<Message>
}

/** `kbd({}, ["⌘"], h)` */
export function kbd<Message>(options: KbdOptions<Message>, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.kbd(
    [
      h.Class(cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/60 bg-muted/50 px-1.5 font-mono text-[11px] font-medium text-current select-none",
        options.class,
      )),
      ...(options.attributes ?? []),
    ],
    children,
  )
}

/** `kbdGroup({}, [kbd({}, ["⌘"], h), kbd({}, ["K"], h)], h)` */
export function kbdGroup<Message>(options: KbdOptions<Message>, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class(cn("inline-flex items-center gap-0.5", options.class)), ...(options.attributes ?? [])], children)
}
