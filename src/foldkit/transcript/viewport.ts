import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { isOptimisticMessageId, shouldPinForNewPrompt, type LatestUserPrompt, type TranscriptScrollTarget } from "../../client/app/ChatPage/transcriptScrollAnchors"
import type { ChatJumpTarget } from "../../client/lib/chat-navigation"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"
import { MessageScroller } from "./scroller"

// ChatTranscriptViewport's scrolling (TranscriptScrollerBody's refs, layout
// effects, effects and listeners), against the live elements. One controller
// per viewport, made by `ControlViewport` as the scroller mounts: the
// viewport is keyed by chat, as React's was, so a chat switch starts afresh.
//
// What it decides from the transcript's data (which row is the latest
// prompt, where the stored anchor is, what a jump names) is worked out in
// the view and handed over as one JSON attribute on the viewport (`Feed`),
// so the controller can act in the same frame the rows are patched in:
// a MutationObserver on that attribute and on the content's children runs
// what React's layout effects and effects ran on those deps, before paint.
// What the slice must know comes back as Messages; what the slice asks of it
// outside a render (the scroll-to-bottom button, a minimap jump, Load More)
// goes through `controllerFor` from a Command.

/**
 * How close to the bottom counts as "at the end", in pixels. One number shared
 * by the scroller (whether to keep following) and the viewport (whether the
 * reader is following), so the two never disagree.
 */
export const AT_END_THRESHOLD_PX = 48

/** How long a pin keeps correcting itself as the transcript settles. */
const PIN_SETTLE_MS = 2000

/** Close enough to the intended offset to stop correcting. */
const PIN_TOLERANCE_PX = 2

/**
 * How far down the visible transcript a jumped-to message lands, as a fraction
 * of the height between the navbar and the composer: a fifth of a screen of
 * lead-in places it without spending the screen you came to read.
 */
const JUMP_LEAD_IN_RATIO = 0.2

/** Slack before the transcript counts as scrollable. */
const OVERFLOW_EPSILON_PX = 8

/** A restore candidate: React's `resolveRestoreTarget` but for the width test, which needs the column. */
export type RestoreCandidate =
  | { kind: "end" }
  | { kind: "pin"; rowId: string; offsetFromMessage?: number; transcriptWidth?: number }

/** What the viewport's effects read off the transcript, worked out in the view. */
export interface Feed {
  chatId: string | null
  /** headerOffsetPx */
  header: number
  /** The composer's overlay over the transcript's foot (the insets' bottom). */
  insetBottom: number
  readAnchor: { resolved: boolean; confirmed: boolean }
  restore: RestoreCandidate
  /** The latest user prompt (`getLatestUserPrompt`), its signature hashed. */
  prompt: { messageId: string; signature: string; rowIndex: number; rowId: string } | null
  /** The row of the latest assistant text, for a jump to the reply. */
  reply: string | null
  /** The row of the tool call a jump names, when one does. */
  tool: { toolId: string; rowId: string | null } | null
  /** The jump waiting for this chat. */
  jump: { requestId: number; target: ChatJumpTarget } | null
  hasOlder: boolean
  loadingOlder: boolean
  /** A minimap jump to a turn before the window, and its row once loaded. */
  unloadedJump: { seq: number; rowId: string | null } | null
  /** The page's `isAtEndRef`. */
  atEnd: boolean
  /** The minimap is drawn: the visible rows are tracked. */
  minimap: boolean
  /** Read positions are reported (a chat page; not the export viewer). */
  reports: boolean
}

export const FEED_ATTRIBUTE = "data-transcript-feed"
export const VIEWPORT_KEY_ATTRIBUTE = "data-transcript-viewport"

/** What the controller reports (ControlViewport's messages). */
type Reported = Extract<Message, { _tag: "MountedViewport" | "ChangedAtEnd" | "ChangedOverflow" | "ResizedViewport" | "ChangedVisibleRange" | "ReportedReadAnchor" | "RequestedLoadOlder" | "SpentJump" | "JumpedToRow" | "AppliedUnloadedJump" }>
type Emit = (message: Reported) => void

