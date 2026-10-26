import { Effect, Option, Schema } from "effect"
import { Command, Runtime, Submodel, Subscription } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { getLatestToolIds } from "../../../client/app/derived"
import { processTranscriptMessages } from "../../../client/lib/parseTranscript"
import { APP_NAME } from "../../../shared/branding"
import type { HydratedTranscriptMessage, StandaloneTranscriptBundle } from "../../../shared/types"
import { syncThemeMetadata } from "../../app/theme"
import { opaque } from "../../core/schema"
import { ChevronRight, Flower } from "../../ui/icons"
import * as Viewer from "../../viewer/standalone"
import * as Messages from "../messages"
import { Message as TranscriptMessage } from "../message"
import * as TranscriptModel from "../model"
import { NO_READ_ANCHOR, type TranscriptSource } from "../source"
import { step } from "../update"
import { transcriptView } from "../view"

// The standalone transcript viewer (src/export-viewer/main.tsx): a page that
// fetches the `transcript.json` exported beside it and shows it read-only,
// under its header and over a "Try It" banner. No socket: links are text,
// nothing is sent, and a payload the rows ask for is never there to fetch.

const MARKETING_URL = "https://kanna.sh"

const Bundle = opaque<StandaloneTranscriptBundle>("StandaloneTranscriptBundle")

export const Model = Schema.Struct({
  state: Schema.Union([
    Schema.TaggedStruct("Loading", {}),
    Schema.TaggedStruct("Failed", { message: Schema.String }),
    Schema.TaggedStruct("Ready", {
      bundle: Bundle,
      messages: opaque<HydratedTranscriptMessage[]>("HydratedTranscriptMessages"),
      latestToolIds: opaque<Record<string, string | null>>("LatestToolIds"),
    }),
  ]),
  transcript: TranscriptModel.Model,
  /** The page's title: index.html's until the export names it. */
  title: Schema.String,
  /** The viewer over the page, for the transcript's attachments and charts (ViewerLayer className="fixed"). */
  viewer: Viewer.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  SucceededLoad: { bundle: Bundle },
  FailedLoad: { message: Schema.String },
  CompletedApplyTheme: {},
  GotTranscriptMessage: { message: TranscriptMessage },
  GotViewerMessage: { message: Viewer.Message },
})
export type Message = typeof Message.Type

