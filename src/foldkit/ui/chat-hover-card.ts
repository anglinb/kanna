import { autoUpdate, computePosition, flip, limitShift, offset, shift, size, type Middleware, type Placement, type VirtualElement } from "@floating-ui/dom"
import { Effect, Schema } from "effect"
import { Command, Mount, Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { resolveDiffFilePath } from "../../client/app/ChatPage/utils"
import type { SidebarThread } from "../../client/lib/thread-sections"
import { cn } from "../../client/lib/utils"
import { waitingOnLabel } from "../../client/lib/waiting-on"
import { getRepoUrlLabel } from "../../shared/git-url"
import { toMessagePreview } from "../../shared/message-preview"
import { PROVIDERS, type ChatPreview, type ChatTouchedFilesResult, type SidebarChatRow } from "../../shared/types"
import { opaque } from "../core/schema"
import { sendCommand } from "../core/socket"
import type { Child } from "./attributes"
import { GitBranch, PencilLine } from "./icons"
import { registerLayer } from "./overlay/layer"
import { getSideAndAlignFromPlacement, POPPER_WRAPPER_INITIAL_STYLE } from "./overlay/popper"
import { portalToBody } from "./overlay/portal"
import { domStream } from "./overlay/stream"
import { PROVIDER_ICONS } from "./provider-icons"
import { TURN_CARD_ROW_INSET, turnCardMessage, turnCardMetaRow, turnCardTimingRow } from "./turn-card"

// The chat card that comes up on hover over a chat (chat-ui/sidebar/
// ChatHoverCard.tsx), and the list hover card machinery it rides on
// (components/ui/list-hover-card.tsx). One module for every surface that
// shows it: the sidebar's lists, the chat tabs, a chat's live card in the
// transcript.
//
// The card's body is a Submodel (`CardBody`) over `CardData`: what was
// fetched for it (React's module-level `touchedFilesCache` / `previewCache`)
// and what the open card holds. Each surface keeps a `CardData` and passes
// the others' in as `shared`, so a chat fetched under one surface is served
// from memory under the next, as React's one cache did. Its actions come back
// as a `CardIntent` for the surface to carry out (each surface opens a chat
// its own way), after dismissing its card.
//
// The pointer tracking (the safe triangle, the dismissal held while the
// pointer stays on its row) is imperative, as React kept it in refs:
// `trackHoverRows` on the list element reports the row the card is on; the
// card's popper Mount places it and listens for Escape, a press outside, and
// the pointer leaving it. Requests the other way (an action in the card
// dismisses it) go to the tracker as a DOM event on the list (`syncHoverTracker`).

// THE SURFACE

/**
 * The surface every hover card shares. Enters with an animation, leaves with
 * none: a card that fades out is still on screen over the row you moved to.
 */
export const HOVER_CARD_SURFACE_CLASSNAME =
  "z-50 w-80 rounded-lg border border-border bg-popover/95 px-1.5 py-2 text-xs text-popover-foreground shadow-xl outline-none backdrop-blur-sm animate-in fade-in-0 zoom-in-95 data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:hidden"

/** The height from a card's top, level with its row, to the window's bottom. */
export const LIST_HOVER_CARD_ROOM_BELOW = "--list-hover-card-room-below"

/** On every card's element (the sidebar's carry their list's name). */
export const LIST_HOVER_CARD_ATTRIBUTE = "data-list-hover-card"

export const COLLISION_PADDING_PX = 12
export const SAFE_TRIANGLE_APEX_BACKSET_PX = 6
export const SAFE_TRIANGLE_REST_MS = 300
/** How soon after mounting a pointer found on a row is taken to have been there all along. */
const HELD_ON_MOUNT_MS = 1000
export const OPEN_MENU_SELECTOR = "[data-radix-menu-content][data-state='open']"
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)"

export type CardSide = "right" | "left" | "bottom"

export interface Point {
  x: number
  y: number
}

export function isInsideTriangle(point: Point, a: Point, b: Point, c: Point) {
  const side = (p: Point, q: Point, r: Point) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y)
  const first = side(point, a, b)
  const second = side(point, b, c)
  const third = side(point, c, a)
  const hasNegative = first < 0 || second < 0 || third < 0
  const hasPositive = first > 0 || second > 0 || third > 0
  return !(hasNegative && hasPositive)
}

