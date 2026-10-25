import { Effect, Stream } from "effect"
import type { KannaSocket } from "../../client/app/socket"
import { KannaSocketResource, type KannaSocketService } from "../core/socket"

// A terminal pane is a Mount (its xterm lives on the pane's element), and it
// talks to the server as TerminalPane did: terminal.create once the pane has
// a size, terminal.input per keystroke, terminal.resize as it moves, a
// terminal.tail when it is shown again, and the terminal topic's snapshots
// and output in between. A Mount's Stream can't require the socket service,
// so the slice's Subscription (which can) lends the socket to the panes
// while it runs: `socketBridge` below, lifted by whoever embeds the slice.
// Two embeddings (the /terminal page and the chat page) both lend it; the
// socket is the app's one socket either way.

const lenders = new Map<KannaSocket, number>()
const waiting = new Set<(socket: KannaSocket) => void>()

function current(): KannaSocket | null {
  const first = lenders.keys().next()
  return first.done ? null : first.value
}

function lend(socket: KannaSocket) {
  lenders.set(socket, (lenders.get(socket) ?? 0) + 1)
  for (const listener of [...waiting]) listener(socket)
}

function giveBack(socket: KannaSocket) {
  const count = (lenders.get(socket) ?? 1) - 1
  if (count > 0) lenders.set(socket, count)
  else lenders.delete(socket)
}

/** For the slice's subscriptions: lends the socket to the panes while it runs. Emits nothing. */
export const socketBridge: Stream.Stream<never, never, KannaSocketService> = Stream.callback<never, never, KannaSocketService>(() =>
  Effect.gen(function* () {
    const socket = yield* KannaSocketResource.get.pipe(Effect.orDie)
    yield* Effect.acquireRelease(Effect.sync(() => lend(socket)), () => Effect.sync(() => giveBack(socket)))
  }),
)

/**
 * Calls `use` with the socket now, or as soon as it is lent. Returns a
 * cancel for the wait.
 */
export function withSocket(use: (socket: KannaSocket) => void): () => void {
  const socket = current()
  if (socket) {
    use(socket)
    return () => {}
  }
  const listener = (lent: KannaSocket) => {
    waiting.delete(listener)
    use(lent)
  }
  waiting.add(listener)
  return () => {
    waiting.delete(listener)
  }
}

/** The socket, if one is lent. */
export function lentSocket(): KannaSocket | null {
  return current()
}
