import { autoUpdate, computePosition, flip, limitShift, offset, shift, size, type Middleware, type Placement, type VirtualElement } from "@floating-ui/dom"
import { Effect, Schema } from "effect"
import { Command, Mount, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import { resolveDiffFilePath } from "../../client/app/ChatPage/utils"
import type { SidebarThread } from "../../client/lib/thread-sections"
import { cn, normalizeChatId } from "../../client/lib/utils"
import type { ChatPreview, ChatTouchedFilesResult } from "../../shared/types"
import { AppAction } from "../app/action"
import type { AppModel } from "../app/slice"
import { sendCommand } from "../core/socket"
import { CARD_CACHE_LIMIT, chatCardBody, HOVER_CARD_SURFACE_CLASSNAME, LIST_HOVER_CARD_ROOM_BELOW } from "../sidebar/hoverCard"
import type { Message as SidebarMessage } from "../sidebar/message"
import { FINE_POINTER_QUERY, type Model as SidebarModel } from "../sidebar/model"
import { registerLayer } from "../ui/overlay/layer"
import { getSideAndAlignFromPlacement, POPPER_WRAPPER_INITIAL_STYLE } from "../ui/overlay/popper"
import { portalToBody } from "../ui/overlay/portal"
import { domStream } from "../ui/overlay/stream"
import { Message, type TabCard } from "./message"
import type { Model } from "./model"

// The chat tabs' hover card (ChatTabs' `renderHoverCard`, which ChatPage
// filled with the sidebar's SidebarChatHoverCard): the sidebar's chat card,
// beneath the tab under the pointer. ListHoverCard's machinery for a bar of
// tabs: one card for the bar, the safe triangle, a press on a tab dismissing
// its card, and the tab pressed being held dismissed when the bar is rebuilt
// under the pointer (`holdRowUnderPointerOnMount`).
//
// The card's body is the sidebar's (`chatCardBody`, drawn with its own
// Messages and lifted into `GotTabCardMessage`); its tracking and placement
// are restated here, against the tab bar instead of a sidebar list.

type H = HtmlBuilder<Message>

/** On the card's element, so the bar's tracker can find it. */
const TAB_CARD_ATTRIBUTE = "data-chat-tab-card"
/** What the rows (the tabs) carry their key in. */
const ROW_ATTRIBUTE = "data-chat-id"
/** The card or an action in it telling the bar's tracker what it did. */
const SYNC_EVENT = "kanna:chat-tab-card-sync"
/** Marks every hover card's element, the sidebar's included. */
const LIST_HOVER_CARD_ATTRIBUTE = "data-list-hover-card"
/** Set on the tab the card is up for (styled with `group-data-[hover-card-open]/tabhost`). */
export const HOVER_CARD_OPEN_ATTRIBUTE = "hover-card-open"

const SIDE = "bottom"
/** Just clear of the tab; the default distance is a sidebar's edge. */
const SIDE_OFFSET = 6
/** Beneath a bar the bridge would lie across the tab itself, so it is a hairline. */
const BRIDGE_OVERLAP = 1
const COLLISION_PADDING_PX = 12
const SAFE_TRIANGLE_APEX_BACKSET_PX = 6
const SAFE_TRIANGLE_REST_MS = 300
/** How soon after mounting a pointer found on a tab is taken to have been there all along. */
const HELD_ON_MOUNT_MS = 1000
const OPEN_MENU_SELECTOR = "[data-radix-menu-content][data-state='open']"

type SyncDetail = { action: "dismiss" } | { action: "close" }

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

function findCard() {
  return document.querySelector<HTMLElement>(`[${TAB_CARD_ATTRIBUTE}]`)
}

function findBar() {
  return document.querySelector<HTMLElement>("[role=tablist][aria-label='Open chats']")
}

function syncBar(detail: SyncDetail) {
  findBar()?.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail }))
}

// TRACKER

/**
 * ListHoverCard's effect on the bar (the tab list): which tab the card is on.
 * Installed by the bar's own Mount (`TabListMount`); returns its cleanup.
 */
