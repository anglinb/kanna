// The message scroller primitive the transcript sits in: `@shadcn/react`'s
// message-scroller (src/client/components/ui/message-scroller.tsx vendors
// its React wrapper), as plain DOM code. What it owns: following the end
// while the reader is at the end, keeping the reader's place when rows land
// above, and the programmatic scrolls (to the end, to a message). React ran
// it from a provider's refs, its parts' layout effects and observers; here
// one object holds the same state against the live elements, and the
// viewport controller (viewport.ts) drives it.
//
// Ported from the shipped bundle (dist/message-scroller/index.js), with
// vite-plugin-message-scroller.ts's patch applied: the content height is one
// rect of the content box, not a sweep of every row. Only what the
// transcript reaches is here: no visibility store (the transcript measures
// its own visible rows) and no scroll button (it has its own).

/** The primitive's constants (`xe`, `Ve`, `_e`, `Z`, `Be`). */
const DEFAULT_SCROLL_EDGE_THRESHOLD = 8
const DEFAULT_PREVIOUS_ITEM_PEEK = 64
const DEFAULT_SCROLL_MARGIN = 0
const EPSILON = 0.5
const AUTOSCROLLING_MS = 180

/** Keys that scroll the viewport: the reader moving it themselves (`De`). */
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "])

type Mode = "following-bottom" | "free-scrolling" | "settling-jump" | "anchored-to-message"
export type ScrollAlign = "start" | "center" | "end" | "nearest"
export interface ScrollOptions {
  align?: ScrollAlign
  behavior?: ScrollBehavior
  scrollMargin?: number
}

interface Scrollable { start: boolean; end: boolean }

