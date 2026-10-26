import { Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { FaveModel } from "../../shared/types"
import { button } from "../ui/button"
import * as Dialog from "../ui/dialog"

// src/client/components/DefaultModelsDialog.tsx: edits the Default Models
// list (pi's model picker), opened from Settings and from the "Add models…"
// row in the chat input's model picker, so it is exported for the composer.
//
// The dialog edits a local draft only: nothing commits until Done or
// dismissal. Mid-edit commits would echo a snapshot back that resets the
// draft (normalization drops id-less rows), wiping a row while it's being
// filled in.
//
// A blank row is always rendered at the bottom; typing into it appends a
// real entry (and a fresh blank row appears below).
//
//   Model:   defaultModels: DefaultModelsDialog.Model     init: DefaultModelsDialog.init({ id: "default-models" })
//   update:  DefaultModelsDialog.open(model.defaultModels, faveModels) to open it, seeded with the saved list;
//            GotDefaultModelsMessage: DefaultModelsDialog.update, whose `Saved` OutMessage carries the list to write.

const FaveModelSchema = Schema.Struct({ label: Schema.String, id: Schema.String })

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  draft: Schema.Array(FaveModelSchema),
})
export type Model = typeof Model.Type

export function init(config: { id: string }): Model {
  return { dialog: Dialog.init({ id: config.id }), draft: [] }
}

export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  ChangedField: { index: Schema.Number, field: Schema.Literals(["label", "id"]), value: Schema.String },
  ClickedRemove: { index: Schema.Number },
  ClickedDone: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** The dialog closed (Done or dismissed): the rows that got a model id. */
  Saved: { faveModels: Schema.Array(FaveModelSchema) },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

function liftDialog(model: Model, result: Pick<Update.Return<Dialog.Model, Dialog.Message>, "model" | "commands">): Update.Return<Model, Message> {
  return {
    model: { ...model, dialog: result.model },
    commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
  }
}

/** Opens it, re-seeding the draft from the saved list. */
export function open(model: Model, faveModels: ReadonlyArray<FaveModel>): Update.Return<Model, Message> {
  return liftDialog({ ...model, draft: faveModels.map((fave) => ({ ...fave })) }, Dialog.open(model.dialog))
}

// Drop rows that never got a model id and save the rest.
function saved(model: Model): OutMessage {
  return OutMessage.Saved({ faveModels: model.draft.filter((fave) => fave.id.trim().length > 0) })
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    GotDialogMessage: ({ message: child }) => {
      const result = Dialog.update(model.dialog, child)
      const lifted = liftDialog(model, result)
      return result.outMessage ? { ...lifted, outMessage: saved(model) } : lifted
    },
    ChangedField: ({ index, field, value }) => {
      // An index past the end targets the always-present blank bottom row:
      // typing there appends a real entry.
      const draft = index >= model.draft.length
        ? [...model.draft, { label: "", id: "", [field]: value }]
        : model.draft.map((entry, entryIndex) => (entryIndex === index ? { ...entry, [field]: value } : entry))
      return { model: { ...model, draft } }
    },
    ClickedRemove: ({ index }) => ({ model: { ...model, draft: model.draft.filter((_, entryIndex) => entryIndex !== index) } }),
    ClickedDone: () => ({ ...liftDialog(model, Dialog.close(model.dialog)), outMessage: saved(model) }),
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: "dialog",
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "lg",
      content: ({ titleId }: Dialog.ContentParts) => [
        Dialog.dialogBody({ class: "space-y-4" }, [
          Dialog.dialogTitle({ id: titleId }, ["Default Models"], h),
          h.p([h.Class("text-sm text-muted-foreground")], [
            "Shown in Pi's model picker. Each entry has a display label and the model id sent to the Model Registry endpoint.",
          ]),
          h.div([h.Class("max-h-[55vh] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-background")],
            [...model.draft, { label: "", id: "" }].map((fave, index) => {
              const isNewRow = index === model.draft.length
              return h.keyed("div")(String(index), [h.Class("flex items-center")], [
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