const controllers = new WeakMap<Element, ViewportController>()

/**
 * Where the last right click in a transcript was: the markdown's link
 * handler hears the contextmenu but not its position, and the local-link
 * menu opens there, as React's did from the event's clientX/clientY.
 */
let lastContextMenuPoint: { x: number; y: number } | null = null

/** The local-link menu's point: the right click that asked for it. */
export const LocateLinkMenu = Command.define("LocateTranscriptLinkMenu", {
  messages: [Message.LocatedLinkMenu],
  execute: Effect.sync(() => Message.LocatedLinkMenu({ x: lastContextMenuPoint?.x ?? 0, y: lastContextMenuPoint?.y ?? 0 })),
})

/** The controller of the viewport keyed `key`, if it is on the page. */
export function controllerFor(key: string): ViewportController | null {
  const viewport = document.querySelector(`[${VIEWPORT_KEY_ATTRIBUTE}="${CSS.escape(key)}"]`)
  return viewport ? controllers.get(viewport) ?? null : null
}

function readFeed(viewport: HTMLElement): Feed | null {
  const raw = viewport.getAttribute(FEED_ATTRIBUTE)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Feed
  } catch {
    return null
  }
}

function rowElement(viewport: HTMLElement, rowId: string) {
  return viewport.querySelector(`[data-message-id="${CSS.escape(rowId)}"]`)
}

/** The rendered width of the transcript column, which is what wraps text. */
function measureTranscriptColumnWidth(viewport: HTMLElement): number | undefined {
  const column = viewport.querySelector("[data-transcript-row-id]")
  return column ? Math.round(column.getBoundingClientRect().width) : undefined
}

/**
 * Where the reader sits within the top row, plus the column width that makes
 * that meaningful: a distance into the row does not move when the content
 * above it re-measures.
 */
function measureReadAnchorLayout(viewport: HTMLElement, rowId: string, headerOffsetPx: number) {
  const row = rowElement(viewport, rowId)
  const column = row?.querySelector("[data-transcript-row-id]")
  if (!row || !column) return null
  const offsetFromMessage = viewport.getBoundingClientRect().top + headerOffsetPx - row.getBoundingClientRect().top
  return {
    // The column, not the viewport: a wider window past the column's max width rewraps nothing.
    transcriptWidth: Math.round(column.getBoundingClientRect().width),
    offsetFromMessage: Math.round(offsetFromMessage),
  }
}

/** The viewport's rows (MessageScrollerItem), in order. */
function rowItems(content: HTMLElement) {
  return content.querySelectorAll<HTMLElement>(':scope > [data-slot="message-scroller-item"]')
}

export class ViewportController {
  readonly scroller: MessageScroller
  private feed: Feed

  /** Chat we have already positioned, so restore runs exactly once per open. */
  private restoredChatId: string | null = null
  /** Latest user prompt as of the last observation, for the pin-on-send rule. */
  private latestPrompt: LatestUserPrompt | null = null
  /**
   * Whether the user has actually scrolled this chat themselves. Only their
   * own scrolling may move the stored read position; restores, pins and
   * auto-follow scroll programmatically and settle over several frames.
   */
  private hasUserScrolled = false
  private pendingPin: { rowId: string; offsetFromMessage: number; until: number } | null = null
  /** Until when a landing at the end is held there, as a pin is held on its row. */
  private pendingEndUntil: number | null = null
  private restoredFrom: { target: TranscriptScrollTarget; jump: { requestId: number; target: ChatJumpTarget } | null; confirmed: boolean } | null = null
  /** Jump requests already spent, so each one lands exactly once. */
  private handledJumpRequestId: number | null = null
  private appliedUnloadedJumpSeq: number | null = null
  /** The first loaded row and where it sat when older rows were asked for. */
  private prependAnchor: { rowId: string; top: number } | null = null
  /** The first row when the last automatic load was asked for. */
  private autoLoadFirstRowId: string | null = null
  /**
   * A load was asked for here and the feed does not say so yet. React set
   * its loading flag in the render that followed the press, before the next
   * scroll event; the feed is a frame later, and a scroll event in between
   * (a press scrolling its button into view) would ask for the page again.
   */
  private loadPending: { firstRowId: string | null } | null = null

