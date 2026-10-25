import type { VirtualElement } from "@floating-ui/dom"
import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SidebarThread } from "../../client/lib/thread-sections"
import { normalizeChatId } from "../../client/lib/utils"
import type { AppModel } from "../app/slice"
import * as ChatInput from "../core/stores/chatInput"
import type { Child } from "../ui/attributes"
import * as ChatCard from "../ui/chat-hover-card"
import { registerLayer } from "../ui/overlay/layer"
import { portalToBody } from "../ui/overlay/portal"
import { domStream } from "../ui/overlay/stream"
import { threadByRowId } from "./derived"
import { Message } from "./message"
import { HoverList, type Model } from "./model"

type H = HtmlBuilder<Message>

// The sidebar's list hover cards (components/ui/list-hover-card.tsx): the
// chat card beside its chat rows (SidebarChatHoverCard, whose body and
// fetches are ui/chat-hover-card.ts, shared with the chat tabs and the
// transcript's chat cards) and the channel card. The sidebar's tracker is its
// own: a channel's card can be pinned open, and holds the chats' own card.
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
const { LIST_HOVER_CARD_ATTRIBUTE, LIST_HOVER_CARD_ROOM_BELOW, OPEN_MENU_SELECTOR, SAFE_TRIANGLE_REST_MS, COLLISION_PADDING_PX, FINE_POINTER_QUERY } = ChatCard
const SYNC_EVENT = "kanna:list-hover-sync"

/** The attribute a list's rows carry their key in. */
export const ROW_ATTRIBUTES: Record<HoverList, string> = {
  chats: "data-chat-id",
  channels: "data-channel-id",
  peek: "data-chat-id",
}

export { HOVER_CARD_SURFACE_CLASSNAME, LIST_HOVER_CARD_ROOM_BELOW } from "../ui/chat-hover-card"

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
      let apex: ChatCard.Point | null = null
      let pointer: ChatCard.Point | null = null
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
      const safeTriangle = () => ChatCard.safeTriangle(findCard(list), apex)
      const settle = (key: string | null, point: ChatCard.Point) => {
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
        if (triangle && ChatCard.isInsideTriangle(point, ...triangle)) {
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
        if (!triangle || !ChatCard.isInsideTriangle(point, ...triangle)) {
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
        if (triangle && ChatCard.isInsideTriangle({ x: event.clientX, y: event.clientY }, ...triangle)) {
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
      const placement = ChatCard.placeCard(wrapper, content, reference, { side, sideOffset, alignOffset })
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
  return ChatCard.hoverCardSurface({
    key: `list-hover-card-${options.list}`,
    mount: h.OnMount(ListHoverCardContent({ list: options.list, side, sideOffset, alignOffset })),
    markers: [
      h.Attribute(LIST_HOVER_CARD_ATTRIBUTE, options.list),
      ...(options.parentList ? [h.DataAttribute("parent-list", options.parentList)] : []),
    ],
    id: `radix-list-hover-card-${options.list}`,
    rowKey: options.rowKey,
    side,
    sideOffset,
    className: options.className,
  }, content, h)
}

// THE CHAT CARD (SidebarChatHoverCard)

/**
 * The other surfaces' card data, whose fetches serve the sidebar's card too
 * (React's caches were one, module-wide).
 */
export function sharedCardData(app: AppModel): ReadonlyArray<ChatCard.CardData> {
  return [app.chatPage.tabCard.card, app.chatPage.transcript.chatCard]
}

/** The card's body (ui/chat-hover-card.ts), its Messages lifted into the list's. */
export function chatCardBody(thread: SidebarThread, list: HoverList, app: AppModel, model: Model, h: H): Html {
  return h.submodel({
    slotId: `sidebar-chat-card-${list}`,
    model: model.card,
    view: ChatCard.CardBody,
    viewInputs: {
      thread,
      draft: ChatInput.chatDraft(app.stores.chatInput, thread.row.chatId) || null,
      nowMs: model.nowMs,
      shared: sharedCardData(app),
    },
    toParentMessage: (message: ChatCard.CardMessage) => Message.GotCardMessage({ list, message }),
  })
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
