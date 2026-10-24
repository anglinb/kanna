// Every lucide icon the client uses, from src/foldkit/ui/icons.ts, against
// lucide-react (gallery/icons.tsx on the React side).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Icon } from "../../../foldkit/ui/icon"
import * as Icons from "../../../foldkit/ui/icons"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({})
type Model = typeof Model.Type
const Message = defineMessageUnion({ NoOp: {} })
type Message = typeof Message.Type

const names = Object.keys(Icons).sort()

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: {} }),
  update: (model) => ({ model }),
  view: (_model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex flex-wrap gap-2 bg-background p-4 text-foreground")], names.map((name) => {
      const icon = (Icons as unknown as Record<string, Icon>)[name]!
      return h.span([h.Title(name), h.Class("inline-flex")], [
        icon({ class: "size-5" }, h),
        icon({ class: "h-3 w-3 text-muted-foreground", strokeWidth: 1.5, attributes: [h.AriaLabel(name)] }, h),
      ])
    })),
  }),
})