const LoadTranscript = Command.define("LoadExportedTranscript", {
  messages: [Message.SucceededLoad, Message.FailedLoad],
  execute: Effect.tryPromise(async () => {
    const response = await fetch(new URL("./transcript.json", document.baseURI).toString(), { headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error(`Transcript request failed with status ${response.status}`)
    return await response.json() as StandaloneTranscriptBundle
  }).pipe(
    Effect.map((bundle) => Message.SucceededLoad({ bundle })),
    Effect.catch((error) => Effect.succeed(Message.FailedLoad({
      message: error.cause instanceof Error ? error.cause.message : "Unable to load transcript.",
    }))),
  ),
})

/** The page takes the export's title and theme; the browser chrome follows a frame later. */
const ApplyTheme = Command.define("ApplyExportedTranscriptTheme", {
  args: { theme: Schema.Literals(["light", "dark"]) },
  messages: [Message.CompletedApplyTheme],
  execute: ({ theme }) => Effect.gen(function* () {
    document.documentElement.classList.toggle("dark", theme === "dark")
    document.documentElement.style.colorScheme = theme
    yield* Effect.callback<void>((resume) => {
      const frame = window.requestAnimationFrame(() => resume(Effect.void))
      return Effect.sync(() => window.cancelAnimationFrame(frame))
    })
    syncThemeMetadata(theme)
    return Message.CompletedApplyTheme()
  }),
})

export function init(): [Model, ReadonlyArray<Command.Command<Message>>] {
  return [{ state: { _tag: "Loading" }, transcript: TranscriptModel.init(), title: "Kanna Transcript", viewer: Viewer.init(null) }, [LoadTranscript()]]
}

/** The viewer with its transcript already in hand (the parity gallery): no fetch, the page's theme kept. */
export function initLoaded(bundle: StandaloneTranscriptBundle, title: string): Model {
  const messages = processTranscriptMessages(bundle.messages)
  return { state: { _tag: "Ready", bundle, messages, latestToolIds: getLatestToolIds(messages) }, transcript: TranscriptModel.init(), title, viewer: Viewer.init(bundle.chatId) }
}

const lift = (commands: ReadonlyArray<Command.Command<TranscriptMessage, never, unknown>>) =>
  Command.mapMessages(commands as never, (message: TranscriptMessage) => Message.GotTranscriptMessage({ message })) as unknown as ReadonlyArray<Command.Command<Message>>

function viewportKey(model: Model) {
  return `export:${model.state._tag === "Ready" ? model.state.bundle.chatId : "none"}`
}

const liftViewer = (commands: ReadonlyArray<Command.Command<Viewer.Message>>) =>
  Command.mapMessages(commands, (message: Viewer.Message) => Message.GotViewerMessage({ message })) as unknown as ReadonlyArray<Command.Command<Message>>

/**
 * The rows' asks with nobody to answer them: payloads aren't there. What
 * opens in the viewer (an attachment, a chart, a visualization) goes to the
 * page's own viewer; any other action goes nowhere.
 */
function rowsStep(model: Model, message: Messages.Message): { model: Model; commands: ReadonlyArray<Command.Command<Message>> } {
  const result = Messages.update(model.transcript.messages, message)
  let rows = result.model
  const out = result.outMessage
  if (out) {
    if (out._tag === "RequestedToolEntries") rows = Messages.failedToolEntries(rows, out.entryIds)
    if (out._tag === "RequestedDebugRaw") rows = Messages.receivedDebugRaw(rows, out.entryId, Option.some(null))
  }
  const commands = Command.mapMessages(result.commands, (inner: Messages.Message) => TranscriptMessage.GotMessagesMessage({ message: inner }))
  const next = modifyFields(model, { transcript: (transcript) => ({ ...transcript, messages: rows }) })
  if (out?._tag !== "RequestedAppAction") return { model: next, commands: lift(commands as never) }
  const applied = Viewer.apply(next.viewer, out.action)
  return { model: { ...next, viewer: applied.model }, commands: [...lift(commands as never), ...liftViewer(applied.commands)] }
}

export function update(model: Model, message: Message): [Model, ReadonlyArray<Command.Command<Message>>] {
  return Message.match<[Model, ReadonlyArray<Command.Command<Message>>]>(message, {
    SucceededLoad: ({ bundle }) => {
      const messages = processTranscriptMessages(bundle.messages)
      return [
        { ...model, state: { _tag: "Ready", bundle, messages, latestToolIds: getLatestToolIds(messages) }, title: `${bundle.title} | Kanna`, viewer: Viewer.init(bundle.chatId) },
        [ApplyTheme({ theme: bundle.theme })],
      ]
    },
    FailedLoad: ({ message: text }) => [{ ...model, state: { _tag: "Failed", message: text } }, []],
    CompletedApplyTheme: () => [model, []],
    GotViewerMessage: ({ message: inner }) => {
      const result = Viewer.update(model.viewer, inner)
      return [{ ...model, viewer: result.model }, liftViewer(result.commands)]
    },
    GotTranscriptMessage: ({ message: inner }) => {
      if (inner._tag === "GotMessagesMessage") {
        const result = rowsStep(model, inner.message)
        return [result.model, result.commands]
      }
      const shared = step(model.transcript, inner, { key: viewportKey(model) })
      if (!shared) return [model, []]
      return [{ ...model, transcript: shared.model }, lift(shared.commands as never)]
    },
  })
}

function source(model: Model, bundle: StandaloneTranscriptBundle, messages: HydratedTranscriptMessage[], latestToolIds: Record<string, string | null>): TranscriptSource {
  return {
    chatId: bundle.chatId,
    messages,
    queued: [],
    localPath: bundle.localPath,
    latestToolIds,
    isProcessing: false,
    runtimeStatus: null,
    waitingOn: undefined,
    isDraining: false,
    commandError: null,
    usageLimitResume: null,
    canResume: false,
    hasOlder: false,
    outline: undefined,
    isLoadingOlder: false,
    readAnchor: NO_READ_ANCHOR,
    reports: false,
    jump: null,
    headerOffsetPx: 20,
    transcriptPaddingBottom: 120,
    showEmptyState: false,
    isPageFileDragActive: false,
    // The export has no delay on it: the button follows the end directly.
    showScrollButton: !model.transcript.isAtEnd && messages.length > 0,
    parentChatId: null,
    currentProjectId: null,
    options: {
      readonly: true,
      localLinkMode: "text",
      sourceOrigin: bundle.sourceOrigin ?? null,
      attachmentMode: bundle.attachmentMode,
      interceptLocalLinks: true,
    },
    references: null,
    viewportKey: viewportKey(model),
    linkMenu: null,
  }
}

type H = HtmlBuilder<Message>

const transcriptSlot = Submodel.defineView<TranscriptModel.Model, TranscriptMessage, { source: TranscriptSource }>((transcript, inputs, h) =>
  transcriptView(transcript, inputs.source, {}, h))

function readyView(model: Model, bundle: StandaloneTranscriptBundle, messages: HydratedTranscriptMessage[], latestToolIds: Record<string, string | null>, h: H): Html {
  return h.div([h.Class("relative h-full bg-background")], [
    // The same viewer the app has, for the attachments and charts in the
    // transcript, over the whole page since there's no chat column here.
    h.submodel({
      slotId: "export-viewer-layer",
      model: model.viewer,
      view: Viewer.view,
      viewInputs: {},
      toParentMessage: (message: Viewer.Message) => Message.GotViewerMessage({ message }),
    }),
    h.div([h.Class("flex h-full min-h-0 flex-col overflow-hidden")], [
      h.header([h.Class("flex-shrink-0 border-b border-border px-4")], [
        h.div([h.Class("mx-auto flex h-16 w-full items-center gap-2 min-w-0")], [
          h.div([h.Class("flex items-center gap-2 min-w-0")], [
            h.a([h.Class("flex flex-shrink-0 items-center gap-2"), h.Href(MARKETING_URL), h.Target("_blank"), h.Rel("noopener noreferrer")], [
              Flower({ class: "h-5 w-5 sm:h-6 sm:w-6 text-logo" }, h),
              h.span([h.Class("font-logo text-base uppercase sm:text-lg text-slate-600 dark:text-slate-100")], [APP_NAME]),
            ]),
            h.span([h.Class("hidden text-sm text-muted-foreground sm:inline")], ["/"]),
            h.span([h.Class("truncate text-sm text-muted-foreground")], [bundle.title]),
          ]),
          h.div([h.Class("flex-1 md:hidden")], []),
        ]),
      ]),
      h.div([h.Class("relative flex h-full min-h-0 flex-col overflow-hidden")], [
        h.submodel({
          slotId: "transcript",
          model: model.transcript,
          view: transcriptSlot,
          viewInputs: { source: source(model, bundle, messages, latestToolIds) },
          toParentMessage: (message: TranscriptMessage) => Message.GotTranscriptMessage({ message }),
        }),
        h.div([h.Class("absolute bottom-4 left-1/2 z-20 w-full -translate-x-1/2 md:w-auto")], [
          h.div([h.Class("mx-2 flex items-center gap-3 rounded-xl border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur-lg md:mx-0")], [
            Flower({ class: "h-6 w-6 flex-shrink-0 text-logo" }, h),
            h.p([h.Class("flex-1 text-sm text-foreground sm:text-base")], ["Kanna is a delightful open-source harness UI"]),
            h.a([
              h.Class("ml-4 flex flex-shrink-0 flex-row items-center gap-1 rounded-lg bg-logo px-3 py-1.5 pr-2 text-sm font-bold text-white transition-colors hover:bg-logo/90"),
              h.Href(MARKETING_URL),
              h.Target("_blank"),
              h.Rel("noopener noreferrer"),
            ], [
              h.span([], ["Try It"]),
              ChevronRight({ class: "h-4 w-4 translate-y-[0.5px]" }, h),
            ]),
          ]),
        ]),
      ]),
    ]),
  ])
}

export function view(model: Model, h: H): Document {
  const state = model.state
  const body = state._tag === "Loading"
    ? h.div([h.Class("flex h-full items-center justify-center bg-background text-sm text-muted-foreground")], ["Loading transcript..."])
    : state._tag === "Failed"
      ? h.div([h.Class("flex h-full items-center justify-center bg-background px-6")], [
        h.div([h.Class("max-w-md rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground")], [state.message]),
      ])
      : readyView(model, state.bundle, state.messages, state.latestToolIds, h)
  return { title: model.title, body }
}

/**
 * The viewer's own: reduced motion, the layer's keys. Its chat preview's
 * subscriptions are typed on the socket, which this page has none of; they
 * only run while a chat is previewed, and nothing here previews one.
 */
export const subscriptions = Subscription.lift(Viewer.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.viewer),
  toParentMessage: (message: Viewer.Message) => Message.GotViewerMessage({ message }),
}) as never

/** The program, for `Runtime.makeApplication` (or a gallery page) with its own init. */
export const program = {
  Model,
  subscriptions,
  update: (model: Model, message: Message) => {
    const [next, commands] = update(model, message)
    return { model: next, commands }
  },
  view,
}

export function runExportViewer(container: HTMLElement) {
  Runtime.run(Runtime.makeApplication({
    ...program,
    init: () => {
      const [model, commands] = init()
      return { model, commands }
    },
    container,
  }))
}
