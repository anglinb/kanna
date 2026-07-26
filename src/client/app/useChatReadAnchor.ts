import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ResolvedChatReadAnchor } from "../../shared/types"
import type { KannaSocket } from "./socket"
import { INITIAL_CHAT_RECENT_LIMIT } from "./kannaStateHelpers"

/**
 * Minimum gap between `chat.setReadAnchor` writes while the user keeps
 * scrolling. Also bounds how long after they stop before the final position
 * lands (the trailing write fires at most this late).
 */
const READ_ANCHOR_WRITE_INTERVAL_MS = 1500

/** Extra entries loaded beyond the anchor so there's context above it. */
const READ_ANCHOR_WINDOW_PADDING = 50

/**
 * Ceiling on how far back we'll widen the initial chat window to reach an
 * anchor. Beyond this the transcript payload gets unreasonable and we fall
 * back to the latest user message instead.
 */
export const MAX_READ_ANCHOR_RECENT_LIMIT = 2000

export interface ChatReadAnchorState {
  /**
   * False until `chat.getReadAnchor` settles for the current chat. Consumers
   * must wait for this before restoring scroll, otherwise they'd land on the
   * fallback and then visibly jump when the anchor arrives.
   */
  resolved: boolean
  anchor: ResolvedChatReadAnchor | null
}

const UNRESOLVED: ChatReadAnchorState = { resolved: false, anchor: null }
const RESOLVED_EMPTY: ChatReadAnchorState = { resolved: true, anchor: null }

export interface ChatReadAnchorSync {
  anchorState: ChatReadAnchorState
  /** `recentLimit` the chat subscription should use to include the anchor. */
  recentLimit: number
  /**
   * Report the message currently at the top of the viewport. Safe to call on
   * every scroll event — writes are throttled and deduped.
   */
  reportReadAnchor: (messageId: string, atEnd: boolean) => void
}

/**
 * Tracks a chat's server-side read position.
 *
 * Reads happen once per chat open; there is deliberately no live push, so a
 * device sitting on an open chat never gets its viewport moved because another
 * device scrolled. Writes are throttled and ack-only — the anchor is not part
 * of any snapshot, so scrolling causes no broadcast fan-out.
 */
export function useChatReadAnchor(socket: KannaSocket, activeChatId: string | null): ChatReadAnchorSync {
  const [state, setState] = useState<{ chatId: string | null; value: ChatReadAnchorState; limit: number }>({
    chatId: null,
    value: RESOLVED_EMPTY,
    limit: INITIAL_CHAT_RECENT_LIMIT,
  })

  // Derived rather than stored so a chat switch resets synchronously — a stale
  // limit would otherwise drive one wasted subscription at the old window.
  const anchorState = state.chatId === activeChatId ? state.value : UNRESOLVED
  const recentLimit = state.chatId === activeChatId ? state.limit : INITIAL_CHAT_RECENT_LIMIT

  useEffect(() => {
    if (!activeChatId) {
      setState({ chatId: null, value: RESOLVED_EMPTY, limit: INITIAL_CHAT_RECENT_LIMIT })
      return
    }

    let cancelled = false
    void socket.command<ResolvedChatReadAnchor | null>({ type: "chat.getReadAnchor", chatId: activeChatId })
      .then((anchor) => {
        if (cancelled) return
        // Only widen for a message anchor — `atEnd` restores to the bottom,
        // which the default window always covers.
        const needsWiderWindow = Boolean(anchor)
          && !anchor?.atEnd
          && (anchor?.distanceFromEnd ?? 0) > INITIAL_CHAT_RECENT_LIMIT
        const limit = needsWiderWindow
          ? Math.min((anchor?.distanceFromEnd ?? 0) + READ_ANCHOR_WINDOW_PADDING, MAX_READ_ANCHOR_RECENT_LIMIT)
          : INITIAL_CHAT_RECENT_LIMIT
        setState({ chatId: activeChatId, value: { resolved: true, anchor: anchor ?? null }, limit })
      })
      .catch(() => {
        // A missing anchor is not an error worth surfacing — fall back.
        if (cancelled) return
        setState({ chatId: activeChatId, value: RESOLVED_EMPTY, limit: INITIAL_CHAT_RECENT_LIMIT })
      })

    return () => {
      cancelled = true
    }
  }, [activeChatId, socket])

  const pendingRef = useRef<{ chatId: string; messageId: string; atEnd: boolean } | null>(null)
  const timerRef = useRef<number | null>(null)
  const lastWriteAtRef = useRef(0)
  const lastWrittenKeyRef = useRef<string | null>(null)

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return

    // While parked at the bottom the top-visible message churns with every
    // streamed chunk, but restore only needs to know "was at the end" — so all
    // of those collapse to a single write instead of one every interval.
    const key = pending.atEnd ? `${pending.chatId}:atEnd` : `${pending.chatId}:${pending.messageId}`
    if (key === lastWrittenKeyRef.current) return
    lastWrittenKeyRef.current = key
    lastWriteAtRef.current = Date.now()

    void socket.command({
      type: "chat.setReadAnchor",
      chatId: pending.chatId,
      messageId: pending.messageId,
      atEnd: pending.atEnd,
    }).catch(() => {
      // Every pending command rejects with "Disconnected" on socket close even
      // though the envelope may still be delivered. Never surface this.
    })
  }, [socket])

  const reportReadAnchor = useCallback((messageId: string, atEnd: boolean) => {
    if (!activeChatId) return
    pendingRef.current = { chatId: activeChatId, messageId, atEnd }
    // Already scheduled — the newer position just replaces the pending one.
    if (timerRef.current !== null) return
    const delay = Math.max(0, READ_ANCHOR_WRITE_INTERVAL_MS - (Date.now() - lastWriteAtRef.current))
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      flush()
    }, delay)
  }, [activeChatId, flush])

  // Drop anything still queued for the outgoing chat, and reset the dedupe key
  // so the new chat's first sample always writes.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      pendingRef.current = null
      lastWrittenKeyRef.current = null
    }
  }, [activeChatId])

  // Backgrounding a tab is the common way a session ends. `visibilitychange`
  // fires reliably here, unlike pagehide/beforeunload where the socket may
  // already be closing and the envelope would sit in an undrained queue.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") flush()
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange)
  }, [flush])

  return useMemo(
    () => ({ anchorState, recentLimit, reportReadAnchor }),
    [anchorState, recentLimit, reportReadAnchor]
  )
}
