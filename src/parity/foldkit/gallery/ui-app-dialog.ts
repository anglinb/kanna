// src/foldkit/ui/app-dialog.ts against the React app dialog (gallery/ui-app-dialog.tsx).
import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as AppDialog from "../../../foldkit/ui/app-dialog"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ appDialog: AppDialog.Model, answer: Schema.String })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotAppDialogMessage: { message: AppDialog.Message },
  ClickedDelete: {},
  ClickedRename: {},
  ClickedAbout: {},
})
type Message = typeof Message.Type

const toGot = (message: AppDialog.Message) => Message.GotAppDialogMessage({ message })
const read = (model: Model) => Option.some(model.appDialog)
const write = (model: Model, appDialog: AppDialog.Model): Model => ({ ...model, appDialog })

const ask = (request: AppDialog.Request) =>
  Update.foldChildStep({ update: (dialog: AppDialog.Model) => AppDialog.open(dialog, request), read, write, toParentMessage: toGot })

const describe = (answer: AppDialog.Answer) => {
  switch (answer._tag) {
    case "Confirm":
      return `confirm: ${answer.confirmed}`
    case "Prompt":
      return `prompt: ${Option.getOrElse(answer.value, () => "cancelled")}`
    case "Alert":
      return "alert: closed"
  }
}

const foldAppDialog = Update.foldChild({
  update: AppDialog.update,
  read,
  write,
  toParentMessage: toGot,
  foldOutMessage: AppDialog.OutMessage.match<Update.Step<Model, Message>>({
    Answered: ({ answer }) => (model) => ({ model: { ...model, answer: describe(answer) } }),
  }),
})

const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { appDialog: AppDialog.init(), answer: "none" } }),
  update: (model, message) =>
    Message.match(message, {
      GotAppDialogMessage: ({ message: child }) => foldAppDialog(model, child),
      ClickedDelete: () => ask(AppDialog.confirm({
        requestId: "delete",
        title: "Delete project?",
        description: "Its chats stay on disk.",
        confirmLabel: "Delete",
        confirmVariant: "destructive",
      }))(model),
      ClickedRename: () => ask(AppDialog.prompt({
        requestId: "rename",
        title: "Rename chat",
        placeholder: "Chat title",
        initialValue: "Port the UI",
        resetLabel: "Use generated title",
        resetValue: "Foldkit primitives",
        confirmLabel: "Rename",
      }))(model),
      ClickedAbout: () => ask(AppDialog.alert({ requestId: "about", title: "Kanna is up to date", description: "Version 0.68.0" }))(model),
    }),
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex min-h-dvh flex-col items-start gap-3 bg-background p-6 text-foreground")], [
      h.button([h.Type("button"), h.Class(triggerClass), h.OnClick(Message.ClickedDelete())], ["Delete project"]),
      h.button([h.Type("button"), h.Class(triggerClass), h.OnClick(Message.ClickedRename())], ["Rename"]),
      h.button([h.Type("button"), h.Class(triggerClass), h.OnClick(Message.ClickedAbout())], ["About"]),
      h.p([h.Class("text-sm")], ["Answer: ", model.answer]),
      h.submodel({ slotId: "app-dialog", model: model.appDialog, view: AppDialog.view, toParentMessage: toGot }),
    ]),
  }),
})
