import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { Child } from "../ui/attributes"

// The DOM react-resizable-panels 4 renders for src/client/components/ui/
// resizable.tsx (Group, Panel, Separator), with the layout held by the
// caller's Model instead of the library's store: a panel's share of the
// group is its flex-grow, as the library writes it.

export type Orientation = "horizontal" | "vertical"

/** `<ResizablePanelGroup>`: the flex container. */
export function panelGroup<Message>(
  options: { id: string; orientation: Orientation; class?: string; attributes?: ReadonlyArray<Attribute<Message>> },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  return h.div([
    h.Class(cn("flex h-full w-full", options.class)),
    h.DataAttribute("group", "true"),
    h.DataAttribute("testid", options.id),
    h.Id(options.id),
    h.Style({
      height: "100%",
      width: "100%",
      overflow: "hidden",
      display: "flex",
      "flex-flow": options.orientation === "horizontal" ? "row" : "column",
      "touch-action": options.orientation === "horizontal" ? "pan-y" : "pan-x",
    }),
    ...(options.attributes ?? []),
  ], children)
}

/** `<ResizablePanel>`: the sized outer box and the inner one carrying `class`. */
export function panel<Message>(
  options: {
    id: string
    orientation: Orientation
    /** Its share of the group, in percent: the flex-grow the library writes. */
    size: number
    class?: string
    attributes?: ReadonlyArray<Attribute<Message>>
    innerAttributes?: ReadonlyArray<Attribute<Message>>
  },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  return h.div([
    h.DataAttribute("panel", "true"),
    h.DataAttribute("testid", options.id),
    h.Id(options.id),
    h.Style({
      "min-height": "0px",
      "max-height": "100%",
      height: "auto",
      "min-width": "0px",
      "max-width": "100%",
      width: "auto",
      border: "0px",
      padding: "0px",
      margin: "0px",
      display: "flex",
      flex: `${formatGrow(options.size)} 1 0px`,
      overflow: "visible",
    }),
    ...(options.attributes ?? []),
  ], [
    h.div([
      ...(options.class ? [h.Class(options.class)] : []),
      h.Style({
        "max-height": "100%",
        "max-width": "100%",
        "flex-grow": "1",
        overflow: "auto",
        "touch-action": options.orientation === "horizontal" ? "pan-y" : "pan-x",
      }),
      ...(options.innerAttributes ?? []),
    ], children),
  ])
}

/**
 * A separator's drag, on its element: the pointer is captured on the press,
 * and every move reports the first panel's new share of the group (its
 * parent), held between `min` and `max` percent; the release reports the
 * last one again as `done`. A disabled separator doesn't drag.
 */
export function separatorDrag(options: {
  element: HTMLElement
  orientation: Orientation
  min: () => number
  max: () => number
  report: (first: number, groupSizePx: number, done: boolean) => void
}): () => void {
  const { element, orientation } = options
  let start: { pointer: number; first: number; size: number; pointerId: number } | null = null
  let last = 0
  const firstPanel = () => element.previousElementSibling as HTMLElement | null
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || element.getAttribute("data-separator") === "disabled") return
    const group = element.parentElement
    const panel = firstPanel()
    if (!group || !panel) return
    const groupRect = group.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const size = orientation === "horizontal" ? groupRect.width : groupRect.height
    if (size <= 0) return
    event.preventDefault()
    element.setPointerCapture(event.pointerId)
    const first = ((orientation === "horizontal" ? panelRect.width : panelRect.height) / size) * 100
    start = { pointer: orientation === "horizontal" ? event.clientX : event.clientY, first, size, pointerId: event.pointerId }
    last = first
    element.setAttribute("data-separator", "active")
  }
  const move = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.pointerId) return
    const delta = (orientation === "horizontal" ? event.clientX : event.clientY) - start.pointer
    last = Math.min(options.max(), Math.max(options.min(), start.first + (delta / start.size) * 100))
    options.report(last, start.size, false)
  }
  const end = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.pointerId) return
    const size = start.size
    start = null
    element.setAttribute("data-separator", "inactive")
    options.report(last, size, true)
  }
  element.addEventListener("pointerdown", down)
  element.addEventListener("pointermove", move)
  element.addEventListener("pointerup", end)
  element.addEventListener("pointercancel", end)
  return () => {
    element.removeEventListener("pointerdown", down)
    element.removeEventListener("pointermove", move)
    element.removeEventListener("pointerup", end)
    element.removeEventListener("pointercancel", end)
  }
}

// The library writes the layout's number as it is; trim float noise so the
// style string stays the one a settled layout gives.
function formatGrow(size: number) {
  const rounded = Math.round(size * 1000) / 1000
  return String(rounded)
}

/**
 * `<ResizableHandle>`: a separator straddling the seam. `orientation` is the
 * group's: a vertical group's handle is a horizontal line.
 */
export function separator<Message>(
  options: {
    id: string
    orientation: Orientation
    withHandle?: boolean
    disabled: boolean
    class?: string
    /** The enabled handle's aria value, the library's: the first panel's size and bounds. */
    value?: { controls: string; now: number; min: number; max: number }
    attributes?: ReadonlyArray<Attribute<Message>>
  },
  h: HtmlBuilder<Message>,
): Html {
  const ariaOrientation = options.orientation === "horizontal" ? "vertical" : "horizontal"
  return h.div([
    ...(options.value && !options.disabled ? [h.Attribute("aria-controls", options.value.controls)] : []),
    ...(options.disabled ? [h.Attribute("aria-disabled", "true")] : []),
    h.Attribute("aria-orientation", ariaOrientation),
    ...(options.value && !options.disabled
      ? [
        h.Attribute("aria-valuemax", String(options.value.max)),
        h.Attribute("aria-valuemin", String(options.value.min)),
        h.Attribute("aria-valuenow", String(options.value.now)),
      ]
      : []),
    h.Class(cn(
      "relative flex items-center justify-center bg-transparent focus-visible:outline-none",
      options.orientation === "vertical"
        ? "h-2 w-full -my-1 cursor-row-resize"
        : "h-full w-2 -mx-1 cursor-col-resize",
      options.withHandle && (
        // One pixel, just below the seam rather than astride it: what's
        // above (the composer, drawn over the transcript's foot) covered
        // the upper half of a centred 2px line and nothing covered it beside
        // that, so the line doubled in thickness under the widget column.
        options.orientation === "vertical"
          ? "before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-border"
          : "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border"
      ),
      options.class,
    )),
    h.DataAttribute("separator", options.disabled ? "disabled" : "inactive"),
    h.DataAttribute("testid", options.id),
    h.Id(options.id),
    h.Role("separator"),
    h.Style({
      flex: "0 0 auto",
      ...(options.disabled ? { cursor: "not-allowed" } : {}),
      "touch-action": "none",
    }),
    ...(options.disabled ? [] : [h.Tabindex(0)]),
    ...(options.attributes ?? []),
  ], [
    h.span([h.Class("sr-only")], [options.orientation === "vertical" ? "Resize rows" : "Resize columns"]),
  ])
}
