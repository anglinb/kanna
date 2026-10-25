import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { Child, ExtraAttributes } from "./attributes"

/** `scrollArea({ class: "max-h-80" }, rows, h)`: a vertical scroller with no scrollbar. */
export function scrollArea<Message>(
  options: { class?: string; attributes?: ExtraAttributes<Message> },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  return h.div(
    [
      h.Class(cn("relative overflow-y-auto overscroll-contain touch-pan-y scrollbar-hide", options.class)),
      // React also wrote `-webkit-overflow-scrolling: touch`, an old iOS
      // Safari switch no current browser reads; Foldkit's style module
      // rejects it, so it's left out.
      ...(options.attributes ?? []),
    ],
    children,
  )
}
