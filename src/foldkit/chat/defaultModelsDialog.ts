import { Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import type { FaveModel } from "../../shared/types"
import { opaque } from "../core/schema"
import { button } from "../ui/button"
import * as Dialog from "../ui/dialog"

// DefaultModelsDialog (components/DefaultModelsDialog.tsx): edits the Default
// Models list (pi's model picker), opened from the composer's model picker
// ("Add models…") and from Settings. It edits a local draft only: nothing
// commits until Done or a dismissal, since a mid-edit commit would echo a
// snapshot back that resets the draft. A blank row is always at the bottom;
// typing into it appends a real entry.
//
//   open:   DefaultModelsDialog.open(model, faveModels)   (React's `open` turning true)
//   update: the OutMessage `Saved` carries the list to write (`WriteFaveModels`).

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  draft: Schema.Array(opaque<FaveModel>("FaveModel")),
})
export type Model = typeof Model.Type

export function init(id = "default-models"): Model {
  return { dialog: Dialog.init({ id }), draft: [] }
}

export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  ChangedField: { index: Schema.Number, field: Schema.Literals(["label", "id"]), value: Schema.String },
  ClickedRemove: { index: Schema.Number },
  ClickedDone: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** Closed (Done or a dismissal): the rows that have a model id, to save. */
  Saved: { faveModels: Schema.Array(opaque<FaveModel>("FaveModel")) },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

function withDialog(model: Model, result: Update.Return<Dialog.Model, Dialog.Message>): Update.Return<Model, Message> {
  return {
    model: modifyFields(model, { dialog: () => result.model }),
    commands: Command.mapMessages(result.commands, (message: Dialog.Message) => Message.GotDialogMessage({ message })),
  }
}

/** Opens it on a copy of the saved list. */
export function open(model: Model, faveModels: ReadonlyArray<FaveModel>): Update.Return<Model, Message> {
  if (Dialog.isOpen(model.dialog)) return { model }
  return withDialog(modifyFields(model, { draft: () => faveModels.map((fave) => ({ ...fave })) }), Dialog.open(model.dialog))
}

/** Drop rows that never got a model id and save the rest. */
function saved(model: Model) {
  return OutMessage.Saved({ faveModels: model.draft.filter((fave) => fave.id.trim().length > 0) })
}

export function update(model: Model, message: Message): Return {
  return Message.match<Return>(message, {
    GotDialogMessage: ({ message: inner }) => {
      const result = Dialog.update(model.dialog, inner)
      const stepped = withDialog(model, { model: result.model, commands: result.commands ?? [] })
      return result.outMessage ? { ...stepped, outMessage: saved(model) } : stepped
    },
    // An index past the end is the blank bottom row: typing there appends.
    ChangedField: ({ index, field, value }) => ({
      model: modifyFields(model, {
        draft: (faves) => index >= faves.length
          ? [...faves, { label: "", id: "", [field]: value } as FaveModel]
          : faves.map((entry, entryIndex) => (entryIndex === index ? { ...entry, [field]: value } : entry)),
      }),
    }),
    ClickedRemove: ({ index }) => ({ model: modifyFields(model, { draft: (faves) => faves.filter((_, entryIndex) => entryIndex !== index) }) }),
    ClickedDone: () => ({ ...withDialog(model, Dialog.close(model.dialog)), outMessage: saved(model) }),
  })
}

export const view = Submodel.defineView<Model, Message, {}>((model, _inputs, h: HtmlBuilder<Message>) =>
  h.submodel({
    slotId: "default-models-dialog",
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "lg",
      content: ({ titleId }) => [
        Dialog.dialogBody({ class: "space-y-4" }, [
          Dialog.dialogTitle({ id: titleId }, ["Default Models"], h),
          h.p([h.Class("text-sm text-muted-foreground")], [
            "Shown in Pi's model picker. Each entry has a display label and the model id sent to the Model Registry endpoint.",
          ]),
          h.div([h.Class("max-h-[55vh] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-background")],
            [...model.draft, { label: "", id: "" }].map((fave, index) => {
              const isNewRow = index === model.draft.length
              return h.keyed("div")(`${index}`, [h.Class("flex items-center")], [
                h.input([
                  h.Value(fave.label),
                  h.OnInput((value) => Message.ChangedField({ index, field: "label", value })),
                  h.Placeholder("Name"),
                  h.Spellcheck(false),
                  h.Class("w-[160px] shrink-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60"),
                ]),
                h.input([
                  h.Value(fave.id),
                  h.OnInput((value) => Message.ChangedField({ index, field: "id", value })),
                  h.Placeholder("Model id"),
                  h.Spellcheck(false),
                  h.Attribute("autocapitalize", "off"),
                  h.Attribute("autocorrect", "off"),
                  h.Class("min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground/60"),
                ]),
                isNewRow
                  ? h.div([h.Class("w-9 shrink-0")], [])
                  : h.button([
                    h.Type("button"),
                    h.AriaLabel("Remove default model"),
                    h.OnClick(Message.ClickedRemove({ index })),
                    h.Class("flex w-9 shrink-0 items-center justify-center self-stretch text-muted-foreground transition-colors hover:text-foreground"),
                  ], ["✕"]),
              ])
            })),
        ], h),
        Dialog.dialogFooter({}, [
          button({ variant: "secondary", size: "sm", attributes: [h.OnClick(Message.ClickedDone())] }, ["Done"], h),
        ], h),
      ],
    },
    toParentMessage: (message) => Message.GotDialogMessage({ message }),
  }))