  /** The page's `isAtEndRef`, as last told or as last reported. */
  private pageAtEnd: boolean
  private overflows: boolean | null = null
  private width: number | null = null
  private lastReport: string | null = null

  // useVisibleRowRange's state
  private tops: number[] = []
  private rangeFrame: number | null = null
  private range: { start: number; end: number } | null = null
  private rowCount = -1

  private readonly cleanups: Array<() => void> = []

  constructor(
    private readonly root: HTMLElement,
    private readonly viewport: HTMLElement,
    private readonly content: HTMLElement,
    spacer: HTMLElement,
    private readonly emit: Emit,
  ) {
    this.feed = readFeed(viewport) ?? emptyFeed()
    this.pageAtEnd = this.feed.atEnd
    this.scroller = new MessageScroller({ root, viewport, content, spacer }, { autoScroll: true, scrollEdgeThreshold: AT_END_THRESHOLD_PX })
    controllers.set(viewport, this)
  }

  /**
   * React's mount, in its order: the content's layout effect (the scroller
   * sees its first rows), the body's layout effects (restore; the pin's
   * settle observer), the provider's, then the effects and their observers.
   */
  start() {
    const { scroller, viewport, content } = this
    scroller.attachViewportListeners()
    scroller.handleContentChange()
    this.layoutEffects()
    // Keeps a pin on its row while the content settles under it.
    const pinObserver = new ResizeObserver(() => this.correctPendingPin())
    pinObserver.observe(content)
    this.cleanups.push(() => pinObserver.disconnect())
    scroller.mountProvider()

    // The scroller's own observers (its parts' passive effects).
    scroller.observeContentResize()
    scroller.observeViewportResize()

    // The minimap's visible rows (a child of the body, so before the body's).
    const rangeObserver = new ResizeObserver(() => this.remeasureRows())
    rangeObserver.observe(content)
    rangeObserver.observe(viewport)
    const scheduleRange = () => this.scheduleRange()
    viewport.addEventListener("scroll", scheduleRange, { passive: true })
    this.cleanups.push(() => {
      rangeObserver.disconnect()
      viewport.removeEventListener("scroll", scheduleRange)
      if (this.rangeFrame !== null) window.cancelAnimationFrame(this.rangeFrame)
    })
    this.rowCount = rowItems(content).length
    this.remeasureRows()

    // useScrollbarGutterVar: the chat card's overlays stop at the gutter.
    this.cleanups.push(this.publishGutter())

    this.passiveEffects()

    // The body's scroll listener effect.
    const markUserScrolled = () => {
      this.hasUserScrolled = true
    }
    const userIntentEvents = ["wheel", "touchmove", "pointerdown", "keydown"] as const
    const syncSize = () => {
      const nextWidth = viewport.clientWidth
      if (this.width === null || Math.abs(this.width - nextWidth) >= 1) {
        this.width = nextWidth
        this.emit(Message.ResizedViewport({ width: nextWidth }))
      }
      this.handleScroll()
    }
    const sizeObserver = new ResizeObserver(syncSize)
    sizeObserver.observe(viewport)
    syncSize()
    const contentObserver = new ResizeObserver(() => this.handleScroll())
    contentObserver.observe(content)
    const onScroll = () => this.handleScroll()
    viewport.addEventListener("scroll", onScroll, { passive: true })
    for (const name of userIntentEvents) viewport.addEventListener(name, markUserScrolled, { passive: true })
    const recordContextMenu = (event: MouseEvent) => {
      lastContextMenuPoint = { x: event.clientX, y: event.clientY }
    }
    viewport.addEventListener("contextmenu", recordContextMenu, { capture: true })
    this.cleanups.push(() => viewport.removeEventListener("contextmenu", recordContextMenu, { capture: true }))
    this.cleanups.push(() => {
      sizeObserver.disconnect()
      contentObserver.disconnect()
      viewport.removeEventListener("scroll", onScroll)
      for (const name of userIntentEvents) viewport.removeEventListener(name, markUserScrolled)
    })

    // What the view patches in: the feed, and the rows.
    const mutations = new MutationObserver((records) => {
      const rowsChanged = records.some((record) => record.type === "childList")
      const previous = this.feed
      this.feed = readFeed(viewport) ?? this.feed
      // The page moved its own isAtEnd (the scroll-to-bottom button): take it.
      // Otherwise the last one reported here stands, the feed being a render behind.
      if (this.feed.atEnd !== previous.atEnd) this.pageAtEnd = this.feed.atEnd
      // A load asked for here is the feed's to report from now on.
      if (this.loadPending && this.feed.loadingOlder) this.loadPending = null
      this.layoutEffects()
      if (rowsChanged) scroller.handleContentChange()
      // Or it landed before the feed ever said so: the rows start elsewhere.
      if (this.loadPending && this.firstRowId() !== this.loadPending.firstRowId) this.loadPending = null
      const count = rowItems(content).length
      if (count !== this.rowCount || this.feed.minimap !== previous.minimap) {
        this.rowCount = count
        this.remeasureRows()
      }
      this.passiveEffects()
    })
    mutations.observe(content, { childList: true })
    mutations.observe(viewport, { attributes: true, attributeFilter: [FEED_ATTRIBUTE] })
    this.cleanups.push(() => mutations.disconnect())
  }