/** From where the pointer last was on its row to the card's near edge. */
export function safeTriangle(content: HTMLElement | null, apex: Point | null): [Point, Point, Point] | null {
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

/**
 * Radix's popper placement (overlay/popper.ts's `placePopper`), with the
 * update exposed: the card is one element that moves from row to row, and
 * each move has to place it again without remounting it (which would replay
 * its entrance).
 */
export function placeCard(wrapper: HTMLElement, content: HTMLElement, reference: VirtualElement, options: { side: CardSide; sideOffset: number; alignOffset: number }) {
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

/**
 * The card's markup, as Radix's Popover.Content renders it in its portal: a
 * popper wrapper (carrying the Mount that places it), then the
 * `role="dialog"` surface with the bridge over the gap to its row.
 */
export function hoverCardSurface<Message>(
  options: {
    key: string
    mount: Attribute<Message>
    /** What marks the card for its list's tracker, first on the surface. */
    markers: ReadonlyArray<Attribute<Message>>
    id: string
    rowKey: string
    side: CardSide
    sideOffset: number
    className?: string
  },
  content: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  // Beneath a bar the bridge would lie across the row itself, so it is a hairline.
  const bridgeOverlap = options.side === "bottom" ? 1 : 5
  return h.keyed("div")(options.key, [
    h.DataAttribute("radix-popper-content-wrapper", ""),
    h.Style(POPPER_WRAPPER_INITIAL_STYLE),
    options.mount,
  ], [
    h.div([
      ...options.markers,
      h.DataAttribute("row-key", options.rowKey),
      h.DataAttribute("side", options.side),
      h.DataAttribute("align", "start"),
      h.DataAttribute("state", "open"),
      h.Role("dialog"),
      h.Id(options.id),
      h.Tabindex(-1),
      h.Style({
        "--bridge": `${Math.max(0, options.sideOffset) + bridgeOverlap}px`,
        "--radix-popover-content-transform-origin": "var(--radix-popper-transform-origin)",
        "--radix-popover-content-available-width": "var(--radix-popper-available-width)",
        "--radix-popover-content-available-height": "var(--radix-popper-available-height)",
        "--radix-popover-trigger-width": "var(--radix-popper-anchor-width)",
        "--radix-popover-trigger-height": "var(--radix-popper-anchor-height)",
      }),
      h.Class(cn(
        HOVER_CARD_SURFACE_CLASSNAME,
        // The bridge: an invisible part of the card over the gap to the row,
        // overlapping the row's edge so no subpixel seam drops the pointer.
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

// THE TRACKER (ListHoverCard's effect)

export type HoverSyncDetail = { action: "dismiss" } | { action: "close" }

/** Tells a list's tracker what the Model did to its card. */
export function syncHoverTracker(container: Element | null | undefined, syncEvent: string, detail: HoverSyncDetail) {
  container?.dispatchEvent(new CustomEvent(syncEvent, { detail }))
}

export interface HoverRowsOptions {
  /** The attribute a row carries its key in. */
  rowAttribute: string
  /** The list's card, while it is up. */
  findCard: () => HTMLElement | null
  /** The DOM event a card's actions tell the tracker on (`syncHoverTracker`). */
  syncEvent: string
  /**
   * A pointer found on a row soon after mounting has been there all along
   * (the list rebuilt by a click on one of its rows): that row is held
   * dismissed until the pointer leaves it.
   */
  holdRowUnderPointerOnMount?: boolean
}

/**
 * On a list: which row the card belongs to. A port of ListHoverCard's effect:
 * pointer listeners on the list, the safe triangle toward the card, the
 * dismissal held while the pointer stays on its row, a press on a row
 * dismissing its card, the window losing focus closing it. Desktop only.
 * Returns its cleanup.
 */
export function trackHoverRows(list: HTMLElement, options: HoverRowsOptions, onChange: (key: string | null) => void): () => void {
  const { rowAttribute, findCard, syncEvent } = options
  const finePointer = window.matchMedia(FINE_POINTER_QUERY)
  const mountedAt = performance.now()
  let holdFirstRow = options.holdRowUnderPointerOnMount === true
  let hovered: string | null = null
  let dismissed: string | null = null
  let apex: Point | null = null
  let pointer: Point | null = null
  let restTimer: number | null = null

  const setHovered = (key: string | null) => {
    if (hovered === key) return
    hovered = key
    if (key === null) apex = null
    onChange(key)
  }
  const clearRestTimer = () => {
    if (restTimer === null) return
    window.clearTimeout(restTimer)
    restTimer = null
  }
  const keyAt = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest(`[${rowAttribute}]`) : null
    return row && list.contains(row) ? row.getAttribute(rowAttribute) : null
  }
  const settle = (key: string | null, point: Point) => {
    clearRestTimer()
    if (key != null && key === dismissed) return
    apex = key === null ? null : point
    setHovered(key)
  }

  // A dismissal holds while the pointer is still on its row, judged by where
  // the pointer is against the row's box: a click rebuilds what is under the
  // pointer, and the enter and leave events that follow name elements the
  // pointer never crossed.
  const releaseDismissalIfLeft = (event: PointerEvent) => {
    if (dismissed === null) return
    const row = list.querySelector(`[${rowAttribute}="${CSS.escape(dismissed)}"]`)
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
    if (event.pointerType === "touch" || !finePointer.matches) return
    const point = { x: event.clientX, y: event.clientY }
    pointer = point
    if (holdFirstRow) {
      // The first the list hears of the pointer: where it already was, if
      // that is soon after mounting.
      holdFirstRow = false
      const key = keyAt(event.target)
      if (key !== null && performance.now() - mountedAt < HELD_ON_MOUNT_MS) {
        dismissed = key
        return
      }
    }
    const key = keyAt(event.target)
    if (key === hovered) {
      clearRestTimer()
      if (key !== null) apex = point
      return
    }
    const triangle = hovered === null ? null : safeTriangle(findCard(), apex)
    if (triangle && isInsideTriangle(point, ...triangle)) {
      clearRestTimer()
      restTimer = window.setTimeout(() => {
        restTimer = null
        const rested = pointer
        if (!rested) return
        const under = document.elementFromPoint(rested.x, rested.y)
        if (under && list.contains(under)) settle(keyAt(under), rested)
      }, SAFE_TRIANGLE_REST_MS)
      return
    }
    settle(key, point)
  }
  // From a row toward a card that hangs off the list the way leaves the list
  // altogether: followed on the window while inside the triangle.
  const trackOutside = (event: PointerEvent) => {
    const target = event.target
    if (target instanceof Node && (list.contains(target) || findCard()?.contains(target))) {
      stopTrackingOutside()
      return
    }
    const point = { x: event.clientX, y: event.clientY }
    pointer = point
    const triangle = safeTriangle(findCard(), apex)
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
    if (next instanceof Node && findCard()?.contains(next)) return
    const triangle = hovered === null ? null : safeTriangle(findCard(), apex)
    if (triangle && isInsideTriangle({ x: event.clientX, y: event.clientY }, ...triangle)) {
      window.addEventListener("pointermove", trackOutside)
      return
    }
    setHovered(null)
  }
  // A card left up while the window is in the background would be waiting
  // on the far side of a Cmd-Tab.
  const handleWindowBlur = () => {
    stopTrackingOutside()
    setHovered(null)
  }
  const handleSync = (event: Event) => {
    const detail = (event as CustomEvent<HoverSyncDetail>).detail
    if (detail.action === "dismiss") {
      // Only a card that is up has a row to hold closed.
      if (hovered !== null) dismissed = hovered
    }
    setHovered(null)
  }

  document.addEventListener("pointermove", releaseDismissalIfLeft, true)
  list.addEventListener("pointerdown", handlePointerDown, true)
  list.addEventListener("pointerover", track)
  list.addEventListener("pointermove", track)
  list.addEventListener("pointerleave", handlePointerLeave)
  list.addEventListener(syncEvent, handleSync)
  window.addEventListener("blur", handleWindowBlur)
  return () => {
    stopTrackingOutside()
    document.removeEventListener("pointermove", releaseDismissalIfLeft, true)
    list.removeEventListener("pointerdown", handlePointerDown, true)
    list.removeEventListener("pointerover", track)
    list.removeEventListener("pointermove", track)
    list.removeEventListener("pointerleave", handlePointerLeave)
    list.removeEventListener(syncEvent, handleSync)
    window.removeEventListener("blur", handleWindowBlur)
  }
}

// THE CHAT CARD'S DATA (useChatTouchedFiles, useChatPreview)

export const CardData = Schema.Struct({
  /** Fetched card bodies, by `getPreviewCacheKey` / `getTouchedFilesCacheKey`. */
  previewCache: Schema.Record(Schema.String, opaque<ChatPreview>("ChatPreview")),
  touchedFilesCache: Schema.Record(Schema.String, opaque<ChatTouchedFilesResult>("ChatTouchedFilesResult")),
  /** What the open card shows while its current key loads: kept for the same chat, dropped for another. */
  heldPreview: Schema.NullOr(Schema.Struct({ chatId: Schema.String, preview: opaque<ChatPreview>("ChatPreview") })),
  heldTouchedFiles: Schema.NullOr(Schema.Struct({ chatId: Schema.String, result: opaque<ChatTouchedFilesResult>("ChatTouchedFilesResult") })),
  /** The keys the open card is waiting on: an answer for another is cached, not shown. */
  cardFilesKey: Schema.NullOr(Schema.String),
  cardPreviewKey: Schema.NullOr(Schema.String),
})
export type CardData = typeof CardData.Type

export function initCardData(): CardData {
  return { previewCache: {}, touchedFilesCache: {}, heldPreview: null, heldTouchedFiles: null, cardFilesKey: null, cardPreviewKey: null }
}

/** A card that leaves stops waiting on its answers. */
export function closedCard(data: CardData): CardData {
  return data.cardFilesKey === null && data.cardPreviewKey === null ? data : { ...data, cardFilesKey: null, cardPreviewKey: null }
}

export function getTouchedFilesCacheKey(row: SidebarChatRow) {
  return [row.chatId, row.turnCount ?? 0, row.lastTurnEndedAt ?? 0, row.uncommittedWork ? 1 : 0].join(" ")
}

export function getPreviewCacheKey(row: SidebarChatRow) {
  return [row.chatId, row.lastMessageAt ?? 0, row.lastAgentMessageAt ?? 0].join("^")
}

/** Enough for a long hover session; the point is to survive re-hovers, not to persist. */
export const CARD_CACHE_LIMIT = 64

function cacheInsert<Value>(cache: Readonly<Record<string, Value>>, key: string, value: Value): Record<string, Value> {
  const next: Record<string, Value> = { ...cache }
  const keys = Object.keys(next)
  if (!(key in next) && keys.length >= CARD_CACHE_LIMIT) delete next[keys[0]!]
  next[key] = value
  return next
}

function cachedPreview(key: string, data: CardData, shared: ReadonlyArray<CardData>): ChatPreview | undefined {
  return data.previewCache[key] ?? shared.find((other) => key in other.previewCache)?.previewCache[key]
}

function cachedTouchedFiles(key: string, data: CardData, shared: ReadonlyArray<CardData>): ChatTouchedFilesResult | undefined {
  return data.touchedFilesCache[key] ?? shared.find((other) => key in other.touchedFilesCache)?.touchedFilesCache[key]
}

/** The card's fetched parts for a row: cached for its current key, else what the card held for the same chat. */
export function cardPreview(data: CardData, shared: ReadonlyArray<CardData>, row: SidebarChatRow): ChatPreview | null {
  return cachedPreview(getPreviewCacheKey(row), data, shared)
    ?? (data.heldPreview?.chatId === row.chatId ? data.heldPreview.preview : null)
}

export function cardTouchedFiles(data: CardData, shared: ReadonlyArray<CardData>, row: SidebarChatRow): ChatTouchedFilesResult | null {
  return cachedTouchedFiles(getTouchedFilesCacheKey(row), data, shared)
    ?? (data.heldTouchedFiles?.chatId === row.chatId ? data.heldTouchedFiles.result : null)
}

// MESSAGES

export const CardMessage = defineMessageUnion({
  /** A card is up for a chat, or its row's key moved: fetch what the caches lack (React's two effects). */
  RequestedCardLoad: { chatId: Schema.String, kind: Schema.Literals(["files", "preview"]), cacheKey: Schema.String },
  SucceededLoadTouchedFiles: { chatId: Schema.String, cacheKey: Schema.String, result: opaque<ChatTouchedFilesResult>("ChatTouchedFilesResult") },
  SucceededLoadPreview: { chatId: Schema.String, cacheKey: Schema.String, preview: opaque<ChatPreview>("ChatPreview") },
  /** A card's fetch failed: it stays without, quietly (the card is a peek). */
  FailedLoadCard: {},
  ClickedCardMessage: { chatId: Schema.String, role: Schema.Literals(["prompt", "reply"]) },
  ClickedCardChat: { chatId: Schema.String, archived: Schema.Boolean },
  ClickedCardSetupGit: { chatId: Schema.String },
  ClickedCardRepo: { url: Schema.String },
  ClickedCardFile: { localPath: Schema.String, filePath: Schema.String },
  CompletedSideEffect: {},
})
export type CardMessage = typeof CardMessage.Type

/** What a click in the card asks the surface to do, once it has dismissed the card. */
export type CardIntent =
  /** Open the chat at one end of its last exchange: the clickable previews. */
  | { kind: "openAt"; chatId: string; role: "prompt" | "reply" }
  /** Open the chat plainly (the draft's action); an archived one by its own route. */
  | { kind: "open"; chatId: string; archived: boolean }
  /** Prompt to `git init` the chat's project. */
  | { kind: "setupGit"; chatId: string }
  /** Send a changed file to the editor, by its full path. */
  | { kind: "openFile"; localPath: string }
  /** Nothing more for the surface (the repo, opened here): only the dismissal. */
  | { kind: "dismiss" }

export const LoadTouchedFiles = Command.define("ChatCardLoadTouchedFiles", {
  args: { chatId: Schema.String, cacheKey: Schema.String },
  messages: [CardMessage.SucceededLoadTouchedFiles, CardMessage.FailedLoadCard],
  execute: ({ chatId, cacheKey }) => sendCommand<ChatTouchedFilesResult>({ type: "chat.touchedFiles", chatId }).pipe(
    Effect.map((result) => CardMessage.SucceededLoadTouchedFiles({ chatId, cacheKey, result })),
    Effect.catch(() => Effect.succeed(CardMessage.FailedLoadCard())),
  ),
})

export const LoadPreview = Command.define("ChatCardLoadPreview", {
  args: { chatId: Schema.String, cacheKey: Schema.String },
  messages: [CardMessage.SucceededLoadPreview, CardMessage.FailedLoadCard],
  execute: ({ chatId, cacheKey }) => sendCommand<ChatPreview>({ type: "chat.getPreview", chatId }).pipe(
    Effect.map((preview) => CardMessage.SucceededLoadPreview({ chatId, cacheKey, preview })),
    Effect.catch(() => Effect.succeed(CardMessage.FailedLoadCard())),
  ),
})

/**
 * The repo, opened by this browser rather than through `system.openExternal`:
 * that opens things on the machine the project lives on, the wrong screen
 * whenever that machine isn't this one.
 */
export const OpenRepo = Command.define("ChatCardOpenRepo", {
  args: { url: Schema.String },
  messages: [CardMessage.CompletedSideEffect],
  execute: ({ url }) => Effect.sync(() => {
    window.open(url, "_blank", "noopener,noreferrer")
    return CardMessage.CompletedSideEffect()
  }),
})

export interface CardStep {
  data: CardData
  commands: ReadonlyArray<Command.Command<CardMessage, never, unknown>>
  intent: CardIntent | null
}

/** The card's Messages: its fetches (from any surface's cache first) and its actions, as intents. */
export function updateCard(data: CardData, message: CardMessage, shared: ReadonlyArray<CardData>): CardStep {
  const step = (next: CardData, commands: CardStep["commands"] = [], intent: CardIntent | null = null): CardStep => ({ data: next, commands, intent })
  return CardMessage.match<CardStep>(message, {
    // From the cache when it has the key, else asked for, keeping what the
    // card held for the same chat meanwhile: cards are reused as the pointer
    // runs down the list, and one row's list under another row's title is
    // worse than no list at all.
    RequestedCardLoad: ({ chatId, kind, cacheKey }) => {
      if (kind === "files") {
        const cached = cachedTouchedFiles(cacheKey, data, shared)
        if (cached) return step({ ...data, heldTouchedFiles: { chatId, result: cached }, cardFilesKey: cacheKey })
        return step(
          { ...data, heldTouchedFiles: data.heldTouchedFiles?.chatId === chatId ? data.heldTouchedFiles : null, cardFilesKey: cacheKey },
          [LoadTouchedFiles({ chatId, cacheKey })],
        )
      }
      const cached = cachedPreview(cacheKey, data, shared)
      if (cached) return step({ ...data, heldPreview: { chatId, preview: cached }, cardPreviewKey: cacheKey })
      return step(
        { ...data, heldPreview: data.heldPreview?.chatId === chatId ? data.heldPreview : null, cardPreviewKey: cacheKey },
        [LoadPreview({ chatId, cacheKey })],
      )
    },
    SucceededLoadTouchedFiles: ({ chatId, cacheKey, result }) => step({
      ...data,
      touchedFilesCache: cacheInsert(data.touchedFilesCache, cacheKey, result),
      heldTouchedFiles: data.cardFilesKey === cacheKey ? { chatId, result } : data.heldTouchedFiles,
    }),
    SucceededLoadPreview: ({ chatId, cacheKey, preview }) => step({
      ...data,
      previewCache: cacheInsert(data.previewCache, cacheKey, preview),
      heldPreview: data.cardPreviewKey === cacheKey ? { chatId, preview } : data.heldPreview,
    }),
    FailedLoadCard: () => step(data),
    ClickedCardMessage: ({ chatId, role }) => step(data, [], { kind: "openAt", chatId, role }),
    ClickedCardChat: ({ chatId, archived }) => step(data, [], { kind: "open", chatId, archived }),
    ClickedCardSetupGit: ({ chatId }) => step(data, [], { kind: "setupGit", chatId }),
    ClickedCardRepo: ({ url }) => step(data, [OpenRepo({ url })], { kind: "dismiss" }),
    // Repo-relative, as the server records them: the project path goes back on.
    ClickedCardFile: ({ localPath, filePath }) => step(data, [], { kind: "openFile", localPath: resolveDiffFilePath(localPath, filePath) }),
    CompletedSideEffect: () => step(data),
  })
}

// THE CHAT CARD'S BODY (ChatHoverCardContent inside SidebarChatCard)

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

type CardH = HtmlBuilder<CardMessage>

function diffFileStat(additions: number | undefined, deletions: number | undefined, className: string, h: CardH): Html {
  const hasAdditions = (additions ?? 0) > 0
  const hasDeletions = (deletions ?? 0) > 0
  if (!hasAdditions && !hasDeletions) return null
  return h.span([h.Class(cn("whitespace-nowrap text-xs font-mono", className))], [
    hasAdditions ? h.span([h.Class("text-emerald-600 dark:text-emerald-400")], [`+${additions}`]) : null,
    hasDeletions ? h.span([h.Class(cn("text-red-600 dark:text-red-400", hasAdditions && "ml-2"))], [`-${deletions}`]) : null,
  ])
}

function touchedFileList(localPath: string, result: ChatTouchedFilesResult, h: CardH): ReadonlyArray<Html> {
  if (result.files.length === 0) return []
  const hidden = result.totalCount - result.files.length
  return [
    h.div([h.Class("-mx-1.5 mt-2 border-t border-border/60"), h.AriaHidden(true)]),
    h.div([h.Class("mt-1.5")], [
      ...result.files.map((file) => h.keyed("button")(file.path, [
        h.Type("button"),
        h.AriaLabel(`Open ${file.path}`),
        h.OnClick(CardMessage.ClickedCardFile({ localPath, filePath: file.path })),
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

const FILES_KEY_ATTRIBUTE = "data-card-files-key"
const PREVIEW_KEY_ATTRIBUTE = "data-card-preview-key"
/** A digest of the row the card shows: a new one is a new `row` to React's effects. */
const ROW_ATTRIBUTE = "data-card-row"

function rowDigest(row: SidebarChatRow): string {
  const text = JSON.stringify(row)
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  return (hash >>> 0).toString(36)
}

/**
 * On a chat card's body, one per chat: React's two effects on the card's
 * row (`useChatTouchedFiles`, then `useChatPreview`, each on its cache key
 * and the row). It asks when the card comes up for a chat, and again, files
 * before preview, whenever the row changes while it is up: a key that moved
 * (the row's turn count, last turn or messages) is a new fetch, and a row
 * that changed while its answer is still on the way asks again, as the
 * effect re-ran with nothing cached yet.
 */
export const ChatCardLoader = Mount.defineStream("ChatCardLoader", {
  args: { chatId: Schema.String },
  messages: [CardMessage.RequestedCardLoad],
  execute: ({ element, chatId }) =>
    domStream<typeof CardMessage.RequestedCardLoad.Type>((emit) => {
      const read = () => ({
        files: element.getAttribute(FILES_KEY_ATTRIBUTE) ?? "",
        preview: element.getAttribute(PREVIEW_KEY_ATTRIBUTE) ?? "",
        row: element.getAttribute(ROW_ATTRIBUTE) ?? "",
      })
      let last = read()
      emit(CardMessage.RequestedCardLoad({ chatId, kind: "files", cacheKey: last.files }))
      emit(CardMessage.RequestedCardLoad({ chatId, kind: "preview", cacheKey: last.preview }))
      const observer = new MutationObserver(() => {
        const next = read()
        const rowChanged = next.row !== last.row
        if (rowChanged || next.files !== last.files) emit(CardMessage.RequestedCardLoad({ chatId, kind: "files", cacheKey: next.files }))
        if (rowChanged || next.preview !== last.preview) emit(CardMessage.RequestedCardLoad({ chatId, kind: "preview", cacheKey: next.preview }))
        last = next
      })
      observer.observe(element, { attributes: true, attributeFilter: [FILES_KEY_ATTRIBUTE, PREVIEW_KEY_ATTRIBUTE, ROW_ATTRIBUTE] })
      return () => observer.disconnect()
    }),
})

export interface CardBodyInputs {
  thread: SidebarThread
  /** The chat's composer draft (chatInput store), if any: shown in place of the prompt. */
  draft: string | null
  /** The clock the timestamps read. */
  nowMs: number
  /** The other surfaces' card data: their caches serve this card too. */
  shared: ReadonlyArray<CardData>
}

/** ChatHoverCardContent inside SidebarChatCard's wrapper. */
export function chatCardBody(data: CardData, inputs: CardBodyInputs, h: CardH): Html {
  const { thread, draft, nowMs, shared } = inputs
  const row = thread.row
  const label = thread.projectLabel
  const archived = thread.archived
  const touchedFiles = cardTouchedFiles(data, shared, row)
  const preview = cardPreview(data, shared, row)
  const effectivePreview: ChatPreview = preview ?? row
  const reply = getCurrentTurnReply(row, effectivePreview)
  const turns = formatTurnCount(row)
  const endedAt = getActiveTurnStartedAt(row) != null || row.lastTurnEndedAt == null
    ? null
    : row.status === "waiting_on_subagent"
      ? waitingOnLabel(row.waitingOn)
      : formatPromptTimestamp(new Date(row.lastTurnEndedAt).toISOString(), new Date(nowMs))
  // An archived chat has nowhere to jump to and nothing to set up; its card
  // reads, and its one action reopens it.
  const canJump = !archived
  const HarnessIcon = row.provider ? PROVIDER_ICONS[row.provider] : null
  const previewKey = getPreviewCacheKey(row)
  const filesKey = getTouchedFilesCacheKey(row)

  // File rows carry their own `py-0.5`, so the card's full `pb-2` under the
  // last one reads as a wider gap than the one above the list. Taken back
  // only when the list is there.
  return h.keyed("div")(`card-${row.chatId}`, [
    ...(touchedFiles?.files.length ? [h.Class("-mb-0.5")] : []),
    h.Attribute(FILES_KEY_ATTRIBUTE, filesKey),
    h.Attribute(PREVIEW_KEY_ATTRIBUTE, previewKey),
    h.Attribute(ROW_ATTRIBUTE, rowDigest(row)),
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
            h.OnClick(CardMessage.ClickedCardSetupGit({ chatId: row.chatId })),
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
            h.OnClick(CardMessage.ClickedCardRepo({ url: label.repoUrl })),
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
          onSelect: canJump ? CardMessage.ClickedCardMessage({ chatId: row.chatId, role: "prompt" }) : undefined,
        }, [toMessagePreview(effectivePreview.lastUserMessagePreview || thread.title)], h),
      reply
        ? turnCardMessage({
          class: cn("text-sm text-muted-foreground", draft ? "line-clamp-1" : "line-clamp-3"),
          label: "Jump to this reply",
          onSelect: canJump ? CardMessage.ClickedCardMessage({ chatId: row.chatId, role: "reply" }) : undefined,
        }, [toMessagePreview(reply)], h)
        : null,
      draft
        ? turnCardMessage({
          class: "line-clamp-2 text-sm font-medium italic text-popover-foreground",
          label: "Open this chat",
          onSelect: CardMessage.ClickedCardChat({ chatId: row.chatId, archived }),
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
    ...(touchedFiles ? touchedFileList(row.localPath, touchedFiles, h) : []),
  ])
}

/** The body as a Submodel, for a surface whose own Messages are not the card's. */
export const CardBody = Submodel.defineView<CardData, CardMessage, CardBodyInputs>((data, inputs, h) => chatCardBody(data, inputs, h))

// A WHOLE CARD, FOR A SURFACE WITH ONE LIST (the chat tabs, a transcript card)

/**
 * On the card's popper wrapper: to <body>, placed beside its row (and again
 * whenever it moves to another), dismissed by Escape, a press outside or
 * focus moving out (Radix's non-modal popover), and closed when the pointer
 * leaves it for anywhere but its list.
 */
export const HoverCardContent = Mount.defineStream("ChatHoverCardContent", {
  args: {
    /** Finds the list the card belongs to. */
    listSelector: Schema.String,
    rowAttribute: Schema.String,
    syncEvent: Schema.String,
    side: Schema.Literals(["right", "left", "bottom"]),
    sideOffset: Schema.Number,
    alignOffset: Schema.Number,
  },
  messages: [CardMessage.CompletedSideEffect],
  execute: ({ element, listSelector, rowAttribute, syncEvent, side, sideOffset, alignOffset }) =>
    domStream<typeof CardMessage.CompletedSideEffect.Type>(() => {
      const wrapper = element as HTMLElement
      const content = wrapper.firstElementChild as HTMLElement
      const cleanups: Array<() => void> = []
      const findList = () => document.querySelector<HTMLElement>(listSelector)
      const sync = (detail: HoverSyncDetail) => syncHoverTracker(findList(), syncEvent, detail)
      let lastRow: Element | null = null
      const row = () => {
        const key = content.getAttribute("data-row-key")
        const found = key ? findList()?.querySelector(`[${rowAttribute}="${CSS.escape(key)}"]`) ?? null : null
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

      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: false,
        onDismiss: () => sync({ action: "dismiss" }),
      }))

      // A right-click menu over the page makes everything under it dead to
      // the pointer, which the browser reports as the pointer leaving the
      // card. That leave is held, and looked at again on the first move after
      // the menu has gone.
      let menuHold: ((event: PointerEvent) => void) | null = null
      const releaseMenuHold = () => {
        if (!menuHold) return
        window.removeEventListener("pointermove", menuHold)
        menuHold = null
      }
      const handleLeave = (event: PointerEvent) => {
        const next = event.relatedTarget
        if (next instanceof Node && findList()?.contains(next)) return
        if (document.querySelector(OPEN_MENU_SELECTOR)) {
          if (menuHold) return
          const recheck = (moveEvent: PointerEvent) => {
            if (document.querySelector(OPEN_MENU_SELECTOR)) return
            releaseMenuHold()
            const target = moveEvent.target
            const stillOver = target instanceof Element
              && (findList()?.contains(target) || target.closest(`[${LIST_HOVER_CARD_ATTRIBUTE}]`))
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

export interface HoverCardInputs extends CardBodyInputs {
  /** The popper wrapper's key, and the surface's id. */
  key: string
  id: string
  /** What marks the surface for its list's tracker (`findCard`). */
  markers: ReadonlyArray<readonly [string, string]>
  rowKey: string
  listSelector: string
  rowAttribute: string
  syncEvent: string
  side: CardSide
  sideOffset: number
}

/** The chat card, whole: surface and body, for a surface with one list (SidebarChatHoverCard). */
export const HoverCard = Submodel.defineView<CardData, CardMessage, HoverCardInputs>((data, inputs, h) => hoverCardSurface({
  key: inputs.key,
  mount: h.OnMount(HoverCardContent({
    listSelector: inputs.listSelector,
    rowAttribute: inputs.rowAttribute,
    syncEvent: inputs.syncEvent,
    side: inputs.side,
    sideOffset: inputs.sideOffset,
    alignOffset: 0,
  })),
  markers: inputs.markers.map(([name, value]) => h.Attribute(name, value)),
  id: inputs.id,
  rowKey: inputs.rowKey,
  side: inputs.side,
  sideOffset: inputs.sideOffset,
}, [chatCardBody(data, inputs, h)], h))
