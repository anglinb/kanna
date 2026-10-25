import { autoUpdate, computePosition, flip, limitShift, offset, shift, size, type Middleware, type Placement, type VirtualElement } from "@floating-ui/dom"
import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { cn } from "../../client/lib/utils"
import type { Child } from "../ui/attributes"
import { registerLayer } from "../ui/overlay/layer"
import { getSideAndAlignFromPlacement, POPPER_WRAPPER_INITIAL_STYLE } from "../ui/overlay/popper"
import { portalToBody } from "../ui/overlay/portal"
import { domStream } from "../ui/overlay/stream"

// WidgetHoverCard (widgets/WidgetHoverCard.tsx) over the app's list hover
// card (components/ui/list-hover-card.tsx): one card per list, anchored to
// whichever row is under the pointer, opening leftward over the chat.
//
// The pointer tracking (the safe triangle toward the card, the dismissal
// held while the pointer stays on its row) is imperative, as React kept it
// in refs: it lives in the `ListHoverTracker` Mount on the list, which
// reports the row the card is on as `ChangedHoveredRow`. The host keeps that
// key (`Hovered`) and draws the card for it with `listHoverCard`. Requests
// the other way (an action in the card dismisses it) go to the tracker as a
// DOM event on the list (`SyncHoverTracker`).
//
// A host lifts these Messages into its own (`Mount.mapMessage`,
// `Command.mapMessage`); lists are named by the host, one name per list on
// the page.

/** Rows carry their key in this attribute (WidgetRow's `rowKey`). */
export const ROW_ATTRIBUTE = "data-row-key"
/** On a list that carries a card: its name. */
const LIST_ATTRIBUTE = "data-widget-hover-list"
/** On every card's element, as React's Popover content carries it. */
const LIST_HOVER_CARD_ATTRIBUTE = "data-list-hover-card"
const SYNC_EVENT = "kanna:widget-hover-sync"

/**
 * The surface every hover card shares. Enters with an animation, leaves with
 * none: a card that fades out is still on screen over the row you moved to.
 */
export const HOVER_CARD_SURFACE_CLASSNAME =
  "z-50 w-80 rounded-lg border border-border bg-popover/95 px-1.5 py-2 text-xs text-popover-foreground shadow-xl outline-none backdrop-blur-sm animate-in fade-in-0 zoom-in-95 data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:hidden"

/** The height from a card's top, level with its row, to the window's bottom. */
export const LIST_HOVER_CARD_ROOM_BELOW = "--list-hover-card-room-below"

const SAFE_TRIANGLE_APEX_BACKSET_PX = 6
const SAFE_TRIANGLE_REST_MS = 300
const COLLISION_PADDING_PX = 12
const OPEN_MENU_SELECTOR = "[data-radix-menu-content][data-state='open']"
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)"

// MESSAGES

export const HoverMessage = defineMessageUnion({
  /** The row the list's card is on, or none. */
  ChangedHoveredRow: { list: Schema.String, key: Schema.NullOr(Schema.String) },
  CompletedSyncHoverTracker: {},
})
export type HoverMessage = typeof HoverMessage.Type

/** Which row each list's card is on (absent: no card). */
export const Hovered = Schema.Record(Schema.String, Schema.String)
export type Hovered = typeof Hovered.Type

export function applyHover(hovered: Hovered, list: string, key: string | null): Hovered {
  if ((hovered[list] ?? null) === key) return hovered
  const { [list]: _previous, ...rest } = hovered
  return key === null ? rest : { ...rest, [list]: key }
}

interface Point {
  x: number
  y: number
}

function isInsideTriangle(point: Point, a: Point, b: Point, c: Point) {
  const side = (p: Point, q: Point, r: Point) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y)
  const first = side(point, a, b)
  const second = side(point, b, c)
  const third = side(point, c, a)
  const hasNegative = first < 0 || second < 0 || third < 0
  const hasPositive = first > 0 || second > 0 || third > 0
  return !(hasNegative && hasPositive)
}

function findContainer(list: string) {
  return document.querySelector<HTMLElement>(`[${LIST_ATTRIBUTE}="${CSS.escape(list)}"]`)
}

export const cardId = (list: string) => `radix-widget-hover-card-${list}`

function findCard(list: string) {
  return document.getElementById(cardId(list))
}

type SyncDetail = { action: "dismiss" } | { action: "close" }

