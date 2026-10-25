import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { KannaSocketService } from "../core/socket"
import { AppAction } from "./action"
import type { Model as AppModel } from "./model"

// The contract every slice (sidebar/, home/, settings/, chat/, …) follows,
// so the root wires each one the same way and a slice's agent never edits
// app/:
//
//   export const Model                       the slice's own state (Schema)
//   export const Message                     its Messages
//   export function init(): Model
//   export function update(model, message, app: AppModel): SliceReturn<Model, Message>
//   export const view = Submodel.defineView<Model, Message, SliceViewInputs>(
//     (model, { app }, h) => …)
//   export const subscriptions (optional)    Subscription.make<Model, Message, KannaSocketService>
//   export function observe(model, previousApp, app) (optional)
//       Runs after any root update that changed the root Model. For a
//       slice that must act on a change it didn't cause (an effect on
//       `[snapshot]` in React): return { model } when nothing changes.
//
// `app` is the root Model, read-only: stores, the page's chat session,
// snapshots, settings. A slice changes anything outside its own Model by
// emitting `SliceOutMessage.RequestedAppAction({ action })`.

export type { AppModel }

export const SliceOutMessage = defineMessageUnion({
  RequestedAppAction: { action: AppAction },
})
export type SliceOutMessage = typeof SliceOutMessage.Type

export type SliceReturn<Model, Message> = Update.ReturnWithOutMessage<Model, Message, SliceOutMessage, KannaSocketService>

export interface SliceViewInputs {
  app: AppModel
}

/** Shorthand for a slice's update that asks the root for one thing. */
export function requestAction<Model>(model: Model, action: AppAction) {
  return { model, outMessage: SliceOutMessage.RequestedAppAction({ action }) }
}

/** A slice's optional `observe` (see the contract above). */
export type SliceObserve<Model, Message> = (model: Model, previousApp: AppModel, app: AppModel) => SliceReturn<Model, Message>
