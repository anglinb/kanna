import { Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { KannaSocketService } from "../core/socket"
import { Message } from "./message"
import type { Model } from "./model"
import { PORTS_POLL_INTERVAL_MS } from "./ports"

// What the column polls while it is on screen, and its clock.

const visible = () => typeof document === "undefined" || document.visibilityState === "visible"

export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  /**
   * PortsWidget's poll: every 7s while the column is open and the tab
   * visible. (The read at once when it opens is the update's, on the page
   * observed open: it went out before the page's own effects.)
   */
  widgetsPorts: entry({ active: Schema.Boolean, projectId: Schema.NullOr(Schema.String) }, {
    modelToDependencies: (model) => ({ active: model.watch?.active ?? false, projectId: model.watch?.projectId ?? null }),
    dependenciesToStream: ({ active, projectId }) =>
      Stream.when(
        Stream.tick(`${PORTS_POLL_INTERVAL_MS} millis`).pipe(
          Stream.drop(1),
          Stream.filter(visible),
          Stream.map(() => Message.TickedPorts()),
        ),
        Effect.sync(() => active && projectId !== null),
      ),
  }),

  /** useNow (1s, while a task runs) and useMinuteClock (20s, while a schedule counts down). */
  widgetsClock: entry({ clockMs: Schema.NullOr(Schema.Number) }, {
    modelToDependencies: (model) => ({ clockMs: model.watch?.clockMs ?? null }),
    dependenciesToStream: ({ clockMs }) =>
      Stream.when(
        Stream.tick(`${clockMs ?? 1_000} millis`).pipe(
          Stream.drop(1),
          Stream.map(() => Message.TickedClock({ now: Date.now() })),
        ),
        Effect.sync(() => clockMs !== null),
      ),
  }),
}))