export function trackTabCard(list: HTMLElement, emit: (message: typeof Message.ChangedTabCardRow.Type) => void): () => void {
  const finePointer = window.matchMedia(FINE_POINTER_QUERY)
  const mountedAt = performance.now()
  let holdFirstRow = true
  let hovered: string | null = null
  let dismissed: string | null = null
  let apex: Point | null = null
  let pointer: Point | null = null
  let restTimer: number | null = null

  const setHovered = (key: string | null) => {
    if (hovered === key) return
    hovered = key
    if (key === null) apex = null
    emit(Message.ChangedTabCardRow({ key }))
  }
  const clearRestTimer = () => {
    if (restTimer === null) return
    window.clearTimeout(restTimer)
    restTimer = null
  }
  const keyAt = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest(`[${ROW_ATTRIBUTE}]`) : null
    return row?.getAttribute(ROW_ATTRIBUTE) ?? null
  }
  const safeTriangle = (): [Point, Point, Point] | null => {
    const content = findCard()
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

  // A dismissal holds while the pointer is still on its tab, judged by where
  // the pointer is against the tab's box: a click rebuilds what is under the
  // pointer (a tab becoming the open one), and the enter and leave events
  // that follow name elements the pointer never crossed.
  const releaseDismissalIfLeft = (event: PointerEvent) => {
    if (dismissed === null) return
    const row = list.querySelector(`[${ROW_ATTRIBUTE}="${CSS.escape(dismissed)}"]`)
    const rect = row?.getBoundingClientRect()
    const stillOnRow = rect !== undefined
      && event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom
    if (!stillOnRow) dismissed = null
  }
  // A press on a tab dismisses its card: the tab was acted on.
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
      // The first the bar hears of the pointer: where it already was, if that
      // is soon after mounting (the bar rebuilt by a click on one of its tabs).
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
    const triangle = hovered === null ? null : safeTriangle()
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
  // From a tab toward a card that hangs below the bar the way leaves the bar
  // altogether: followed on the window while inside the triangle.
  const trackOutside = (event: PointerEvent) => {
    const target = event.target
    if (target instanceof Node && (list.contains(target) || findCard()?.contains(target))) {
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
    if (next instanceof Node && findCard()?.contains(next)) return
    const triangle = hovered === null ? null : safeTriangle()
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
    const detail = (event as CustomEvent<SyncDetail>).detail
    if (detail.action === "dismiss") {
      // Only a card that is up has a tab to hold closed.
      if (hovered !== null) dismissed = hovered
    }
    setHovered(null)
  }

  document.addEventListener("pointermove", releaseDismissalIfLeft, true)
  list.addEventListener("pointerdown", handlePointerDown, true)
  list.addEventListener("pointerover", track)
  list.addEventListener("pointermove", track)
  list.addEventListener("pointerleave", handlePointerLeave)
  list.addEventListener(SYNC_EVENT, handleSync)
  window.addEventListener("blur", handleWindowBlur)
  return () => {
    stopTrackingOutside()
    document.removeEventListener("pointermove", releaseDismissalIfLeft, true)
    list.removeEventListener("pointerdown", handlePointerDown, true)
    list.removeEventListener("pointerover", track)
    list.removeEventListener("pointermove", track)
    list.removeEventListener("pointerleave", handlePointerLeave)
    list.removeEventListener(SYNC_EVENT, handleSync)
    window.removeEventListener("blur", handleWindowBlur)
  }
}

// PLACEMENT

/**
 * Radix's popper placement, with the update exposed: the card is one element
 * that moves from tab to tab, placed again on each move without remounting
 * (which would replay its entrance).
 */
function placeCard(wrapper: HTMLElement, content: HTMLElement, reference: VirtualElement) {
  const placement = `${SIDE}-start` as Placement
  const detectOverflowOptions = { padding: COLLISION_PADDING_PX, boundary: [] as Element[], altBoundary: false }
  const middleware: Middleware[] = [
    offset({ mainAxis: SIDE_OFFSET, alignmentAxis: 0 }),
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
 * On the card's popper wrapper: to <body>, placed beneath its tab (and again
 * whenever it moves to another), dismissed by Escape, a press outside or
 * focus moving out (Radix's non-modal popover), and closed when the pointer
 * leaves it for anywhere but the bar.
 */
export const TabCardContent = Mount.defineStream("ChatTabCardContent", {
  messages: [Message.CompletedSideEffect],
  execute: ({ element }) =>
    domStream<typeof Message.CompletedSideEffect.Type>(() => {
      const wrapper = element as HTMLElement
      const content = wrapper.firstElementChild as HTMLElement
      const cleanups: Array<() => void> = []
      let lastRow: Element | null = null
      const row = () => {
        const key = content.getAttribute("data-row-key")
        const found = key ? findBar()?.querySelector(`[${ROW_ATTRIBUTE}="${CSS.escape(key)}"]`) ?? null : null
        if (found) lastRow = found
        return found ?? lastRow
      }
      const reference: VirtualElement = {
        getBoundingClientRect: () => row()?.getBoundingClientRect() ?? DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 }),
        contextElement: row() ?? undefined,
      }
      const setRoom = () => {
        const top = row()?.getBoundingClientRect().top ?? 0
        const room = window.innerHeight - top - COLLISION_PADDING_PX
        content.style.setProperty(LIST_HOVER_CARD_ROOM_BELOW, `${Math.max(0, room)}px`)
      }

      cleanups.push(portalToBody(wrapper))
      setRoom()
      const placement = placeCard(wrapper, content, reference)
      cleanups.push(placement.cleanup)
      const observer = new MutationObserver(() => {
        setRoom()
        placement.update()
      })
      observer.observe(content, { attributes: true, attributeFilter: ["data-row-key"] })
      cleanups.push(() => observer.disconnect())

      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: false,
        onDismiss: () => syncBar({ action: "dismiss" }),
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
        if (next instanceof Node && findBar()?.contains(next)) return
        if (document.querySelector(OPEN_MENU_SELECTOR)) {
          if (menuHold) return
          const recheck = (moveEvent: PointerEvent) => {
            if (document.querySelector(OPEN_MENU_SELECTOR)) return
            releaseMenuHold()
            const target = moveEvent.target
            const stillOver = target instanceof Element
              && (findBar()?.contains(target) || target.closest(`[${LIST_HOVER_CARD_ATTRIBUTE}]`))
            if (!stillOver) syncBar({ action: "close" })
          }
          menuHold = recheck
          window.addEventListener("pointermove", recheck)
          return
        }
        syncBar({ action: "close" })
      }
      content.addEventListener("pointerleave", handleLeave)
      cleanups.push(() => {
        content.removeEventListener("pointerleave", handleLeave)
        releaseMenuHold()
      })

      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

// COMMANDS

/** An action in the card dismisses it first: each takes you somewhere. */
export const DismissTabCard = Command.define("DismissChatTabCard", {
  messages: [Message.CompletedSideEffect],
  execute: Effect.sync(() => {
    syncBar({ action: "dismiss" })
    return Message.CompletedSideEffect()
  }),
})

export const LoadTabCardFiles = Command.define("LoadChatTabCardFiles", {
  args: { chatId: Schema.String, cacheKey: Schema.String },
  messages: [Message.SucceededLoadTabCardFiles, Message.FailedLoadTabCard],
  execute: ({ chatId, cacheKey }) => sendCommand<ChatTouchedFilesResult>({ type: "chat.touchedFiles", chatId }).pipe(
    Effect.map((result) => Message.SucceededLoadTabCardFiles({ chatId, cacheKey, result })),
    Effect.catch(() => Effect.succeed(Message.FailedLoadTabCard())),
  ),
})

export const LoadTabCardPreview = Command.define("LoadChatTabCardPreview", {
  args: { chatId: Schema.String, cacheKey: Schema.String },
  messages: [Message.SucceededLoadTabCardPreview, Message.FailedLoadTabCard],
  execute: ({ chatId, cacheKey }) => sendCommand<ChatPreview>({ type: "chat.getPreview", chatId }).pipe(
    Effect.map((preview) => Message.SucceededLoadTabCardPreview({ chatId, cacheKey, preview })),
    Effect.catch(() => Effect.succeed(Message.FailedLoadTabCard())),
  ),
})

/**
 * The repo, opened by this browser rather than through the machine the
 * project lives on (the wrong screen whenever that isn't this one).
 */
export const OpenTabCardRepo = Command.define("OpenChatTabCardRepo", {
  args: { url: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ url }) => Effect.sync(() => {
    window.open(url, "_blank", "noopener,noreferrer")
    return Message.CompletedSideEffect()
  }),
})

// UPDATE

function cacheInsert<Value>(cache: Readonly<Record<string, Value>>, key: string, value: Value): Record<string, Value> {
  const next: Record<string, Value> = { ...cache }
  const keys = Object.keys(next)
  if (!(key in next) && keys.length >= CARD_CACHE_LIMIT) delete next[keys[0]!]
  next[key] = value
  return next
}

type TabCardCommand = Command.Command<Message, never, unknown>

export interface TabCardStep {
  model: Model
  commands: ReadonlyArray<TabCardCommand>
  action: AppAction | null
}

function withCard(model: Model, change: (card: TabCard) => TabCard): Model {
  return modifyFields(model, { tabCard: change })
}

/** The page's handling of the card's Messages (`SidebarChatCard`'s actions, ChatPage's tab card props). */
export function updateTabCard(model: Model, message: Message, app: AppModel): TabCardStep | null {
  const step = (next: Model, commands: ReadonlyArray<TabCardCommand> = [], action: AppAction | null = null): TabCardStep => ({ model: next, commands, action })
  switch (message._tag) {
    case "ChangedTabCardRow":
      return step(withCard(model, (card) => ({
        ...card,
        hovered: message.key,
        // A card that leaves stops waiting on its answers.
        ...(message.key === null ? { cardFilesKey: null, cardPreviewKey: null } : {}),
      })))
    case "SucceededLoadTabCardFiles":
      return step(withCard(model, (card) => ({
        ...card,
        touchedFilesCache: cacheInsert(card.touchedFilesCache, message.cacheKey, message.result),
        heldTouchedFiles: card.cardFilesKey === message.cacheKey ? { chatId: message.chatId, result: message.result } : card.heldTouchedFiles,
      })))
    case "SucceededLoadTabCardPreview":
      return step(withCard(model, (card) => ({
        ...card,
        previewCache: cacheInsert(card.previewCache, message.cacheKey, message.preview),
        heldPreview: card.cardPreviewKey === message.cacheKey ? { chatId: message.chatId, preview: message.preview } : card.heldPreview,
      })))
    case "FailedLoadTabCard":
      return step(model)
    case "GotTabCardMessage":
      return cardBodyMessage(model, message.message, app)
    default:
      return null
  }
}

function cardBodyMessage(model: Model, message: SidebarMessage, app: AppModel): TabCardStep {
  const step = (next: Model, commands: ReadonlyArray<TabCardCommand> = [], action: AppAction | null = null): TabCardStep => ({ model: next, commands, action })
  const card = model.tabCard
  switch (message._tag) {
    // useChatTouchedFiles, then useChatPreview: from the cache when it has
    // the key (the sidebar's card's too, as React's caches were one), else
    // asked for, keeping what the card held for the same chat meanwhile.
    case "RequestedCardLoad": {
      const { chatId, kind, cacheKey } = message
      if (kind === "files") {
        const cached = card.touchedFilesCache[cacheKey] ?? app.sidebar.touchedFilesCache[cacheKey]
        if (cached) return step(withCard(model, (current) => ({ ...current, heldTouchedFiles: { chatId, result: cached }, cardFilesKey: cacheKey })))
        return step(
          withCard(model, (current) => ({ ...current, heldTouchedFiles: current.heldTouchedFiles?.chatId === chatId ? current.heldTouchedFiles : null, cardFilesKey: cacheKey })),
          [LoadTabCardFiles({ chatId, cacheKey })],
        )
      }
      const cached = card.previewCache[cacheKey] ?? app.sidebar.previewCache[cacheKey]
      if (cached) return step(withCard(model, (current) => ({ ...current, heldPreview: { chatId, preview: cached }, cardPreviewKey: cacheKey })))
      return step(
        withCard(model, (current) => ({ ...current, heldPreview: current.heldPreview?.chatId === chatId ? current.heldPreview : null, cardPreviewKey: cacheKey })),
        [LoadTabCardPreview({ chatId, cacheKey })],
      )
    }
    // Opening a chat at one end of its last exchange.
    case "ClickedCardMessage":
      return step(model, [DismissTabCard()], AppAction.OpenChatAt({ chatId: message.chatId, jump: message.role }))
    // The draft's action: the chat plainly, or an archived one by its own route.
    case "ClickedCardChat":
      return step(model, [DismissTabCard()], message.archived
        ? AppAction.OpenArchivedChat({ chatId: message.chatId })
        : AppAction.Navigate({ path: `/chat/${message.chatId}`, replace: false }))
    case "ClickedCardSetupGit":
      return step(model, [DismissTabCard()], AppAction.SetupGit({ chatId: message.chatId }))
    case "ClickedCardRepo":
      return step(model, [DismissTabCard(), OpenTabCardRepo({ url: message.url })])
    // Repo-relative, as the server records them: the project path goes back on.
    case "ClickedCardFile":
      return step(model, [DismissTabCard()], AppAction.OpenExternalPath({ action: "open_editor", localPath: resolveDiffFilePath(message.localPath, message.filePath) }))
    default:
      return step(model)
  }
}

// VIEW

/** The card's body: the sidebar's, over the sidebar's Model with this card's fetches. */
const CardBody = Submodel.defineView<SidebarModel, SidebarMessage, { thread: SidebarThread; app: AppModel }>(
  (model, { thread, app }, h) => chatCardBody(thread, "chats", app, model, h),
)

/** Whether the card is up, and for which tab: on a tab whose chat the sidebar knows, with a fine pointer. */
export function openTabCardKey(model: Model, app: AppModel, threads: ReadonlyMap<string, SidebarThread>): string | null {
  const key = model.tabCard.hovered
  if (!key || !app.sidebar.hasFinePointer) return null
  return threadForKey(threads, key) ? key : null
}

function threadForKey(threads: ReadonlyMap<string, SidebarThread>, key: string): SidebarThread | undefined {
  for (const [chatId, thread] of threads) {
    if (normalizeChatId(chatId) === key) return thread
  }
  return undefined
}

/**
 * The card, as Radix's Popover.Content renders it in its portal: a popper
 * wrapper, then the `role="dialog"` surface with the bridge over the gap to
 * its tab. Nothing while no tab has it.
 */
export function tabHoverCardView(model: Model, app: AppModel, threads: ReadonlyMap<string, SidebarThread>, h: H): Html | null {
  const key = openTabCardKey(model, app, threads)
  const thread = key ? threadForKey(threads, key) : undefined
  if (!key || !thread) return null
  const card = model.tabCard
  const cardModel: SidebarModel = {
    ...app.sidebar,
    previewCache: { ...app.sidebar.previewCache, ...card.previewCache },
    touchedFilesCache: { ...app.sidebar.touchedFilesCache, ...card.touchedFilesCache },
    heldPreview: card.heldPreview,
    heldTouchedFiles: card.heldTouchedFiles,
  }
  return h.keyed("div")("chat-tab-hover-card", [
    h.DataAttribute("radix-popper-content-wrapper", ""),
    h.Style(POPPER_WRAPPER_INITIAL_STYLE),
    h.OnMount(TabCardContent()),
  ], [
    h.div([
      h.Attribute(LIST_HOVER_CARD_ATTRIBUTE, ""),
      h.Attribute(TAB_CARD_ATTRIBUTE, ""),
      h.DataAttribute("row-key", key),
      h.DataAttribute("side", SIDE),
      h.DataAttribute("align", "start"),
      h.DataAttribute("state", "open"),
      h.Role("dialog"),
      h.Id("radix-chat-tab-hover-card"),
      h.Tabindex(-1),
      h.Style({
        "--bridge": `${Math.max(0, SIDE_OFFSET) + BRIDGE_OVERLAP}px`,
        "--radix-popover-content-transform-origin": "var(--radix-popper-transform-origin)",
        "--radix-popover-content-available-width": "var(--radix-popper-available-width)",
        "--radix-popover-content-available-height": "var(--radix-popper-available-height)",
        "--radix-popover-trigger-width": "var(--radix-popper-anchor-width)",
        "--radix-popover-trigger-height": "var(--radix-popper-anchor-height)",
      }),
      h.Class(cn(
        HOVER_CARD_SURFACE_CLASSNAME,
        // The bridge: an invisible part of the card over the gap to the tab,
        // overlapping the tab's edge so no subpixel seam drops the pointer.
        "relative before:absolute before:content-['']",
        "data-[side=right]:before:inset-y-0 data-[side=right]:before:left-[calc(var(--bridge)*-1)] data-[side=right]:before:w-(--bridge)",
        "data-[side=left]:before:inset-y-0 data-[side=left]:before:right-[calc(var(--bridge)*-1)] data-[side=left]:before:w-(--bridge)",
        "data-[side=bottom]:before:inset-x-0 data-[side=bottom]:before:top-[calc(var(--bridge)*-1)] data-[side=bottom]:before:h-(--bridge)",
        "data-[side=top]:before:inset-x-0 data-[side=top]:before:bottom-[calc(var(--bridge)*-1)] data-[side=top]:before:h-(--bridge)",
        "origin-(--radix-popover-content-transform-origin)",
      )),
    ], [
      h.submodel({
        slotId: "chat-tab-card-body",
        model: cardModel,
        view: CardBody,
        viewInputs: { thread, app },
        toParentMessage: (message) => Message.GotTabCardMessage({ message }),
      }),
    ]),
  ])
}
