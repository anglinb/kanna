import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { Child, ExtraAttributes } from "./attributes"

export interface AnimatedShinyTextOptions<Message> {
  class?: string
  shimmerWidth?: number
  animate?: boolean
  style?: Record<string, string>
  attributes?: ExtraAttributes<Message>
}

/**
 * `animatedShinyText({ class: "text-sm" }, ["Thinking…"], h)`
 *
 * The label renders twice (the text and the shimmer copy over it), and a
 * VNode can only sit in one place, so label markup other than strings comes
 * as a renderer: `animatedShinyText({}, () => [h.span([], [name])], h)`.
 */
export function animatedShinyText<Message>(
  options: AnimatedShinyTextOptions<Message>,
  content: ReadonlyArray<string> | (() => ReadonlyArray<Child>),
  h: HtmlBuilder<Message>,
): Html {
  const children = () => typeof content === "function" ? content() : content
  const animate = options.animate ?? true
  const halfShimmerWidth = Math.min(Math.max(options.shimmerWidth ?? 100, 0), 100) / 2
  return h.span(
    [
      h.Class(cn(
        // The base text must truncate like the animated copy below, or long
        // labels hard-clip at the overflow edge with no ellipsis. `align-top`
        // matters too: `overflow-hidden` moves an inline-block's baseline to
        // its bottom edge, which grows the line box past the font's 20px.
        "kanna-shiny-text relative mx-auto inline-block max-w-md overflow-hidden text-ellipsis whitespace-nowrap align-top text-foreground/50",
        !animate && "text-neutral",
        options.class,
      )),
      h.Style({ ...options.style, "--shiny-half-width": `${halfShimmerWidth}px` }),
      ...(options.attributes ?? []),
    ],
    [
      ...children(),
      animate
        ? h.span([h.AriaHidden(true), h.Class("kanna-shiny-track pointer-events-none absolute inset-0 block")], [
          h.span([h.Class("kanna-shiny-copy block h-full w-full overflow-hidden text-ellipsis whitespace-nowrap text-black/80 dark:text-white/80")], children()),
        ])
        : null,
    ],
  )
}
