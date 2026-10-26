// A gallery page with nothing to update: one view of a primitive's states.
// In support/, not gallery/, so main.ts's glob doesn't take it for a page.
import { Schema } from "effect"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { galleryPage } from "../../gallery-page"

const Model = Schema.Struct({})
type Model = typeof Model.Type
export const StaticMessage = defineMessageUnion({ NoOp: {} })
export type StaticMessage = typeof StaticMessage.Type

export function staticPage(body: (h: HtmlBuilder<StaticMessage>) => Html) {
  return galleryPage<Model, StaticMessage>({
    Model,
    init: () => ({ model: {} }),
    update: (model) => ({ model }),
    view: (_model, h): Document => ({ title: "Kanna", body: body(h) }),
  })
}
