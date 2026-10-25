// useEdgePeek (src/client/app/useEdgePeek.ts, a React file: its rules copied
// here, its effect a Mount's setup): a closed side panel comes back as an
// overlay while the mouse is at its edge of the window, and leaves as soon
// as the mouse has left it. Nothing is opened: this only says when to show
// the panel over the chat. Listened for on the document rather than on a
// strip along the edge, which would take the clicks that land on it.

/** How far past the panel's inner edge the mouse may stray before the panel leaves. */
const PEEK_SLOP_PX = 16

/**
 * How long the mouse may be out of the window before a peek gives up on it:
 * an overshoot comes back in some 300 to 500ms; a mouse gone to another
 * screen takes the panel down before it is in the way.
 */
export const PEEK_AWAY_CLOSE_MS = 600

/** How often a held peek is looked at again. The focus watch's beat. */
const PEEK_AWAY_HELD_RECHECK_MS = 200

/** A menu, select or dialog that is up: they portal out of the panel. */
export const OPEN_LAYER_SELECTOR = "[role='menu'][data-state='open'], [role='listbox'][data-state='open'], [role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"

export interface PeekAway {
  since: number | null
}

export const PEEK_POINTER_INSIDE: PeekAway = { since: null }

export function peekPointerLeft(now: number): PeekAway {
  return { since: now }
}

/**
 * Whether a peek whose mouse is out of the window should close now, and if
 * not, when to ask again. Held (a button down, a menu up, a field in the
 * panel being typed in), it does not close, and the clock starts over.
 */
export function checkPeekAway(away: PeekAway, now: number, held: boolean): { away: PeekAway; close: boolean; recheckInMs: number | null } {
  if (away.since === null) return { away, close: false, recheckInMs: null }
  if (held) return { away: { since: now }, close: false, recheckInMs: PEEK_AWAY_HELD_RECHECK_MS }
  const remaining = PEEK_AWAY_CLOSE_MS - (now - away.since)
  if (remaining <= 0) return { away, close: true, recheckInMs: null }
  return { away, close: false, recheckInMs: remaining }
}

/** Whether a point is on the shown panel, give or take `slopPx`. `fromEdgePx` is measured from the panel's side of the window. */
export function isOnPeekPanel(fromEdgePx: number, y: number, panel: { reachPx: number; top: number; bottom: number }, slopPx: number) {
  return fromEdgePx <= panel.reachPx + slopPx && y >= panel.top - slopPx && y <= panel.bottom + slopPx
}

/**
 * The peek's listeners, on `panel` (the panel as it is laid out). Calls
 * `report(true)` when it should show and `report(false)` when it should go.
 * Returns the cleanup.
 */
export function watchEdgePeek(options: {
  side: "left" | "right"
  panel: HTMLElement
  edgePx: number
  insetPx?: number
  report: (peeking: boolean) => void
}): () => void {
  const { side, panel, edgePx, report } = options
  const insetPx = options.insetPx ?? 0
  let open = false
  let buttons = 0
  let lastPointerWasMouse = false
  let away = PEEK_POINTER_INSIDE
  let awayTimer: number | undefined

  function show() {
    open = true
    report(true)
  }

  function hide() {
    stopAwayWatch()
    if (open) report(false)
    open = false
  }

  const fromEdge = (clientX: number) => (side === "left" ? clientX : window.innerWidth - clientX)

  function besidePanel(clientY: number) {
    const rect = panel.getBoundingClientRect()
    return clientY >= rect.top && clientY <= rect.bottom
  }

  function onPanel(clientX: number, clientY: number) {
    const rect = panel.getBoundingClientRect()
    return isOnPeekPanel(fromEdge(clientX), clientY, { reachPx: insetPx + panel.offsetWidth, top: rect.top, bottom: rect.bottom }, PEEK_SLOP_PX)
  }

  const inWindow = (event: MouseEvent) => event.clientX >= 0 && event.clientX < window.innerWidth
    && event.clientY >= 0 && event.clientY < window.innerHeight

  function isBusy() {
    if (buttons !== 0) return true
    if (document.querySelector(OPEN_LAYER_SELECTOR)) return true
    const focused = document.activeElement
    return focused instanceof HTMLElement
      && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable)
      && panel.contains(focused)
  }

  const handleWindowBlur = () => hide()
  const focusWatch = window.setInterval(() => {
    if (open && !document.hasFocus()) hide()
  }, 200)
  const handleVisibilityChange = () => {
    if (document.visibilityState !== "visible") hide()
  }

  function startAwayWatch() {
    away = peekPointerLeft(performance.now())
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

  function handlePointerDown(event: PointerEvent) {
    lastPointerWasMouse = event.pointerType === "mouse"
    if (lastPointerWasMouse) buttons = event.buttons
  }

  function handlePointerUp(event: PointerEvent) {
    if (event.pointerType !== "mouse") return
    buttons = event.buttons
    if (open && !inWindow(event)) startAwayWatch()
  }

  function handlePointerMove(event: PointerEvent) {
    lastPointerWasMouse = event.pointerType === "mouse"
    if (!lastPointerWasMouse) return
    buttons = event.buttons
    if (!inWindow(event)) {
      if (open && away.since === null) startAwayWatch()
      return
    }
    stopAwayWatch()
    if (fromEdge(event.clientX) <= edgePx && besidePanel(event.clientY)) {
      if (!open && buttons === 0 && document.hasFocus()) show()
      return
    }
    if (open && !onPanel(event.clientX, event.clientY) && !isBusy()) hide()
  }

  function handleMouseLeave(event: MouseEvent) {
    if (!lastPointerWasMouse) return
    buttons = event.buttons
    if (away.since !== null) return
    if (!open && fromEdge(event.clientX) <= 0 && besidePanel(event.clientY) && buttons === 0 && document.hasFocus()) show()
    if (!open) return
    // Leaving by the panel's side (or over it into the title bar) may be an
    // overshoot, and gets the wait; so does one mid-drag or under a menu.
    const exitX = Math.min(Math.max(event.clientX, 0), window.innerWidth)
    const exitY = Math.min(Math.max(event.clientY, 0), window.innerHeight)
    if (onPanel(exitX, exitY) || isBusy()) startAwayWatch()
    else hide()
  }

  function handleMouseEnter() {
    if (lastPointerWasMouse) stopAwayWatch()
  }

  window.addEventListener("pointerdown", handlePointerDown, true)
  window.addEventListener("pointerup", handlePointerUp, true)
  window.addEventListener("pointercancel", handlePointerUp, true)
  window.addEventListener("pointermove", handlePointerMove)
  window.addEventListener("blur", handleWindowBlur)
  document.addEventListener("visibilitychange", handleVisibilityChange)
  document.documentElement.addEventListener("mouseleave", handleMouseLeave)
  document.documentElement.addEventListener("mouseenter", handleMouseEnter)
  return () => {
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
    // The column can go away mid-peek (a narrower window, no project).
    if (open) report(false)
  }
}
