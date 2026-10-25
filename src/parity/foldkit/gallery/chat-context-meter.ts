// src/foldkit/chat/contextWindowMeter.ts against the React meter (gallery/chat-context-meter.tsx).
import { Schema } from "effect"
import { Command } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as ContextWindowMeter from "../../../foldkit/chat/contextWindowMeter"
import { CONTEXT_METER_USAGES } from "../../react/gallery/support/context-meter-usages"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ meters: Schema.Array(ContextWindowMeter.Model) })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotMeterMessage: { index: Schema.Number, message: ContextWindowMeter.Message },
})
type Message = typeof Message.Type

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { meters: CONTEXT_METER_USAGES.map((_, index) => ContextWindowMeter.init(`meter-${index}`)) } }),
  update: (model, message) =>
    Message.match(message, {
      GotMeterMessage: ({ index, message: inner }) => {
        const result = ContextWindowMeter.update(model.meters[index]!, inner)
        return {
          model: { meters: model.meters.map((meter, at) => (at === index ? result.model : meter)) },
          commands: Command.mapMessages(result.commands, (m: ContextWindowMeter.Message) => Message.GotMeterMessage({ index, message: m })),
        }
      },
    }),
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex min-h-dvh flex-col items-start gap-6 bg-background p-10 pt-24 text-foreground")],
      CONTEXT_METER_USAGES.map((usage, index) =>
        h.keyed("div")(`${index}`, [h.Class("flex items-center gap-3")], [
          h.submodel({
            slotId: `meter-${index}`,
            model: model.meters[index]!,
            view: ContextWindowMeter.view,
            viewInputs: { usage },
            toParentMessage: (message) => Message.GotMeterMessage({ index, message }),
          }),
          h.span([h.Class("text-sm")], [`Meter ${index + 1}`]),
        ]))),
  }),
})
