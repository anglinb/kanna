import { Schema } from "effect"
import { Runtime, Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"

// The Foldkit client. Empty until the first slices land: every parity
// scenario is expected to fail against it. See docs/foldkit-migration.md.

// MODEL

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  NoOp: {},
})
export type Message = typeof Message.Type

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    NoOp: () => ({ model }),
  })

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({ model: {} })

// VIEW

export const view = (_model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Kanna",
  body: h.div([h.Class("h-dvh bg-background")], []),
})
