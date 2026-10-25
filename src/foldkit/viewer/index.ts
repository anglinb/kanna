import { Option } from "effect"
import { Dom, Subscription } from "foldkit"
import * as Composer from "../composer"
import * as ChatSession from "../core/chatSession"
import type { KannaSocketService } from "../core/socket"
import { Message } from "./message"
import { init, Model } from "./model"

// The viewer layer: the one surface a changed file's diff, an attachment, a
// project file, a chart or a visualization at full size, another chat, and a
// delegator's list open in (components/viewer/*, chat-ui/git/DiffViewer,
// ChatPage/ChatPreview and DelegatedList, messages' ChartFullView and
// VisualizationFullView). Embedded by chat/ with `{ app, page, requests }`.
// What is open is the stores' (`app.stores.viewer`, the right sidebar's
// `chatViewers`); changes to it go to the root as `AppAction.Store`.
//
//   model.ts / message.ts   the Model and Messages
//   update.ts               what they do
//   view.ts                 ViewerLayer: which card, where, and its motion
//   surface.ts              ViewerSurface: the card's chrome and keys
//   attachment.ts           AttachmentViewer (and the sortable table)
//   file.ts                 FileViewer
//   diff.ts / diffs.ts      DiffViewer, and @pierre/diffs in Mounts
//   fullViews.ts            ChartFullView, VisualizationFullView, Download image
//   markup.ts               VisualizationMarkup
//   preview.ts              ChatPreview: a second chat session, live
//   delegated.ts            DelegatedList
//   openFileSelect.ts       OpenFileSelect ("Open in…" for one file)

export { Message, Model, init }
export { update } from "./update"
export { view, type ViewInputs } from "./view"

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/**
 * A lifted record under keys of its own: the page aggregates the root's
 * session and its own composer under the same names, and an aggregate
 * takes each key once.
 */
function prefixed<Record extends object>(prefix: string, record: Record): Record {
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [`${prefix}${key[0]!.toUpperCase()}${key.slice(1)}`, entry])) as Record
}

export const subscriptions = Subscription.aggregate(
  Subscription.make<Model, Message, KannaSocketService>()(() => ({
    /** prefersReducedMotion(): a close then drops the card at once. */
    viewerReducedMotion: Subscription.persistentEntry(
      Dom.streamFromMediaQuery({ query: REDUCED_MOTION_QUERY, mapMatches: (reduced) => Message.ChangedReducedMotion({ reduced }) }),
    ),
  })),
  // The previewed chat's session and its composer.
  prefixed("viewerPreview", Subscription.lift(ChatSession.subscriptions)<Model, Message>({
    read: (model) => Option.fromNullishOr(model.preview?.session),
    toParentMessage: (message: ChatSession.Message) => Message.GotPreviewSessionMessage({ chatId: null, message }),
  })),
  prefixed("viewerPreview", Subscription.lift(Composer.subscriptions)<Model, Message>({
    read: (model) => Option.fromNullishOr(model.preview?.composer),
    toParentMessage: (message: Composer.Message) => Message.GotPreviewComposerMessage({ chatId: null, message }),
  })),
)