/** Tells a list's tracker to drop its card: `dismiss` holds it closed until the pointer leaves the row. */
export const SyncHoverTracker = Command.define("SyncWidgetHoverTracker", {
  args: { list: Schema.String, action: Schema.Literals(["dismiss", "close"]) },
  messages: [HoverMessage.CompletedSyncHoverTracker],
  execute: ({ list, action }) => Effect.sync(() => {
    findContainer(list)?.dispatchEvent(new CustomEvent<SyncDetail>(SYNC_EVENT, { detail: { action } }))
    return HoverMessage.CompletedSyncHoverTracker()
  }),
})

/** The attributes a list that carries a card puts on its container. */
export function listHoverAttributes<Message>(list: string, toMessage: (message: HoverMessage) => Message, h: HtmlBuilder<Message>) {
  return [h.Attribute(LIST_ATTRIBUTE, list), h.OnMount(Mount.mapMessage(ListHoverTracker({ list }), toMessage))]
}

// TRACKER

/**
 * On a list: which row the card belongs to. A port of ListHoverCard's
 * effect: pointer listeners on the list, the safe triangle toward the card,
 * the dismissal held while the pointer stays on its row, a press on a row
 * dismissing its card, the window losing focus closing it. Desktop only.
 */
export const ListHoverTracker = Mount.defineStream("WidgetListHoverTracker", {
  args: { list: Schema.String },
  messages: [HoverMessage.ChangedHoveredRow],
  execute: ({ element, list }) =>
    domStream<typeof HoverMessage.ChangedHoveredRow.Type>((emit) => {
      const container = element as HTMLElement
      const finePointer = window.matchMedia(FINE_POINTER_QUERY)
      if (!finePointer.matches) return () => {}
      let hovered: string | null = null
      let dismissed: string | null = null
      let apex: Point | null = null
      let pointer: Point | null = null
      let restTimer: number | null = null

      const setHovered = (key: string | null) => {
        if (hovered === key) return
        hovered = key
        if (key === null) apex = null
        emit(HoverMessage.ChangedHoveredRow({ list, key }))
      }
      const dismiss = () => {
        if (hovered !== null) dismissed = hovered
        setHovered(null)
      }
      const clearRestTimer = () => {
        if (restTimer === null) return
        window.clearTimeout(restTimer)
        restTimer = null
      }
      const keyAt = (target: EventTarget | null) => {
        const row = target instanceof Element ? target.closest(`[${ROW_ATTRIBUTE}]`) : null
        return row && container.contains(row) ? row.getAttribute(ROW_ATTRIBUTE) : null
      }
      const safeTriangle = (): [Point, Point, Point] | null => {
        const content = findCard(list)
        if (!content || !apex) return null
        const rect = content.getBoundingClientRect()
        const placed = content.dataset.side
        if (placed === "bottom" || placed === "top") {
          const opensDown = placed === "bottom"
          const nearY = opensDown ? rect.top : rect.bottom
          const apexY = apex.y + (opensDown ? -SAFE_TRIANGLE_APEX_BACKSET_PX : SAFE_TRIANGLE_APEX_BACKSET_PX)
          return [{ x: apex.x, y: apexY }, { x: rect.left, y: nearY }, { x: rect.right, y: nearY }]
        }
        const opensRight = placed !== "left"
        const nearX = opensRight ? rect.left : rect.right
        const apexX = apex.x + (opensRight ? -SAFE_TRIANGLE_APEX_BACKSET_PX : SAFE_TRIANGLE_APEX_BACKSET_PX)
        return [{ x: apexX, y: apex.y }, { x: nearX, y: rect.top }, { x: nearX, y: rect.bottom }]
      }
      const settle = (key: string | null, point: Point) => {
        clearRestTimer()
        if (key != null && key === dismissed) return
        apex = key === null ? null : point
        setHovered(key)
      }

      // A dismissal holds while the pointer is still on the row it was made
      // on, judged by where the pointer is against the row's box.
      const releaseDismissalIfLeft = (event: PointerEvent) => {
        if (dismissed === null) return
        const row = container.querySelector(`[${ROW_ATTRIBUTE}="${CSS.escape(dismissed)}"]`)
        const rect = row?.getBoundingClientRect()
        const stillOnRow = rect !== undefined
          && event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom
        if (!stillOnRow) dismissed = null
      }
      // A press on a row dismisses its card: the row was acted on.
      const handlePointerDown = (event: PointerEvent) => {
        const key = keyAt(event.target)
        if (key === null) return
        dismissed = key
      }
      const track = (event: PointerEvent) => {
        if (event.pointerType === "touch") return
        const point = { x: event.clientX, y: event.clientY }
        pointer = point
        const key = keyAt(event.target)
        if (key === hovered) {
          clearRestTimer()
          if (key !== null) apex = point
          return
        }
        const triangle = hovered === null ? null : safeTriangle()
        if (triangle && isInsideTriangle(point, ...triangle)) {
          clearRestTimer()
          restTimer = window.setTimeout(() => {
            restTimer = null
            const rested = pointer
            if (!rested) return
            const under = document.elementFromPoint(rested.x, rested.y)
            if (under && container.contains(under)) settle(keyAt(under), rested)
          }, SAFE_TRIANGLE_REST_MS)
          return
        }
        settle(key, point)
      }
      const trackOutside = (event: PointerEvent) => {
        const target = event.target
        if (target instanceof Node && (container.contains(target) || findCard(list)?.contains(target))) {
          stopTrackingOutside()
          return
        }
        const point = { x: event.clientX, y: event.clientY }
        pointer = point
        const triangle = safeTriangle()
        if (!triangle || !isInsideTriangle(point, ...triangle)) {
          stopTrackingOutside()
          setHovered(null)
          return
        }
        clearRestTimer()
        restTimer = window.setTimeout(() => {
          restTimer = null
          stopTrackingOutside()
          setHovered(null)
        }, SAFE_TRIANGLE_REST_MS)
      }
      const stopTrackingOutside = () => {
        clearRestTimer()
        window.removeEventListener("pointermove", trackOutside)
      }
      const handlePointerLeave = (event: PointerEvent) => {
        clearRestTimer()
        const next = event.relatedTarget
        if (next instanceof Node && findCard(list)?.contains(next)) return
        const triangle = hovered === null ? null : safeTriangle()
        if (triangle && isInsideTriangle({ x: event.clientX, y: event.clientY }, ...triangle)) {
          window.addEventListener("pointermove", trackOutside)
          return
        }
        setHovered(null)
      }
      const handleWindowBlur = () => {
        stopTrackingOutside()
        setHovered(null)
      }
      const handleSync = (event: Event) => {
        const detail = (event as CustomEvent<SyncDetail>).detail
        if (detail.action === "dismiss") dismiss()
        else setHovered(null)
      }

      document.addEventListener("pointermove", releaseDismissalIfLeft, true)
      container.addEventListener("pointerdown", handlePointerDown, true)
      container.addEventListener("pointerover", track)
      container.addEventListener("pointermove", track)
      container.addEventListener("pointerleave", handlePointerLeave)
      container.addEventListener(SYNC_EVENT, handleSync)
      window.addEventListener("blur", handleWindowBlur)
      return () => {
        stopTrackingOutside()
        // The list going (a card that folds it away) takes its card with it.
        if (hovered !== null) emit(HoverMessage.ChangedHoveredRow({ list, key: null }))
        document.removeEventListener("pointermove", releaseDismissalIfLeft, true)
        container.removeEventListener("pointerdown", handlePointerDown, true)
        container.removeEventListener("pointerover", track)
        container.removeEventListener("pointermove", track)
        container.removeEventListener("pointerleave", handlePointerLeave)
        container.removeEventListener(SYNC_EVENT, handleSync)
        window.removeEventListener("blur", handleWindowBlur)
      }
    }),
})

