// Smoke page for the gallery mechanism itself (scripts/parity/scenarios/gallery-smoke.ts).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({})
type Model = typeof Model.Type
const Message = defineMessageUnion({ NoOp: {} })
type Message = typeof Message.Type

export default galleryPage({
  Model,
  init: () => ({ model: {} }),
  update: (model: Model) => ({ model }),
  view: (_model: Model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex min-h-dvh items-center justify-center bg-background")], [
      h.button([h.Type("button"), h.Class("rounded-md border border-border px-3 py-1.5 text-sm text-foreground")], ["Gallery"]),
    ]),
  }),
})
