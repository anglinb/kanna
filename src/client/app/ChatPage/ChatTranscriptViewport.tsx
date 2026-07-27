import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, Flower, Upload } from "lucide-react"
import { AnimatedShinyText } from "../../components/ui/animated-shiny-text"
import { DrainingIndicator } from "../../components/messages/DrainingIndicator"
import { QueuedUserMessage } from "../../components/messages/QueuedUserMessage"
import { OpenLocalLinkProvider, type OpenLocalLinkTarget } from "../../components/messages/shared"
import { ProcessingMessage } from "../../components/messages/ProcessingMessage"
import { ContextMenu, ContextMenuTrigger } from "../../components/ui/context-menu"
import { OpenExternalContextMenuContent, openContextMenuFromButton } from "../../components/open-external-menu"
import { TRANSCRIPT_PADDING_BOTTOM_OFFSET } from "../kannaStateHelpers"
import { cn } from "../../lib/utils"
import { formatPathWithTilde, shouldOpenLocalFileLinkInEditor } from "../../lib/pathUtils"
import {
  buildResolvedTranscriptRows,
  KannaTranscriptRow,
  type ResolvedTranscriptRow,
  useStableResolvedRows,
} from "../KannaTranscript"
import type { KannaState } from "../useKannaState"
import type { KannaSocket } from "../socket"
import type { ChatReadAnchorState } from "../useChatReadAnchor"
import type { ChatTurnSummary } from "../../../shared/types"
import {
  buildRowIndexByMessageId,
  getLatestUserPrompt,
  getRowAnchorMessageId,
  isOptimisticMessageId,
  resolveRestoreTarget,
  shouldPinForNewPrompt,
  type LatestUserPrompt,
  type TranscriptScrollTarget,
} from "./transcriptScrollAnchors"
import { TranscriptMinimap } from "./TranscriptMinimap"
import { buildTranscriptTurns, getVisibleRowRange, mergeTurnIndex, type TranscriptTurn } from "./transcriptTurns"
import { EmptyStateAuthCards } from "./EmptyStateAuthCards"
import { EmptyStateUsageCards } from "./EmptyStateUsageCards"
import {
  CHAT_NAVBAR_OFFSET_PX,
  EMPTY_STATE_TEXT,
} from "./utils"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction } from "../../../shared/protocol"
import { estimateTranscriptRowSize } from "./transcriptRowSize"

/**
 * How close to the bottom counts as "at the end", as a fraction of viewport
 * height.
 *
 * Deliberately one number shared by two consumers: the list uses it to decide
 * whether to keep following new content, and the viewport uses it to decide
 * whether the reader is following. When those disagreed — the list treating a
 * tenth of the viewport as "at the end" while the viewport insisted on 4px —
 * scrolling up slightly put them in opposite states, so the list kept pulling
 * back to the bottom while the UI showed a scroll-to-bottom button.
 */
const AT_END_THRESHOLD_RATIO = 0.05

/**
 * Frames a restore may re-issue its scroll for before giving up.
 *
 * Each pass pulls more real row measurements into range, which moves where the
 * anchor actually is; the loop exits as soon as the offset stops changing, so
 * this is a ceiling for pathological lists rather than a frame count anyone
 * normally pays.
 */
const RESTORE_SETTLE_FRAMES = 8

/**
 * Viewport width below which this is a phone-shaped layout.
 *
 * Two things key off it, both about spending less per scroll frame on a device
 * that has less to spend: the overview map has no gutter to live in, so the
 * geometry it needs is not worth computing, and far fewer rows are kept mounted
 * around the viewport.
 */
const NARROW_VIEWPORT_PX = 640

/**
 * Rows are kept mounted this far beyond the viewport. Generous on a desktop —
 * a remounted row renders collapsed while the list still holds its expanded
 * height, and that mismatch both re-anchors layout and re-triggers
 * follow-the-bottom. On a phone the extra mounted DOM costs more in paint than
 * the occasional remount costs in jumpiness.
 */
const DRAW_DISTANCE_PX = 1200
const DRAW_DISTANCE_NARROW_PX = 400

/** Max auto-fetched history pages per chat when the list is too short to scroll. */
const MAX_HISTORY_AUTO_FILL_PAGES = 4

/** Cap on older-history pages fetched to reach a turn clicked in the minimap. */
const MAX_HISTORY_SEEK_PAGES = 20

/** Stable empty default so the export viewer does not re-merge every render. */
const EMPTY_TURN_INDEX: ChatTurnSummary[] = []

/**
 * LegendList state changes that can move which rows are on screen.
 * `footerSize` is the one that catches a turn ending: the processing indicator
 * and any error box live in the footer, outside `data`.
 */
