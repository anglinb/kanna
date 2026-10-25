import { autoUpdate, computePosition, flip, limitShift, offset, shift, size, type Middleware, type Placement, type VirtualElement } from "@floating-ui/dom"
import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SidebarThread } from "../../client/lib/thread-sections"
import { cn, normalizeChatId } from "../../client/lib/utils"
import { waitingOnLabel } from "../../client/lib/waiting-on"
import { getRepoUrlLabel } from "../../shared/git-url"
import { toMessagePreview } from "../../shared/message-preview"
import { PROVIDERS, type ChatPreview, type ChatTouchedFilesResult, type SidebarChatRow } from "../../shared/types"
import type { AppModel } from "../app/slice"
import * as ChatInput from "../core/stores/chatInput"
import type { Child } from "../ui/attributes"
import { GitBranch, PencilLine } from "../ui/icons"
import { registerLayer } from "../ui/overlay/layer"
import { getSideAndAlignFromPlacement, POPPER_WRAPPER_INITIAL_STYLE } from "../ui/overlay/popper"
import { portalToBody } from "../ui/overlay/portal"
import { domStream } from "../ui/overlay/stream"
import { TURN_CARD_ROW_INSET, turnCardMessage, turnCardMetaRow, turnCardTimingRow } from "../ui/turn-card"
import { threadByRowId } from "./derived"
import { PROVIDER_ICONS } from "./icons"
import { Message } from "./message"
import { HoverList, type Model } from "./model"

type H = HtmlBuilder<Message>

// The list hover card (components/ui/list-hover-card.tsx) and the chat card
// it shows beside the sidebar's rows (chat-ui/sidebar/ChatHoverCard.tsx).
//
// One card per list, anchored to whichever row is under the pointer. The
// pointer tracking (the safe triangle, the dismissal held while the pointer
// stays on its row) is imperative, as React kept it in refs: it lives in the
// `ListHoverTracker` Mount on the list, which reports the row the card is on
// as `ChangedHoveredRow`. The Model holds that key; the view draws the card
// for it. Requests the other way (an action in the card dismisses it) go to
// the tracker as a DOM event on the list (`SyncHoverTracker`).

/** On a list that carries a card: its name (`HoverList`). */
export const LIST_HOVER_ATTRIBUTE = "data-list-hover"
/** On every card's element, with its list's name. */
const LIST_HOVER_CARD_ATTRIBUTE = "data-list-hover-card"
const SYNC_EVENT = "kanna:list-hover-sync"

/** The attribute a list's rows carry their key in. */
export const ROW_ATTRIBUTES: Record<HoverList, string> = {
  chats: "data-chat-id",
  channels: "data-channel-id",
  peek: "data-chat-id",
}

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

function findContainer(list: HoverList) {
  return document.querySelector<HTMLElement>(`[${LIST_HOVER_ATTRIBUTE}="${list}"]`)
}

function findCard(list: HoverList) {
  return document.querySelector<HTMLElement>(`[${LIST_HOVER_CARD_ATTRIBUTE}="${list}"]`)
}

type SyncDetail =
  | { action: "dismiss" }
  | { action: "close" }
  | { action: "unpinned"; key: string }

/** Tells a list's tracker what the Model did to its card. */
export const SyncHoverTracker = Command.define("SyncHoverTracker", {
  args: { list: HoverList, action: Schema.Literals(["dismiss", "close", "unpinned"]), key: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedSideEffect],
  execute: ({ list, action, key }) => Effect.sync(() => {
    const detail: SyncDetail = action === "unpinned" ? { action, key: key ?? "" } : { action }
    findContainer(list)?.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail }))
    return Message.CompletedSideEffect()
  }),
})

// TRACKER

/**
 * On a list: which row the card belongs to. A port of ListHoverCard's
 * effect: pointer listeners on the list, the safe triangle toward the card,
 * the dismissal held while the pointer stays on its row, a press on a row
 * dismissing its card, the window losing focus closing it. Desktop only.
 */
