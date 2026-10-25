import { Effect, Queue, Stream } from "effect"

/**
 * The shape every overlay Mount has: imperative DOM setup that reports
 * Messages as things happen (Escape, a click outside, a scroll) and undoes
 * itself when the element leaves the DOM. `setup` runs once at mount and
 * returns its cleanup.
 */
export function domStream<Message>(setup: (emit: (message: Message) => void) => () => void): Stream.Stream<Message> {
  return Stream.callback<Message>((queue) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => setup((message) => {
          Queue.offerUnsafe(queue, message)
        })),
        (cleanup) => Effect.sync(cleanup),
      )
      return yield* Effect.never
    }),
  )
}