// PLACEMENT

/**
 * Radix's popper placement, with the update exposed: the card is one
 * element that moves from row to row, and each move has to place it again
 * without remounting it (which would replay its entrance).
 */
function placeCard(wrapper: HTMLElement, content: HTMLElement, reference: VirtualElement, options: { side: "right" | "left" | "bottom"; sideOffset: number; alignOffset: number }) {
  const placement = `${options.side}-start` as Placement
  const detectOverflowOptions = { padding: COLLISION_PADDING_PX, boundary: [] as Element[], altBoundary: false }
  const middleware: Middleware[] = [
    offset({ mainAxis: options.sideOffset, alignmentAxis: options.alignOffset }),
    shift({ mainAxis: true, crossAxis: false, limiter: limitShift(), ...detectOverflowOptions }),
    flip({ ...detectOverflowOptions }),
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
    {
      name: "transformOrigin",
      fn(data) {
        const [placedSide, placedAlign] = getSideAndAlignFromPlacement(data.placement)
        const noArrowAlign = { start: "0%", center: "50%", end: "100%" }[placedAlign]
        let x = ""
        let y = ""
        if (placedSide === "bottom") [x, y] = [noArrowAlign, "0px"]
        else if (placedSide === "top") [x, y] = [noArrowAlign, `${data.rects.floating.height}px`]
        else if (placedSide === "right") [x, y] = ["0px", noArrowAlign]
        else [x, y] = [`${data.rects.floating.width}px`, noArrowAlign]
        return { data: { x, y } }
      },
    },
  ]
  wrapper.style.zIndex = getComputedStyle(content).zIndex
  content.style.animation = "none"
  let active = true
  let placed = false
  const dpr = window.devicePixelRatio || 1
  const update = () => {
    void computePosition(reference, wrapper, { strategy: "fixed", placement, middleware }).then((data) => {
      if (!active) return
      wrapper.style.transform = `translate(${Math.round(data.x * dpr) / dpr}px, ${Math.round(data.y * dpr) / dpr}px)`
      const origin = data.middlewareData.transformOrigin as { x?: string; y?: string } | undefined
      wrapper.style.setProperty("--radix-popper-transform-origin", [origin?.x, origin?.y].join(" "))
      const [side, align] = getSideAndAlignFromPlacement(data.placement)
      content.setAttribute("data-side", side)
      content.setAttribute("data-align", align)
      if (!placed) {
        placed = true
        content.style.removeProperty("animation")
      }
    })
  }
  const stop = autoUpdate(reference, wrapper, update, { animationFrame: false })
  return {
    update,
    cleanup: () => {
      active = false
      stop()
    },
  }
}

