// src/foldkit/ui/turn-card.ts against the React turn-card parts (gallery/ui-turn-card.tsx).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { turnCardMessage, turnCardMetaRow, turnCardMetaSeparator, turnCardTimingRow } from "../../../foldkit/ui/turn-card"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ selected: Schema.String })
type Model = typeof Model.Type
const Message = defineMessageUnion({ SelectedPrompt: {} })
type Message = typeof Message.Type

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { selected: "none" } }),
  update: (_model, message) => Message.match(message, { SelectedPrompt: () => ({ model: { selected: "prompt" } }) }),
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex flex-col gap-4 bg-background p-4 text-foreground")], [
      h.div([h.Class("w-80 rounded-md border border-border bg-card px-1.5 py-1.5")], [
        turnCardMetaRow({}, [h.span([], ["You"]), turnCardMetaSeparator(h), h.span([], ["Claude"])], h),
        turnCardMessage(
          { class: "line-clamp-2 text-sm", label: "Open the prompt", onSelect: Message.SelectedPrompt() },
          ["Port the shared UI primitives to Foldkit, matching the React DOM exactly so slices can swap them in."],
          h,
        ),
        turnCardMessage({ class: "line-clamp-2 text-sm text-muted-foreground", label: "Reply" }, ["Done: buttons, cards and inputs."], h),
        turnCardTimingRow({ detail: "2m", timestamp: "1h ago", leading: [h.span([], ["Claude"])] }, h),
      ]),
      h.div([h.Class("w-80 rounded-md border border-border bg-card px-1.5 py-1.5")], [
        turnCardTimingRow({ timestamp: "yesterday" }, h),
        turnCardTimingRow({ detail: "8 turns" }, h),
        turnCardTimingRow({}, h),
      ]),
      h.p([], ["Selected: ", model.selected]),
    ]),
  }),
})
