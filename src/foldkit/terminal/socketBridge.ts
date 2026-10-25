import { Effect } from "effect"
import { Command } from "foldkit"
import type { KannaSocket } from "../../client/app/socket"
import { KannaSocketResource } from "../core/socket"
import { Message } from "./message"

// A terminal pane is a Mount (its xterm lives on the pane's element), and it
// talks to the server as TerminalPane did: terminal.create once the pane has
// a size, terminal.input per keystroke, terminal.resize as it moves, a
// terminal.tail when it is shown again, and the terminal topic's snapshots
// and output in between. A Mount's Stream can't require the socket service,
// so a Command (which can) hands the app's socket over: a pane that mounts
// before one is here says so (`NeededSocket`), update runs `LendSocket`, and
// the pane's session starts as soon as it lands (`withSocket`).
//
// Not a Subscription: the root and the chat page both lift this slice's
// subscriptions, and two lifts of one keyed entry collide.

let lent: KannaSocket | null = null
const waiting = new Set<(socket: KannaSocket) => void>()

function lend(socket: KannaSocket) {
  if (lent === socket) return
  lent = socket
  for (const listener of [...waiting]) listener(socket)
}

/** Hands the app's socket to the panes. Without a socket (not acquired yet), a later pane asks again. */
export const LendSocket = Command.define("LendTerminalSocket", {
  messages: [Message.CompletedSideEffect],
  execute: KannaSocketResource.get.pipe(
    Effect.tap((socket) => Effect.sync(() => lend(socket))),
    Effect.ignore,
    Effect.as(Message.CompletedSideEffect()),
  ),
})

/**
 * Calls `use` with the socket now, or as soon as it is lent. Returns a
 * cancel for the wait.
 */
export function withSocket(use: (socket: KannaSocket) => void): () => void {
  if (lent) {
    use(lent)
    return () => {}
  }
  const listener = (socket: KannaSocket) => {
    waiting.delete(listener)
    use(socket)
  }
  waiting.add(listener)
  return () => {
    waiting.delete(listener)
  }
}

/** The socket, if one is lent. */
export function lentSocket(): KannaSocket | null {
  return lent
}
