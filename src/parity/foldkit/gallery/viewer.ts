// src/foldkit/viewer against the React ViewerLayer (gallery/viewer.tsx), as a
// page without a chat shows it, opened on the item `?item=` names
// (react/gallery/support/viewer-items.ts). The page holds the stores the
// viewer reads and applies the store changes it asks for, as the root
// would; anything else it asks for goes nowhere.
import { Option, Schema } from "effect"
import { Command, Subscription } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { AppAction } from "../../../foldkit/app/action"
import type { AppModel } from "../../../foldkit/app/slice"
import * as Stores from "../../../foldkit/app/stores"
import * as ViewerStore from "../../../foldkit/core/stores/viewer"
import * as Viewer from "../../../foldkit/viewer"
import { VIEWER_GALLERY_CHAT_ID, viewerGalleryItem } from "../../react/gallery/support/viewer-items"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ viewer: Viewer.Model, stores: Stores.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotViewerMessage: { message: Viewer.Message },
  GotStoresMessage: { message: Stores.Message },
})
type Message = typeof Message.Type

type AnyCommand = Command.Command<Message>

const app = (model: Model) => ({ stores: model.stores }) as AppModel

function viewerStore(stores: Stores.Model, message: ViewerStore.Message): Stores.Model {
  return Stores.update(stores, Stores.Message.GotViewerMessage({ message })).model
}

function initialStores(): Stores.Model {
  const stores = Stores.load()
  const onChat = viewerStore(stores, ViewerStore.Message.ChangedChat({ chatId: VIEWER_GALLERY_CHAT_ID }))
  return viewerStore(onChat, ViewerStore.Message.OpenedItem({ item: viewerGalleryItem(window.location.search) as ViewerStore.ViewerItem, expanded: false, byKey: false }))
}

/** What the root does with a store change; the rest goes nowhere here. */
function applyAction(stores: Stores.Model, action: AppAction): { stores: Stores.Model; commands: AnyCommand[] } {
  if (action._tag === "Batch") {
    return (action.actions as AppAction[]).reduce<{ stores: Stores.Model; commands: AnyCommand[] }>((acc, next) => {
      const applied = applyAction(acc.stores, next)
      return { stores: applied.stores, commands: [...acc.commands, ...applied.commands] }
    }, { stores, commands: [] })
  }
  if (action._tag !== "Store") return { stores, commands: [] }
  const result = Stores.update(stores, action.message)
  return {
    stores: result.model,
    commands: Command.mapMessages(result.commands ?? [], (message: Stores.Message) => Message.GotStoresMessage({ message })) as AnyCommand[],
  }
}

function update(model: Model, message: Message): { model: Model; commands?: ReadonlyArray<AnyCommand> } {
  if (message._tag === "GotStoresMessage") {
    const result = Stores.update(model.stores, message.message)
    return {
      model: { ...model, stores: result.model },
      commands: Command.mapMessages(result.commands ?? [], (inner: Stores.Message) => Message.GotStoresMessage({ message: inner })) as AnyCommand[],
    }
  }
  const result = Viewer.update(model.viewer, message.message, app(model))
  const commands = Command.mapMessages((result.commands ?? []) as never, (inner: Viewer.Message) => Message.GotViewerMessage({ message: inner })) as AnyCommand[]
  const applied = result.outMessage ? applyAction(model.stores, result.outMessage.action) : { stores: model.stores, commands: [] }
  return { model: { viewer: result.model, stores: applied.stores }, commands: [...commands, ...applied.commands] }
}

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { viewer: Viewer.init(), stores: initialStores() } }),
  update,
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("relative h-full bg-background")], [
      h.submodel({
        slotId: "viewer",
        model: model.viewer,
        view: Viewer.view,
        viewInputs: { app: app(model), className: "fixed" },
        toParentMessage: (message: Viewer.Message) => Message.GotViewerMessage({ message }),
      }),
    ]),
  }),
  subscriptions: Subscription.lift(Viewer.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.viewer),
    toParentMessage: (message: Viewer.Message) => Message.GotViewerMessage({ message }),
  }) as never,
})
