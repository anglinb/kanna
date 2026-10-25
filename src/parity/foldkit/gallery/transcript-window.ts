// src/foldkit/transcript over a window of a longer chat, against the React
// viewport (gallery/transcript-window.tsx) on the same fixture: Load More,
// the older slice landing in front, the minimap's turns before the window.
// What the viewport asks of the page's chat (load older) is answered here
// after 50ms, as the React page answers it.
import { Effect, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { getLatestToolIds } from "../../../client/app/derived"
import { processTranscriptMessages } from "../../../client/lib/parseTranscript"
import { olderStart, WINDOW_CHAT_ID, windowFixture } from "../../../foldkit/transcript/fixture"
import * as Messages from "../../../foldkit/transcript/messages"
import { Message as TranscriptMessage } from "../../../foldkit/transcript/message"
import * as TranscriptModel from "../../../foldkit/transcript/model"
import { NO_READ_ANCHOR, type TranscriptSource } from "../../../foldkit/transcript/source"
import { step } from "../../../foldkit/transcript/update"
import { transcriptView } from "../../../foldkit/transcript/view"
import { galleryPage } from "../gallery-page"

const FIXTURE = windowFixture()
const LOAD_MS = 50
const KEY = `gallery:${WINDOW_CHAT_ID}`

const Model = Schema.Struct({
  transcript: TranscriptModel.Model,
  start: Schema.Number,
  loading: Schema.Boolean,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotTranscriptMessage: { message: TranscriptMessage },
  LandedOlder: { untilMessageId: Schema.NullOr(Schema.String) },
})
type Message = typeof Message.Type

const LoadOlder = Command.define("GalleryLoadOlder", {
  args: { untilMessageId: Schema.NullOr(Schema.String) },
  messages: [Message.LandedOlder],
  execute: ({ untilMessageId }) => Effect.sleep(LOAD_MS).pipe(Effect.as(Message.LandedOlder({ untilMessageId }))),
})

type Commands = ReadonlyArray<Command.Command<Message>>

const lift = (commands: ReadonlyArray<unknown>) =>
  Command.mapMessages(commands as never, (message: TranscriptMessage) => Message.GotTranscriptMessage({ message })) as unknown as Commands

let messagesCache: { start: number; messages: ReturnType<typeof processTranscriptMessages> } | null = null
function messagesFrom(start: number) {
  if (messagesCache?.start !== start) messagesCache = { start, messages: processTranscriptMessages(FIXTURE.entries.slice(start)) }
  return messagesCache.messages
}

function update(model: Model, message: Message): { model: Model; commands: Commands } {
  if (message._tag === "LandedOlder") {
    return { model: { ...model, start: olderStart(FIXTURE, model.start, message.untilMessageId), loading: false }, commands: [] }
  }
  const inner = message.message
  if (inner._tag === "GotMessagesMessage") {
    const result = Messages.update(model.transcript.messages, inner.message)
    let rows = result.model
    if (result.outMessage?._tag === "RequestedToolEntries") rows = Messages.failedToolEntries(rows, result.outMessage.entryIds)
    const commands = Command.mapMessages(result.commands, (child: Messages.Message) => TranscriptMessage.GotMessagesMessage({ message: child }))
    return { model: { ...model, transcript: { ...model.transcript, messages: rows } }, commands: lift(commands) }
  }
  const shared = step(model.transcript, inner, { key: KEY })
  if (!shared) return { model, commands: [] }
  let next: Model = { ...model, transcript: shared.model }
  const commands: Array<Command.Command<Message>> = [...lift(shared.commands)]
  for (const action of shared.actions) {
    if (action._tag === "Chat" && action.message._tag === "ClickedLoadOlder") {
      next = { ...next, loading: true }
      commands.push(LoadOlder({ untilMessageId: action.message.untilMessageId }))
    }
  }
  return { model: next, commands }
}

function source(model: Model): TranscriptSource {
  const messages = messagesFrom(model.start)
  return {
    chatId: WINDOW_CHAT_ID,
    messages,
    queued: [],
    localPath: "/Users/demo/code/tidepool",
    latestToolIds: getLatestToolIds(messages),
    isProcessing: false,
    runtimeStatus: null,
    waitingOn: undefined,
    isDraining: false,
    commandError: null,
    usageLimitResume: null,
    canResume: false,
    hasOlder: model.start > 0,
    outline: FIXTURE.outline,
    isLoadingOlder: model.loading,
    readAnchor: NO_READ_ANCHOR,
    reports: false,
    jump: null,
    headerOffsetPx: 20,
    transcriptPaddingBottom: 120,
    showEmptyState: false,
    isPageFileDragActive: false,
    showScrollButton: !model.transcript.isAtEnd && messages.length > 0,
    parentChatId: null,
    currentProjectId: null,
    options: { interceptLocalLinks: true },
    references: null,
    viewportKey: KEY,
    linkMenu: null,
  }
}

const transcriptSlot = Submodel.defineView<TranscriptModel.Model, TranscriptMessage, { source: TranscriptSource }>((transcript, inputs, h) =>
  transcriptView(transcript, inputs.source, {}, h))

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { transcript: TranscriptModel.init(), start: FIXTURE.initialStart, loading: false } }),
  update,
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("relative h-full bg-background")], [
      h.div([h.Class("relative flex h-full min-h-0 flex-col overflow-hidden")], [
        h.submodel({
          slotId: "transcript",
          model: model.transcript,
          view: transcriptSlot,
          viewInputs: { source: source(model) },
          toParentMessage: (message: TranscriptMessage) => Message.GotTranscriptMessage({ message }),
        }),
      ]),
    ]),
  }),
})

