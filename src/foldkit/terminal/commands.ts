import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import * as TerminalLayout from "../core/stores/terminalLayout"
import { sendCommand } from "../core/socket"
import { Message } from "./message"
import { disposeCachedTerminal } from "./pane"

/** `addTerminal`'s id: made here, then added to the layout under it. */
export function makeTerminalId(args: { layoutKey: string; afterTerminalId: string | null; nextTerminalIndex: number }) {
  return Command.mapMessage(
    TerminalLayout.AddTerminal({ projectId: args.layoutKey, afterTerminalId: args.afterTerminalId, chatKey: null, nextTerminalIndex: args.nextTerminalIndex }),
    (added) => Message.MadeTerminalId({ layoutKey: added.projectId, terminalId: added.terminalId, afterTerminalId: added.afterTerminalId }),
  )
}

/**
 * `terminal.close` for a removed split, which nothing can reach again; or
 * for Clear, which the pane sends itself. Errors are dropped, as React's
 * `.catch(() => {})`.
 */
export const CloseTerminal = Command.define("CloseTerminal", {
  args: { terminalId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ terminalId }) =>
    sendCommand({ type: "terminal.close", terminalId }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedSideEffect()),
    ),
})

/**
 * The chat page's `disposeCachedTerminal` for a removed split. React ran it
 * once a dynamic import resolved, after the pane had unmounted and parked
 * its xterm; this waits for the frame that unmounts it.
 */
export const DisposeCachedTerminal = Command.define("DisposeCachedTerminal", {
  args: { terminalId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ terminalId }) =>
    Effect.promise(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0))
    })).pipe(
      Effect.andThen(Effect.sync(() => disposeCachedTerminal(terminalId))),
      Effect.as(Message.CompletedSideEffect()),
    ),
})
