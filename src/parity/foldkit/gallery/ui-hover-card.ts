// src/foldkit/ui/hover-card.ts against the React hover card (gallery/ui-hover-card.tsx).
import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as HoverCard from "../../../foldkit/ui/hover-card"
import { galleryPage } from "../gallery-page"

const NAMES = ["branch", "instant"] as const
type Name = (typeof NAMES)[number]

const Model = Schema.Struct({ branch: HoverCard.Model, instant: HoverCard.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotHoverCardMessage: { name: Schema.Literals(NAMES), message: HoverCard.Message },
})
type Message = typeof Message.Type

const foldHoverCard = Update.foldChildAt({
  update: HoverCard.update,
  readAt: (model: Model, name: Name) => Option.some(model[name]),
  writeAt: (model, name, next): Model => ({ ...model, [name]: next }),
  toParentMessage: (name, message) => Message.GotHoverCardMessage({ name, message }),
})

export default galleryPage<Model, Message>({
  Model,
  init: () => ({
    model: {
      branch: HoverCard.init({ id: "branch" }),
      instant: HoverCard.init({ id: "instant", openDelay: 0, closeDelay: 0 }),
    },
  }),
  update: (model, message) =>
    Message.match(message, { GotHoverCardMessage: ({ name, message: child }) => foldHoverCard(model, name, child) }),
  view: (model, h: HtmlBuilder<Message>): Document => {
    const embed = (name: Name, inputs: HoverCard.ViewInputs) =>
      h.submodel({
        slotId: name,
        model: model[name],
        view: HoverCard.view,
        viewInputs: inputs,
        toParentMessage: (message) => Message.GotHoverCardMessage({ name, message }),
      })
    return {
      title: "Kanna",
      body: h.div([h.Class("flex min-h-dvh items-start gap-24 bg-background p-24 text-foreground")], [
        embed("branch", {
          className: "w-72",
          content: () => [
            h.p([h.Class("text-sm font-medium")], ["feat/foldkit-ui"]),
            h.p([h.Class("text-xs text-muted-foreground")], ["3 commits ahead of main"]),
            h.button([h.Type("button"), h.Class("mt-2 rounded-md border border-border px-2 py-1 text-xs")], ["Open pull request"]),
          ],
          toView: ({ trigger, portal }) => h.a([...trigger, h.Href("#branch"), h.Class("text-sm underline")], ["feat/foldkit-ui", portal]),
        }),
        embed("instant", {
          side: "right",
          align: "start",
          sideOffset: 8,
          content: () => ["No delay either way"],
          toView: ({ trigger, portal }) => h.span([...trigger, h.Class("text-sm")], ["Instant", portal]),
        }),
      ]),
    }
  },
})
