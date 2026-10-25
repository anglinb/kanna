// src/foldkit/ui/copy-button.ts against the React <CopyButton> (gallery/ui-copy-button.tsx).
import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "../../../foldkit/ui/copy-button"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({
  command: CopyButton.Model,
  code: CopyButton.Model,
  quiet: CopyButton.Model,
  link: CopyButton.Model,
})
type Model = typeof Model.Type
type Slot = keyof Model

const Message = defineMessageUnion({
  GotCopyButtonMessage: { slot: Schema.Literals(["command", "code", "quiet", "link"]), message: CopyButton.Message },
})
type Message = typeof Message.Type

// The link button has no `text`: it asks, and the page "copies" and shows the
// check, as React's onCopy returning true does.
const foldCopyButton = Update.foldChildAt({
  update: CopyButton.update,
  readAt: (model: Model, slot: Slot) => Option.some(model[slot]),
  writeAt: (model, slot, next): Model => ({ ...model, [slot]: next }),
  toParentMessage: (slot, message) => Message.GotCopyButtonMessage({ slot, message }),
  foldOutMessage: (slot: Slot) =>
    CopyButton.OutMessage.match<Update.Step<Model, Message>>({
      RequestedCopy: () =>
        Update.foldChildStep({
          update: CopyButton.markCopied,
          read: (model: Model) => Option.some(model[slot]),
          write: (model, next): Model => ({ ...model, [slot]: next }),
          toParentMessage: (message) => Message.GotCopyButtonMessage({ slot, message }),
        }),
    }),
})

export default galleryPage<Model, Message>({
  Model,
  init: () => ({
    model: {
      command: CopyButton.init({ id: "command" }),
      code: CopyButton.init({ id: "code" }),
      quiet: CopyButton.init({ id: "quiet" }),
      link: CopyButton.init({ id: "link" }),
    },
  }),
  update: (model, message) =>
    Message.match(message, {
      GotCopyButtonMessage: ({ slot, message: child }) => foldCopyButton(model, slot, child),
    }),
  view: (model, h: HtmlBuilder<Message>): Document => {
    const embed = (slot: Slot, viewInputs: CopyButton.ViewInputs) =>
      h.submodel({
        slotId: slot,
        model: model[slot],
        view: CopyButton.view,
        viewInputs,
        toParentMessage: (message) => Message.GotCopyButtonMessage({ slot, message }),
      })
    return {
      title: "Kanna",
      body: h.div([h.Class("flex items-center gap-4 bg-background p-4 text-foreground")], [
        embed("command", { text: "npm install kanna", title: "Copy command", class: "h-8 w-8 text-muted-foreground" }),
        embed("code", { text: "ABCD-1234", title: "Copy code", copiedTitle: "Copied", class: "h-7 w-7", checkClass: "h-3.5 w-3.5 text-green-400" }),
        embed("quiet", {
          text: "kanna dev",
          title: "Copy quietly",
          copiedHoverReset: false,
          class: "h-8 w-8 text-muted-foreground hover:text-foreground hover:!border-border/0 hover:!bg-transparent",
        }),
        embed("link", {
          plain: true,
          title: "Copy link",
          copiedTitle: "Copied link",
          checkClass: "h-4 w-4 text-emerald-400",
          class: "flex flex-shrink-0 items-center justify-center rounded-lg text-logo hover:text-logo/60 transition-colors hover:bg-background hover:text-foreground",
        }),
      ]),
    }
  },
})
