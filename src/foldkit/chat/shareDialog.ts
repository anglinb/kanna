import { Effect, Schema } from "effect"
import { Command, Submodel, Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as CopyButton from "../ui/copy-button"
import * as Dialog from "../ui/dialog"
import { ExternalLink } from "../ui/icons"

// StandaloneShareDialog (components/chat-ui/StandaloneShareDialog.tsx): the
// shared link once a chat's export has uploaded. Rendered by the root at
// layout level, as App.tsx did, open while `app.actions.standaloneShareUrl`
// is set:
//
//   Model:   shareDialog: ShareDialog.Model             init: ShareDialog.init()
//   update:  each time standaloneShareUrl changes, fold ShareDialog.sync(model, url !== null)
//            GotShareDialogMessage: ({ message }) => ShareDialog.update(model, message)
//              OutMessage Closed     → ActionMessage.ClosedShareDialog
//              OutMessage OpenedLink → ActionMessage.ClickedOpenShareLink
//              OutMessage FailedCopy → ActionMessage.FailedCopyShareLink({ error })
//   view:    h.submodel({ slotId: "share-dialog", model, view: ShareDialog.view,
//              viewInputs: { shareUrl: app.actions.standaloneShareUrl ?? "" }, toParentMessage })
//
// The copy is the dialog's own (useShareExport's handleCopyStandaloneShareLink),
// so the button's check shows only once the clipboard took the link; a
// failure goes up for the root's alert.

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  copy: CopyButton.Model,
  /** The link being shown, kept through the close animation. */
  shownUrl: Schema.String,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    dialog: Dialog.init({ id: "standalone-share" }),
    copy: CopyButton.init({ id: "standalone-share-copy" }),
    shownUrl: "",
  }
}

export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  GotCopyMessage: { message: CopyButton.Message },
  ClickedOpenLink: {},
  SucceededCopyLink: {},
  FailedCopyLink: { error: Schema.String },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** The X, Escape or a click outside (React's `onOpenChange(false)`). */
  Closed: {},
  OpenedLink: {},
  FailedCopy: { error: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const CopyLink = Command.define("CopyStandaloneShareLink", {
  args: { url: Schema.String },
  messages: [Message.SucceededCopyLink, Message.FailedCopyLink],
  execute: ({ url }) => Effect.tryPromise({
    try: async () => {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("Clipboard is not available")
      await navigator.clipboard.writeText(url)
    },
    // The browser's own error, as useShareExport showed it.
    catch: (error) => error,
  }).pipe(
    Effect.as(Message.SucceededCopyLink()),
    Effect.catch((error) => Effect.succeed(Message.FailedCopyLink({
      error: error instanceof Error ? error.message : String(error),
    }))),
  ),
})

function withDialog(model: Model, result: Update.Return<Dialog.Model, Dialog.Message>): Update.Return<Model, Message> {
  return {
    model: modifyFields(model, { dialog: () => result.model }),
    commands: Command.mapMessages(result.commands, (message: Dialog.Message) => Message.GotDialogMessage({ message })),
  }
}

/**
 * Opens or closes the dialog to match the root (`open={Boolean(standaloneShareUrl)}`).
 * `shareUrl` is the link to show while open.
 */
export function sync(model: Model, shareUrl: string | null): Update.Return<Model, Message> {
  const isOpen = Dialog.isOpen(model.dialog)
  if (shareUrl !== null) {
    const next = modifyFields(model, { shownUrl: () => shareUrl })
    return isOpen ? { model: next } : withDialog(next, Dialog.open(next.dialog))
  }
  return isOpen ? withDialog(model, Dialog.close(model.dialog)) : { model }
}

export function update(model: Model, message: Message): Return {
  return Message.match<Return>(message, {
    GotDialogMessage: ({ message: inner }) => {
      const result = Dialog.update(model.dialog, inner)
      const stepped = withDialog(model, { model: result.model, commands: result.commands ?? [] })
      return result.outMessage ? { ...stepped, outMessage: OutMessage.Closed() } : stepped
    },
    GotCopyMessage: ({ message: inner }) => {
      const result = CopyButton.update(model.copy, inner)
      const next = modifyFields(model, { copy: () => result.model })
      const commands = Command.mapMessages(result.commands, (m: CopyButton.Message) => Message.GotCopyMessage({ message: m }))
      if (!result.outMessage) return { model: next, commands }
      return { model: next, commands: [...commands, CopyLink({ url: model.shownUrl })] }
    },
    ClickedOpenLink: () => ({ model, outMessage: OutMessage.OpenedLink() }),
    SucceededCopyLink: () => {
      const result = CopyButton.markCopied(model.copy)
      return {
        model: modifyFields(model, { copy: () => result.model }),
        commands: Command.mapMessages(result.commands, (m: CopyButton.Message) => Message.GotCopyMessage({ message: m })),
      }
    },
    FailedCopyLink: ({ error }) => ({ model, outMessage: OutMessage.FailedCopy({ error }) }),
  })
}

export interface ViewInputs {
  /** The link, while there is one (`standaloneShareUrl`); the last one is kept through the close. */
  shareUrl?: string
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h: HtmlBuilder<Message>) => {
  const shareUrl = inputs.shareUrl || model.shownUrl
  return h.submodel({
    slotId: "standalone-share-dialog",
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "md",
      content: ({ titleId, descriptionId }) => [
        Dialog.dialogHeader({}, [
          Dialog.dialogTitle({ id: titleId }, ["Shared Link"], h),
          Dialog.dialogDescription({ id: descriptionId }, ["Shared links are snapshots in time and contain all attachments, tool calls and history. Be mindful of sensitive info."], h),
        ], h),
        Dialog.dialogBody({ class: "space-y-3" }, [
          h.div([h.Class("flex w-full items-center gap-2 rounded-2xl border border-border bg-muted/40 pl-4 px-3 py-2.5")], [
            h.span([h.Class("min-w-0 flex-1 truncate font-mono text-sm text-foreground")], [shareUrl]),
            h.submodel({
              slotId: "standalone-share-copy",
              model: model.copy,
              view: CopyButton.view,
              viewInputs: {
                plain: true,
                title: "Copy link",
                copiedTitle: "Copied",
                checkClass: "h-4 w-4 text-emerald-400",
                class: "flex flex-shrink-0 items-center justify-center rounded-lg text-logo hover:text-logo/60 transition-colors hover:bg-background hover:text-foreground",
              },
              toParentMessage: (message) => Message.GotCopyMessage({ message }),
            }),
          ]),
        ], h),
        Dialog.dialogFooter({}, [
          Dialog.dialogPrimaryButton({ type: "button", attributes: [h.OnClick(Message.ClickedOpenLink())] }, [
            ExternalLink({ class: "mr-2 h-4 w-4" }, h),
            "Open",
          ], h),
        ], h),
      ],
    },
    toParentMessage: (message) => Message.GotDialogMessage({ message }),
  })
})
