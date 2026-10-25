// src/foldkit/ui/input.ts against the React <Input> (gallery/ui-input.tsx).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { input } from "../../../foldkit/ui/input"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ name: Schema.String })
type Model = typeof Model.Type
const Message = defineMessageUnion({ ChangedName: { value: Schema.String } })
type Message = typeof Message.Type

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { name: "kanna" } }),
  update: (_model, message) => Message.match(message, { ChangedName: ({ value }) => ({ model: { name: value } }) }),
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex w-96 flex-col gap-3 bg-background p-4 text-foreground")], [
      input({ type: "text", value: model.name, onInput: (value) => Message.ChangedName({ value }), attributes: [h.AriaLabel("Name")] }, h),
      h.p([], ["Hello, ", model.name]),
      input({ type: "text", placeholder: "Search projects", attributes: [h.AriaLabel("Search")] }, h),
      input({ type: "text", value: "read only", disabled: true, attributes: [h.AriaLabel("Disabled"), h.Readonly(true)] }, h),
      input({ type: "password", class: "font-mono", value: "secret", attributes: [h.AriaLabel("Token"), h.Readonly(true)] }, h),
    ]),
  }),
})
