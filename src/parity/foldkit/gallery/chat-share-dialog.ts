// src/foldkit/chat/shareDialog.ts against the React dialog (gallery/chat-share-dialog.tsx).
import { Number, Schema } from "effect"
import { Command } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as ShareDialog from "../../../foldkit/chat/shareDialog"
import { galleryPage } from "../gallery-page"

const SHARE_URL = "https://kanna.sh/s/3f9c2a7e-demo-chat-units"
const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"

const Model = Schema.Struct({
  dialog: ShareDialog.Model,
  shareUrl: Schema.NullOr(Schema.String),
  opened: Schema.Number,
  copyError: Schema.NullOr(Schema.String),
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotShareDialogMessage: { message: ShareDialog.Message },
  ClickedShare: {},
})
type Message = typeof Message.Type

type Commands = ReadonlyArray<Command.Command<Message>>

/** What the root does when `standaloneShareUrl` changes: the dialog follows it. */
function setUrl(model: Model, shareUrl: string | null): { model: Model; commands: Commands } {
  const result = ShareDialog.sync(model.dialog, shareUrl)
  return {
    model: modifyFields(model, { shareUrl: () => shareUrl, dialog: () => result.model }),
    commands: Command.mapMessages(result.commands, (message: ShareDialog.Message) => Message.GotShareDialogMessage({ message })),
  }
}

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { dialog: ShareDialog.init(), shareUrl: null, opened: 0, copyError: null } }),
  update: (model, message) =>
    Message.match(message, {
      ClickedShare: () => setUrl(model, SHARE_URL),
      GotShareDialogMessage: ({ message: inner }) => {
        const result = ShareDialog.update(model.dialog, inner)
        const next = modifyFields(model, { dialog: () => result.model })
        const commands: Commands = Command.mapMessages(result.commands, (m: ShareDialog.Message) => Message.GotShareDialogMessage({ message: m }))
        if (!result.outMessage) return { model: next, commands }
        const out = ShareDialog.OutMessage.match(result.outMessage, {
          Closed: () => setUrl(next, null),
          OpenedLink: () => setUrl(modifyFields(next, { opened: Number.increment }), null),
          FailedCopy: ({ error }) => ({ model: modifyFields(next, { copyError: () => error }), commands: [] as Commands }),
        })
        return { model: out.model, commands: [...commands, ...out.commands] }
      },
    }),
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex min-h-dvh flex-col items-start gap-3 bg-background p-6 text-foreground")], [
      h.button([h.Type("button"), h.Class(triggerClass), h.OnClick(Message.ClickedShare())], ["Share"]),
      h.p([h.Class("text-sm")], ["Opened ", `${model.opened}`, " times"]),
      model.copyError ? h.p([h.Class("text-sm")], ["Copy failed: ", model.copyError]) : null,
      h.submodel({
        slotId: "share-dialog",
        model: model.dialog,
        view: ShareDialog.view,
        viewInputs: { shareUrl: model.shareUrl ?? "" },
        toParentMessage: (message) => Message.GotShareDialogMessage({ message }),
      }),
    ]),
  }),
})
