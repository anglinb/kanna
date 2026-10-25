// src/foldkit/ui/select.ts against the React select (gallery/ui-select.tsx).
import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Globe, Lock } from "../../../foldkit/ui/icons"
import * as Select from "../../../foldkit/ui/select"
import { SELECT_MODES } from "../../react/gallery/support/select-options"
import { galleryPage } from "../gallery-page"

const NAMES = ["visibility", "mode", "transport"] as const
type Name = (typeof NAMES)[number]

const Model = Schema.Struct({
  visibility: Select.Model,
  mode: Select.Model,
  transport: Select.Model,
  chosenVisibility: Schema.Option(Schema.String),
  chosenMode: Schema.String,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotSelectMessage: { name: Schema.Literals(NAMES), message: Select.Message },
})
type Message = typeof Message.Type

const foldSelect = Update.foldChildAt({
  update: Select.update,
  readAt: (model: Model, name: Name) => Option.some(model[name]),
  writeAt: (model, name, next): Model => ({ ...model, [name]: next }),
  toParentMessage: (name, message) => Message.GotSelectMessage({ name, message }),
  foldOutMessage: (name: Name) => Select.OutMessage.match<Update.Step<Model, Message>>({
    Selected: ({ value }) => (model) => ({
      model: name === "visibility"
        ? { ...model, chosenVisibility: Option.some(value) }
        : name === "mode" ? { ...model, chosenMode: value } : model,
    }),
  }),
})

export default galleryPage<Model, Message>({
  Model,
  init: () => ({
    model: {
      visibility: Select.init({ id: "visibility" }),
      mode: Select.init({ id: "mode" }),
      transport: Select.init({ id: "transport" }),
      chosenVisibility: Option.none(),
      chosenMode: "queue",
    },
  }),
  update: (model, message) =>
    Message.match(message, { GotSelectMessage: ({ name, message: child }) => foldSelect(model, name, child) }),
  view: (model, h: HtmlBuilder<Message>): Document => {
    const embed = (name: Name, inputs: Select.ViewInputs) =>
      h.submodel({
        slotId: name,
        model: model[name],
        view: Select.view,
        viewInputs: inputs,
        toParentMessage: (message) => Message.GotSelectMessage({ name, message }),
      })
    const iconLabel = (icon: typeof Lock, label: string) => () => [
      h.span([h.Class("flex items-center gap-2")], [icon({ class: "size-4 text-muted-foreground" }, h), h.span([h.Class("pl-[1px]")], [label])]),
    ]
    return {
      title: "Kanna",
      body: h.div([h.Class("flex min-h-dvh items-start gap-8 bg-background p-8 text-foreground")], [
        h.div([h.Class("w-56")], [
          embed("visibility", {
            value: Option.getOrUndefined(model.chosenVisibility),
            placeholder: "Select visibility",
            items: [
              { value: "private" },
              { value: "public" },
            ],
            renderItem: (value) => (value === "private" ? iconLabel(Lock, "Private") : iconLabel(Globe, "Public"))(),
            toView: ({ trigger, value, portal }) =>
              Select.selectTrigger({ attributes: trigger, class: "pl-[11px] [&>span]:flex [&>span]:items-center [&>span]:gap-2" }, [value], portal, h),
          }),
        ]),
        h.div([h.Class("ml-auto")], [
          embed("mode", {
            value: model.chosenMode,
            align: "end",
            grouped: true,
            items: SELECT_MODES.map((option) => ({ value: option.value, disabled: option.disabled })),
            renderItem: (value) => [SELECT_MODES.find((option) => option.value === value)?.label ?? value],
            toView: ({ trigger, value, portal }) =>
              Select.selectTrigger({ attributes: [...trigger, h.AriaLabel("Follow-up mode")], class: "w-40" }, [value], portal, h),
          }),
        ]),
        h.div([h.Class("w-40")], [
          embed("transport", {
            value: "stdio",
            disabled: true,
            items: [{ value: "stdio" }],
            renderItem: (value) => [value],
            toView: ({ trigger, value, portal }) =>
              Select.selectTrigger({ attributes: [...trigger, h.AriaLabel("Transport")] }, [value], portal, h),
          }),
        ]),
      ]),
    }
  },
})
