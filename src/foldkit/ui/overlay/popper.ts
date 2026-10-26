import {
  autoUpdate,
  computePosition,
  flip,
  limitShift,
  shift,
  size,
  offset,
  type Middleware,
  type Placement,
  type VirtualElement,
} from "@floating-ui/dom"

/**
 * Radix's PopperContent (@radix-ui/react-popper) without React: the same
 * Floating UI call, middleware and DOM writes, so a Foldkit overlay lands on
 * the pixel a Radix one does for the same side, align, offsets and collision
 * padding.
 *
 * The DOM it drives, as Radix renders it:
 *
 *   <div data-radix-popper-content-wrapper style="position: fixed; left: 0;
 *        top: 0; transform: translate(x, y); min-width: max-content;
 *        z-index: <content's>; --radix-popper-transform-origin: …">
 *     <div data-side data-align …content…>
 *
 * The view renders both elements (see `popperWrapperStyle`); this module
 * writes what Radix computes after layout: the transform, z-index, the
 * `--radix-popper-*` variables and the placed side and align.
 */

export type Side = "top" | "right" | "bottom" | "left"
export type Align = "start" | "center" | "end"
export type CollisionPadding = number | Partial<Record<Side, number>>

export interface PopperOptions {
  side: Side
  sideOffset: number
  align: Align
  alignOffset: number
  avoidCollisions: boolean
  collisionPadding: CollisionPadding
}

export const DEFAULT_POPPER_OPTIONS: PopperOptions = {
  side: "bottom",
  sideOffset: 0,
  align: "center",
  alignOffset: 0,
  avoidCollisions: true,
  collisionPadding: 0,
}

/**
 * The wrapper's style before it is placed, as Radix renders it on the first
 * frame: fixed at the corner and moved off screen while it is measured.
 */
export const POPPER_WRAPPER_INITIAL_STYLE: Record<string, string> = {
  position: "fixed",
  left: "0px",
  top: "0px",
  transform: "translate(0, -200%)",
  "min-width": "max-content",
}

export function getSideAndAlignFromPlacement(placement: Placement): [Side, Align] {
  const [side, align = "center"] = placement.split("-") as [Side, Align | undefined]
  return [side, align]
}

// Radix's transformOrigin middleware, for a popper without an arrow (none of
// the app's overlays draws one).
const transformOrigin: Middleware = {
  name: "transformOrigin",
  fn(data) {
    const [placedSide, placedAlign] = getSideAndAlignFromPlacement(data.placement)
    const noArrowAlign = { start: "0%", center: "50%", end: "100%" }[placedAlign]
    let x = ""
    let y = ""
    if (placedSide === "bottom") {
      x = noArrowAlign
      y = "0px"
    } else if (placedSide === "top") {
      x = noArrowAlign
      y = `${data.rects.floating.height}px`
    } else if (placedSide === "right") {
      x = "0px"
      y = noArrowAlign
    } else if (placedSide === "left") {
      x = `${data.rects.floating.width}px`
      y = noArrowAlign
    }
    return { data: { x, y } }
  },
}

// @floating-ui/react-dom rounds to the device pixel before writing the transform.
function roundByDPR(element: Element, value: number) {
  const dpr = element.ownerDocument.defaultView?.devicePixelRatio || 1
  return Math.round(value * dpr) / dpr
}

/**
 * Positions `wrapper` (the popper wrapper) against `reference` and keeps it
 * there through scroll, resize and layout shifts (Floating UI's autoUpdate,
 * as Radix runs it). `content` is the wrapper's child: it gets `data-side`
 * and `data-align`, and its entry animation is held (`animation: none`) until
 * the first position lands, as Radix does. Returns the cleanup.
 */
export function placePopper(
  wrapper: HTMLElement,
  content: HTMLElement,
  reference: Element | VirtualElement,
  options: PopperOptions,
  onPlaced?: () => void,
): () => void {
  const placement = (options.side + (options.align !== "center" ? `-${options.align}` : "")) as Placement
  const collisionPadding = typeof options.collisionPadding === "number"
    ? options.collisionPadding
    : { top: 0, right: 0, bottom: 0, left: 0, ...options.collisionPadding }
  // Radix passes an empty boundary list: overflow is checked against the
  // viewport alone, not the clipping ancestors.
  const detectOverflowOptions = { padding: collisionPadding, boundary: [] as Element[], altBoundary: false }
  const middleware: Middleware[] = [
    offset({ mainAxis: options.sideOffset, alignmentAxis: options.alignOffset }),
    ...(options.avoidCollisions
      ? [
        shift({ mainAxis: true, crossAxis: false, limiter: limitShift(), ...detectOverflowOptions }),
        flip({ ...detectOverflowOptions }),
      ]
      : []),
    size({
      ...detectOverflowOptions,
      apply: ({ elements, rects, availableWidth, availableHeight }) => {
        const style = elements.floating.style
        style.setProperty("--radix-popper-available-width", `${availableWidth}px`)
        style.setProperty("--radix-popper-available-height", `${availableHeight}px`)
        style.setProperty("--radix-popper-anchor-width", `${rects.reference.width}px`)
        style.setProperty("--radix-popper-anchor-height", `${rects.reference.height}px`)
      },
    }),
    transformOrigin,
  ]

  // Radix copies the content's z-index (z-50 on every overlay here) onto the
  // wrapper, which is what stacks the fixed wrapper.
  wrapper.style.zIndex = getComputedStyle(content).zIndex
  content.style.animation = "none"

  let active = true
  let placed = false
  const update = () => {
    void computePosition(reference, wrapper, { strategy: "fixed", placement, middleware }).then((data) => {
      if (!active) return
      const x = roundByDPR(wrapper, data.x)
      const y = roundByDPR(wrapper, data.y)
      wrapper.style.transform = `translate(${x}px, ${y}px)`
      const origin = data.middlewareData.transformOrigin as { x?: string; y?: string } | undefined
      wrapper.style.setProperty("--radix-popper-transform-origin", [origin?.x, origin?.y].join(" "))
      const [side, align] = getSideAndAlignFromPlacement(data.placement)
      content.setAttribute("data-side", side)
      content.setAttribute("data-align", align)
      if (!placed) {
        placed = true
        content.style.removeProperty("animation")
        onPlaced?.()
      }
    })
  }
  const stop = autoUpdate(reference, wrapper, update, { animationFrame: false })
  return () => {
    active = false
    stop()
  }
}

/** A zero-size reference at a point: where a context menu opens. */
export function pointReference(x: number, y: number): VirtualElement {
  return { getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x, y }) }
}
