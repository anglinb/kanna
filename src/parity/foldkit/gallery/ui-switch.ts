// src/foldkit/ui/switch.ts against the React <Switch> (gallery/ui-switch.tsx).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { switchControl } from "../../../foldkit/ui/switch"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ sounds: Schema.Boolean, updates: Schema.Boolean })
type Model = typeof Model.Type
const Message = defineMessageUnion({
  ToggledSounds: { checked: Schema.Boolean },
  ToggledUpdates: { checked: Schema.Boolean },
  ToggledNothing: {},
})
type Message = typeof Message.Type

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { sounds: false, updates: true } }),
  update: (model, message) =>
    Message.match(message, {
      ToggledSounds: ({ checked }) => ({ model: modifyFields(model, { sounds: () => checked }) }),
      ToggledUpdates: ({ checked }) => ({ model: modifyFields(model, { updates: () => checked }) }),
      ToggledNothing: () => ({ model }),
    }),
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex flex-col items-start gap-3 bg-background p-4 text-foreground")], [
      switchControl({ checked: model.sounds, onCheckedChange: (checked) => Message.ToggledSounds({ checked }), ariaLabel: "Sounds" }, h),
      switchControl({ checked: model.updates, onCheckedChange: (checked) => Message.ToggledUpdates({ checked }), ariaLabel: "Updates" }, h),
      switchControl({ checked: false, onCheckedChange: () => Message.ToggledNothing(), disabled: true, ariaLabel: "Disabled off" }, h),
      switchControl({ checked: true, onCheckedChange: () => Message.ToggledNothing(), disabled: true, ariaLabel: "Disabled on", class: "ml-4" }, h),
    ]),
  }),
})
