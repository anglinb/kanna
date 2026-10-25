import { Option } from "effect"
import { Dom, Subscription } from "foldkit"
import type { KannaSocketService } from "../core/socket"
import * as Composer from "../composer"
import * as Terminal from "../terminal"
import * as Transcript from "../transcript"
import * as Viewer from "../viewer"
import * as Widgets from "../widgets"
import { Message } from "./message"
import type { Model } from "./model"

// The window's width, for the phone layout. What ChatPage listened to while
// a condition held (its shortcuts, the sheet's Escape, the diff refresh) are
// Mounts on the page (effects.ts): they live exactly as long as the page.

const pageSubscriptions = Subscription.make<Model, Message, KannaSocketService>()(() => ({
  /** useIsMobileViewport. */
  windowWidth: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: () => window,
      type: "resize",
      mapEvent: () => Message.ResizedWindow({ width: window.innerWidth }),
    }),
  ),

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