const LIST_LAYOUT_EVENTS = ["lastPositionUpdate", "totalSize", "footerSize", "lastItemKeys"] as const

/**
 * Slack before the transcript counts as scrollable. Content and viewport rarely
 * land on equal subpixel values, and a hairline of scroll is not something
 * worth offering a map for.
 */
const OVERFLOW_EPSILON_PX = 8

/** No stored anchor — pin the latest user prompt. Used by the export viewer too. */
const DEFAULT_READ_ANCHOR_STATE: ChatReadAnchorState = { resolved: true, anchor: null }

interface ChatTranscriptViewportProps {
  activeChatId: string | null
  listRef: React.RefObject<LegendListRef | null>
  messages: KannaState["messages"]
  queuedMessages: KannaState["queuedMessages"]
  transcriptPaddingBottom: number
  localPath: string | null | undefined
  latestToolIds: KannaState["latestToolIds"]
  isHistoryLoading: boolean
  hasOlderHistory: boolean
  isProcessing: boolean
  runtimeStatus: string | null
  isDraining: boolean
  commandError: string | null
  loadOlderHistory: () => Promise<void>
  /** Whole-transcript turn summaries; the map covers more than the loaded rows. */
  chatTurnIndex?: ChatTurnSummary[]
  onStopDraining: () => void
  onSteerQueuedMessage: (queuedMessageId: string) => Promise<void>
  onRemoveQueuedMessage: (queuedMessageId: string) => Promise<void>
  onOpenLocalLink: KannaState["handleOpenLocalLink"]
  onAskUserQuestionSubmit: KannaState["handleAskUserQuestion"]
  onExitPlanModeConfirm: KannaState["handleExitPlanMode"]
  showScrollButton: boolean
  onIsAtEndChange: (isAtEnd: boolean) => void
  scrollToBottom: () => void
  typedEmptyStateText: string
  isEmptyStateTypingComplete: boolean
  isPageFileDragActive: boolean
  showEmptyState: boolean
  /** When provided, the empty state shows live harness usage cards. */
  socket?: KannaSocket
  emptyStateProjectPath?: string | null
  onOpenProjectExternal?: (action: OpenExternalAction, editor?: EditorOpenSettings) => void
  editorPreset?: EditorPreset
  editorCommandTemplate?: string
  platform?: NodeJS.Platform
  headerOffsetPx?: number
  /** Server-stored read position; restore waits for this to resolve. */
  readAnchorState?: ChatReadAnchorState
  /** Reports the message at the top of the viewport as the user scrolls. */
  onReportReadAnchor?: (messageId: string, atEnd: boolean) => void
}

