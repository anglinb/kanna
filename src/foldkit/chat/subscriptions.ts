import { Effect, Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { UsageLimitsSnapshot } from "../../shared/types"
import { topicStream, type KannaSocketService } from "../core/socket"
import * as Composer from "../composer"
import * as Terminal from "../terminal"
import * as Transcript from "../transcript"
import * as Viewer from "../viewer"
import * as Widgets from "../widgets"
import { PAGE_LEFT_EVENT } from "./effects"
import { Message } from "./message"
import type { Model } from "./model"

// The window's width, for the phone layout, and what the page holds open
// while it is on screen (`presence`): the usage-limits topic the widget
// column shows. What ChatPage listened to while a condition held (its
// shortcuts, the sheet's Escape, the diff refresh) are Mounts on the page
// (effects.ts): they live exactly as long as the page.

/** How often an open usage view re-checks (UsageSection's USAGE_POLL_MS); the server's TTL coalesces the reads. */
const USAGE_POLL_MS = 60_000

/**
 * UsageWidgets mounts with the widget column, which is there whenever the
 * page has a project (open or not, and on a phone as a closed sheet); a
 * phone's new chat page also shows the cards (EmptyStateUsageCards).
 */
function usageShown(model: Model) {
  const watch = model.watch
  if (model.presence === null || !watch) return false
  return watch.projectId !== null || (watch.isMobile && watch.showEmptyState)
}

const pageSubscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  /** useIsMobileViewport. */
  windowWidth: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: () => window,
      type: "resize",
      mapEvent: () => Message.ResizedWindow({ width: window.innerWidth }),
    }),
  ),

  /** The page's view going (effects.ts `HoldPagePresence`). */
  pageLeft: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: () => window as EventTarget,
      type: PAGE_LEFT_EVENT,
      mapEvent: (event) => Message.LeftPage({ token: Number((event as CustomEvent<{ token: number }>).detail?.token ?? -1) }),
    }),
  ),

  /** useUsageLimits' live subscription: the cached snapshot at once, then each push. */
  usageLimits: entry({ shown: Schema.Boolean }, {
    modelToDependencies: (model) => ({ shown: usageShown(model) }),
    dependenciesToStream: ({ shown }) =>
      Stream.when(
        topicStream<UsageLimitsSnapshot>({ type: "usage-limits" }).pipe(Stream.map((snapshot) => Message.ReceivedUsageLimits({ snapshot }))),
        Effect.sync(() => shown),
      ),
  }),

  /** While the column is open (UsageWidgets' `active`): a refresh at once, then every minute the tab is visible. */
  usageRefresh: entry({ active: Schema.Boolean }, {
    modelToDependencies: (model) => ({ active: usageShown(model) && model.watch?.projectId !== null && Boolean(model.watch?.showRightSidebar) }),
    dependenciesToStream: ({ active }) =>
      Stream.when(
        Stream.concat(
          Stream.make(Message.TickedUsageRefresh()),
          Stream.tick(`${USAGE_POLL_MS} millis`).pipe(
            Stream.drop(1),
            Stream.filter(() => typeof document === "undefined" || document.visibilityState === "visible"),
            Stream.map(() => Message.TickedUsageRefresh()),
          ),
        ),
        Effect.sync(() => active),
      ),
  }),
}))

// The sub-slices' subscriptions, lifted.
const lift = <Sub extends Parameters<typeof Subscription.lift>[0]>(subscriptions: Sub, key: keyof Model, wrap: (message: never) => Message) =>
  Subscription.lift(subscriptions)<Model, Message>({
    read: (model) => Option.some(model[key] as never),
    toParentMessage: wrap as never,
  })

export const subscriptions = Subscription.aggregate(
  pageSubscriptions,
  lift(Transcript.subscriptions, "transcript", (message: Transcript.Message) => Message.GotTranscriptMessage({ message })),
  lift(Composer.subscriptions, "composer", (message: Composer.Message) => Message.GotComposerMessage({ message })),
  lift(Widgets.subscriptions, "widgets", (message: Widgets.Message) => Message.GotWidgetsMessage({ message })),
  lift(Viewer.subscriptions, "viewer", (message: Viewer.Message) => Message.GotViewerMessage({ message })),
  lift(Terminal.subscriptions, "terminal", (message: Terminal.Message) => Message.GotTerminalMessage({ message })),
)
