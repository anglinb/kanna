import { Mount } from "foldkit"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"

// Work tied to the sidebar's own elements.

// From app/useEdgePeek.ts (a React file, so copied).

/**
 * How long the mouse may be out of the window before a peek gives up on it:
 * an overshoot comes back within 300 to 500ms, a departure doesn't.
 */
const PEEK_AWAY_CLOSE_MS = 600
/** How often a held peek is looked at again. */
const PEEK_AWAY_HELD_RECHECK_MS = 200

/** A menu, select or dialog that is up (a hover card is a dialog too). */
export const OPEN_LAYER_SELECTOR = "[role='menu'][data-state='open'], [role='listbox'][data-state='open'], [role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"

interface PeekAway {
  since: number | null
}

const PEEK_POINTER_INSIDE: PeekAway = { since: null }

/**
 * Whether a peek whose mouse is out of the window should close now, and if
 * not, when to ask again. Held (a button down, a menu up, a field in the
 * panel being typed in), it does not close, and the clock starts over.
 */
function checkPeekAway(away: PeekAway, now: number, held: boolean): { away: PeekAway; close: boolean; recheckInMs: number | null } {
  if (away.since === null) return { away, close: false, recheckInMs: null }
  if (held) return { away: { since: now }, close: false, recheckInMs: PEEK_AWAY_HELD_RECHECK_MS }
  const remaining = PEEK_AWAY_CLOSE_MS - (now - away.since)
  if (remaining <= 0) return { away, close: true, recheckInMs: null }
  return { away, close: false, recheckInMs: remaining }
}

/** Whether a point is on the shown panel, give or take `slopPx`. */
function isOnPeekPanel(fromEdgePx: number, y: number, panel: { reachPx: number; top: number; bottom: number }, slopPx: number) {
  return fromEdgePx <= panel.reachPx + slopPx && y >= panel.top - slopPx && y <= panel.bottom + slopPx
}

/** Whether a chat's send time moved between two serialized `sentAt` maps (a removal is not a send). */
function sendStarted(previous: string, next: string) {
  try {
    const before = JSON.parse(previous) as Record<string, number>
    const after = JSON.parse(next) as Record<string, number>
    return Object.keys(after).some((chatId) => after[chatId] !== before[chatId])
  } catch {
    return false
  }
}

/** How far past the panel's inner edge the mouse may stray before the panel leaves. */
const PEEK_SLOP_PX = 16
const PEEK_EDGE_PX = 8
const PEEK_INSET_PX = 8

/**
 * KannaSidebar's scroll-to-active: when the open chat changes, its row is
 * brought into view, below the sticky header's 38px or centred.
 */
function scrollActiveIntoView(card: HTMLElement) {
  const chatId = card.dataset.sidebarActiveChat
  if (!chatId) return
  requestAnimationFrame(() => {
    const container = card.querySelector<HTMLElement>("[data-sidebar-scroller]")
    const activeElement = container?.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(chatId)}"]`)
    if (!activeElement || !container) return
    const elementRect = activeElement.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    if (elementRect.top < containerRect.top + 38) {
      const relativeTop = elementRect.top - containerRect.top + container.scrollTop
      container.scrollTo({ top: relativeTop - 38, behavior: "smooth" })
    } else if (elementRect.bottom > containerRect.bottom) {
      const elementCenter = elementRect.top + elementRect.height / 2 - containerRect.top + container.scrollTop
      container.scrollTo({ top: elementCenter - container.clientHeight / 2, behavior: "smooth" })
    }
  })
}

/**
 * On the sidebar card. The card's own effects, which follow what it shows:
 *
 *  - the open chat's row scrolled into view when the chat changes;
 *  - the peek (useEdgePeek): while collapsed, the card comes back over the
 *    chat when the mouse reaches the window's left edge, and leaves when the
 *    mouse leaves it;
 *  - the machine switcher's connection check (MachineSwitcher's effect),
 *    asked for when the card says it is needed.
 *
 * What changed is read off the card's `data-sidebar-*` attributes, which the
 * view keeps current.
 */
