// src/foldkit/ui/dialog.ts against the React dialog (gallery/ui-dialog.tsx).
import { Number, Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as Dialog from "../../../foldkit/ui/dialog"
import { galleryPage } from "../gallery-page"

const SIZES = ["sm", "md", "lg"] as const
type Size = (typeof SIZES)[number]

const Model = Schema.Struct({ sm: Dialog.Model, md: Dialog.Model, lg: Dialog.Model, saved: Schema.Number })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotDialogMessage: { size: Schema.Literals(SIZES), message: Dialog.Message },
  ClickedOpen: { size: Schema.Literals(SIZES) },
  ClickedCancel: { size: Schema.Literals(SIZES) },
  ClickedPair: {},
})
type Message = typeof Message.Type

const read = (model: Model, size: Size) => Option.some(model[size])
const write = (model: Model, size: Size, next: Dialog.Model): Model => ({ ...model, [size]: next })

const foldDialog = Update.foldChildAt({
  update: Dialog.update,
  readAt: read,
  writeAt: write,
  toParentMessage: (size, message) => Message.GotDialogMessage({ size, message }),
  foldOutMessage: () => Dialog.OutMessage.match<Update.Step<Model, Message>>({ Closed: () => (model) => ({ model }) }),
})

const step = (size: Size, entry: (dialog: Dialog.Model) => Update.Return<Dialog.Model, Dialog.Message>) =>
  Update.foldChildStep({
    update: entry,
    read: (model: Model) => read(model, size),
    write: (model, next) => write(model, size, next),
    toParentMessage: (message) => Message.GotDialogMessage({ size, message }),
  })

const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"

export default galleryPage<Model, Message>({
  Model,
  init: () => ({
    model: { sm: Dialog.init({ id: "sm" }), md: Dialog.init({ id: "md" }), lg: Dialog.init({ id: "lg" }), saved: 0 },
  }),
  update: (model, message) =>
    Message.match(message, {
      GotDialogMessage: ({ size, message: child }) => foldDialog(model, size, child),
      ClickedOpen: ({ size }) => step(size, Dialog.open)(model),
      ClickedCancel: ({ size }) => step(size, Dialog.close)(model),
      ClickedPair: () => step("md", Dialog.close)(modifyFields(model, { saved: Number.increment })),
    }),
  view: (model, h: HtmlBuilder<Message>): Document => {
    const embed = (size: Size, inputs: Dialog.ViewInputs) =>
      h.submodel({
        slotId: size,
        model: model[size],
        view: Dialog.view,
        viewInputs: inputs,
        toParentMessage: (message) => Message.GotDialogMessage({ size, message }),
      })
    return {
      title: "Kanna",
      body: h.div([h.Class("flex min-h-dvh flex-col items-start gap-3 bg-background p-6 text-foreground")], [
        h.button([h.Type("button"), h.Class(triggerClass), h.OnClick(Message.ClickedOpen({ size: "md" }))], ["Pair device"]),
        h.button([h.Type("button"), h.Class(triggerClass), h.OnClick(Message.ClickedOpen({ size: "sm" }))], ["Small"]),
        h.button([h.Type("button"), h.Class(triggerClass), h.OnClick(Message.ClickedOpen({ size: "lg" }))], ["Large"]),
        h.p([h.Class("text-sm")], ["Saved ", `${model.saved}`, " times"]),
        embed("md", {
          size: "md",
          content: ({ titleId, descriptionId }) => [
            Dialog.dialogHeader({}, [
              Dialog.dialogTitle({ id: titleId }, ["Pair a device"], h),
              Dialog.dialogDescription({ id: descriptionId }, ["Scan the code with the Kanna app."], h),
            ], h),
            Dialog.dialogBody({}, [
              h.input([h.AriaLabel("Device name"), h.Class("w-full rounded-md border border-border bg-background px-2 py-1 text-sm"), h.Value("iPhone")]),
            ], h),
            Dialog.dialogFooter({}, [
              Dialog.dialogGhostButton({ attributes: [h.OnClick(Message.ClickedCancel({ size: "md" }))] }, ["Cancel"], h),
              Dialog.dialogPrimaryButton({ attributes: [h.OnClick(Message.ClickedPair())] }, ["Pair"], h),
            ], h),
          ],
        }),
        embed("sm", {
          size: "sm",
          className: "gap-0",
          content: ({ titleId, descriptionId }) => [
            Dialog.dialogBody({ class: "space-y-4" }, [
              Dialog.dialogTitle({ id: titleId }, ["Archive this chat?"], h),
              Dialog.dialogDescription({ id: descriptionId }, ["It moves to the archive; nothing is deleted."], h),
            ], h),
            Dialog.dialogFooter({}, [
              Dialog.dialogGhostButton({ attributes: [h.OnClick(Message.ClickedCancel({ size: "sm" }))] }, ["Cancel"], h),
              Dialog.dialogPrimaryButton({ disabled: true }, ["Archive"], h),
            ], h),
          ],
        }),
        embed("lg", {
          size: "lg",
          content: ({ titleId }) => [
            Dialog.dialogHeader({}, [Dialog.dialogTitle({ id: titleId }, ["Release notes"], h)], h),
            Dialog.dialogBody({}, Array.from({ length: 30 }, (_, index) =>
              h.keyed("p")(`${index}`, [h.Class("py-1 text-sm")], [`Change ${index + 1}: something got better.`])), h),
          ],
        }),
      ]),
    }
  },
})
