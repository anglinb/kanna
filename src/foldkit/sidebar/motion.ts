import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { PANE_EASING, prefersReducedMotion } from "../../client/app/paneAnimation"
import { AppAction } from "../app/action"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"

// Focus mode as a page pushed onto the sidebar (KannaSidebar's
// useFocusMotion): the whole page, bar and list, slides in from the right,
// opaque, over the page that was there, which drifts a third of the way left
// and fades beneath it. Leaving pops: the page slides back off to the right
// and the one before it drifts back in from the left.
//
// Foldkit, like React, turns one page into the other in a single patch, so
// there is no outgoing page left to animate. A copy is taken the moment
// before the change (`CaptureOutgoingPage`, ahead of the action that makes
// it) and stands in for it: inert, laid over the frame the page sits in,
// scrolled to where the original was, and removed when the motion ends.
//
// Not for the toggle shortcut, which is pressed to get somewhere, over and
// over: it takes no copy, so nothing moves. React also copied on a change
// from anywhere else (the palette's toggle); here only the sidebar's own
// controls take one.

/** iOS's push runs a little longer than a pane opening: a whole page travels its own width. */
const FOCUS_PUSH_MS = 350
/** How far the page underneath drifts while the one on top crosses it, as a share of its width. */
const FOCUS_PARALLAX = "-30%"
/** The sidebar card's own background, for the page on top, so it covers the one under it. */
const FOCUS_PAGE_SURFACE = ["bg-background", "dark:bg-card"]
const SIDEBAR_SCROLLER_SELECTOR = "[data-sidebar-scroller]"
/** On the page element: "focused" or "all". */
export const SIDEBAR_PAGE_ATTRIBUTE = "data-sidebar-page"

function findSidebarScroller(element: HTMLElement) {
  return element.matches(SIDEBAR_SCROLLER_SELECTOR) ? element : element.querySelector<HTMLElement>(SIDEBAR_SCROLLER_SELECTOR)
}

/**
 * What travels: the bar and the list under it, except in the Mac app's
 * desktop layout, where the bar holds nothing that differs between the two
 * pages and only the list under it moves.
 */
function getMovingPage(page: HTMLElement | null) {
  if (!page) return null
  const isMacApp = Boolean((window as { webkit?: { messageHandlers?: { kanna?: unknown } } }).webkit?.messageHandlers?.kanna)
  const barIsShared = isMacApp && window.matchMedia("(min-width: 768px)").matches
  return barIsShared ? findSidebarScroller(page) : page
}

let outgoingPage: { page: HTMLElement; scrollTop: number } | null = null
let finishMotion: (() => void) | null = null

export function captureOutgoingPage() {
  const page = getMovingPage(document.querySelector<HTMLElement>(`[${SIDEBAR_PAGE_ATTRIBUTE}]`))
  if (!page) return
  // A motion still running ends here, so its copy is not copied in turn.
  finishMotion?.()
  const copy = { page: page.cloneNode(true) as HTMLElement, scrollTop: findSidebarScroller(page)?.scrollTop ?? 0 }
  outgoingPage = copy
  // Dropped if the change moved nothing on screen (no current project).
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (outgoingPage === copy) outgoingPage = null
  }))
}

/** Takes the outgoing copy, then carries on with what the control asked for. */
export const CaptureOutgoingPage = Command.define("SidebarCaptureOutgoingPage", {
  args: { then: Schema.Array(AppAction) },
  messages: [Message.ContinuedActions],
  execute: ({ then }) => Effect.sync(() => {
    captureOutgoingPage()
    return Message.ContinuedActions({ actions: then })
  }),
})

function animate(root: HTMLElement, focused: boolean) {
  const outgoing = outgoingPage
  outgoingPage = null
  const page = getMovingPage(root)
  const frame = page?.parentElement
  if (!outgoing || !page || !frame) return

  // Over exactly where the page is: the whole frame, or under the bar.
  const copy = outgoing.page
  copy.inert = true
  copy.setAttribute("aria-hidden", "true")
  copy.removeAttribute(SIDEBAR_PAGE_ATTRIBUTE)
  Object.assign(copy.style, {
    position: "absolute",
    top: `${page.offsetTop}px`,
    left: `${page.offsetLeft}px`,
    width: `${page.offsetWidth}px`,
    height: `${page.offsetHeight}px`,
    pointerEvents: "none",
  })
  frame.append(copy)
  const copyScroller = findSidebarScroller(copy)
  if (copyScroller) copyScroller.scrollTop = outgoing.scrollTop

  // Pushing, the new page is the one on top; popping, the copy is.
  const top = focused ? page : copy
  const under = focused ? copy : page
  top.classList.add(...FOCUS_PAGE_SURFACE)
  top.style.zIndex = "2"
  under.style.zIndex = "1"
  const previousPosition = page.style.position
  page.style.position = "relative"

  const reduced = prefersReducedMotion()
  const timing = reduced ? { duration: 150, easing: "ease" } : { duration: FOCUS_PUSH_MS, easing: PANE_EASING }
  const offRight = reduced ? { opacity: 0 } : { transform: "translateX(100%)" }
  const underneath = reduced ? { opacity: 0 } : { transform: `translateX(${FOCUS_PARALLAX})`, opacity: 0 }
  const atRest = { transform: "none", opacity: 1 }
  const animations = focused
    ? [page.animate([offRight, atRest], timing), copy.animate([atRest, underneath], { ...timing, fill: "forwards" })]
    : [copy.animate([atRest, offRight], { ...timing, fill: "forwards" }), page.animate([underneath, atRest], timing)]

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (finishMotion === finish) finishMotion = null
    for (const animation of animations) animation.cancel()
    copy.remove()
    page.classList.remove(...FOCUS_PAGE_SURFACE)
    page.style.zIndex = ""
    page.style.position = previousPosition
  }
  finishMotion = finish
  animations[0]!.onfinish = finish
}

/** On the sidebar's page: plays the push or pop when its focus flips with a copy taken. */
export const FocusMotion = Mount.defineStream("SidebarFocusMotion", {
  messages: [Message.CompletedSideEffect],
  execute: ({ element }) =>
    domStream<typeof Message.CompletedSideEffect.Type>(() => {
      const root = element as HTMLElement
      let wasFocused = root.getAttribute(SIDEBAR_PAGE_ATTRIBUTE) === "focused"
      const observer = new MutationObserver(() => {
        const focused = root.getAttribute(SIDEBAR_PAGE_ATTRIBUTE) === "focused"
        if (focused === wasFocused) return
        wasFocused = focused
        animate(root, focused)
      })
      observer.observe(root, { attributes: true, attributeFilter: [SIDEBAR_PAGE_ATTRIBUTE] })
      return () => {
        observer.disconnect()
        finishMotion?.()
      }
    }),
})