// CARD

/**
 * On the card's popper wrapper: to <body>, placed beside its row (and again
 * whenever it moves to another), dismissed by Escape or a press outside, and
 * closed when the pointer leaves it for anywhere but its list. The row it is
 * up for is marked `data-hover-card-open` (HOVER_CARD_OPEN_ATTRIBUTE) while
 * it is.
 *
 * `alignToAncestor`: open beside the list's nth ancestor instead of the row,
 * level with the row (ListHoverCard's `alignTo`, for keys mid-card: a
 * workflow's tiles).
 */
export const ListHoverCardContent = Mount.defineStream("WidgetListHoverCardContent", {
  args: {
    list: Schema.String,
    side: Schema.Literals(["right", "left", "bottom"]),
    sideOffset: Schema.Number,
    alignOffset: Schema.Number,
    alignToAncestor: Schema.Number,
  },
  messages: [HoverMessage.ChangedHoveredRow],
  execute: ({ element, list, side, sideOffset, alignOffset, alignToAncestor }) =>
    domStream<typeof HoverMessage.ChangedHoveredRow.Type>((_emit) => {
      const wrapper = element as HTMLElement
      const content = wrapper.firstElementChild as HTMLElement
      const cleanups: Array<() => void> = []
      const sync = (detail: SyncDetail) => findContainer(list)?.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail }))
      let lastRow: Element | null = null
      let marked: Element | null = null
      const row = () => {
        const key = content.getAttribute(ROW_ATTRIBUTE)
        const found = key ? findContainer(list)?.querySelector(`[${ROW_ATTRIBUTE}="${CSS.escape(key)}"]`) ?? null : null
        if (found) lastRow = found
        return found ?? lastRow
      }
      const edge = () => {
        let node: Element | null | undefined = findContainer(list)
        for (let level = 0; level < alignToAncestor && node; level += 1) node = node.parentElement
        return alignToAncestor > 0 ? node ?? null : null
      }
      const markRow = () => {
        const current = row()
        if (current === marked) return
        marked?.removeAttribute("data-hover-card-open")
        current?.setAttribute("data-hover-card-open", "")
        marked = current
      }
      const reference: VirtualElement = {
        getBoundingClientRect: () => {
          const rowRect = row()?.getBoundingClientRect() ?? DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
          const edgeElement = edge()
          if (!edgeElement) return rowRect
          const edgeRect = edgeElement.getBoundingClientRect()
          return DOMRect.fromRect({ x: edgeRect.left, y: rowRect.top, width: edgeRect.width, height: rowRect.height })
        },
        contextElement: row() ?? undefined,
      }
      const setRoom = () => {
        const top = row()?.getBoundingClientRect().top ?? 0
        const room = window.innerHeight - (top + alignOffset) - COLLISION_PADDING_PX
        content.style.setProperty(LIST_HOVER_CARD_ROOM_BELOW, `${Math.max(0, room)}px`)
      }

      cleanups.push(portalToBody(wrapper))
      markRow()
      setRoom()
      const placement = placeCard(wrapper, content, reference, { side, sideOffset, alignOffset })
      cleanups.push(placement.cleanup)
      const observer = new MutationObserver(() => {
        markRow()
        setRoom()
        placement.update()
      })
      observer.observe(content, { attributes: true, attributeFilter: [ROW_ATTRIBUTE] })
      cleanups.push(() => observer.disconnect())
      cleanups.push(() => marked?.removeAttribute("data-hover-card-open"))

      // Radix's non-modal popover: Escape or a press outside closes it.
      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: false,
        onDismiss: () => sync({ action: "dismiss" }),
      }))

      // A right-click menu opened from inside the card makes everything under
      // it dead to the pointer, which the browser reports as the pointer
      // leaving the card. That leave is held, and looked at again on the
      // first move after the menu has gone.
      let menuHold: ((event: PointerEvent) => void) | null = null
      const releaseMenuHold = () => {
        if (!menuHold) return
        window.removeEventListener("pointermove", menuHold)
        menuHold = null
      }
      const handleLeave = (event: PointerEvent) => {
        const next = event.relatedTarget
        if (next instanceof Node && findContainer(list)?.contains(next)) return
        if (document.querySelector(OPEN_MENU_SELECTOR)) {
          if (menuHold) return
          const recheck = (moveEvent: PointerEvent) => {
            if (document.querySelector(OPEN_MENU_SELECTOR)) return
            releaseMenuHold()
            const target = moveEvent.target
            const stillOver = target instanceof Element
              && (findContainer(list)?.contains(target) || target.closest(`[${LIST_HOVER_CARD_ATTRIBUTE}]`))
            if (!stillOver) sync({ action: "close" })
          }
          menuHold = recheck
          window.addEventListener("pointermove", recheck)
          return
        }
        sync({ action: "close" })
      }
      content.addEventListener("pointerleave", handleLeave)
      cleanups.push(() => {
        content.removeEventListener("pointerleave", handleLeave)
        releaseMenuHold()
      })

      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