  dispose() {
    controllers.delete(this.viewport)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.scroller.dispose()
  }

  // ── From the slice (Commands) ───────────────────────────────────────────

  /** The scroll-to-bottom button: an explicit read-position choice. */
  scrollToBottom() {
    this.hasUserScrolled = true
    this.pageAtEnd = true
    this.scroller.scrollToEnd()
  }

  /** A minimap tick or card on a loaded turn. */
  jumpToRow(rowId: string) {
    this.hasUserScrolled = true
    this.applyScrollTarget(this.prepareJumpToRow(rowId))
  }

  /** A minimap jump to a turn still to load: the reader chose a position, and a load is out. */
  jumpToUnloaded() {
    this.hasUserScrolled = true
    this.loadPending = { firstRowId: this.firstRowId() }
  }

  /** Load More: where the first row sits is kept for when older rows land, and a load is out. */
  loadMore() {
    this.captureFirstRow()
    this.loadPending = { firstRowId: this.firstRowId() }
  }

  /** Remember where the first row sits, to keep it there once older rows land. */
  private captureFirstRow() {
    const first = rowItems(this.content)[0]
    const rowId = first?.dataset.messageId
    if (!first || !rowId) return
    this.prependAnchor = { rowId, top: first.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top }
  }

  // ── Effects ─────────────────────────────────────────────────────────────

  private rowCountNow() {
    return rowItems(this.content).length
  }

  private firstRowId() {
    return rowItems(this.content)[0]?.dataset.messageId ?? null
  }

  private layoutEffects() {
    this.restoreEffect()
    this.prependAnchorEffect()
  }

  private passiveEffects() {
    this.jumpEffect()
    this.newPromptEffect()
    this.unloadedJumpEffect()
  }

  private onIsAtEndChange(isAtEnd: boolean) {
    if (this.pageAtEnd === isAtEnd) return
    this.pageAtEnd = isAtEnd
    this.emit(Message.ChangedAtEnd({ isAtEnd }))
  }

  /**
   * Put a row at the top of the viewport, re-issuing until it stays there (see
   * `correctPendingPin`).
   */
  private pinRowToTop(rowId: string, offsetFromMessage = 0) {
    if (!this.scroller.scrollToMessage(rowId, { align: "start", scrollMargin: this.feed.header - offsetFromMessage })) {
      this.scroller.scrollToEnd()
      return
    }
    this.pendingPin = { rowId, offsetFromMessage, until: Date.now() + PIN_SETTLE_MS }
  }

