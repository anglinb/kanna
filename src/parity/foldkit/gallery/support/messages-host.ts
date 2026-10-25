// What the Foldkit message-row galleries share, as the React galleries'
// support/messages-host.tsx: a page that scrolls, a status line saying what
// the last press asked for, and sections of transcript rows drawn through
// src/foldkit/transcript/messages, embedded as the transcript viewport
// embeds them (one Messages Model, one `h.submodel` per row).
import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { TRANSCRIPT_ROW_CLASS } from "../../../../client/components/messages/transcript-row"
import * as Messages from "../../../../foldkit/transcript/messages"
import type { GallerySection } from "../../../../foldkit/transcript/messages/fixture"
import {
  describeAnswers,
  describeLocalLinkOpen,
  describePlan,
  describeQueued,
  describeResume,
  NO_ACTION,
  STOPPED,
} from "../../../../foldkit/transcript/messages/fixture-status"
import { galleryPage } from "../../gallery-page"

export const Model = Schema.Struct({ status: Schema.String, messages: Messages.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotMessagesMessage: { message: Messages.Message },
})
export type Message = typeof Message.Type

const setStatus = (status: string): Update.Step<Model, Message> => (model) => ({ model: { ...model, status } })

const foldMessages = Update.foldChild({
  update: Messages.update,
  read: (model: Model) => Option.some(model.messages),
  write: (model: Model, messages: Messages.Model) => ({ ...model, messages }),
  toParentMessage: (message: Messages.Message) => Message.GotMessagesMessage({ message }),
  foldOutMessage: (outMessage: Messages.OutMessage) =>
    Messages.OutMessage.match<Update.Step<Model, Message>>(outMessage, {
      RequestedAppAction: () => (model) => ({ model }),
      RequestedToolEntries: ({ entryIds }) => (model) => ({ model: { ...model, messages: Messages.failedToolEntries(model.messages, entryIds) } }),
      RequestedDebugRaw: ({ entryId }) => (model) => ({ model: { ...model, messages: Messages.receivedDebugRaw(model.messages, entryId, Option.none()) } }),
      SubmittedAskUserQuestion: ({ toolUseId, answers }) => setStatus(describeAnswers(toolUseId, answers)),
      ConfirmedExitPlanMode: ({ toolUseId, confirmed, clearContext, message }) => setStatus(describePlan(toolUseId, confirmed, clearContext, message)),
      OpenedLocalLink: ({ target }) => setStatus(describeLocalLinkOpen(target)),
      OpenedChat: () => (model) => ({ model }),
      // The React gallery's handlers return nothing, so the press settles at once.
      RequestedQueueAction: ({ messageId, action }) => (model) => ({
        model: { ...model, status: describeQueued(messageId, action), messages: Messages.settledQueued(model.messages, messageId) },
      }),
      RequestedResumeAction: ({ action }) => (model) => ({
        model: { ...model, status: describeResume(action), messages: Messages.settledResume(model.messages, RESUME_KEY) },
      }),
      RequestedStop: () => setStatus(STOPPED),
    }),
})

export const RESUME_KEY = "usage-limit"

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotMessagesMessage: ({ message: child }) => foldMessages(model, child),
  })

/** One row-list item, embedded as the viewport does. */
export function item(model: Model, slotId: string, inputs: Messages.ViewInputs, h: HtmlBuilder<Message>): Html {
  return h.submodel({
    slotId,
    model: model.messages,
    view: Messages.view,
    viewInputs: inputs,
    toParentMessage: (message: Messages.Message) => Message.GotMessagesMessage({ message }),
  })
}

export function rowSections(
  model: Model,
  sections: ReadonlyArray<GallerySection>,
  options: Partial<Messages.RenderOptions>,
  h: HtmlBuilder<Message>,
  references: Omit<Partial<Messages.ViewInputs>, "item" | "options"> = {},
): Html[] {
  const all: Partial<Messages.RenderOptions> = { interceptLocalLinks: true, ...options }
  return sections.map((section) => h.section([h.AriaLabel(section.label), h.Class("mb-6")], [
    h.h2([h.Class("mx-auto mb-2 max-w-[816px] px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground")], [section.label]),
    ...section.rows.map((row) => h.keyed("div")(row.id, [h.Class(TRANSCRIPT_ROW_CLASS), h.DataAttribute("transcript-row-id", row.id)], [
      item(model, row.id, { ...references, item: { kind: "row", row }, options: all }, h),
    ])),
  ]))
}

export function shell(model: Model, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Document {
  return {
    title: "Kanna",
    // #root clips (index.css), so the page scrolls in here.
    body: h.div([h.DataAttribute("gallery-scroll", ""), h.Class("h-full overflow-y-auto bg-background py-4 px-3 text-foreground")], [
      h.p([h.Role("status"), h.Class("mx-auto mb-4 max-w-[816px] px-2 text-sm text-muted-foreground")], [model.status]),
      ...children,
    ]),
  }
}

/** A gallery page of row sections and whatever else `extra` draws under them. */
export function messagesPage(view: (model: Model, h: HtmlBuilder<Message>) => ReadonlyArray<Html>) {
  return galleryPage<Model, Message>({
    Model,
    init: () => ({ model: { status: NO_ACTION, messages: Messages.init() } }),
    update,
    view: (model, h) => shell(model, view(model, h), h),
  })
}
