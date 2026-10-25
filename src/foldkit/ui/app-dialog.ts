import { Effect, Option, Schema } from "effect"
import { Command, Submodel, Update } from "foldkit"
import { childAttributes } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { button } from "./button"
import * as Dialog from "./dialog"
import { input } from "./input"

/**
 * The app's confirm / prompt / alert dialog (src/client/components/ui/app-dialog.tsx).
 *
 * React exposed it as promises (`useAppDialog().confirm(options)`); here it is
 * a Submodel the root embeds once. A caller asks by folding
 * `AppDialog.open(model, request)` (a `Request` built with `confirm`,
 * `prompt` or `alert`, carrying a `requestId` the caller picks), and hears
 * the answer as the `Answered` OutMessage with that `requestId`, where React
 * resolved the promise:
 *
 *   confirm → Answer.Confirm({ confirmed })     cancel / Escape / outside / X → false
 *   prompt  → Answer.Prompt({ value })          the trimmed text; "" only with allowEmpty; none if cancelled or empty
 *   alert   → Answer.Alert()
 *
 * A request opened while another is showing replaces it, and the replaced one
 * is never answered: the React promise was left pending the same way.
 *
 * Wiring (root):
 *   Model:   appDialog: AppDialog.Model                         init: AppDialog.init()
 *   Message: GotAppDialogMessage: { message: AppDialog.Message }
 *   update:  ClickedDeleteProject: () => Update.foldChildStep({ update: (dialog) => AppDialog.open(dialog,
 *              AppDialog.confirm({ requestId: "delete-project", title: "Delete project?", confirmVariant: "destructive" })), … })(model)
 *            GotAppDialogMessage: ({ message }) => foldAppDialog(model, message)
 *              (foldOutMessage: Answered: ({ requestId, answer }) => …)
 *   view:    h.submodel({ slotId: "app-dialog", model: model.appDialog, view: AppDialog.view,
 *              toParentMessage: (message) => GotAppDialogMessage({ message }) })
 */

// REQUEST

const ConfirmVariant = Schema.Literals(["default", "destructive", "secondary"])

export const ConfirmRequest = Schema.TaggedStruct("Confirm", {
  requestId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  confirmLabel: Schema.optional(Schema.String),
  cancelLabel: Schema.optional(Schema.String),
  confirmVariant: Schema.optional(ConfirmVariant),
})

export const PromptRequest = Schema.TaggedStruct("Prompt", {
  requestId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  placeholder: Schema.optional(Schema.String),
  initialValue: Schema.optional(Schema.String),
  allowEmpty: Schema.optional(Schema.Boolean),
  resetLabel: Schema.optional(Schema.String),
  resetValue: Schema.optional(Schema.String),
  confirmLabel: Schema.optional(Schema.String),
  cancelLabel: Schema.optional(Schema.String),
})

export const AlertRequest = Schema.TaggedStruct("Alert", {
  requestId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  closeLabel: Schema.optional(Schema.String),
})

export const Request = Schema.Union([ConfirmRequest, PromptRequest, AlertRequest])
export type Request = typeof Request.Type

export const confirm = (options: Omit<typeof ConfirmRequest.Type, "_tag">): Request => ({ _tag: "Confirm", ...options })
export const prompt = (options: Omit<typeof PromptRequest.Type, "_tag">): Request => ({ _tag: "Prompt", ...options })
export const alert = (options: Omit<typeof AlertRequest.Type, "_tag">): Request => ({ _tag: "Alert", ...options })

// ANSWER

export const Answer = Schema.Union([
  Schema.TaggedStruct("Confirm", { confirmed: Schema.Boolean }),
  Schema.TaggedStruct("Prompt", { value: Schema.Option(Schema.String) }),
  Schema.TaggedStruct("Alert", {}),
])
export type Answer = typeof Answer.Type

// MODEL

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  request: Schema.Option(Request),
  inputValue: Schema.String,
})
export type Model = typeof Model.Type

const DIALOG_ID = "app-dialog"
const INPUT_ID = "app-dialog-input"

export function init(): Model {
  return { dialog: Dialog.init({ id: DIALOG_ID }), request: Option.none(), inputValue: "" }
}

// MESSAGE

export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  ChangedInput: { value: Schema.String },
  ClickedReset: {},
  ClickedCancel: {},
  ClickedConfirm: {},
  PressedEnter: {},
  CompletedFocusInput: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Answered: { requestId: Schema.String, answer: Answer },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