export const SidebarCard = Mount.defineStream("SidebarCard", {
  messages: [Message.ChangedPeek, Message.RequestedConnectionLoad, Message.RequestedPairSession, Message.ObservedSendStarted],
  execute: ({ element }) =>
    domStream<typeof Message.ChangedPeek.Type | typeof Message.RequestedConnectionLoad.Type | typeof Message.RequestedPairSession.Type | typeof Message.ObservedSendStarted.Type>((emit) => {
      const card = element as HTMLElement
      const cleanups: Array<() => void> = []

      // Scroll to the active chat, and the effects asked for by attribute.
      let activeChat = card.dataset.sidebarActiveChat ?? ""
      let connectionLoad = card.dataset.sidebarConnectionLoad === "1"
      let pairEnabled = card.dataset.sidebarPairEnabled === "1"
      let sends = card.dataset.sidebarSends ?? ""
      scrollActiveIntoView(card)
      if (connectionLoad) emit(Message.RequestedConnectionLoad())
      if (pairEnabled) emit(Message.RequestedPairSession())
      const observer = new MutationObserver(() => {
        const nextChat = card.dataset.sidebarActiveChat ?? ""
        if (nextChat !== activeChat) {
          activeChat = nextChat
          scrollActiveIntoView(card)
        }
        const nextLoad = card.dataset.sidebarConnectionLoad === "1"
        if (nextLoad !== connectionLoad) {
          connectionLoad = nextLoad
          if (nextLoad) emit(Message.RequestedConnectionLoad())
        }
        const nextPair = card.dataset.sidebarPairEnabled === "1"
        if (nextPair !== pairEnabled) {
          pairEnabled = nextPair
          if (nextPair) emit(Message.RequestedPairSession())
        }
        const nextSends = card.dataset.sidebarSends ?? ""
        if (nextSends !== sends) {
          const previous = sends
          sends = nextSends
          if (previous && nextSends && sendStarted(previous, nextSends)) emit(Message.ObservedSendStarted())
        }
        syncPeek()
      })
      observer.observe(card, {
        attributes: true,
        attributeFilter: ["data-sidebar-active-chat", "data-sidebar-connection-load", "data-sidebar-pair-enabled", "data-sidebar-collapsed", "data-sidebar-sends"],
      })
      cleanups.push(() => observer.disconnect())

      // THE PEEK
      let peekInstalled = false
      let open = false
      let buttons = 0
      let lastPointerWasMouse = false
      let away = PEEK_POINTER_INSIDE
      let awayTimer: number | undefined
      let focusWatch: number | undefined
      const peekCleanups: Array<() => void> = []

      const show = () => {
        open = true
        emit(Message.ChangedPeek({ peeking: true }))
      }
      const hide = () => {
        stopAwayWatch()
        if (!open) return
        open = false
        emit(Message.ChangedPeek({ peeking: false }))
      }
      const fromEdge = (clientX: number) => clientX
      const besidePanel = (clientY: number) => {
        const rect = card.getBoundingClientRect()
        return clientY >= rect.top && clientY <= rect.bottom
      }
      const onPanel = (clientX: number, clientY: number) => {
        const rect = card.getBoundingClientRect()
        return isOnPeekPanel(fromEdge(clientX), clientY, { reachPx: PEEK_INSET_PX + card.offsetWidth, top: rect.top, bottom: rect.bottom }, PEEK_SLOP_PX)
      }
      const inWindow = (event: MouseEvent) => event.clientX >= 0 && event.clientX < window.innerWidth
        && event.clientY >= 0 && event.clientY < window.innerHeight
      const isBusy = () => {
        if (buttons !== 0) return true
        if (document.querySelector(OPEN_LAYER_SELECTOR)) return true
        const focused = document.activeElement
        return focused instanceof HTMLElement
          && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable)
          && card.contains(focused)
      }
      function startAwayWatch() {
        away = { since: performance.now() }
        scheduleAwayCheck(PEEK_AWAY_CLOSE_MS)
      }
      function stopAwayWatch() {
        window.clearTimeout(awayTimer)
        awayTimer = undefined
        away = PEEK_POINTER_INSIDE
      }
      function scheduleAwayCheck(delayMs: number) {
        window.clearTimeout(awayTimer)
        awayTimer = window.setTimeout(() => {
          awayTimer = undefined
          if (!open) return
          const result = checkPeekAway(away, performance.now(), isBusy())
          away = result.away
          if (result.close) hide()
          else if (result.recheckInMs !== null) scheduleAwayCheck(result.recheckInMs)
        }, delayMs)
      }
      const handleWindowBlur = () => hide()
      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") hide()
      }
      const handlePointerDown = (event: PointerEvent) => {
        lastPointerWasMouse = event.pointerType === "mouse"
        if (lastPointerWasMouse) buttons = event.buttons
      }
      const handlePointerUp = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return
        buttons = event.buttons
        if (open && !inWindow(event)) startAwayWatch()
      }
      const handlePointerMove = (event: PointerEvent) => {
        lastPointerWasMouse = event.pointerType === "mouse"
        if (!lastPointerWasMouse) return
        buttons = event.buttons
        if (!inWindow(event)) {
          if (open && away.since === null) startAwayWatch()
          return
        }
        stopAwayWatch()
        if (fromEdge(event.clientX) <= PEEK_EDGE_PX && besidePanel(event.clientY)) {
          if (!open && buttons === 0 && document.hasFocus()) show()
          return
        }
        if (open && !onPanel(event.clientX, event.clientY) && !isBusy()) hide()
      }
      const handleMouseLeave = (event: MouseEvent) => {
        if (!lastPointerWasMouse) return
        buttons = event.buttons
        if (away.since !== null) return
        if (!open && fromEdge(event.clientX) <= 0 && besidePanel(event.clientY) && buttons === 0 && document.hasFocus()) show()
        if (!open) return
        const exitX = Math.min(Math.max(event.clientX, 0), window.innerWidth)
        const exitY = Math.min(Math.max(event.clientY, 0), window.innerHeight)
        if (onPanel(exitX, exitY) || isBusy()) startAwayWatch()
        else hide()
      }
      const handleMouseEnter = () => {
        if (lastPointerWasMouse) stopAwayWatch()
      }
      const installPeek = () => {
        if (peekInstalled) return
        peekInstalled = true
        window.addEventListener("pointerdown", handlePointerDown, true)
        window.addEventListener("pointerup", handlePointerUp, true)
        window.addEventListener("pointercancel", handlePointerUp, true)
        window.addEventListener("pointermove", handlePointerMove)
        window.addEventListener("blur", handleWindowBlur)
        document.addEventListener("visibilitychange", handleVisibilityChange)
        document.documentElement.addEventListener("mouseleave", handleMouseLeave)
        document.documentElement.addEventListener("mouseenter", handleMouseEnter)
        focusWatch = window.setInterval(() => {
          if (open && !document.hasFocus()) hide()
        }, 200)
        peekCleanups.push(() => {
          window.removeEventListener("pointerdown", handlePointerDown, true)
          window.removeEventListener("pointerup", handlePointerUp, true)
          window.removeEventListener("pointercancel", handlePointerUp, true)
          window.removeEventListener("pointermove", handlePointerMove)
          window.removeEventListener("blur", handleWindowBlur)
          document.removeEventListener("visibilitychange", handleVisibilityChange)
          window.clearInterval(focusWatch)
          window.clearTimeout(awayTimer)
          document.documentElement.removeEventListener("mouseleave", handleMouseLeave)
          document.documentElement.removeEventListener("mouseenter", handleMouseEnter)
        })
      }
      const uninstallPeek = () => {
        if (!peekInstalled) return
        peekInstalled = false
        peekCleanups.splice(0).forEach((cleanup) => cleanup())
        away = PEEK_POINTER_INSIDE
        // Expanding ends the peek (useEdgePeek's `enabled && requested`).
        if (open) {
          open = false
          emit(Message.ChangedPeek({ peeking: false }))
        }
      }
      function syncPeek() {
        if (card.dataset.sidebarCollapsed === "true") installPeek()
        else uninstallPeek()
      }
      syncPeek()
      cleanups.push(uninstallPeek)

      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})
