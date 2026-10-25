// src/foldkit/ui/context-menu.ts against the React context menu (gallery/ui-context-menu.tsx).
import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as ContextMenu from "../../../foldkit/ui/context-menu"
import { Archive, Pencil, Pin, Trash2 } from "../../../foldkit/ui/icons"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ menu: ContextMenu.Model, last: Schema.String })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotMenuMessage: { message: ContextMenu.Message } })
type Message = typeof Message.Type

const foldMenu = Update.foldChild({
  update: ContextMenu.update,
  read: (model: Model) => Option.some(model.menu),
  write: (model, menu): Model => ({ ...model, menu }),
  toParentMessage: (message) => Message.GotMenuMessage({ message }),
  foldOutMessage: ContextMenu.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
    Selected: ({ value }) => (model) => ({ model: { ...model, last: value } }),
  }),
})

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { menu: ContextMenu.init({ id: "row" }), last: "nothing" } }),
  update: (model, message) => Message.match(message, { GotMenuMessage: ({ message: child }) => foldMenu(model, child) }),
  view: (model, h: HtmlBuilder<Message>): Document => {
    const iconItem = (icon: typeof Pin, label: string) => [icon({ class: "h-3.5 w-3.5" }, h), h.span([], [label])]
    return {
      title: "Kanna",
      body: h.div([h.Class("flex min-h-dvh flex-col gap-2 bg-background p-6 text-foreground")], [
        h.submodel({
          slotId: "row",
          model: model.menu,
          view: ContextMenu.view,
          viewInputs: {
            items: [
              ContextMenu.item({ value: "pin" }),
              ContextMenu.item({ value: "rename" }),
              ContextMenu.item({ value: "fork", disabled: true }),
              ContextMenu.item({ value: "delegate", title: "Takes effect on this chat's next turn" }),
              ContextMenu.separator(),
              ContextMenu.item({ value: "archive" }),
              ContextMenu.item({ value: "delete", className: "text-destructive" }),
            ],
            renderItem: (value) => {
              switch (value) {
                case "pin":
                  return iconItem(Pin, "Pin")
                case "rename":
                  return iconItem(Pencil, "Rename")
                case "archive":
                  return iconItem(Archive, "Archive")
                case "delete":
                  return iconItem(Trash2, "Delete")
                case "fork":
                  return [h.span([], ["Fork"])]
                default:
                  return [h.span([], ["Delegate"])]
              }
            },
            toView: ({ trigger, portal }) =>
              h.div([...trigger, h.Class("w-80 rounded-md border border-border px-3 py-2 text-sm")], ["Port the shared UI primitives", portal]),
          },
          toParentMessage: (message) => Message.GotMenuMessage({ message }),
        }),
        h.p([h.Class("text-sm")], ["Last: ", model.last]),
      ]),
    }
  },
})
