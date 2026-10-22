import { Effect, Exit, Scope, Stream } from "effect"
import { runKanna } from "./effect/bridge"
import type { HarnessTurn, HarnessTurnEffect } from "./harness-types"

/**
 * The Promise-shaped `HarnessTurn` the agent still consumes, over a
 * provider turn already on Effect. `startTurn` runs in a scope this owns;
 * `close()` closes it, which stops the provider and ends the stream.
 *
 * Temporary: it goes when agent.ts reads `HarnessTurnEffect` directly
 * (wave 4 of docs/effect-migration.md).
 */
export async function toHarnessTurn<E, SE>(
  startTurn: Effect.Effect<HarnessTurnEffect<E>, SE, Scope.Scope>,
): Promise<HarnessTurn> {
  const scope = await runKanna(Scope.make())
  const turn = await runKanna(Scope.provide(startTurn, scope)).catch(async (error: unknown) => {
    await runKanna(Scope.close(scope, Exit.void))
    throw error
  })
  let closed = false
  return {
    provider: turn.provider,
    stream: Stream.toAsyncIterable(turn.events),
    ...(turn.accountInfo ? { getAccountInfo: () => runKanna(turn.accountInfo!) } : {}),
    interrupt: () => runKanna(turn.interrupt),
    close: () => {
      if (closed) return
      closed = true
      void runKanna(Scope.close(scope, Exit.void))
    },
  }
}