  /**
   * Nudge an in-flight pin back onto its row after the layout moves under it,
   * or a landing at the end back to the end. Gives up on a deadline, once the
   * row is where it should be, or the moment the reader scrolls.
   */
  private correctPendingPin() {
    const endUntil = this.pendingEndUntil
    const viewport = this.viewport
    if (endUntil !== null) {
      if (this.hasUserScrolled || Date.now() > endUntil) this.pendingEndUntil = null
      else if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > PIN_TOLERANCE_PX) this.scroller.scrollToEnd()
      return
    }
    const pending = this.pendingPin
    if (!pending) return
    if (this.hasUserScrolled || Date.now() > pending.until) {
      this.pendingPin = null
      return
    }
    const row = rowElement(viewport, pending.rowId)
    if (!row) return
    const intended = this.feed.header - pending.offsetFromMessage
    const offset = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - intended
    if (Math.abs(offset) <= PIN_TOLERANCE_PX) return
    // Landed as close as the content allows: a row near either end cannot
    // reach the intended offset, and chasing it would never converge.
    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight
    const atLimit = offset > 0 ? viewport.scrollTop >= maxScrollTop - PIN_TOLERANCE_PX : viewport.scrollTop <= PIN_TOLERANCE_PX
    if (atLimit) {
      this.pendingPin = null
      return
    }
    this.scroller.scrollToMessage(pending.rowId, { align: "start", scrollMargin: intended })
  }

  private applyScrollTarget(target: TranscriptScrollTarget) {
    if (target.kind === "end") {
      // A pin still settling would pull the reader back to its row.
      this.pendingPin = null
      this.pendingEndUntil = Date.now() + PIN_SETTLE_MS
      this.onIsAtEndChange(true)
      this.scroller.scrollToEnd()
      return
    }
    this.pendingEndUntil = null
    this.onIsAtEndChange(false)
    this.pinRowToTop(target.rowId, target.offsetFromMessage)
  }

  /** That fraction in pixels, measured off the live viewport: the composer grows with its draft. */
  private measureJumpLeadIn() {
    const visible = this.viewport.clientHeight - this.feed.header - this.feed.insetBottom
    return visible <= 0 ? 0 : Math.round(visible * JUMP_LEAD_IN_RATIO)
  }

  /** Everything a jump does to a row: where it lands, and lighting it up. */
  private prepareJumpToRow(rowId: string): TranscriptScrollTarget {
    this.emit(Message.JumpedToRow({ rowId }))
    // Negative: `offsetFromMessage` measures how far into the message the
    // landing point is; a jump wants breathing room above it.
    return { kind: "pin", rowId, offsetFromMessage: -this.measureJumpLeadIn() }
  }

  private resolveJump(target: ChatJumpTarget): TranscriptScrollTarget | null {
    const rowId = typeof target !== "string"
      ? (this.feed.tool?.toolId === target.toolId ? this.feed.tool.rowId : null)
      : target === "prompt" ? this.feed.prompt?.rowId ?? null : this.feed.reply
    return rowId ? { kind: "pin", rowId } : null
  }

  /**
   * Take the pending jump, if there is one. Marks it spent either way: a
   * message that isn't in the transcript won't appear by retrying.
   */
  private consumeJumpTarget(): TranscriptScrollTarget | null {
    const jump = this.feed.jump
    if (!jump || this.handledJumpRequestId === jump.requestId) return null
    this.handledJumpRequestId = jump.requestId
    this.emit(Message.SpentJump({ requestId: jump.requestId, target: jump.target }))
    const target = this.resolveJump(jump.target)
    return target?.kind === "pin" ? this.prepareJumpToRow(target.rowId) : target
  }

  private restoreTarget(): TranscriptScrollTarget {
    const candidate = this.feed.restore
    if (candidate.kind === "end") return candidate
    // The offset holds only if the message wraps the same way it did then.
    const width = measureTranscriptColumnWidth(this.viewport)
    const sameWidth = candidate.transcriptWidth !== undefined && width !== undefined && Math.abs(candidate.transcriptWidth - width) < 1
    return sameWidth && candidate.offsetFromMessage !== undefined
      ? { kind: "pin", rowId: candidate.rowId, offsetFromMessage: candidate.offsetFromMessage }
      : { kind: "pin", rowId: candidate.rowId }
  }

  /**
   * Restore once per chat open: wait until rows exist and the stored anchor
   * has resolved, otherwise we'd land on the fallback and jump when the
   * anchor arrives.
   */
  private restoreEffect() {
    const { chatId, readAnchor } = this.feed
    if (!chatId) {
      // Leaving the chat surface arms the next open to restore again.
      this.restoredChatId = null
      this.pendingPin = null
      this.pendingEndUntil = null
      this.onIsAtEndChange(true)
      return
    }
    if (this.rowCountNow() === 0 || !readAnchor.resolved) {
      // Nothing to scroll yet; this clears the button the last chat left.
      if (this.restoredChatId !== chatId) this.onIsAtEndChange(true)
      return
    }

    if (this.restoredChatId === chatId) {
      // The chat opened from what this browser had; the server has now
      // answered. Land again if it disagrees, unless the reader has scrolled.
      const restoredFrom = this.restoredFrom
      if (!restoredFrom || restoredFrom.confirmed || !readAnchor.confirmed) return
      restoredFrom.confirmed = true
      // Prompts the server's answer brought were sent before this open.
      this.latestPrompt = this.feed.prompt
      if (this.hasUserScrolled) return
      if (restoredFrom.jump) {
        const next = this.resolveJump(restoredFrom.jump.target)
        const landedRowId = restoredFrom.target.kind === "pin" ? restoredFrom.target.rowId : null
        if (next?.kind !== "pin" || next.rowId === landedRowId) return
        this.applyScrollTarget(this.prepareJumpToRow(next.rowId))
        return
      }
      const next = this.restoreTarget()
      if (!sameScrollTarget(next, restoredFrom.target)) this.applyScrollTarget(next)
      return
    }

    this.restoredChatId = chatId
    this.hasUserScrolled = false
    this.pendingPin = null
    this.pendingEndUntil = null
    this.latestPrompt = this.feed.prompt
    // A jump outranks the stored position; resolved here so the open scrolls once.
    const jump = this.feed.jump
    const jumpTarget = this.consumeJumpTarget()
    const target = jumpTarget ?? this.restoreTarget()
    this.restoredFrom = { target, jump: jumpTarget ? jump : null, confirmed: readAnchor.confirmed }
    this.applyScrollTarget(target)
  }

  /** A jump into the chat that is already open: as deliberate as clicking a minimap tick. */
  private jumpEffect() {
    const { chatId } = this.feed
    if (!chatId || this.restoredChatId !== chatId) return
    if (this.rowCountNow() === 0) return
    const target = this.consumeJumpTarget()
    if (!target) return
    this.hasUserScrolled = true
    this.applyScrollTarget(target)
  }

  /** Sending jumps to the bottom, where the new prompt and its reply are. */
  private newPromptEffect() {
    const { chatId } = this.feed
    if (!chatId || this.restoredChatId !== chatId) return
    const next = this.feed.prompt
    const previous = this.latestPrompt
    this.latestPrompt = next
    if (!shouldPinForNewPrompt(previous, next) || next === null) return
    this.applyScrollTarget({ kind: "end" })
  }

  /** A minimap jump to an unloaded turn lands once its row is in. */
  private unloadedJumpEffect() {
    const pending = this.feed.unloadedJump
    if (!pending || pending.rowId === null || this.appliedUnloadedJumpSeq === pending.seq) return
    this.appliedUnloadedJumpSeq = pending.seq
    this.emit(Message.AppliedUnloadedJump({ seq: pending.seq }))
    this.applyScrollTarget(this.prepareJumpToRow(pending.rowId))
  }

  /** Once older rows land, the row that was first goes back to the offset it had. */
  private prependAnchorEffect() {
    const anchor = this.prependAnchor
    if (!anchor) return
    const row = rowElement(this.viewport, anchor.rowId)
    if (!row) return
    // Still the first row: nothing landed above it yet.
    if (this.firstRowId() === anchor.rowId) return
    this.prependAnchor = null
    const top = row.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top
    this.viewport.scrollTop += top - anchor.top
  }

  // ── Scroll ──────────────────────────────────────────────────────────────

  private handleScroll() {
    const viewport = this.viewport
    const distanceFromEnd = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
    const isAtEnd = distanceFromEnd <= AT_END_THRESHOLD_PX
    this.onIsAtEndChange(isAtEnd)
    this.reportTopVisibleMessage(isAtEnd)
    const overflows = viewport.scrollHeight - viewport.clientHeight > OVERFLOW_EPSILON_PX
    if (overflows !== this.overflows) {
      this.overflows = overflows
      this.emit(Message.ChangedOverflow({ overflows }))
    }
    this.maybeLoadOlderOnScroll()
  }

  /** Remember which message the reader is looking at: the topmost row on screen. */
  private reportTopVisibleMessage(isAtEnd: boolean) {
    if (!this.feed.reports) return
    // Never let a programmatic scroll move the stored position.
    if (!this.hasUserScrolled) return
    const range = this.range
    const row = range === null ? undefined : rowItems(this.content)[range.start]
    const messageId = row?.dataset.messageId
    // Optimistic ids are client-local and will not resolve on another device.
    if (!messageId || isOptimisticMessageId(messageId)) return
    const layout = measureReadAnchorLayout(this.viewport, messageId, this.feed.header)
    const key = JSON.stringify([messageId, isAtEnd, layout])
    if (key === this.lastReport) return
    this.lastReport = key
    this.emit(Message.ReportedReadAnchor({ messageId, atEnd: isAtEnd, layout, at: Date.now() }))
  }

  /**
   * Load the page before the window once the reader nears the top, half a
   * screen early. Only the reader's own scrolling triggers it.
   */
  private maybeLoadOlderOnScroll() {
    if (!this.hasUserScrolled) return
    if (!this.feed.hasOlder || this.feed.loadingOlder || this.loadPending !== null) return
    if (this.viewport.scrollTop > this.viewport.clientHeight / 2) return
    const firstRowId = this.firstRowId()
    if (!firstRowId || this.autoLoadFirstRowId === firstRowId) return
    this.autoLoadFirstRowId = firstRowId
    this.captureFirstRow()
    this.loadPending = { firstRowId }
    this.emit(Message.RequestedLoadOlder())
  }

  // ── Visible rows (useVisibleRowRange) ───────────────────────────────────

  /** Each row's top, against the viewport's own rect in scroll coordinates. */
  private remeasureRows() {
    if (!this.feed.minimap) {
      this.tops = []
    } else {
      const origin = this.viewport.getBoundingClientRect().top - this.viewport.scrollTop
      this.tops = Array.from(rowItems(this.content), (item) => item.getBoundingClientRect().top - origin)
    }
    this.scheduleRange()
  }

  private scheduleRange() {
    if (this.rangeFrame === null) this.rangeFrame = window.requestAnimationFrame(() => this.computeRange())
  }

  /** The last row whose top edge is at or above `y`: the row that contains `y`. */
  private rowAt(y: number) {
    let low = 0
    let high = this.tops.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (this.tops[mid]! <= y) low = mid
      else high = mid - 1
    }
    return low
  }

  private computeRange() {
    this.rangeFrame = null
    if (this.tops.length === 0) {
      if (this.range !== null) {
        this.range = null
        this.emit(Message.ChangedVisibleRange({ range: null }))
      }
      return
    }
    const start = this.rowAt(this.viewport.scrollTop + this.feed.header)
    const end = this.rowAt(this.viewport.scrollTop + this.viewport.clientHeight - 1)
    if (this.range && this.range.start === start && this.range.end === end) return
    this.range = { start, end }
    this.emit(Message.ChangedVisibleRange({ range: { start, end } }))
  }

  // ── useScrollbarGutterVar ───────────────────────────────────────────────

  private publishGutter() {
    const scroller = this.viewport
    const host = this.root.closest<HTMLElement>("[data-chat-card]")
    if (!host) return () => {}
    const name = "--transcript-scrollbar-w"
    let published = -1
    const sync = () => {
      const width = Math.max(0, scroller.offsetWidth - scroller.clientWidth)
      if (width === published) return
      published = width
      host.style.setProperty(name, `${width}px`)
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(scroller)
    return () => {
      observer.disconnect()
      host.style.removeProperty(name)
    }
  }
}

