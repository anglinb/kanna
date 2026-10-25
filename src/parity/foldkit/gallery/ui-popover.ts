// src/foldkit/ui/popover.ts against the React popover (gallery/ui-popover.tsx).
import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as Popover from "../../../foldkit/ui/popover"
import { POPOVER_FILTERS, POPOVER_MODELS } from "../../react/gallery/support/popover-options"
import { galleryPage } from "../gallery-page"

const NAMES = ["model", "details", "filter"] as const
type Name = (typeof NAMES)[number]

const Model = Schema.Struct({
  model: Popover.Model,
  details: Popover.Model,
  filter: Popover.Model,
  chosenModel: Schema.String,
  chosenFilter: Schema.String,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotPopoverMessage: { name: Schema.Literals(NAMES), message: Popover.Message },
  ChoseModel: { value: Schema.String },
  ChoseFilter: { value: Schema.String },
})
type Message = typeof Message.Type

const readPopover = (model: Model, name: Name) => Option.some(model[name])
const writePopover = (model: Model, name: Name, next: Popover.Model): Model => ({ ...model, [name]: next })

const foldPopover = Update.foldChildAt({
  update: Popover.update,
  readAt: readPopover,
  writeAt: writePopover,
  toParentMessage: (name, message) => Message.GotPopoverMessage({ name, message }),
  foldOutMessage: () => Popover.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
})

const closeModelPopover = Update.foldChildStep({
  update: (popover: Popover.Model) => Popover.close(popover),
  read: (model: Model) => Option.some(model.model),
  write: (model, next): Model => ({ ...model, model: next }),
  toParentMessage: (message) => Message.GotPopoverMessage({ name: "model", message }),
  foldOutMessage: Popover.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
})

const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"
const optionClass = "flex w-full items-center px-3 py-2 text-left text-sm hover:bg-muted"

export default galleryPage<Model, Message>({
  Model,
  init: () => ({
    model: {
      model: Popover.init({ id: "model" }),
      details: Popover.init({ id: "details" }),
      filter: Popover.init({ id: "filter" }),
      chosenModel: "Opus",
      chosenFilter: "Everything",
    },
  }),
  update: (model, message) =>
    Message.match(message, {
      GotPopoverMessage: ({ name, message: child }) => foldPopover(model, name, child),
      ChoseModel: ({ value }) => closeModelPopover(modifyFields(model, { chosenModel: () => value })),
      ChoseFilter: ({ value }) => ({ model: modifyFields(model, { chosenFilter: () => value }) }),
    }),
  view: (model, h: HtmlBuilder<Message>): Document => {
    const embed = (name: Name, inputs: Popover.ViewInputs) =>
      h.submodel({
        slotId: name,
        model: model[name],
        view: Popover.view,
        viewInputs: inputs,
        toParentMessage: (message) => Message.GotPopoverMessage({ name, message }),
      })
    return {
      title: "Kanna",
      body: h.div([h.Class("flex min-h-dvh items-start justify-between bg-background p-8 text-foreground")], [
        embed("model", {
          align: "start",
          className: "w-64 overflow-hidden p-0",
          content: () => [
            h.div([h.Class("max-h-80 overflow-y-auto divide-y divide-border/60")], POPOVER_MODELS.map((option) =>
              h.keyed("button")(option, [h.Type("button"), h.Class(optionClass), h.OnClick(Message.ChoseModel({ value: option }))], [option]))),
          ],
          toView: ({ trigger, portal }) => h.button([...trigger, h.Class(triggerClass)], [model.chosenModel, portal]),
        }),
        embed("details", {
          content: () => [
            h.p([h.Class("mb-2 text-sm")], ["Name this chat"]),
            h.input([h.AriaLabel("Chat name"), h.Class("w-full rounded-md border border-border bg-background px-2 py-1 text-sm"), h.Value("Port the UI")]),
          ],
          toView: ({ trigger, portal }) => h.button([...trigger, h.Class(triggerClass)], ["Details", portal]),
        }),
        embed("filter", {
          align: "end",
          sideOffset: 8,
          className: "w-60 overflow-hidden p-0",
          content: () => [
            h.div([h.Class("max-h-96 overflow-y-auto divide-y divide-border/60")], POPOVER_FILTERS.map((option) =>
              h.keyed("button")(option, [h.Type("button"), h.Class(optionClass), h.OnClick(Message.ChoseFilter({ value: option }))], [option]))),
          ],
          toView: ({ trigger, portal }) => h.button([...trigger, h.AriaLabel("Filter projects"), h.Class(triggerClass)], [model.chosenFilter, portal]),
        }),
      ]),
    }
  },
})
