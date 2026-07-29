import { useCallback, useEffect, useState } from "react"
import {
  fetchPairSession,
  startPairSession,
  type PairSessionState,
} from "../../lib/pairSession"

/** While a claim is outstanding, mirror the machine's own poll cadence. */
const PAIR_POLL_MS = 2_000

export interface CloudPairSession {
  session: PairSessionState
  /** False until the first status fetch lands — "idle" is ambiguous before it. */
  loaded: boolean
  /** A start request is in flight (used to disable the retry button). */
  starting: boolean
  /** Mint a claim URL, or adopt the live session if one is already open. */
  begin: () => void
}

/**
 * Owns one machine's device-code pairing state for the UI.
 *
 * The machine does the polling; this only asks "what's the state" — so the
 * claim still completes if the user finishes on their phone, and the sidebar
 * flips to the hosted URL even with the dialog closed. Polling runs whenever
 * a claim is outstanding, not just while some dialog is mounted.
 */
export function useCloudPairSession({ enabled = true }: { enabled?: boolean } = {}): CloudPairSession {
  const [session, setSession] = useState<PairSessionState>({ status: "idle" })
  const [loaded, setLoaded] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void fetchPairSession().then((next) => {
      if (cancelled) return
      setSession(next)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])

  const begin = useCallback(() => {
    setStarting(true)
    void startPairSession().then((next) => {
      setSession(next)
      setLoaded(true)
      setStarting(false)
    })
  }, [])

  useEffect(() => {
    if (!enabled || session.status !== "waiting") return
    const interval = window.setInterval(() => {
      void fetchPairSession().then(setSession)
    }, PAIR_POLL_MS)
    return () => window.clearInterval(interval)
  }, [enabled, session.status])

  return { session, loaded, starting, begin }
}
