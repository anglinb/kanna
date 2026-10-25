import { Effect, Number, Option, Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { copyTextToClipboard } from "../../client/lib/clipboard"
import { cn } from "../../client/lib/utils"
import { button } from "./button"
import { Check, Copy } from "./icons"

/**
 * `<CopyButton>` (src/client/components/ui/copy-button.tsx) as a Submodel.
 *
 * Its "copied" check is state that outlives the click by two seconds, so it
 * can't be a view input: the copy is a Command, the two seconds a Command,
 * and the Model remembers which. The rest (text, classes, titles) are view
 * inputs, read fresh on every render.
 *
 * Two ways to copy, as in React:
 *  - `text`: the button copies it itself.
 *  - no `text` (React's `onCopy`): a click emits `RequestedCopy`; the parent
 *    does its own copy and, if it worked, folds `CopyButton.markCopied` to
 *    show the check (React's "return false to skip the copied feedback").
 *
 * Wiring:
 *   Model:   copy: CopyButton.Model                    init: CopyButton.init({ id: "plan-copy" })
 *   Message: GotCopyMessage: { message: CopyButton.Message }
 *   update:  GotCopyMessage: ({ message }) => foldCopy(model, message)   (Update.foldChild)
 *   view:    h.submodel({ slotId: "plan-copy", model: model.copy, view: CopyButton.view,
 *              viewInputs: { text: plan, class: "h-8 w-8" }, toParentMessage: (message) => GotCopyMessage({ message }) })
 */

const COPIED_FEEDBACK_MS = 2000

// MODEL

export const Model = Schema.Struct({
  id: Schema.String,
  isCopied: Schema.Boolean,
  /** Bumped per copy, so an older copy's timeout can't clear a newer check. */
  copyVersion: Schema.Number,
})
export type Model = typeof Model.Type

export function init(config: { id: string }): Model {
  return { id: config.id, isCopied: false, copyVersion: 0 }
}

// MESSAGE

export const Message = defineMessageUnion({
  ClickedCopy: { text: Schema.Option(Schema.String) },
  CompletedCopyText: { didCopy: Schema.Boolean },
  ElapsedCopiedFeedback: { copyVersion: Schema.Number },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** A click on a button with no `text`: the parent copies, then folds `markCopied`. */
  RequestedCopy: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const CopyText = Command.define("CopyText", {
  args: { text: Schema.String },
  messages: [Message.CompletedCopyText],
  execute: ({ text }) =>
    Effect.tryPromise(() => copyTextToClipboard(text)).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error("[CopyButton] Copy failed:", error)
          return false
        }),
      ),
      Effect.map((didCopy) => Message.CompletedCopyText({ didCopy })),
    ),
})

export const WaitCopiedFeedback = Command.define("WaitCopiedFeedback", {
  args: { copyVersion: Schema.Number },
  messages: [Message.ElapsedCopiedFeedback],
  execute: ({ copyVersion }) =>
    Effect.sleep(COPIED_FEEDBACK_MS).pipe(Effect.as(Message.ElapsedCopiedFeedback({ copyVersion }))),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

/** Shows the check for two seconds. The parent's entry point after its own copy succeeded. */
export function markCopied(model: Model): Update.Return<Model, Message> {
  const copyVersion = Number.increment(model.copyVersion)
  return {
    model: modifyFields(model, { isCopied: () => true, copyVersion: () => copyVersion }),
    commands: [WaitCopiedFeedback({ copyVersion })],
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedCopy: ({ text }) =>
      Option.match(text, {
        onNone: () => ({ model, outMessage: OutMessage.RequestedCopy() }),
        onSome: (value) => ({ model, commands: [CopyText({ text: value })] }),
      }),
    CompletedCopyText: ({ didCopy }) => (didCopy ? markCopied(model) : { model }),
    ElapsedCopiedFeedback: ({ copyVersion }) =>
      copyVersion === model.copyVersion ? { model: modifyFields(model, { isCopied: () => false }) } : { model },
  })

// VIEW

export interface ViewInputs {
  /** Text written to the clipboard. Without it a click emits `RequestedCopy`. */
  text?: string
  class?: string
  /** Class for the check icon shown while in the copied state. */
  checkClass?: string
  /** Class for the copy icon. */
  copyClass?: string
  /** Render an unstyled <button> instead of the ghost icon Button. */
  plain?: boolean
  /** Mute the ghost Button's hover styles while the copied check is shown. Default true. */
  copiedHoverReset?: boolean
  title?: string
  copiedTitle?: string
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const copied = model.isCopied
  const copiedHoverReset = inputs.copiedHoverReset ?? true
  const label = copied ? inputs.copiedTitle ?? inputs.title : inputs.title
  const icon = copied
    ? Check({ class: inputs.checkClass ?? "h-4 w-4 text-green-400" }, h)
    : Copy({ class: inputs.copyClass ?? "h-4 w-4" }, h)
  const labelAttributes = label === undefined ? [] : [h.Title(label), h.AriaLabel(label)]
  const onClick = h.OnClick(Message.ClickedCopy({ text: Option.fromUndefinedOr(inputs.text) }))

  if (inputs.plain) {
    return h.button([h.Type("button"), onClick, ...labelAttributes, ...(inputs.class ? [h.Class(inputs.class)] : [])], [icon])
  }

  return button({
    variant: "ghost",
    size: "icon",
    class: cn(
      inputs.class,
      copiedHoverReset && !copied && "hover:text-foreground",
      copiedHoverReset && copied && "hover:!bg-transparent hover:!border-transparent",
    ),
    attributes: [...labelAttributes, onClick],
  }, [icon], h)
})
