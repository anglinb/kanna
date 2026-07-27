import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
} from "../../components/ui/message-scroller"
import { ArrowDown, Flower, Upload } from "lucide-react"
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
  useStableResolvedRows,
} from "../KannaTranscript"
import type { KannaState } from "../useKannaState"
import type { KannaSocket } from "../socket"
import type { ChatReadAnchorState } from "../useChatReadAnchor"
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
import { buildTranscriptTurns, type TranscriptTurn } from "./transcriptTurns"
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
 * Slack before the transcript counts as scrollable. Content and viewport rarely
 * land on equal subpixel values, and a hairline of scroll is not something
 * worth offering a map for.
 */
const OVERFLOW_EPSILON_PX = 8

/** No stored anchor — pin the latest user prompt. Used by the export viewer too. */
const DEFAULT_READ_ANCHOR_STATE: ChatReadAnchorState = { resolved: true, anchor: null }

/** What ChatPage drives the transcript with, in place of a list ref. */
export interface TranscriptScrollHandle {
  scrollToEnd: () => void
}

interface ChatTranscriptViewportProps {
  activeChatId: string | null
  listRef: React.RefObject<TranscriptScrollHandle | null>
  messages: KannaState["messages"]
  queuedMessages: KannaState["queuedMessages"]
  transcriptPaddingBottom: number
  localPath: string | null | undefined
  latestToolIds: KannaState["latestToolIds"]
  isProcessing: boolean
  runtimeStatus: string | null
  isDraining: boolean
  commandError: string | null
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

/**
 * The provider owns scroll anchoring and follow-the-end; the body below reads
 * them through hooks, which is why they are separate components.
 */
export const ChatTranscriptViewport = memo(function ChatTranscriptViewport(props: ChatTranscriptViewportProps) {
  return (
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={AT_END_THRESHOLD_RATIO}>
      <TranscriptScrollerBody {...props} />
    </MessageScrollerProvider>
  )
})

const TranscriptScrollerBody = memo(function TranscriptScrollerBody({
  activeChatId,
  listRef,
  messages,
  queuedMessages,
  transcriptPaddingBottom,
  localPath,
  latestToolIds,
  isProcessing,
  runtimeStatus,
  isDraining,
  commandError,
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
  const { scrollToEnd, scrollToMessage } = useMessageScroller()
  const { visibleMessageIds } = useMessageScrollerVisibility()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const localLinkMenuTriggerRef = useRef<HTMLSpanElement | null>(null)
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({})
  const [localLinkMenuTarget, setLocalLinkMenuTarget] = useState<OpenLocalLinkTarget | null>(null)
  const isMac = platform === "darwin"

  const rawRows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading: isProcessing,
    localPath: localPath ?? undefined,
    latestToolIds,
  }), [isProcessing, latestToolIds, localPath, messages])
  const resolvedRows = useStableResolvedRows(rawRows)

  useEffect(() => {
    setToolGroupExpanded({})
  }, [activeChatId])

  useEffect(() => {
    listRef.current = { scrollToEnd: () => { scrollToEnd() } }
    return () => { listRef.current = null }
  }, [listRef, scrollToEnd])

  const rowIndexByMessageId = useMemo(() => buildRowIndexByMessageId(resolvedRows), [resolvedRows])
  const rowIndexByRowId = useMemo(
    () => new Map(resolvedRows.map((row, index) => [row.id, index])),
    [resolvedRows]
  )
  const loadedTurns = useMemo(() => buildTranscriptTurns(resolvedRows), [resolvedRows])
  const turns = loadedTurns

  /**
   * Rendered row window plus whether the list can scroll at all — together they
   * drive the minimap, which only earns its space once there is something to
   * navigate.
   */
  const [transcriptOverflows, setTranscriptOverflows] = useState(false)
  /** Scroll pane width, driving whether the minimap has a gutter to live in. */
  const [transcriptWidth, setTranscriptWidth] = useState(0)

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

  const applyScrollTarget = useCallback((target: TranscriptScrollTarget) => {
    if (target.kind === "end") {
      onIsAtEndChange(true)
      scrollToEnd()
      return
    }

    // Written synchronously (it sets a ref in ChatPage) so the parent's
    // auto-follow effect bails on this same commit instead of yanking us to
    // the bottom — child effects flush before parent effects.
    onIsAtEndChange(false)
    // Rows are real elements, so this lands on the row rather than near it.
    // `scrollMargin` clears the floating navbar the row would otherwise sit
    // under.
    if (!scrollToMessage(target.rowId, { align: "start", scrollMargin: headerOffsetPx })) {
      scrollToEnd()
    }
  }, [headerOffsetPx, onIsAtEndChange, scrollToEnd, scrollToMessage])

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
    applyScrollTarget({ kind: "pin", rowId: nextPrompt.rowId })
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
  /**
   * Which rows are on screen, as the scroller observes them.
   *
   * Real elements report their own visibility, so there is no geometry to
   * mirror and nothing to re-derive when something moves rows under a
   * stationary scroll position.
   */
  const visibleRowRange = useMemo(() => {
    let start = Number.POSITIVE_INFINITY
    let end = Number.NEGATIVE_INFINITY
    for (const rowId of visibleMessageIds) {
      const index = rowIndexByRowId.get(rowId)
      if (index === undefined) continue
      if (index < start) start = index
      if (index > end) end = index
    }
    return Number.isFinite(start) ? { start, end } : null
  }, [rowIndexByRowId, visibleMessageIds])

