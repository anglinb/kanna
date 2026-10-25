import { Schema } from "effect"
import { Submodel, Subscription } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { AppModel, SliceReturn, SliceViewInputs } from "../app/slice"
import type { KannaSocketService } from "../core/socket"

// The chat page's right sidebar (ChatPage/WidgetsColumn, components/chat-ui/widgets/*, git/*). Embedded by chat/.
// Stub until the slice is ported: see app/slice.ts for the contract.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  NotYetPorted: {},
})
export type Message = typeof Message.Type

export function init(): Model {
  return {}
}

export function update(model: Model, _message: Message, _app: AppModel): SliceReturn<Model, Message> {
  return { model }
}

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((_model, _inputs, _h) => null)

export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()(() => ({}))