function parsePx(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function blockPadding(element: Element) {
  const style = window.getComputedStyle(element)
  return {
    end: parsePx(style.paddingBlockEnd || style.paddingBottom),
    start: parsePx(style.paddingBlockStart || style.paddingTop),
  }
}

/** Top of `element` in the viewport's scroll coordinates (`me`). */
function offsetInScroll(element: Element, viewport: HTMLElement) {
  return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
}

/** Top of `element` against the viewport's top edge (`ne`). */
function offsetInViewport(element: Element, viewport: HTMLElement) {
  return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
}

export interface ScrollerElements {
  root: HTMLElement
  viewport: HTMLElement
  content: HTMLElement
  spacer: HTMLElement
}

export interface ScrollerOptions {
  autoScroll?: boolean
  defaultScrollPosition?: "start" | "end" | "last-anchor"
  scrollEdgeThreshold?: number
  scrollPreviousItemPeek?: number
  scrollMargin?: number
  preserveScrollOnPrepend?: boolean
}

export class MessageScroller {
  private readonly root: HTMLElement
  private readonly viewport: HTMLElement
  private readonly content: HTMLElement
  private readonly spacer: HTMLElement

  private readonly autoScroll: boolean
  private readonly defaultScrollPosition: "start" | "end" | "last-anchor"
  private readonly scrollEdgeThreshold: number
  private readonly scrollPreviousItemPeek: number
  private readonly scrollMargin: number
  private readonly preserveScrollOnPrepend: boolean

  private streamingTurn: HTMLElement | null = null
  private autoscrolling = false
  private autoscrollingTimeout: number | null = null
  private defaultScrollPositionApplied = false
  private firstItem: HTMLElement | null = null
  private itemCount = 0
  private lastScrollTop = 0
  private mode: Mode
  private pendingScrollFrame: number | null = null
  private pendingScrollToMessage: { messageId: string; options: ScrollOptions | undefined } | null = null
  private prependRestore: { element: HTMLElement; viewportTop: number } | null = null
  private spacerGap = 0
  private spacerHeight = 0
  private stateFrame: number | null = null
  private snapshot: Scrollable = { start: false, end: false }
  private readonly handledScrollAnchors = new WeakSet<HTMLElement>()
  private readonly cleanups: Array<() => void> = []

  constructor(elements: ScrollerElements, options: ScrollerOptions = {}) {
    this.root = elements.root
    this.viewport = elements.viewport
    this.content = elements.content
    this.spacer = elements.spacer
    this.autoScroll = options.autoScroll ?? false
    this.defaultScrollPosition = options.defaultScrollPosition ?? "end"
    this.scrollEdgeThreshold = options.scrollEdgeThreshold ?? DEFAULT_SCROLL_EDGE_THRESHOLD
    this.scrollPreviousItemPeek = options.scrollPreviousItemPeek ?? DEFAULT_PREVIOUS_ITEM_PEEK
    this.scrollMargin = options.scrollMargin ?? DEFAULT_SCROLL_MARGIN
    this.preserveScrollOnPrepend = options.preserveScrollOnPrepend ?? true
    this.mode = this.autoScroll ? "following-bottom" : "free-scrolling"
    // setSpacerElement: the gap the content's flex layout puts before it.
    const parent = this.spacer.parentElement
    if (parent) {
      const style = window.getComputedStyle(parent)
      this.spacerGap = parsePx(style.rowGap === "normal" ? style.gap : style.rowGap)
    }
    this.applyScrollableAttributes(this.snapshot)
  }

  // ── Wiring (the parts' listeners and observers) ─────────────────────────

  /** The viewport's React handlers: scroll, wheel, touchmove, keydown. */
  attachViewportListeners() {
    const onScroll = () => this.syncAfterScroll()
    const onIntent = () => this.userScrollIntent()
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) this.userScrollIntent()
    }
    this.viewport.addEventListener("scroll", onScroll)
    this.viewport.addEventListener("wheel", onIntent, { passive: true })
    this.viewport.addEventListener("touchmove", onIntent, { passive: true })
    this.viewport.addEventListener("keydown", onKeyDown)
    this.cleanups.push(() => {
      this.viewport.removeEventListener("scroll", onScroll)
      this.viewport.removeEventListener("wheel", onIntent)
      this.viewport.removeEventListener("touchmove", onIntent)
      this.viewport.removeEventListener("keydown", onKeyDown)
    })
  }

  /** Content's ResizeObserver: a resize is handled on the next frame. */
  observeContentResize() {
    this.cleanups.push(this.frameResizeObserver(this.content))
  }

  /** Viewport's ResizeObserver, likewise. */
  observeViewportResize() {
    this.cleanups.push(this.frameResizeObserver(this.viewport))
  }

  private frameResizeObserver(target: HTMLElement) {
    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => this.handleResize())
    })
    observer.observe(target)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }

  /**
   * The provider's layout effects as it mounts: the default position, then
   * either following the end or committing the scroll state.
   */
  mountProvider() {
    this.applyDefaultScrollPosition()
    if (this.autoScroll && this.mode === "following-bottom" && this.itemCount > 0) {
      this.scrollToEnd({ behavior: "auto" })
      return
    }
    this.commitScrollState()
  }

  dispose() {
    if (this.stateFrame !== null) window.cancelAnimationFrame(this.stateFrame)
    if (this.autoscrollingTimeout !== null) window.clearTimeout(this.autoscrollingTimeout)
    if (this.pendingScrollFrame !== null) window.cancelAnimationFrame(this.pendingScrollFrame)
    this.stateFrame = null
    this.autoscrollingTimeout = null
    this.pendingScrollFrame = null
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  // ── Geometry ────────────────────────────────────────────────────────────

  /** The items: the content's children but the spacer (`re`). */
  private items(): HTMLElement[] {
    return Array.from(this.content.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== this.spacer)
  }

  private messageElement(messageId: string): HTMLElement | null {
    for (const item of this.items()) {
      if (item.dataset.messageId === messageId) return item
    }
    return null
  }

  /** The content's height in scroll coordinates (`pe`, as patched). */
  private contentHeight() {
    const padding = blockPadding(this.content)
    const viewportRect = this.viewport.getBoundingClientRect()
    const base = padding.start + padding.end
    const rect = this.content.getBoundingClientRect()
    return Math.max(base, rect.bottom - viewportRect.top + this.viewport.scrollTop)
  }

  private scrollable(): Scrollable {
    const height = this.contentHeight()
    return {
      start: this.viewport.scrollTop > this.scrollEdgeThreshold,
      end: height - this.viewport.scrollTop - this.viewport.clientHeight > this.scrollEdgeThreshold,
    }
  }

  private maxScrollTop() {
    return Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight)
  }

  /** The first item with any part on screen (`We`). */
  private firstVisibleItem(): HTMLElement | null {
    const viewportRect = this.viewport.getBoundingClientRect()
    for (const item of this.items()) {
      if (!item.dataset.messageId) continue
      const rect = item.getBoundingClientRect()
      if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) return item
    }
    return null
  }

  /** Where `align` puts `element` (`ze`). */
  private alignedScrollTop(element: HTMLElement, align: ScrollAlign, scrollMargin: number) {
    const top = offsetInScroll(element, this.viewport)
    const height = element.getBoundingClientRect().height
    const padding = this.spacer.parentElement ? blockPadding(this.spacer.parentElement) : { start: 0, end: 0 }
    if (align === "center") {
      const visible = Math.max(0, this.viewport.clientHeight - padding.start - padding.end)
      return top - padding.start - (visible - height) / 2 - scrollMargin
    }
    if (align === "end") return top - this.viewport.clientHeight + height + padding.end + scrollMargin
    if (align === "nearest") {
      const bottom = top + height
      const visibleTop = this.viewport.scrollTop + padding.start
      const visibleBottom = this.viewport.scrollTop + this.viewport.clientHeight - padding.end
      if (top >= visibleTop && bottom <= visibleBottom) return this.viewport.scrollTop
      return top < visibleTop ? top - padding.start - scrollMargin : bottom - this.viewport.clientHeight + padding.end + scrollMargin
    }
    return top - padding.start - scrollMargin
  }

  // ── State ───────────────────────────────────────────────────────────────

  private applyScrollableAttributes(state: Scrollable) {
    const value = [state.start && "start", state.end && "end"].filter(Boolean).join(" ")
    for (const element of [this.root, this.viewport]) {
      if (value) element.setAttribute("data-scrollable", value)
      else element.removeAttribute("data-scrollable")
      element.toggleAttribute("data-autoscrolling", this.autoscrolling)
    }
  }

  /** `ae`: the mode as the reader moves. */
  private updateMode(state: Scrollable) {
    const scrollTop = this.viewport.scrollTop
    const movedUp = scrollTop < this.lastScrollTop - EPSILON
    this.lastScrollTop = scrollTop
    if (this.autoScroll && !state.end && this.mode !== "settling-jump" && this.mode !== "anchored-to-message") {
      this.mode = "following-bottom"
    } else if (this.mode === "following-bottom" && state.end && movedUp && !this.autoscrolling) {
      this.mode = "free-scrolling"
    }
  }

  /** `F`: commitScrollState. */
  private commitScrollState() {
    const state = this.scrollable()
    this.updateMode(state)
    const shown = this.mode === "following-bottom" ? { ...state, end: false } : state
    this.applyScrollableAttributes(shown)
    this.snapshot = shown
  }

  /** `se`: scheduleStateCommit. */
  private scheduleStateCommit() {
    if (this.stateFrame !== null) return
    this.stateFrame = window.requestAnimationFrame(() => {
      this.stateFrame = null
      this.commitScrollState()
    })
  }

  /** `U`: the autoscrolling flag, which lapses on its own. */
  private setAutoscrolling(value: boolean) {
    if (this.autoscrollingTimeout !== null) {
      window.clearTimeout(this.autoscrollingTimeout)
      this.autoscrollingTimeout = null
    }
    if (this.autoscrolling !== value) {
      this.autoscrolling = value
      this.commitScrollState()
    }
    if (value) {
      this.autoscrollingTimeout = window.setTimeout(() => {
        this.autoscrollingTimeout = null
        this.autoscrolling = false
        this.commitScrollState()
      }, AUTOSCROLLING_MS)
    }
  }

  /** `v`: the trailing spacer's height (held hidden by its class). */
  private setSpacerHeight(height: number) {
    const next = Math.max(0, Math.ceil(height))
    if (this.spacerHeight === next) return
    this.spacerHeight = next
    this.spacer.hidden = next === 0
    this.spacer.style.height = `${next}px`
    this.spacer.style.marginTop = next > 0 ? `${-this.spacerGap}px` : ""
  }

  /** `H`: scroll to `top`. */
  private scrollTo(top: number, { behavior = "auto", autoscrolling = false }: { behavior?: ScrollBehavior; autoscrolling?: boolean } = {}) {
    const target = Math.max(0, top)
    if (Math.abs(this.viewport.scrollTop - target) <= EPSILON) {
      this.viewport.scrollTop = target
      this.commitScrollState()
      return
    }
    if (autoscrolling) this.setAutoscrolling(true)
    this.viewport.scrollTo({ top: target, behavior })
    this.scheduleStateCommit()
  }

  // ── Programmatic scrolls ────────────────────────────────────────────────

  scrollToStart({ behavior = "auto" }: { behavior?: ScrollBehavior } = {}) {
    this.setSpacerHeight(0)
    this.streamingTurn = null
    this.mode = "free-scrolling"
    this.scrollTo(0, { behavior })
    return true
  }

  scrollToEnd({ behavior = "auto" }: { behavior?: ScrollBehavior } = {}) {
    this.setSpacerHeight(0)
    this.streamingTurn = null
    this.mode = this.autoScroll ? "following-bottom" : "free-scrolling"
    this.scrollTo(this.maxScrollTop(), { autoscrolling: true, behavior })
    return true
  }

  /** `I`: scrollToElement. */
  private scrollToElement(element: HTMLElement, options: ScrollOptions = {}, { keepPreviousPeek = false } = {}) {
    if (!this.content.contains(element)) return false
    const align = options.align ?? "start"
    const margin = options.scrollMargin ?? this.scrollMargin
    const top = this.alignedScrollTop(element, align, keepPreviousPeek ? margin + this.scrollPreviousItemPeek : margin)
    const shortfall = top + this.viewport.clientHeight - this.contentHeight()
    this.setSpacerHeight(shortfall)
    this.prependRestore = { element, viewportTop: offsetInViewport(element, this.viewport) }
    this.mode = keepPreviousPeek ? "anchored-to-message" : "settling-jump"
    this.streamingTurn = keepPreviousPeek ? element : null
    this.scrollTo(top, { behavior: options.behavior ?? "auto" })
    return true
  }

  /** `B`: put the anchored message back where it was. */
  private reanchorToAnchoredMessage() {
    const element = this.streamingTurn
    if (!element || !element.isConnected || this.mode !== "anchored-to-message") return false
    return this.scrollToElement(element, { align: "start" }, { keepPreviousPeek: true })
  }

  /** `D`: scrollToMessage. False when there is no such message. */
  scrollToMessage(messageId: string, options?: ScrollOptions) {
    const element = this.messageElement(messageId)
    if (element) {
      this.defaultScrollPositionApplied = true
      if (this.scrollToElement(element, options)) this.pendingScrollToMessage = null
      else this.pendingScrollToMessage = { messageId, options }
      return true
    }
    if (this.itemCount === 0) {
      this.pendingScrollToMessage = { messageId, options }
      this.defaultScrollPositionApplied = true
      return true
    }
    return false
  }

  private flushPendingScrollToMessage() {
    const pending = this.pendingScrollToMessage
    if (!pending) return false
    const element = this.messageElement(pending.messageId)
    if (!element || !this.scrollToElement(element, pending.options)) return false
    this.pendingScrollToMessage = null
    this.defaultScrollPositionApplied = true
    return true
  }

  // ── Content changes ─────────────────────────────────────────────────────

  /** `Te`: rows landed above the one on screen; put it back where it was. */
  private restoreAfterPrepend() {
    const restore = this.prependRestore
    if (!restore || !restore.element.isConnected) return false
    const delta = offsetInViewport(restore.element, this.viewport) - restore.viewportTop
    if (Math.abs(delta) <= EPSILON) return false
    this.viewport.scrollTop += delta
    restore.viewportTop = offsetInViewport(restore.element, this.viewport)
    this.scheduleStateCommit()
    return true
  }

  /** `X`: remember the first row on screen and where it sits. */
  private capturePrependRestore() {
    const element = this.firstVisibleItem()
    this.prependRestore = element ? { element, viewportTop: offsetInViewport(element, this.viewport) } : null
  }

  /** `fe`: the position a list takes when it first has rows. */
  private applyDefaultScrollPosition() {
    if (!this.defaultScrollPosition || this.defaultScrollPositionApplied || this.itemCount === 0) return false
    let applied = false
    if (this.defaultScrollPosition === "last-anchor") {
      const anchors = this.items().filter((item) => item.dataset.scrollAnchor === "true")
      const last = anchors[anchors.length - 1]
      if (!last) applied = this.scrollToEnd({ behavior: "auto" })
      else {
        const top = offsetInScroll(last, this.viewport)
        applied = this.contentHeight() - top <= this.viewport.clientHeight
          ? this.scrollToEnd({ behavior: "auto" })
          : this.scrollToElement(last, { align: "start" }, { keepPreviousPeek: true })
      }
    } else {
      applied = this.defaultScrollPosition === "end" ? this.scrollToEnd({ behavior: "auto" }) : this.scrollToStart({ behavior: "auto" })
    }
    if (applied) this.defaultScrollPositionApplied = true
    return applied
  }

  /** `ve`: handleContentChange, from the content's mount and its MutationObserver. */
  handleContentChange() {
    const items = this.items()
    const previousCount = this.itemCount
    const previousFirst = this.firstItem
    this.itemCount = items.length
    this.firstItem = items[0] ?? null
    this.contentChangeStep(items, previousCount, previousFirst)
    this.capturePrependRestore()
  }

  private contentChangeStep(items: HTMLElement[], previousCount: number, previousFirst: HTMLElement | null) {
    if (this.flushPendingScrollToMessage()) return
    if (previousCount === 0) {
      if (this.applyDefaultScrollPosition() || (items.length > 0 && this.autoScroll && this.scrollToEnd({ behavior: "auto" }))) return
      this.commitScrollState()
      return
    }
    const previousFirstIndex = previousFirst ? items.indexOf(previousFirst) : -1
    if (this.preserveScrollOnPrepend && previousFirstIndex > 0) {
      this.restoreAfterPrepend()
      return
    }
    if (items.length > previousCount) {
      const anchor = items.slice(previousCount).find((item) => item.dataset.scrollAnchor === "true") ?? null
      if (anchor) {
        if (this.autoScroll && this.mode === "following-bottom" && moreThanOneAnchorFrom(items, previousCount)) {
          this.scrollToEnd({ behavior: "auto" })
          return
        }
        this.scrollToElement(anchor, { align: "start" }, { keepPreviousPeek: true })
        this.handledScrollAnchors.add(anchor)
        return
      }
    }
    if (items.length === previousCount) {
      const anchor = items.find((item) => item.dataset.scrollAnchor === "true" && !this.handledScrollAnchors.has(item)) ?? null
      if (anchor) {
        this.scrollToElement(anchor, { align: "start" }, { keepPreviousPeek: true })
        this.handledScrollAnchors.add(anchor)
        return
      }
    }
    if (this.mode === "following-bottom" && this.autoScroll) this.scrollToEnd({ behavior: "auto" })
    else this.commitScrollState()
  }

  /** `he`: handleResize, a frame after the content or the viewport resized. */
  handleResize() {
    if (this.mode === "following-bottom" && this.autoScroll) {
      this.scrollToEnd({ behavior: "auto" })
      return
    }
    const spacerBefore = this.spacerHeight
    if (this.reanchorToAnchoredMessage()) {
      if (this.autoScroll && spacerBefore > 0 && this.spacerHeight === 0) this.scrollToEnd({ behavior: "auto" })
      return
    }
    this.scheduleStateCommit()
  }

  /** `ye`: the reader took over (wheel, touch, a scrolling key). */
  userScrollIntent() {
    if (this.mode === "following-bottom" || this.mode === "anchored-to-message" || this.mode === "settling-jump") {
      this.streamingTurn = null
      this.mode = "free-scrolling"
    }
  }

  /** `Ie`: syncAfterScroll, on every scroll event. */
  syncAfterScroll() {
    this.commitScrollState()
    this.capturePrependRestore()
  }
}

/** `Ge`: more than one scroll anchor at or after `from`. */
function moreThanOneAnchorFrom(items: HTMLElement[], from: number) {
  let count = 0
  for (let index = from; index < items.length; index++) {
    if (items[index]?.dataset.scrollAnchor === "true") {
      count += 1
      if (count > 1) return true
    }
  }
  return false
}