/**
 * The card's markup, as Radix's Popover.Content renders it in its portal:
 * a popper wrapper, then the `role="dialog"` surface with the bridge over
 * the gap to its row. Render it anywhere (it moves itself to <body>); null
 * content draws nothing.
 */
export function listHoverCard<Message>(
  options: {
    list: string
    rowKey: string
    toMessage: (message: HoverMessage) => Message
    side?: "right" | "left" | "bottom"
    sideOffset?: number
    alignOffset?: number
    alignToAncestor?: number
    className?: string
  },
  content: ReadonlyArray<Child> | null,
  h: HtmlBuilder<Message>,
): Html {
  if (content === null) return null
  const side = options.side ?? "left"
  const sideOffset = options.sideOffset ?? 15
  const alignOffset = options.alignOffset ?? 0
  const bridgeOverlap = side === "bottom" ? 1 : 5
  return h.keyed("div")(`widget-hover-card-${options.list}`, [
    h.DataAttribute("radix-popper-content-wrapper", ""),
    h.Style(POPPER_WRAPPER_INITIAL_STYLE),
    h.OnMount(Mount.mapMessage(
      ListHoverCardContent({ list: options.list, side, sideOffset, alignOffset, alignToAncestor: options.alignToAncestor ?? 0 }),
      options.toMessage,
    )),
  ], [
    h.div([
      h.Attribute(LIST_HOVER_CARD_ATTRIBUTE, ""),
      h.DataAttribute("row-key", options.rowKey),
      h.DataAttribute("side", side),
      h.DataAttribute("align", "start"),
      h.DataAttribute("state", "open"),
      h.Role("dialog"),
      h.Id(cardId(options.list)),
      h.Tabindex(-1),
      h.Style({
        "--bridge": `${Math.max(0, sideOffset) + bridgeOverlap}px`,
        "--radix-popover-content-transform-origin": "var(--radix-popper-transform-origin)",
        "--radix-popover-content-available-width": "var(--radix-popper-available-width)",
        "--radix-popover-content-available-height": "var(--radix-popper-available-height)",
        "--radix-popover-trigger-width": "var(--radix-popper-anchor-width)",
        "--radix-popover-trigger-height": "var(--radix-popper-anchor-height)",
      }),
      h.Class(cn(
        HOVER_CARD_SURFACE_CLASSNAME,
        "relative before:absolute before:content-['']",
        "data-[side=right]:before:inset-y-0 data-[side=right]:before:left-[calc(var(--bridge)*-1)] data-[side=right]:before:w-(--bridge)",
        "data-[side=left]:before:inset-y-0 data-[side=left]:before:right-[calc(var(--bridge)*-1)] data-[side=left]:before:w-(--bridge)",
        "data-[side=bottom]:before:inset-x-0 data-[side=bottom]:before:top-[calc(var(--bridge)*-1)] data-[side=bottom]:before:h-(--bridge)",
        "data-[side=top]:before:inset-x-0 data-[side=top]:before:bottom-[calc(var(--bridge)*-1)] data-[side=top]:before:h-(--bridge)",
        "origin-(--radix-popover-content-transform-origin)",
        options.className,
      )),
    ], content),
  ])
}