export const ChatTranscriptViewport = memo(function ChatTranscriptViewport({
  activeChatId,
  listRef,
  messages,
  queuedMessages,
  transcriptPaddingBottom,
  localPath,
  latestToolIds,
  isHistoryLoading,
  hasOlderHistory,
  isProcessing,
  runtimeStatus,
  isDraining,
  commandError,
  loadOlderHistory,
  chatTurnIndex = EMPTY_TURN_INDEX,
  onStopDraining,
  onSteerQueuedMessage,
  onRemoveQueuedMessage,
  onOpenLocalLink,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  showScrollButton,
  onIsAtEndChange,
  scrollToBottom,
  typedEmptyStateText,
  isEmptyStateTypingComplete,
  isPageFileDragActive,
  showEmptyState,
  socket,
  emptyStateProjectPath,
  onOpenProjectExternal,
  editorPreset = "cursor",
  editorCommandTemplate,
  platform = "darwin",
  headerOffsetPx = CHAT_NAVBAR_OFFSET_PX,
  readAnchorState = DEFAULT_READ_ANCHOR_STATE,
  onReportReadAnchor,
}: ChatTranscriptViewportProps) {
  const localLinkMenuTriggerRef = useRef<HTMLSpanElement | null>(null)
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({})
  const [localLinkMenuTarget, setLocalLinkMenuTarget] = useState<OpenLocalLinkTarget | null>(null)
  const isMac = platform === "darwin"

  const rawRows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading: isProcessing,
    localPath: localPath ?? undefined,
    latestToolIds,
    hasOlderHistory,
  }), [hasOlderHistory, isProcessing, latestToolIds, localPath, messages])
  const resolvedRows = useStableResolvedRows(rawRows)

  useEffect(() => {
    setToolGroupExpanded({})
  }, [activeChatId])

  const rowIndexByMessageId = useMemo(() => buildRowIndexByMessageId(resolvedRows), [resolvedRows])
  const loadedTurns = useMemo(() => buildTranscriptTurns(resolvedRows), [resolvedRows])
  const turns = useMemo(
    () => mergeTurnIndex(chatTurnIndex, loadedTurns),
    [chatTurnIndex, loadedTurns],
  )

  /**
   * Rendered row window plus whether the list can scroll at all — together they
   * drive the minimap, which only earns its space once there is something to
   * navigate.
   */
  const [listGeometry, setListGeometry] = useState({ start: 0, end: 0, overflows: false })
  /** Scroll pane width, driving whether the minimap has a gutter to live in. */
  const [transcriptWidth, setTranscriptWidth] = useState(0)
  // Read inside a scroll handler, so it lives in a ref rather than being a
  // dependency that would rebuild the handler on every resize.
  const transcriptWidthRef = useRef(0)
  transcriptWidthRef.current = transcriptWidth
  const isNarrowViewport = transcriptWidth > 0 && transcriptWidth < NARROW_VIEWPORT_PX
  const drawDistance = isNarrowViewport ? DRAW_DISTANCE_NARROW_PX : DRAW_DISTANCE_PX

  /**
   * Overlay insets, in a ref so the geometry sync stays referentially stable —
   * the bottom inset changes on every keystroke that grows the input, and
   * re-subscribing the list listeners that often would be wasteful.
   */
  const viewportInsetsRef = useRef({ top: 0, bottom: 0 })
  viewportInsetsRef.current = {
    top: headerOffsetPx,
    bottom: Math.max(0, transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET),
  }

  // Kept in a ref so the native scroll handler can read the current rows
  // without being re-created (and re-attached) on every transcript change.
  const resolvedRowsRef = useRef(resolvedRows)
  resolvedRowsRef.current = resolvedRows

  /** Chat we have already positioned, so restore runs exactly once per open. */
  const restoredChatIdRef = useRef<string | null>(null)
  /** Latest user prompt as of the last observation, for the pin-on-send rule. */
  const latestPromptRef = useRef<LatestUserPrompt | null>(null)
  /**
   * Whether the user has actually scrolled this chat themselves.
   *
   * Only their own scrolling may move the stored read position. Restores,
   * pins and auto-follow all scroll programmatically and settle over several
   * frames as rows measure — sampling during that drifts the anchor by a row
   * on every open. Real input events are the one signal those can't fake.
   */
  const hasUserScrolledRef = useRef(false)
  const scrollFramesRef = useRef<number[]>([])
  // `syncListGeometry` is defined below this callback; the ref keeps the
  // restore loop able to reach it without reordering the file.
  const syncListGeometryRef = useRef<() => void>(() => {})

  const cancelPendingScrollFrames = useCallback(() => {
    for (const frameId of scrollFramesRef.current) {
      window.cancelAnimationFrame(frameId)
    }
    scrollFramesRef.current = []
  }, [])

  const applyScrollTarget = useCallback((target: TranscriptScrollTarget) => {
    cancelPendingScrollFrames()

    if (target.kind === "end") {
      onIsAtEndChange(true)
      scrollFramesRef.current.push(window.requestAnimationFrame(() => {
        void listRef.current?.scrollToEnd?.({ animated: false })
      }))
      return
    }

    // Written synchronously (it sets a ref in ChatPage) so the parent's
    // auto-follow effect bails on this same commit instead of yanking us to
    // the bottom — child effects flush before parent effects.
    onIsAtEndChange(false)

    const scrollToTarget = () => {
      void listRef.current?.scrollToIndex?.({
        index: target.index,
        viewPosition: 0,
        viewOffset: headerOffsetPx,
        animated: false,
      })
    }

    /**
     * Re-issue until the anchor row actually sits at the top and stays there.
     *
     * `scrollToIndex` computes its offset from the sizes the list knows, and on
     * a cold open most rows above the target have only an estimate. Each pass
     * brings more real measurements into range, which moves the correct offset
     * — so a fixed number of frames lands near the target rather than on it,
     * and the row the reader left at the top is not the row they come back to.
     *
     * Stops as soon as the scroll offset repeats (settled) or the budget runs
     * out, so a list that never converges cannot spin.
     */
    const settleToTarget = (attemptsLeft: number, previousOffset: number) => {
      scrollToTarget()
      scrollFramesRef.current.push(window.requestAnimationFrame(() => {
        const offset = listRef.current?.getState?.()?.scroll ?? previousOffset
        // The minimap reads the visible range from this; without a sync here it
        // keeps whatever it had before the restore, which on a fresh load is
        // "nothing in view".
        syncListGeometryRef.current()
        if (attemptsLeft <= 0 || Math.abs(offset - previousOffset) < 1) return
        settleToTarget(attemptsLeft - 1, offset)
      }))
    }

    scrollFramesRef.current.push(window.requestAnimationFrame(() => {
      settleToTarget(RESTORE_SETTLE_FRAMES, Number.NaN)
    }))
  }, [cancelPendingScrollFrames, headerOffsetPx, listRef, onIsAtEndChange])

  useEffect(() => cancelPendingScrollFrames, [cancelPendingScrollFrames])

  // Restore once per chat open: wait until rows exist *and* the stored anchor
  // has resolved, otherwise we'd land on the fallback and visibly jump when the
  // anchor arrives a moment later.
  useEffect(() => {
    if (!activeChatId) {
      // Leaving the chat surface arms the next open to restore again. Without
      // this the ref still names the chat just left, so returning to that same
      // chat short-circuits below — no restore, and no geometry sync to light
      // up the map. Navigating to a *different* chat happened to work, which
      // is why this only showed up on away-and-back.
      restoredChatIdRef.current = null
      return
    }
    if (restoredChatIdRef.current === activeChatId) return
    if (resolvedRows.length === 0 || !readAnchorState.resolved) return

    restoredChatIdRef.current = activeChatId
    hasUserScrolledRef.current = false
    latestPromptRef.current = getLatestUserPrompt(resolvedRows)
    applyScrollTarget(resolveRestoreTarget(resolvedRows, readAnchorState.anchor, rowIndexByMessageId))
  }, [activeChatId, applyScrollTarget, readAnchorState, resolvedRows, rowIndexByMessageId])

  // Pin a newly sent prompt to the top. Streaming output never trips this
  // because it leaves the latest prompt untouched.
  useEffect(() => {
    if (!activeChatId || restoredChatIdRef.current !== activeChatId) return

    const nextPrompt = getLatestUserPrompt(resolvedRows)
    const previousPrompt = latestPromptRef.current
    latestPromptRef.current = nextPrompt

    if (!shouldPinForNewPrompt(previousPrompt, nextPrompt) || nextPrompt === null) return
    applyScrollTarget({ kind: "pin", index: nextPrompt.rowIndex })
  }, [activeChatId, applyScrollTarget, resolvedRows])

  const handleToolGroupExpandedChange = useCallback((groupId: string, next: boolean) => {
    setToolGroupExpanded((current) => (
      current[groupId] === next
        ? current
        : {
            ...current,
            [groupId]: next,
          }
    ))
  }, [])

  /**
   * Remember which message the user is looking at. `getState().start` is by
   * construction the first row whose bottom edge is below the viewport top, in
   * a coordinate space that already accounts for the sticky header — so it is
   * exactly "the message at the top of the screen".
   */
  const reportTopVisibleMessage = useCallback((isAtEnd: boolean) => {
    if (!onReportReadAnchor) return
    // Never let a programmatic scroll move the stored position.
    if (!hasUserScrolledRef.current) return

    const start = listRef.current?.getState?.()?.start
    if (typeof start !== "number") return
    const row = resolvedRowsRef.current[start]
    if (!row) return

    const messageId = getRowAnchorMessageId(row)
    // Optimistic ids are client-local and will not resolve on another device.
    if (!messageId || isOptimisticMessageId(messageId)) return

    onReportReadAnchor(messageId, isAtEnd)
  }, [listRef, onReportReadAnchor])

  /**
   * Mirror the list's geometry into state for the minimap.
   *
   * `start`/`end` are already the on-screen range, so no measurement of our own.
   * Overflow comes from the scroll node rather than LegendList's `contentLength`
   * because only the node accounts for the header offset and the tall bottom
   * padding that clears the input dock — a large share of this list's height.
   */
  const syncListGeometry = useCallback(() => {
    // The map is the only reader, and it has no room to render on a narrow
    // viewport. Sampling anyway would commit React state on every scroll
    // event — the most expensive thing this component does per frame — to
    // feed something nobody can see.
    if (transcriptWidthRef.current > 0 && transcriptWidthRef.current < NARROW_VIEWPORT_PX) return

    const state = listRef.current?.getState?.()
    if (!state) return

    const scrollNode = listRef.current?.getScrollableNode?.()
    const overflows = scrollNode instanceof HTMLElement
      && scrollNode.scrollHeight - scrollNode.clientHeight > OVERFLOW_EPSILON_PX

    // The band the reader can actually see: the navbar and the input dock are
    // overlays, so rows sliding under them are on the scroll surface but not
    // on screen.
    const { top: insetTop, bottom: insetBottom } = viewportInsetsRef.current
    const range = getVisibleRowRange(
      {
        count: resolvedRowsRef.current.length,
        positionAtIndex: state.positionAtIndex,
        sizeAtIndex: state.sizeAtIndex,
      },
      state.scroll + insetTop,
      state.scroll + state.scrollLength - insetBottom,
    )

    setListGeometry((current) => {
      // A null range means the list has not laid out yet, not that the reader
      // is looking at nothing — keep the last known rows rather than blanking
      // every tick.
      const start = range?.start ?? current.start
      const end = range?.end ?? current.end
      return current.start === start && current.end === end && current.overflows === overflows
        ? current
        : { start, end, overflows }
    })
  }, [listRef])

  /**
   * Track the row window from LegendList's own layout events rather than from
   * scroll events plus a guessed frame.
   *
   * Plenty of things move rows under a stationary scroll position and emit no
   * `scroll` of their own — streaming, and especially a turn ending: the
   * processing indicator leaves the footer and an error box may join it, which
   * is a pure footer resize the row count never sees. Sampling one rAF after a
   * data change also lands before virtualized rows have re-measured, so the
   * range would stick until the next manual scroll.
   */
  useEffect(() => {
    let unsubscribes: Array<() => void> = []
    const frames: number[] = []

    // Sampled over several frames, not once. A single rAF after mount lands
    // before the list has laid out, so the range stays at its initial value
    // and the map reads as "nothing on screen" until something else moves the
    // list. That is the whole story when a chat is reopened without a restore
    // — the scroll position is already correct, so nothing else ever fires.
    const settleGeometry = (attemptsLeft: number) => {
      frames.push(window.requestAnimationFrame(() => {
        syncListGeometry()
        if (attemptsLeft > 0) settleGeometry(attemptsLeft - 1)
      }))
    }

    const frameId = window.requestAnimationFrame(() => {
      const state = listRef.current?.getState?.()
      if (!state?.listen) return
      unsubscribes = LIST_LAYOUT_EVENTS.map((event) => state.listen(event, syncListGeometry))
      settleGeometry(RESTORE_SETTLE_FRAMES)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
      for (const frame of frames) window.cancelAnimationFrame(frame)
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [activeChatId, listRef, syncListGeometry])

  syncListGeometryRef.current = syncListGeometry

  const handleScroll = useCallback((event?: unknown) => {
    syncListGeometry()

    const currentTarget = (
      typeof event === "object"
      && event !== null
      && "currentTarget" in event
      && event.currentTarget instanceof HTMLElement
    )
      ? event.currentTarget
      : listRef.current?.getScrollableNode?.()

    if (currentTarget instanceof HTMLElement) {
      const distanceFromEnd = currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop
      const isAtEnd = distanceFromEnd <= currentTarget.clientHeight * AT_END_THRESHOLD_RATIO
      onIsAtEndChange(isAtEnd)
      reportTopVisibleMessage(isAtEnd)
      return
    }

    const state = listRef.current?.getState?.()
    if (state) {
      onIsAtEndChange(state.isAtEnd)
      reportTopVisibleMessage(state.isAtEnd)
    }
  }, [listRef, onIsAtEndChange, reportTopVisibleMessage, syncListGeometry])

  useEffect(() => {
    let cleanup: (() => void) | undefined
    const frameId = window.requestAnimationFrame(() => {
      const scrollNode = listRef.current?.getScrollableNode?.()
      if (!(scrollNode instanceof HTMLElement)) {
        return
      }

      const handleNativeScroll = () => {
        handleScroll({ currentTarget: scrollNode })
      }

      // Input events are the only reliable way to tell the user's own
      // scrolling apart from a restore/pin/auto-follow, which also emit
      // `scroll` and keep settling for several frames as rows measure.
      const markUserScrolled = () => {
        hasUserScrolledRef.current = true
      }
      const userIntentEvents = ["wheel", "touchmove", "pointerdown", "keydown"] as const

      // Resizing the pane changes both the gutter and whether the same content
      // still overflows, neither of which emits a scroll or a list layout event.
      const syncSize = () => {
        const nextWidth = scrollNode.clientWidth
        setTranscriptWidth((current) => (Math.abs(current - nextWidth) < 1 ? current : nextWidth))
        syncListGeometry()
      }
      const sizeObserver = new ResizeObserver(syncSize)
      sizeObserver.observe(scrollNode)
      syncSize()

      scrollNode.addEventListener("scroll", handleNativeScroll, { passive: true })
      for (const eventName of userIntentEvents) {
        scrollNode.addEventListener(eventName, markUserScrolled, { passive: true })
      }
      handleNativeScroll()
      cleanup = () => {
        sizeObserver.disconnect()
        scrollNode.removeEventListener("scroll", handleNativeScroll)
        for (const eventName of userIntentEvents) {
          scrollNode.removeEventListener(eventName, markUserScrolled)
        }
      }
    })

    return () => {
      window.cancelAnimationFrame(frameId)
      cleanup?.()
    }
  }, [activeChatId, handleScroll, listRef, resolvedRows.length])

  // The button lives outside the scroll node, so it never trips the input
  // listeners — but jumping to the bottom is an explicit read-position choice.
  const handleScrollToBottomClick = useCallback(() => {
    hasUserScrolledRef.current = true
    scrollToBottom()
  }, [scrollToBottom])

  // Read through refs so the retry loop below sees state from the render that
  // each history page produced, not the one it started in.
  const rowIndexByMessageIdRef = useRef(rowIndexByMessageId)
  rowIndexByMessageIdRef.current = rowIndexByMessageId
  const loadOlderHistoryRef = useRef(loadOlderHistory)
  loadOlderHistoryRef.current = loadOlderHistory
  const hasOlderHistoryRef = useRef(hasOlderHistory)
  hasOlderHistoryRef.current = hasOlderHistory

  // Same reasoning as the scroll-to-bottom button: the minimap sits outside the
  // scroll node, so it never trips the input listeners, but jumping to a turn is
  // as deliberate a read-position choice as scrolling there by hand.
  const handleSelectTurn = useCallback(async (turn: TranscriptTurn) => {
    hasUserScrolledRef.current = true

    if (turn.rowIndex !== null) {
      applyScrollTarget({ kind: "pin", index: turn.rowIndex })
      return
    }

    // The map covers the whole transcript, so a tick can point at a turn that
    // has not been paged in. Fetch older pages until its row exists, then jump.
    for (let attempt = 0; attempt < MAX_HISTORY_SEEK_PAGES; attempt += 1) {
      const index = rowIndexByMessageIdRef.current.get(turn.id)
      if (index !== undefined) {
        applyScrollTarget({ kind: "pin", index })
        return
      }
      if (!hasOlderHistoryRef.current) return
      await loadOlderHistoryRef.current()
      // Yield past the microtask queue so React commits the new page and the
      // refs above point at the widened row list before the next look.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }, [applyScrollTarget])

  const handleStartReached = useCallback(() => {
    if (isHistoryLoading || !hasOlderHistory) {
      return
    }
    void loadOlderHistory()
  }, [hasOlderHistory, isHistoryLoading, loadOlderHistory])

  // A long tool-call run can collapse the entire loaded window into a single
  // tool-group row, leaving the list too short to scroll — so onStartReached
  // can never fire. Auto-fetch older pages until the viewport overflows
  // (capped); the header button below is the manual escape hatch beyond that.
  const autoFillPagesRef = useRef(0)

  useEffect(() => {
    autoFillPagesRef.current = 0
  }, [activeChatId])

  useEffect(() => {
    if (isHistoryLoading || !hasOlderHistory || resolvedRows.length === 0) {
      return
    }
    if (autoFillPagesRef.current >= MAX_HISTORY_AUTO_FILL_PAGES) {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      const scrollNode = listRef.current?.getScrollableNode?.()
      if (!(scrollNode instanceof HTMLElement)) {
        return
      }
      if (scrollNode.scrollHeight > scrollNode.clientHeight + 1) {
        return
      }
      autoFillPagesRef.current += 1
      void loadOlderHistory()
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [activeChatId, hasOlderHistory, isHistoryLoading, listRef, loadOlderHistory, resolvedRows.length])

  const handleOpenLocalLinkClick = useCallback((target: OpenLocalLinkTarget) => {
    if (target.trigger !== "contextmenu") {
      const action = shouldOpenLocalFileLinkInEditor(target.path) ? "open_editor" : "open_default"
      void onOpenLocalLink(target, action)
      return
    }

    setLocalLinkMenuTarget(target)
    window.requestAnimationFrame(() => {
      const trigger = localLinkMenuTriggerRef.current
      if (!trigger) return
      const clientX = target.clientX ?? window.innerWidth / 2
      const clientY = target.clientY ?? window.innerHeight / 2
      trigger.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        view: window,
      }))
    })
  }, [onOpenLocalLink])

  const renderItem = useCallback(({ item }: { item: ResolvedTranscriptRow }) => (
    <div className="mx-auto w-full max-w-[800px] pb-5" data-transcript-row-id={item.id}>
      <KannaTranscriptRow
        row={item}
        toolGroupExpanded={item.kind === "tool-group" ? (toolGroupExpanded[item.id] ?? false) : undefined}
        onToolGroupExpandedChange={handleToolGroupExpandedChange}
        onAskUserQuestionSubmit={onAskUserQuestionSubmit}
        onExitPlanModeConfirm={onExitPlanModeConfirm}
      />
    </div>
  ), [handleToolGroupExpandedChange, onAskUserQuestionSubmit, onExitPlanModeConfirm, toolGroupExpanded])

  // Stable identity: the viewport commits a render on every scroll event (the
  // visible row range changes constantly), and a fresh style object hands the
  // list a "content container changed" signal each time, which relays out the
  // header and footer and can itself re-trigger follow-the-bottom.
  const contentContainerStyle = useMemo(
    () => ({ paddingBottom: transcriptPaddingBottom + 10 }),
    [transcriptPaddingBottom]
  )

  const listHeader = (
    <div className="mx-auto w-full max-w-[800px]" style={{ paddingTop: `${headerOffsetPx}px` }}>
      {isHistoryLoading ? (
        <div className="flex justify-center pb-4">
          <span className="text-sm translate-y-[-0.5px]">
            <AnimatedShinyText
              animate
              shimmerWidth={Math.max(20, "Loading more messages...".length * 3)}
            >
              Loading more messages...
            </AnimatedShinyText>
          </span>
        </div>
      ) : hasOlderHistory ? (
        <div className="flex justify-center pb-4">
          <button
            type="button"
            onClick={() => void loadOlderHistory()}
            className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Load older messages
          </button>
        </div>
      ) : null}
    </div>
  )

  const listFooter = (
    <div className="mx-auto w-full max-w-[800px]">
      {isProcessing ? <ProcessingMessage status={runtimeStatus ?? undefined} /> : null}
      {queuedMessages.map((message) => (
        <QueuedUserMessage
          key={message.id}
          message={message}
          onRemove={() => void onRemoveQueuedMessage(message.id)}
          onSendNow={() => void onSteerQueuedMessage(message.id)}
        />
      ))}
      {!isProcessing && isDraining ? (
        <DrainingIndicator onStop={() => void onStopDraining()} />
      ) : null}
      {commandError ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {commandError}
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      <OpenLocalLinkProvider onOpenLocalLink={handleOpenLocalLinkClick}>
        <LegendList<ResolvedTranscriptRow>
          ref={listRef}
          data={resolvedRows}
          extraData={toolGroupExpanded}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          // Per row, not one number for all of them: a collapsed tool header
          // and a long answer differ by more than an order of magnitude, and
          // the estimate is what unmeasured rows — including every row
          // `scrollToIndex` jumps over — are assumed to be.
          getEstimatedItemSize={getEstimatedItemSize}
          estimatedItemSize={48}
          // No initialScrollAtEnd: the prop is captured at mount, and opening a
          // chat now restores to a stored anchor rather than the bottom. The
          // restore effect above drives the initial position instead.
          maintainScrollAtEnd
          maintainScrollAtEndThreshold={AT_END_THRESHOLD_RATIO}
          maintainVisibleContentPosition
          onScroll={handleScroll}
          onStartReached={handleStartReached}
          onStartReachedThreshold={0.1}
          // Rows unmount as soon as they leave this band, and a remounted row
          // renders collapsed while the list still holds its expanded height —
          // the size delta both re-anchors layout and re-triggers follow-the-
          // bottom. Keeping more of the transcript mounted makes that rare, at
          // the cost of some retained DOM.
          drawDistance={drawDistance}
          className="h-full flex-1 overflow-x-hidden overscroll-y-contain px-3 scroll-pt-[72px] [scrollbar-gutter:auto]"
          contentContainerStyle={contentContainerStyle}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
        />
      </OpenLocalLinkProvider>

      {showEmptyState ? null : (
        <TranscriptMinimap
          turns={turns}
          visibleStart={listGeometry.start}
          visibleEnd={listGeometry.end}
          transcriptOverflows={listGeometry.overflows}
          topPx={headerOffsetPx}
          // Match the empty state: transcriptPaddingBottom carries extra
          // clearance the message list needs but overlays should not.
          bottomPx={Math.max(0, transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET)}
          containerWidthPx={transcriptWidth}
          onSelectTurn={handleSelectTurn}
        />
      )}

      <ContextMenu onOpenChange={(open) => {
        if (!open) {
          setLocalLinkMenuTarget(null)
        }
      }}>
        <ContextMenuTrigger asChild>
          <span
            ref={localLinkMenuTriggerRef}
            aria-hidden="true"
            className="pointer-events-none fixed size-px opacity-0"
            style={{
              left: localLinkMenuTarget?.clientX ?? 0,
              top: localLinkMenuTarget?.clientY ?? 0,
            }}
          />
        </ContextMenuTrigger>
        {localLinkMenuTarget ? (
          <OpenExternalContextMenuContent
            isMac={isMac}
            editorPreset={editorPreset}
            editorCommandTemplate={editorCommandTemplate}
            includeFinder
            includePreview
            includeDefault
            onOpenExternal={(action, editor) => {
              void onOpenLocalLink(localLinkMenuTarget, action, editor)
            }}
          />
        ) : null}
      </ContextMenu>

      {showEmptyState ? (
        <div
          className="pointer-events-none absolute inset-x-4 animate-fade-in"
          style={{
            top: headerOffsetPx,
            // Align the scroll area's bottom to the top of the chat input.
            // transcriptPaddingBottom carries an extra clearance offset the
            // message list needs; the empty state shouldn't include it.
            bottom: Math.max(0, transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET),
          }}
        >
          <div className="pointer-events-auto mx-auto flex h-full max-w-[740px] flex-col items-center overflow-y-auto">
            {/* Flexbox-only center-or-scroll: my-auto centers the group when
                there's room, but its auto margins collapse once the content
                outgrows the container, so overflow-y-auto scrolls it from the
                top instead of clipping — no height measurement. */}
            <div className="my-auto flex w-full flex-col items-center gap-[6vh] py-6">
            <div className="flex flex-col items-center justify-center gap-4 text-muted-foreground opacity-70">
              <Flower strokeWidth={1.5} className="kanna-empty-state-flower size-8 text-muted-foreground" />
              <div
                className="kanna-empty-state-text flex max-w-xs items-center text-center text-base font-normal text-muted-foreground"
                aria-label={EMPTY_STATE_TEXT}
              >
                <span className="relative inline-grid place-items-start">
                  <span className="invisible col-start-1 row-start-1 flex items-center whitespace-pre">
                    <span>{EMPTY_STATE_TEXT}</span>
                    <span className="kanna-typewriter-cursor-slot" aria-hidden="true" />
                  </span>
                  <span className="col-start-1 row-start-1 flex items-center whitespace-pre">
                    <span>{typedEmptyStateText}</span>
                    <span className="kanna-typewriter-cursor-slot" aria-hidden="true">
                      <span
                        className="kanna-typewriter-cursor"
                        data-typing-complete={isEmptyStateTypingComplete ? "true" : "false"}
                      />
                    </span>
                  </span>
                </span>
              </div>
              {emptyStateProjectPath && onOpenProjectExternal ? (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={openContextMenuFromButton}
                      title={emptyStateProjectPath}
                      className={cn(
                        "max-w-xs truncate rounded-md px-2 py-1 font-mono text-xs text-muted-foreground/80 transition-all duration-300 hover:bg-muted hover:text-foreground",
                        isEmptyStateTypingComplete
                          ? "pointer-events-auto opacity-100"
                          : "pointer-events-none opacity-0",
                      )}
                    >
                      {formatPathWithTilde(emptyStateProjectPath)}
                    </button>
                  </ContextMenuTrigger>
                  <OpenExternalContextMenuContent
                    isMac={isMac}
                    editorPreset={editorPreset}
                    editorCommandTemplate={editorCommandTemplate}
                    includeFinder
                    includeTerminal
                    onOpenExternal={onOpenProjectExternal}
                  />
                </ContextMenu>
              ) : null}
            </div>
            {socket ? (
              <div
                className={cn(
                  "mt-8 flex w-full justify-center transition-opacity duration-500",
                  isEmptyStateTypingComplete
                    ? "pointer-events-auto opacity-100"
                    : "pointer-events-none opacity-0",
                )}
              >
                <div className="w-full space-y-3">
                  <EmptyStateAuthCards />
                  <EmptyStateUsageCards socket={socket} activeChatId={activeChatId} />
                </div>
              </div>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {isPageFileDragActive ? (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div className="absolute inset-0 backdrop-blur-sm" />
          <div className="absolute inset-6 ">
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center justify-center gap-3 text-center">
                <Upload className="mx-auto size-14 text-foreground" strokeWidth={1.75} />
                <div className="text-xl font-medium text-foreground">Drop up to 10 files</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{ bottom: transcriptPaddingBottom - 20 }}
        className={cn(
          "absolute left-1/2 z-10 -translate-x-1/2 transition-all",
          showScrollButton
            ? "scale-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            : "pointer-events-none scale-60 opacity-0 blur-sm duration-300 ease-out",
        )}
      >
        <button
          onClick={handleScrollToBottomClick}
          className="flex aspect-square cursor-pointer items-center gap-1.5 rounded-full border border-border bg-white px-2 text-sm text-primary transition-colors hover:bg-muted hover:text-foreground dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      </div>
    </>
  )
})

function keyExtractor(item: ResolvedTranscriptRow) {
  return item.id
}

function getEstimatedItemSize(item: ResolvedTranscriptRow) {
  return estimateTranscriptRowSize(item)
}
