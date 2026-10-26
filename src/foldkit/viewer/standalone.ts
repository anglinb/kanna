import { Option, Schema } from "effect"
import { Command, Submodel, Subscription } from "foldkit"
import type { Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { AppAction } from "../app/action"
import type { AppModel } from "../app/slice"
import * as Stores from "../app/stores"
import * as ViewerStore from "../core/stores/viewer"
import { Message as ViewerMessage } from "./message"
import { init as initViewer, Model as ViewerModel } from "./model"
import { update as updateViewer } from "./update"
import { view as viewerView } from "./view"
import { subscriptions as viewerSubscriptions } from "./index"

/**
 * The viewer on a page with no root to hold its stores: the export viewer
 * (React's `<ViewerLayer className="fixed" />` over the transcript) and the
 * viewer's parity gallery. It keeps the stores the viewer reads and applies
 * the store changes the viewer, or the transcript's rows, ask for (an
 * attachment, a chart or a visualization opening); anything else asked of
 * a root goes nowhere, as there is none.
 *
 * Wiring, for a host program:
 *   Model:    viewer: Standalone.Model               init: Standalone.init(chatKey)
 *   Message:  GotViewerMessage: { message: Standalone.Message }
 *   update:   GotViewerMessage → Standalone.update(model.viewer, message)
 *             a row's RequestedAppAction → Standalone.apply(model.viewer, action)
 *   view:     Standalone.view(model.viewer, h-less: h.submodel({ slotId, model, view: Standalone.view, viewInputs: {}, toParentMessage }))
 *   subscriptions: Subscription.lift(Standalone.subscriptions)
 */

export const Model = Schema.Struct({ viewer: ViewerModel, stores: Stores.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotLayerMessage: { message: ViewerMessage },
  GotStoresMessage: { message: Stores.Message },
})
export type Message = typeof Message.Type

type Return = { model: Model; commands: ReadonlyArray<Command.Command<Message>> }

const appOf = (model: Model) => ({ stores: model.stores }) as AppModel

/** The stores as they load, on the page's chat key (the export's chat id). */
export function init(chatKey: string | null, stores: Stores.Model = Stores.load()): Model {
  const onChat = Stores.update(stores, Stores.Message.GotViewerMessage({ message: ViewerStore.Message.ChangedChat({ chatId: chatKey }) })).model
  return { viewer: initViewer(), stores: onChat }
}

/** What the root does with a store change; the rest goes nowhere here. */
export function apply(model: Model, action: AppAction): Return {
  if (action._tag === "Batch") {
    return (action.actions as AppAction[]).reduce<Return>((acc, next) => {
      const applied = apply(acc.model, next)
      return { model: applied.model, commands: [...acc.commands, ...applied.commands] }
    }, { model, commands: [] })
  }
  if (action._tag !== "Store") return { model, commands: [] }
  const result = Stores.update(model.stores, action.message)
  return {
    model: { ...model, stores: result.model },
    commands: Command.mapMessages(result.commands ?? [], (message: Stores.Message) => Message.GotStoresMessage({ message })) as ReadonlyArray<Command.Command<Message>>,
  }
}

/** Opens an item, as `openViewer(item)` did. */
export function open(model: Model, item: ViewerStore.ViewerItem, expanded = false): Model {
  const message = Stores.Message.GotViewerMessage({ message: ViewerStore.Message.OpenedItem({ item, expanded, byKey: false }) })
  return { ...model, stores: Stores.update(model.stores, message).model }
}

export function update(model: Model, message: Message): Return {
  if (message._tag === "GotStoresMessage") {
    const result = Stores.update(model.stores, message.message)
    return {
      model: { ...model, stores: result.model },
      commands: Command.mapMessages(result.commands ?? [], (inner: Stores.Message) => Message.GotStoresMessage({ message: inner })) as ReadonlyArray<Command.Command<Message>>,
    }
  }
  const result = updateViewer(model.viewer, message.message, appOf(model))
  const commands = Command.mapMessages((result.commands ?? []) as never, (inner: ViewerMessage) => Message.GotLayerMessage({ message: inner })) as ReadonlyArray<Command.Command<Message>>
  const next = { ...model, viewer: result.model }
  if (!result.outMessage) return { model: next, commands }
  const applied = apply(next, result.outMessage.action)
  return { model: applied.model, commands: [...commands, ...applied.commands] }
}

/** The layer, fixed over the page (React's `className="fixed"`). */
export const view = Submodel.defineView<Model, Message, Record<string, never>>((model, _inputs, h): Html => h.submodel({
  slotId: "viewer-layer",
  model: model.viewer,
  view: viewerView,
  viewInputs: { app: appOf(model), className: "fixed" },
  toParentMessage: (message: ViewerMessage) => Message.GotLayerMessage({ message }),
}))

export const subscriptions = Subscription.lift(viewerSubscriptions)<Model, Message>({
  read: (model) => Option.some(model.viewer),
  toParentMessage: (message: ViewerMessage) => Message.GotLayerMessage({ message }),
})
