/**
 * Radix's DismissableLayer (@radix-ui/react-dismissable-layer) without React.
 *
 * Every open overlay registers its content element here. The registry is the
 * React context Radix keeps, held in module state because it belongs to the
 * page, not to any one Model: which overlay is on top decides who Escape
 * closes, and whether any modal layer is open decides `pointer-events` on
 * <body>. Only Mounts touch it (see the overlay modules), so update and view
 * stay pure.
 *
 * What it reproduces, because the paint check and users both see it:
 *  - Escape dismisses the topmost layer only, and is prevented.
 *  - A pointerdown outside dismisses; it is listened for from the next tick,
 *    so the click that opened a layer doesn't close it.
 *  - Focus moving outside asks to dismiss (overlays veto it as Radix's do).
 *  - A layer with `disableOutsidePointerEvents` sets `pointer-events: none` on
 *    <body> while it is open and `auto` on itself and every layer above it.
 *
 * "Outside" is outside the layer's element and every layer opened after it:
 * Radix counts a nested overlay's portal as inside its parent through the
 * React tree, and a later layer is the nearest DOM equivalent.
 */

export type DismissReason = "escape" | "pointer-down-outside" | "focus-outside"

export interface OutsideEvent {
  reason: DismissReason
  /** The DOM event: a pointerdown, focusin or keydown. */
  event: Event
}

export interface LayerOptions {
  disableOutsidePointerEvents: boolean
  /**
   * Called for Escape, a pointerdown outside and focus outside. Return true to
   * dismiss (the layer then calls `onDismiss`), false to stay open: Radix's
   * `event.preventDefault()` in onEscapeKeyDown / onPointerDownOutside /
   * onFocusOutside.
   */
  shouldDismiss?: (outside: OutsideEvent) => boolean
  onDismiss: (reason: DismissReason) => void
}

interface Layer {
  element: HTMLElement
  options: LayerOptions
}

const layers: Layer[] = []
let originalBodyPointerEvents = ""

function highestDisablingIndex() {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (layers[index]!.options.disableOutsidePointerEvents) return index
  }
  return -1
}

function syncPointerEvents() {
  const disabling = highestDisablingIndex()
  layers.forEach((layer, index) => {
    if (disabling === -1) layer.element.style.removeProperty("pointer-events")
    else layer.element.style.pointerEvents = index >= disabling ? "auto" : "none"
  })
}

function isInsideLayerOrAbove(layer: Layer, target: EventTarget | null) {
  if (!(target instanceof Node)) return false
  const index = layers.indexOf(layer)
  return layers.slice(index).some((candidate) => candidate.element.contains(target))
}

function dismiss(layer: Layer, outside: OutsideEvent) {
  const allowed = layer.options.shouldDismiss ? layer.options.shouldDismiss(outside) : true
  if (!allowed) return false
  layer.options.onDismiss(outside.reason)
  return true
}

/** Registers `element` as the topmost layer until the returned cleanup runs. */
export function registerLayer(element: HTMLElement, options: LayerOptions): () => void {
  const layer: Layer = { element, options }
  const document = element.ownerDocument

  if (options.disableOutsidePointerEvents && highestDisablingIndex() === -1) {
    originalBodyPointerEvents = document.body.style.pointerEvents
    document.body.style.pointerEvents = "none"
  }
  layers.push(layer)
  syncPointerEvents()

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    if (layers[layers.length - 1] !== layer) return
    if (dismiss(layer, { reason: "escape", event })) event.preventDefault()
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (!event.target || isInsideLayerOrAbove(layer, event.target)) return
    // Under a modal layer, only the layers it leaves interactive can be dismissed.
    const disabling = highestDisablingIndex()
    if (disabling !== -1 && layers.indexOf(layer) < disabling) return
    if (event.pointerType === "touch") {
      // As Radix: a touch dismisses on the click that follows, so a scroll
      // that starts outside doesn't close the layer.
      document.addEventListener("click", () => dismiss(layer, { reason: "pointer-down-outside", event }), { once: true })
      return
    }
    dismiss(layer, { reason: "pointer-down-outside", event })
  }

  const handleFocusIn = (event: FocusEvent) => {
    if (!event.target || isInsideLayerOrAbove(layer, event.target)) return
    dismiss(layer, { reason: "focus-outside", event })
  }

  document.addEventListener("keydown", handleKeyDown, { capture: true })
  document.addEventListener("focusin", handleFocusIn)
  const timer = window.setTimeout(() => document.addEventListener("pointerdown", handlePointerDown), 0)

  return () => {
    window.clearTimeout(timer)
    document.removeEventListener("keydown", handleKeyDown, { capture: true })
    document.removeEventListener("focusin", handleFocusIn)
    document.removeEventListener("pointerdown", handlePointerDown)
    const wasDisabling = highestDisablingIndex() !== -1
    const index = layers.indexOf(layer)
    if (index !== -1) layers.splice(index, 1)
    element.style.removeProperty("pointer-events")
    if (wasDisabling && highestDisablingIndex() === -1) {
      document.body.style.pointerEvents = originalBodyPointerEvents
    }
    syncPointerEvents()
  }
}