/** React's `setTimeout(() => { input.focus(); input.select() })` after a prompt opens. */
export const FocusInput = Command.define("FocusAppDialogInput", {
  messages: [Message.CompletedFocusInput],
  execute: Effect.sleep(0).pipe(
    Effect.andThen(Effect.sync(() => {
      const element = document.getElementById(INPUT_ID)
      if (element instanceof HTMLInputElement) {
        element.focus()
        element.select()
      }
      return Message.CompletedFocusInput()
    })),
  ),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const toGotDialogMessage = (message: Dialog.Message) => Message.GotDialogMessage({ message })

const foldDialogStep = (entry: (dialog: Dialog.Model) => Update.Return<Dialog.Model, Dialog.Message>) =>
  Update.foldChildStep({
    update: entry,
    read: (model: Model) => Option.some(model.dialog),
    write: (model, dialog): Model => modifyFields(model, { dialog: () => dialog }),
    toParentMessage: toGotDialogMessage,
  })

const answerFor = (request: Request, kind: "confirm" | "cancel", inputValue: string): Answer => {
  switch (request._tag) {
    case "Confirm":
      return { _tag: "Confirm", confirmed: kind === "confirm" }
    case "Prompt": {
      if (kind === "cancel") return { _tag: "Prompt", value: Option.none() }
      const trimmed = inputValue.trim()
      return { _tag: "Prompt", value: trimmed ? Option.some(trimmed) : request.allowEmpty ? Option.some("") : Option.none() }
    }
    case "Alert":
      return { _tag: "Alert" }
  }
}

/** Shows `request`. The parent's entry point (React's `confirm` / `prompt` / `alert`). */
export function open(model: Model, request: Request): Update.Return<Model, Message> {
  const opened = foldDialogStep(Dialog.open)(modifyFields(model, {
    request: () => Option.some(request),
    inputValue: () => (request._tag === "Prompt" ? request.initialValue ?? "" : ""),
  }))
  return request._tag === "Prompt" ? { ...opened, commands: [...(opened.commands ?? []), FocusInput()] } : opened
}

// Answers the pending request and closes the dialog (React's closeDialog).
function resolve(model: Model, kind: "confirm" | "cancel"): UpdateReturn {
  return Option.match(model.request, {
    onNone: () => ({ model }),
    onSome: (request) => {
      const closed = foldDialogStep(Dialog.close)(modifyFields(model, { request: () => Option.none(), inputValue: () => "" }))
      return { ...closed, outMessage: OutMessage.Answered({ requestId: request.requestId, answer: answerFor(request, kind, model.inputValue) }) }
    },
  })
}

const isConfirmDisabled = (model: Model) =>
  Option.match(model.request, {
    onNone: () => false,
    onSome: (request) => request._tag === "Prompt" && !request.allowEmpty && !model.inputValue.trim(),
  })

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model, dialog): Model => modifyFields(model, { dialog: () => dialog }),
  toParentMessage: toGotDialogMessage,
  foldOutMessage: Dialog.OutMessage.match<Update.StepWithOutMessage<Model, Message, OutMessage>>({
    // The X, Escape or a click outside: React's onOpenChange(false) → resolveCancel.
    Closed: () => (model) => Option.match(model.request, {
      onNone: () => ({ model }),
      onSome: (request) => ({
        model: modifyFields(model, { request: () => Option.none(), inputValue: () => "" }),
        outMessage: OutMessage.Answered({ requestId: request.requestId, answer: answerFor(request, "cancel", model.inputValue) }),
      }),
    }),
  }),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotDialogMessage: ({ message: child }) => foldDialog(model, child),
    ChangedInput: ({ value }) => ({ model: modifyFields(model, { inputValue: () => value }) }),
    ClickedReset: () =>
      Option.match(model.request, {
        onNone: () => ({ model }),
        onSome: (request) =>
          request._tag === "Prompt" ? { model: modifyFields(model, { inputValue: () => request.resetValue ?? "" }) } : { model },
      }),
    ClickedCancel: () => resolve(model, "cancel"),
    // A disabled button can't be clicked; Enter in the input still resolves,
    // as React's handler did (an empty prompt then answers none).
    ClickedConfirm: () => (isConfirmDisabled(model) ? { model } : resolve(model, "confirm")),
    PressedEnter: () => resolve(model, "confirm"),
    CompletedFocusInput: () => ({ model }),
  })

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: DIALOG_ID,
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "sm",
      // Enter confirms a confirm dialog from anywhere in it.
      contentAttributes: () =>
        childAttributes([
          h.OnKeyDownPreventDefault((key, modifiers) =>
            key === "Enter" && !modifiers.shiftKey && Option.exists(model.request, (request) => request._tag === "Confirm")
              ? Option.some(Message.PressedEnter())
              : Option.none()),
        ]),
      content: ({ titleId, descriptionId }) =>
        Option.match(model.request, {
          onNone: () => [],
          onSome: (request) => [
            Dialog.dialogBody({ class: "space-y-4" }, [
              Dialog.dialogTitle({ id: titleId }, [request.title], h),
              request.description ? Dialog.dialogDescription({ id: descriptionId }, [request.description], h) : null,
              request._tag === "Prompt"
                ? input({
                  type: "text",
                  value: model.inputValue,
                  placeholder: request.placeholder,
                  onInput: (value) => Message.ChangedInput({ value }),
                  attributes: [
                    h.Id(INPUT_ID),
                    h.OnKeyDownPreventDefault((key) => (key === "Enter" ? Option.some(Message.PressedEnter()) : Option.none())),
                  ],
                }, h)
                : null,
            ], h),
            Dialog.dialogFooter({}, [
              request._tag === "Prompt" && request.resetLabel
                ? button({ variant: "ghost", size: "sm", class: "mr-auto", attributes: [h.OnClick(Message.ClickedReset())] }, [request.resetLabel], h)
                : null,
              button({
                variant: "ghost",
                size: "sm",
                class: request._tag === "Alert" ? "hidden" : undefined,
                attributes: [h.OnClick(Message.ClickedCancel())],
              }, [request._tag === "Alert" ? "Cancel" : request.cancelLabel ?? "Cancel"], h),
              button({
                variant: request._tag === "Confirm" ? request.confirmVariant ?? "default" : "secondary",
                size: "sm",
                disabled: isConfirmDisabled(model),
                attributes: [h.OnClick(Message.ClickedConfirm())],
              }, [request._tag === "Alert" ? request.closeLabel ?? "OK" : request.confirmLabel ?? "Confirm"], h),
            ], h),
          ],
        }),
    },
    toParentMessage: (message) => Message.GotDialogMessage({ message }),
  }),
)
