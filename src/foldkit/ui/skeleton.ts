import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"

/**
 * A placeholder shaped like the content on its way. Loaders that know what
 * they will show use these instead of a spinner: the layout is already there
 * when the data lands, so nothing jumps, and the wait reads as shorter.
 *
 * Pulses, except under reduced motion, where it holds still.
 *
 *   skeleton({ class: "h-4 w-32" }, h)
 */
export function skeleton<Message>(options: { class?: string; style?: Record<string, string> }, h: HtmlBuilder<Message>): Html {
  return h.div([
    h.AriaHidden(true),
    h.Class(cn("animate-pulse rounded-md bg-foreground/[0.07] motion-reduce:animate-none dark:bg-foreground/10", options.class)),
    ...(options.style ? [h.Style(options.style)] : []),
  ])
}
