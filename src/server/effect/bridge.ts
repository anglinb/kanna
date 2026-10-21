import { Effect, Fiber, Stream } from "effect"
import { KannaLoggerLayer } from "./logger"

/**
 * Where Promise code still calls an Effect service, during the migration.
 *
 * A migrated service's methods have no requirements left (its layer resolved
 * them), so a caller that has not moved to Effect yet runs them here. Each
 * call site is a seam to remove when its caller migrates; once
 * `startKannaServer` and the router are Effect programs nothing should import
 * this file. See docs/effect-migration.md.
 */
export const runKanna = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KannaLoggerLayer)))

export const runKannaSync = <A, E>(effect: Effect.Effect<A, E>): A =>
  Effect.runSync(effect.pipe(Effect.provide(KannaLoggerLayer)))

/**
 * Calls `listener` for each element of `stream` until the returned function
 * is called: the bridge for a callback-style `onChange(listener)` API.
 */
export const subscribeKanna = <A, E>(stream: Stream.Stream<A, E>, listener: (value: A) => void): (() => void) => {
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (value) => Effect.sync(() => listener(value))).pipe(Effect.provide(KannaLoggerLayer)),
  )
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}