export const ListHoverTracker = Mount.defineStream("ListHoverTracker", {
  args: { list: HoverList },
  messages: [Message.ChangedHoveredRow],
  execute: ({ element, list }) =>
    domStream<typeof Message.ChangedHoveredRow.Type>((emit) => {
      const container = element as HTMLElement
      const rowAttribute = ROW_ATTRIBUTES[list]
      const finePointer = window.matchMedia(FINE_POINTER_QUERY)
      let hovered: string | null = null
      let dismissed: string | null = null
      let apex: Point | null = null
      let pointer: Point | null = null
      let restTimer: number | null = null
      const pinned = () => container.getAttribute("data-hover-pinned") || null

      const setHovered = (key: string | null) => {
        if (hovered === key) return
        hovered = key
        if (key === null) apex = null
        emit(Message.ChangedHoveredRow({ list, key }))
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
        const row = target instanceof Element ? target.closest(`[${rowAttribute}]`) : null
        return row && container.contains(row) ? row.getAttribute(rowAttribute) : null
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

      const releaseDismissalIfLeft = (event: PointerEvent) => {
        if (dismissed === null) return
        const row = container.querySelector(`[${rowAttribute}="${CSS.escape(dismissed)}"]`)
        const rect = row?.getBoundingClientRect()
        const stillOnRow = rect !== undefined
          && event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom
        if (!stillOnRow) dismissed = null
      }
      const handlePointerDown = (event: PointerEvent) => {
        const key = keyAt(event.target)
        if (key === null || pinned() !== null) return
        dismissed = key
      }
      const track = (event: PointerEvent) => {
        if (event.pointerType === "touch" || !finePointer.matches) return
        const point = { x: event.clientX, y: event.clientY }
        pointer = point
        if (pinned() !== null) return
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
        if (pinned() !== null) return
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
        if (pinned() === null) setHovered(null)
      }
      const handleSync = (event: Event) => {
        const detail = (event as CustomEvent<SyncDetail>).detail
        if (detail.action === "dismiss") dismiss()
        else if (detail.action === "close") setHovered(null)
        else {
          // Unpinned is closed, even with the pointer still on the row.
          dismissed = detail.key
          hovered = null
          apex = null
        }
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
 * Radix's popper placement (ui/overlay/popper.ts's `placePopper`), with the
 * update exposed: the card is one element that moves from row to row, and
 * each move has to place it again without remounting it (which would replay
 * its entrance).
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
 * closed when the pointer leaves it for anywhere but its list.
 */
export const ListHoverCardContent = Mount.defineStream("ListHoverCardContent", {
  args: { list: HoverList, side: Schema.Literals(["right", "left", "bottom"]), sideOffset: Schema.Number, alignOffset: Schema.Number },
  messages: [Message.DismissedChannelCard],
  execute: ({ element, list, side, sideOffset, alignOffset }) =>
    domStream<typeof Message.DismissedChannelCard.Type>((emit) => {
      const wrapper = element as HTMLElement
      const content = wrapper.firstElementChild as HTMLElement
      const rowAttribute = ROW_ATTRIBUTES[list]
      const cleanups: Array<() => void> = []
      const sync = (detail: SyncDetail) => findContainer(list)?.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail }))
      const pinned = () => findContainer(list)?.getAttribute("data-hover-pinned") || null
      let lastRow: Element | null = null
      const row = () => {
        const key = content.getAttribute("data-row-key")
        const found = key ? findContainer(list)?.querySelector(`[${rowAttribute}="${CSS.escape(key)}"]`) ?? null : null
        if (found) lastRow = found
        return found ?? lastRow
      }
      const reference: VirtualElement = {
        getBoundingClientRect: () => row()?.getBoundingClientRect() ?? DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 }),
        contextElement: row() ?? undefined,
      }
      const setRoom = () => {
        const top = row()?.getBoundingClientRect().top ?? 0
        const room = window.innerHeight - (top + alignOffset) - COLLISION_PADDING_PX
        content.style.setProperty(LIST_HOVER_CARD_ROOM_BELOW, `${Math.max(0, room)}px`)
      }

      cleanups.push(portalToBody(wrapper))
      setRoom()
      const placement = placeCard(wrapper, content, reference, { side, sideOffset, alignOffset })
      cleanups.push(placement.cleanup)
      const observer = new MutationObserver(() => {
        setRoom()
        placement.update()
      })
      observer.observe(content, { attributes: true, attributeFilter: ["data-row-key"] })
      cleanups.push(() => observer.disconnect())

      // Radix's non-modal popover: Escape, a press outside or focus moving
      // out closes it (ListHoverCard's onOpenChange(false)).
      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: false,
        onDismiss: () => {
          if (pinned() !== null) emit(Message.DismissedChannelCard())
          else sync({ action: "dismiss" })
        },
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
        if (pinned() !== null) return
        const next = event.relatedTarget
        if (next instanceof Node && findContainer(list)?.contains(next)) return
        // A card raised from inside this one (a channel's chats' cards) is
        // part of it, as React counts a portal inside the tree that rendered it.
        if (next instanceof Element && next.closest(`[data-parent-list="${list}"]`)) return
        if (document.querySelector(OPEN_MENU_SELECTOR)) {
          if (menuHold) return
          const recheck = (moveEvent: PointerEvent) => {
            if (document.querySelector(OPEN_MENU_SELECTOR)) return
            releaseMenuHold()
            const target = moveEvent.target
            const stillOver = target instanceof Element
              && (findContainer(list)?.contains(target) || target.closest(`[${LIST_HOVER_CARD_ATTRIBUTE}]`))
            if (!stillOver && pinned() === null) sync({ action: "close" })
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
 * the gap to its row.
 */
export function listHoverCard(
  options: {
    list: HoverList
    rowKey: string
    side?: "right" | "left" | "bottom"
    sideOffset?: number
    alignOffset?: number
    className?: string
    /** The list whose card this one is raised from (a channel's chats). */
    parentList?: HoverList
  },
  content: ReadonlyArray<Child>,
  h: H,
): Html {
  const side = options.side ?? "right"
  const sideOffset = options.sideOffset ?? 15
  const alignOffset = options.alignOffset ?? 0
  const bridgeOverlap = side === "bottom" ? 1 : 5
  return h.keyed("div")(`list-hover-card-${options.list}`, [
    h.DataAttribute("radix-popper-content-wrapper", ""),
    h.Style(POPPER_WRAPPER_INITIAL_STYLE),
    h.OnMount(ListHoverCardContent({ list: options.list, side, sideOffset, alignOffset })),
  ], [
    h.div([
      h.Attribute(LIST_HOVER_CARD_ATTRIBUTE, options.list),
      ...(options.parentList ? [h.DataAttribute("parent-list", options.parentList)] : []),
      h.DataAttribute("row-key", options.rowKey),
      h.DataAttribute("side", side),
      h.DataAttribute("align", "start"),
      h.DataAttribute("state", "open"),
      h.Role("dialog"),
      h.Id(`radix-list-hover-card-${options.list}`),
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

// THE CHAT CARD (ChatHoverCard.tsx)

const PROVIDER_LABELS = new Map(PROVIDERS.map((provider) => [provider.id, provider.label]))

function getActiveTurnStartedAt(row: SidebarChatRow): number | null {
  if (row.lastTurnStartedAt == null) return null
  if (row.lastTurnEndedAt != null && row.lastTurnEndedAt >= row.lastTurnStartedAt) return null
  return row.lastTurnStartedAt
}

/** The agent's last words, only if they answer the prompt shown above them. */
function getCurrentTurnReply(row: SidebarChatRow, preview: ChatPreview): string | null {
  if (!preview.lastAgentMessagePreview) return null
  const repliedAt = preview.lastAgentMessagePreviewAt ?? row.lastAgentMessageAt
  if (repliedAt == null) return null
  return repliedAt >= (row.lastMessageAt ?? 0) ? preview.lastAgentMessagePreview : null
}

function formatTurnCount(row: SidebarChatRow): string | null {
  if (!row.turnCount) return null
  return `${row.turnCount} turn${row.turnCount === 1 ? "" : "s"}`
}

export function getTouchedFilesCacheKey(row: SidebarChatRow) {
  return [row.chatId, row.turnCount ?? 0, row.lastTurnEndedAt ?? 0, row.uncommittedWork ? 1 : 0].join(" ")
}

export function getPreviewCacheKey(row: SidebarChatRow) {
  return [row.chatId, row.lastMessageAt ?? 0, row.lastAgentMessageAt ?? 0].join("^")
}

/** Enough for a long hover session; the point is to survive re-hovers, not to persist. */
export const CARD_CACHE_LIMIT = 64

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** The transcript's prompt timestamp (messages/ResultMessage.tsx's `formatPromptTimestamp`). */
export function formatPromptTimestamp(timestamp: string, now: Date): string {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const dayDelta = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)
  if (dayDelta <= 0) return time
  if (dayDelta === 1) return `Yesterday ${time}`
  if (dayDelta < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "short" })
    return `${weekday} ${time}`
  }
  const fullDate = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
  return `${fullDate} at ${time}`
}

function diffFileStat(additions: number | undefined, deletions: number | undefined, className: string, h: H): Html {
  const hasAdditions = (additions ?? 0) > 0
  const hasDeletions = (deletions ?? 0) > 0
  if (!hasAdditions && !hasDeletions) return null
  return h.span([h.Class(cn("whitespace-nowrap text-xs font-mono", className))], [
    hasAdditions ? h.span([h.Class("text-emerald-600 dark:text-emerald-400")], [`+${additions}`]) : null,
    hasDeletions ? h.span([h.Class(cn("text-red-600 dark:text-red-400", hasAdditions && "ml-2"))], [`-${deletions}`]) : null,
  ])
}

function touchedFileList(list: HoverList, localPath: string, result: ChatTouchedFilesResult, h: H): ReadonlyArray<Html> {
  if (result.files.length === 0) return []
  const hidden = result.totalCount - result.files.length
  return [
    h.div([h.Class("-mx-1.5 mt-2 border-t border-border/60"), h.AriaHidden(true)]),
    h.div([h.Class("mt-1.5")], [
      ...result.files.map((file) => h.keyed("button")(file.path, [
        h.Type("button"),
        h.AriaLabel(`Open ${file.path}`),
        h.OnClick(Message.ClickedCardFile({ list, localPath, filePath: file.path })),
        h.Class(cn(
          "flex w-full items-center gap-2 rounded text-left text-[12px] text-muted-foreground",
          TURN_CARD_ROW_INSET,
          "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )),
      ], [
        h.span([h.Class("min-w-0 flex-1 truncate"), h.Title(file.path)], [file.path]),
        diffFileStat(file.additions, file.deletions, "shrink-0", h),
      ])),
      hidden > 0
        ? h.div([h.Class(cn("text-[12px] text-muted-foreground/70", TURN_CARD_ROW_INSET))], [`${hidden} more file${hidden === 1 ? "" : "s"}`])
        : null,
    ]),
  ]
}

/** The card's fetched parts for a row: cached for its current key, else what the card held for the same chat. */
export function cardPreview(model: Model, row: SidebarChatRow): ChatPreview | null {
  return model.previewCache[getPreviewCacheKey(row)]
    ?? (model.heldPreview?.chatId === row.chatId ? model.heldPreview.preview : null)
}

export function cardTouchedFiles(model: Model, row: SidebarChatRow): ChatTouchedFilesResult | null {
  return model.touchedFilesCache[getTouchedFilesCacheKey(row)]
    ?? (model.heldTouchedFiles?.chatId === row.chatId ? model.heldTouchedFiles.result : null)
}

const FILES_KEY_ATTRIBUTE = "data-card-files-key"
const PREVIEW_KEY_ATTRIBUTE = "data-card-preview-key"

/**
 * On a chat card's body, one per chat: React's two effects on the card's
 * cache keys (`useChatTouchedFiles`, then `useChatPreview`). It asks when the
 * card comes up for a chat, and again for whichever key moves while it is up
 * (the row's turn count, last turn or messages), files before preview.
 */
export const ChatCardLoader = Mount.defineStream("ChatCardLoader", {
  args: { chatId: Schema.String },
  messages: [Message.RequestedCardLoad],
  execute: ({ element, chatId }) =>
    domStream<typeof Message.RequestedCardLoad.Type>((emit) => {
      let filesKey = element.getAttribute(FILES_KEY_ATTRIBUTE) ?? ""
      let previewKey = element.getAttribute(PREVIEW_KEY_ATTRIBUTE) ?? ""
      emit(Message.RequestedCardLoad({ chatId, kind: "files", cacheKey: filesKey }))
      emit(Message.RequestedCardLoad({ chatId, kind: "preview", cacheKey: previewKey }))
      const observer = new MutationObserver(() => {
        const nextFiles = element.getAttribute(FILES_KEY_ATTRIBUTE) ?? ""
        const nextPreview = element.getAttribute(PREVIEW_KEY_ATTRIBUTE) ?? ""
        if (nextFiles !== filesKey) {
          filesKey = nextFiles
          emit(Message.RequestedCardLoad({ chatId, kind: "files", cacheKey: filesKey }))
        }
        if (nextPreview !== previewKey) {
          previewKey = nextPreview
          emit(Message.RequestedCardLoad({ chatId, kind: "preview", cacheKey: previewKey }))
        }
      })
      observer.observe(element, { attributes: true, attributeFilter: [FILES_KEY_ATTRIBUTE, PREVIEW_KEY_ATTRIBUTE] })
      return () => observer.disconnect()
    }),
})

/** ChatHoverCardContent inside SidebarChatCard's wrapper. */
export function chatCardBody(thread: SidebarThread, list: HoverList, app: AppModel, model: Model, h: H): Html {
  const row = thread.row
  const label = thread.projectLabel
  const archived = thread.archived
  const draft = ChatInput.chatDraft(app.stores.chatInput, row.chatId)
  const touchedFiles = cardTouchedFiles(model, row)
  const preview = cardPreview(model, row)
  const effectivePreview: ChatPreview = preview ?? row
  const reply = getCurrentTurnReply(row, effectivePreview)
  const turns = formatTurnCount(row)
  const endedAt = getActiveTurnStartedAt(row) != null || row.lastTurnEndedAt == null
    ? null
    : row.status === "waiting_on_subagent"
      ? waitingOnLabel(row.waitingOn)
      : formatPromptTimestamp(new Date(row.lastTurnEndedAt).toISOString(), new Date(model.nowMs))
  const canJump = !archived
  const HarnessIcon = row.provider ? PROVIDER_ICONS[row.provider] : null
  const previewKey = getPreviewCacheKey(row)
  const filesKey = getTouchedFilesCacheKey(row)

  return h.keyed("div")(`card-${row.chatId}`, [
    ...(touchedFiles?.files.length ? [h.Class("-mb-0.5")] : []),
    h.Attribute(FILES_KEY_ATTRIBUTE, filesKey),
    h.Attribute(PREVIEW_KEY_ATTRIBUTE, previewKey),
    h.OnMount(ChatCardLoader({ chatId: row.chatId })),
  ], [
    turnCardMetaRow({}, [
      label.currentBranch
        ? h.span([h.Class("flex min-w-0 items-center gap-1")], [
          GitBranch({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h),
          h.span([h.Class("truncate")], [label.currentBranch]),
        ])
        : label.hasGitRepo === false && !archived
          ? h.button([
            h.Type("button"),
            h.OnClick(Message.ClickedCardSetupGit({ list, chatId: row.chatId })),
            h.Class("flex min-w-0 cursor-pointer items-center gap-1 rounded-sm transition-colors hover:text-foreground hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"),
          ], [
            GitBranch({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h),
            h.span([h.Class("truncate")], ["Setup Git"]),
          ])
          : null,
      h.span([h.Class("ml-auto flex min-w-0 items-center gap-1 pl-2")], [
        label.repoUrl
          ? h.button([
            h.Type("button"),
            h.AriaLabel(`Open on ${getRepoUrlLabel(label.repoUrl)}`),
            h.OnClick(Message.ClickedCardRepo({ list, url: label.repoUrl })),
            h.Class("truncate cursor-pointer rounded-sm transition-colors hover:text-foreground hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"),
          ], [label.repoPath ?? label.name])
          : h.span([h.Class("truncate")], [label.repoPath ?? label.name]),
      ]),
    ], h),
    h.div([h.Class("mt-1 space-y-1")], [
      draft
        ? null
        : turnCardMessage({
          class: "line-clamp-2 text-sm font-medium text-popover-foreground",
          label: "Jump to this prompt",
          onSelect: canJump ? Message.ClickedCardMessage({ list, chatId: row.chatId, role: "prompt" }) : undefined,
        }, [toMessagePreview(effectivePreview.lastUserMessagePreview || thread.title)], h),
      reply
        ? turnCardMessage({
          class: cn("text-sm text-muted-foreground", draft ? "line-clamp-1" : "line-clamp-3"),
          label: "Jump to this reply",
          onSelect: canJump ? Message.ClickedCardMessage({ list, chatId: row.chatId, role: "reply" }) : undefined,
        }, [toMessagePreview(reply)], h)
        : null,
      draft
        ? turnCardMessage({
          class: "line-clamp-2 text-sm font-medium italic text-popover-foreground",
          label: "Open this chat",
          onSelect: Message.ClickedCardChat({ list, chatId: row.chatId, archived }),
        }, [PencilLine({ class: "mr-1 inline size-3 shrink-0 -translate-y-px", strokeWidth: 2.5 }, h), toMessagePreview(draft)], h)
        : null,
    ]),
    turnCardTimingRow({
      detail: turns,
      timestamp: endedAt,
      leading: row.provider
        ? [
          HarnessIcon ? HarnessIcon({ class: "size-3 shrink-0" }, h) : null,
          h.span([h.Class("truncate")], [PROVIDER_LABELS.get(row.provider) ?? row.provider]),
        ].filter((child): child is Html => child !== null)
        : null,
    }, h),
    ...(touchedFiles ? touchedFileList(list, row.localPath, touchedFiles, h) : []),
  ])
}

/**
 * The chat card for a list of chat rows (SidebarChatHoverCard): the row
 * under the pointer, if it is still in the list. Desktop only.
 */
export function chatHoverCard(options: { list: "chats" | "peek"; sideOffset?: number }, app: AppModel, model: Model, h: H): Html {
  const key = model.hovered[options.list]
  if (!key || !model.hasFinePointer) return null
  const thread = threadByRowId(app).get(key)
  if (!thread) return null
  return listHoverCard({
    list: options.list,
    rowKey: key,
    sideOffset: options.sideOffset,
    parentList: options.list === "peek" ? "channels" : undefined,
  }, [chatCardBody(thread, options.list, app, model, h)], h)
}

/** Every thread a row id can name, for resolving a card's row in update. */
export function threadForRowKey(app: AppModel, key: string): SidebarThread | null {
  return threadByRowId(app).get(normalizeChatId(key)) ?? null
}
