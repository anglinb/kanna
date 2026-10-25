import { Option, Schema } from "effect"
import { Submodel, Subscription, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import type { AppModel, SliceOutMessage, SliceReturn, SliceViewInputs } from "../app/slice"
import * as Composer from "../composer"
import * as Terminal from "../terminal"
import * as Transcript from "../transcript"
import * as Viewer from "../viewer"
import * as Widgets from "../widgets"

// The chat page at /chat/:chatId (src/client/app/ChatPage). Owns the page
// shell (navbar, tabs, layout, empty state) and composes the sub-slices,
// each its own folder and Submodel: transcript/, composer/, widgets/,
// viewer/, terminal/. Their requests to the root pass through unchanged.
//
// Stub until ported: see app/slice.ts for the contract.

export const Model = Schema.Struct({
  transcript: Transcript.Model,
  composer: Composer.Model,
  widgets: Widgets.Model,
  viewer: Viewer.Model,
  terminal: Terminal.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotTranscriptMessage: { message: Transcript.Message },
  GotComposerMessage: { message: Composer.Message },
  GotWidgetsMessage: { message: Widgets.Message },
  GotViewerMessage: { message: Viewer.Message },
  GotTerminalMessage: { message: Terminal.Message },
})
export type Message = typeof Message.Type

export function init(): Model {
  return {
    transcript: Transcript.init(),
    composer: Composer.init(),
    widgets: Widgets.init(),
    viewer: Viewer.init(),
    terminal: Terminal.init(),
  }
}

type Return = SliceReturn<Model, Message>
const passOutMessage = (outMessage: SliceOutMessage) => outMessage

function child<ChildModel, ChildMessage, Key extends keyof Model>(
  key: Key,
  childUpdate: (model: ChildModel, message: ChildMessage, app: AppModel) => SliceReturn<ChildModel, ChildMessage>,
  wrap: (message: ChildMessage) => Message,
) {
  return Update.foldChild({
    update: (childModel: ChildModel, input: { message: ChildMessage; app: AppModel }) => childUpdate(childModel, input.message, input.app),
    read: (model: Model) => Option.some(model[key] as unknown as ChildModel),
    write: (model: Model, next: ChildModel) => modifyFields(model, { [key]: () => next } as never) as Model,
    toParentMessage: wrap,
    toParentOutMessage: passOutMessage,
  })
}

const foldTranscript = child("transcript", Transcript.update, (message) => Message.GotTranscriptMessage({ message }))
const foldComposer = child("composer", Composer.update, (message) => Message.GotComposerMessage({ message }))
const foldWidgets = child("widgets", Widgets.update, (message) => Message.GotWidgetsMessage({ message }))
const foldViewer = child("viewer", Viewer.update, (message) => Message.GotViewerMessage({ message }))
const foldTerminal = child("terminal", Terminal.update, (message) => Message.GotTerminalMessage({ message }))

export function update(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    GotTranscriptMessage: ({ message: child }) => foldTranscript(model, { message: child, app }) as Return,
    GotComposerMessage: ({ message: child }) => foldComposer(model, { message: child, app }) as Return,
    GotWidgetsMessage: ({ message: child }) => foldWidgets(model, { message: child, app }) as Return,
    GotViewerMessage: ({ message: child }) => foldViewer(model, { message: child, app }) as Return,
    GotTerminalMessage: ({ message: child }) => foldTerminal(model, { message: child, app }) as Return,
  })
}

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, { app }, h) =>
  h.div([h.Class("flex-1 min-w-0"), h.DataAttribute("pending-page", "chat")], [
    h.submodel({ slotId: "transcript", model: model.transcript, view: Transcript.view, viewInputs: { app }, toParentMessage: (message) => Message.GotTranscriptMessage({ message }) }),
    h.submodel({ slotId: "composer", model: model.composer, view: Composer.view, viewInputs: { app }, toParentMessage: (message) => Message.GotComposerMessage({ message }) }),
    h.submodel({ slotId: "widgets", model: model.widgets, view: Widgets.view, viewInputs: { app }, toParentMessage: (message) => Message.GotWidgetsMessage({ message }) }),
    h.submodel({ slotId: "viewer", model: model.viewer, view: Viewer.view, viewInputs: { app }, toParentMessage: (message) => Message.GotViewerMessage({ message }) }),
    h.submodel({ slotId: "terminal", model: model.terminal, view: Terminal.view, viewInputs: { app }, toParentMessage: (message) => Message.GotTerminalMessage({ message }) }),
  ]),
)

// The sub-slices' subscriptions, lifted; plus any of the page's own.
const lift = <Sub extends Parameters<typeof Subscription.lift>[0]>(subscriptions: Sub, key: keyof Model, wrap: (message: never) => Message) =>
  Subscription.lift(subscriptions)<Model, Message>({
    read: (model) => Option.some(model[key] as never),
    toParentMessage: wrap as never,
  })

export const subscriptions = Subscription.aggregate(
  lift(Transcript.subscriptions, "transcript", (message: Transcript.Message) => Message.GotTranscriptMessage({ message })),
  lift(Composer.subscriptions, "composer", (message: Composer.Message) => Message.GotComposerMessage({ message })),
  lift(Widgets.subscriptions, "widgets", (message: Widgets.Message) => Message.GotWidgetsMessage({ message })),
  lift(Viewer.subscriptions, "viewer", (message: Viewer.Message) => Message.GotViewerMessage({ message })),
  lift(Terminal.subscriptions, "terminal", (message: Terminal.Message) => Message.GotTerminalMessage({ message })),
)