  const reportTopVisibleMessage = useCallback((isAtEnd: boolean) => {
    if (!onReportReadAnchor) return
    // Never let a programmatic scroll move the stored position.
    if (!hasUserScrolledRef.current) return

    // The topmost row actually on screen — not the scroller's own anchor, which
    // marks turn starts and so is far coarser than a read position wants.
    const row = visibleRowRange === null ? undefined : resolvedRowsRef.current[visibleRowRange.start]
    if (!row) return

    const messageId = getRowAnchorMessageId(row)
    // Optimistic ids are client-local and will not resolve on another device.
    if (!messageId || isOptimisticMessageId(messageId)) return

    onReportReadAnchor(messageId, isAtEnd)
  }, [onReportReadAnchor, visibleRowRange])

  const handleScroll = useCallback(() => {
    const scrollNode = viewportRef.current
    if (!scrollNode) return
    const distanceFromEnd = scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop
    const isAtEnd = distanceFromEnd <= scrollNode.clientHeight * AT_END_THRESHOLD_RATIO
    onIsAtEndChange(isAtEnd)
    reportTopVisibleMessage(isAtEnd)
    setTranscriptOverflows(scrollNode.scrollHeight - scrollNode.clientHeight > OVERFLOW_EPSILON_PX)
  }, [onIsAtEndChange, reportTopVisibleMessage])

  useEffect(() => {
    const scrollNode = viewportRef.current
    if (!scrollNode) return

    // Input events are the only reliable way to tell the user's own scrolling
    // apart from a restore or a pin, which also emit `scroll`.
    const markUserScrolled = () => {
      hasUserScrolledRef.current = true
    }
    const userIntentEvents = ["wheel", "touchmove", "pointerdown", "keydown"] as const

    // Resizing the pane changes both the minimap's gutter and whether the same
    // content still overflows, neither of which emits a scroll.
    const syncSize = () => {
      const nextWidth = scrollNode.clientWidth
      setTranscriptWidth((current) => (Math.abs(current - nextWidth) < 1 ? current : nextWidth))
      handleScroll()
    }
    const sizeObserver = new ResizeObserver(syncSize)
    sizeObserver.observe(scrollNode)
    syncSize()

    scrollNode.addEventListener("scroll", handleScroll, { passive: true })
    for (const eventName of userIntentEvents) {
      scrollNode.addEventListener(eventName, markUserScrolled, { passive: true })
    }

    return () => {
      sizeObserver.disconnect()
      scrollNode.removeEventListener("scroll", handleScroll)
      for (const eventName of userIntentEvents) {
        scrollNode.removeEventListener(eventName, markUserScrolled)
      }
    }
  }, [activeChatId, handleScroll])

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
  // Same reasoning as the scroll-to-bottom button: the minimap sits outside the
  // scroll node, so it never trips the input listeners, but jumping to a turn is
  // as deliberate a read-position choice as scrolling there by hand.
  const handleSelectTurn = useCallback((turn: TranscriptTurn) => {
    hasUserScrolledRef.current = true
    applyScrollTarget({ kind: "pin", rowId: turn.id })
  }, [applyScrollTarget])

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

  // Stable identity: the viewport commits a render on every scroll event (the
  // visible row range changes constantly), and a fresh style object hands the
  // list a "content container changed" signal each time, which relays out the
  // header and footer and can itself re-trigger follow-the-bottom.
  const contentContainerStyle = useMemo(
    () => ({ paddingBottom: transcriptPaddingBottom + 10 }),
    [transcriptPaddingBottom]
  )

  const listHeader = (
    <div className="mx-auto w-full max-w-[800px]" style={{ paddingTop: `${headerOffsetPx}px` }} />
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
        <MessageScroller className="h-full flex-1">
          <MessageScrollerViewport
            ref={viewportRef}
            className="h-full overflow-x-hidden overscroll-y-contain px-3"
            style={{ scrollPaddingTop: headerOffsetPx }}
          >
            <MessageScrollerContent style={contentContainerStyle}>
              {listHeader}
              {resolvedRows.map((row) => (
                <MessageScrollerItem
                  key={row.id}
                  messageId={row.id}
                  // Anchors are what the scroller restores to and reports as the
                  // current position, so they mark where turns begin.
                  scrollAnchor={row.kind === "single" && row.message.kind === "user_prompt"}
                  // A per-row estimate of the height an offscreen row reserves.
                  // A collapsed tool header and a long answer differ by more
                  // than an order of magnitude, and the browser only keeps this
                  // until it has laid the row out once.
                  style={{ containIntrinsicSize: `auto ${estimateTranscriptRowSize(row)}px` }}
                >
                  <div className="mx-auto w-full max-w-[800px] pb-5" data-transcript-row-id={row.id}>
                    <KannaTranscriptRow
                      row={row}
                      toolGroupExpanded={row.kind === "tool-group" ? (toolGroupExpanded[row.id] ?? false) : undefined}
                      onToolGroupExpandedChange={handleToolGroupExpandedChange}
                      onAskUserQuestionSubmit={onAskUserQuestionSubmit}
                      onExitPlanModeConfirm={onExitPlanModeConfirm}
                    />
                  </div>
                </MessageScrollerItem>
              ))}
              {listFooter}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </OpenLocalLinkProvider>

      {showEmptyState ? null : (
        <TranscriptMinimap
          turns={turns}
          visibleStart={visibleRowRange?.start ?? -1}
          visibleEnd={visibleRowRange?.end ?? -1}
          transcriptOverflows={transcriptOverflows}
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
