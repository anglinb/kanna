// src/foldkit/ui/textarea.ts against the React <Textarea> (gallery/ui-textarea.tsx).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { textarea } from "../../../foldkit/ui/textarea"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ message: Schema.String })
type Model = typeof Model.Type
const Message = defineMessageUnion({ ChangedMessage: { value: Schema.String } })
type Message = typeof Message.Type

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { message: "" } }),
  update: (_model, message) => Message.match(message, { ChangedMessage: ({ value }) => ({ model: { message: value } }) }),
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex w-96 flex-col gap-3 bg-background p-4 text-foreground")], [
      textarea({
        placeholder: "Describe the change",
        rows: 3,
        value: model.message,
        onInput: (value) => Message.ChangedMessage({ value }),
        attributes: [h.AriaLabel("Commit message")],
      }, h),
      h.p([], [`${model.message.length}`, " characters"]),
      textarea({ value: "Nothing to edit", disabled: true, class: "min-h-24", attributes: [h.AriaLabel("Disabled notes"), h.Readonly(true)] }, h),
    ]),
  }),
})