function sameScrollTarget(left: TranscriptScrollTarget, right: TranscriptScrollTarget): boolean {
  if (left.kind === "end" || right.kind === "end") return left.kind === right.kind
  return left.rowId === right.rowId && (left.offsetFromMessage ?? 0) === (right.offsetFromMessage ?? 0)
}

export function emptyFeed(): Feed {
  return {
    chatId: null,
    header: 0,
    insetBottom: 0,
    readAnchor: { resolved: true, confirmed: true },
    restore: { kind: "end" },
    prompt: null,
    reply: null,
    tool: null,
    jump: null,
    hasOlder: false,
    loadingOlder: false,
    unloadedJump: null,
    atEnd: true,
    minimap: false,
    reports: false,
  }
}

/**
 * On the scroller's root (`message-scroller`): finds its parts, starts the
 * controller and keeps it for the element's life. Keyed by chat in the view,
 * so each open gets a fresh one.
 */
export const ControlViewport = Mount.defineStream("ControlTranscriptViewport", {
  messages: [
    Message.MountedViewport,
    Message.ChangedAtEnd,
    Message.ChangedOverflow,
    Message.ResizedViewport,
    Message.ChangedVisibleRange,
    Message.ReportedReadAnchor,
    Message.RequestedLoadOlder,
    Message.SpentJump,
    Message.JumpedToRow,
    Message.AppliedUnloadedJump,
  ],
  execute: ({ element }) => domStream<Reported>((emit) => {
    const viewport = element.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const content = viewport?.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    const spacer = content?.querySelector<HTMLElement>(":scope > [data-message-scroller-spacer]")
    if (!(element instanceof HTMLElement) || !viewport || !content || !spacer) return () => {}
    const controller = new ViewportController(element, viewport, content, spacer, emit)
    emit(Message.MountedViewport({ chatId: readFeed(viewport)?.chatId ?? null }))
    controller.start()
    return () => controller.dispose()
  }),
})

/** What the slice asks of the viewport keyed `key` outside a render, from a Command. */
export const DriveViewport = Command.define("DriveTranscriptViewport", {
  args: { key: Schema.String, action: Schema.Literals(["scroll-to-bottom", "jump-to-unloaded", "load-more"]) },
  messages: [Message.CompletedViewportCommand],
  execute: ({ key, action }) => Effect.sync(() => {
    const controller = controllerFor(key)
    if (controller) {
      if (action === "scroll-to-bottom") controller.scrollToBottom()
      else if (action === "jump-to-unloaded") controller.jumpToUnloaded()
      else controller.loadMore()
    }
    return Message.CompletedViewportCommand()
  }),
})

/** A minimap jump to a loaded turn's row. */
export const JumpViewportToRow = Command.define("JumpTranscriptViewportToRow", {
  args: { key: Schema.String, rowId: Schema.String },
  messages: [Message.CompletedViewportCommand],
  execute: ({ key, rowId }) => Effect.sync(() => {
    controllerFor(key)?.jumpToRow(rowId)
    return Message.CompletedViewportCommand()
  }),
})
