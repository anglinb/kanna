// setup/rows.ts macSetupCards (the wizard's This Mac step) against the React
// MacSetupCards (gallery/setup-mac.tsx).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { macSetupCards } from "../../../foldkit/setup/rows"
import { MAC_STATES } from "../../react/gallery/support/setup-states"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({})
type Model = typeof Model.Type
const Message = defineMessageUnion({ Clicked: {} })
type Message = typeof Message.Type

const messages = {
  openLoginItems: Message.Clicked(),
  setLoginItem: () => Message.Clicked(),
  setKeepAwake: () => Message.Clicked(),
  setKeepAwakeOnBattery: () => Message.Clicked(),
  openFullDiskAccess: Message.Clicked(),
}

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: {} }),
  update: (model) => ({ model }),
  view: (_model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("min-h-dvh bg-background p-6 text-foreground")], [
      h.div([h.Class("grid grid-cols-[400px_400px] items-start justify-center gap-6")],
        MAC_STATES.map((state) => h.div([], [macSetupCards(state, messages, h)]))),
    ]),
  }),
})
