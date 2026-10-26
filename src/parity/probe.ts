import type { ClientCommand } from "../shared/protocol"

/** What a parity app exposes as `window.__parity` for the runner to read. */
export interface ParityProbe {
  /** Every ClientCommand the app sent, in order. */
  commands(): ClientCommand[]
  /** Every topic the app subscribed to, in order. */
  subscriptions(): unknown[]
  /** Commands the demo backend has no handler for. Any one fails the run. */
  unhandled(): ClientCommand[]
  /** Milliseconds since the last socket frame in either direction. */
  quietFor(): number
  /** Moves the backend's scripted turns forward. */
  advance(ms: number): void
  pendingTimers(): number
}
