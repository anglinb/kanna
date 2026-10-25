import { Effect, Schema } from "effect"
import { Command, Mount, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { getTranscriptPaddingBottom } from "../../client/app/kannaStateHelpers"
import { hasFileDragTypes } from "../../client/app/ChatPage/utils"
import { deriveLatestContextWindowSnapshot } from "../../client/lib/contextWindow"
import { snapshotDroppedFiles } from "../../client/lib/snapshotDroppedFiles"
import { cn } from "../../client/lib/utils"
import { viewerLevelBelow } from "../../client/lib/viewer-levels"
import { PROVIDERS, withPiFaveModels } from "../../shared/types"
import { AppAction } from "../app/action"
import { AppRoute } from "../app/route"
import type { AppModel } from "../app/slice"
import * as Stores from "../app/stores"
import { openChatActions, sidebarThread } from "../chat/chatReference"
import type { ChatPageRequests } from "../chat/pageInputs"
import * as Composer from "../composer"
import * as ChatSession from "../core/chatSession"
import type { KannaSocketService } from "../core/socket"
import * as AppSettings from "../core/stores/appSettings"
import * as ChatPreferences from "../core/stores/chatPreferences"
import * as PendingSend from "../core/stores/pendingSend"
import * as Sidebar from "../core/stores/sidebar"
import * as ViewerStore from "../core/stores/viewer"
import * as Transcript from "../transcript"
import { Message as TranscriptMessage } from "../transcript/message"
import * as TranscriptModel from "../transcript/model"
import { pageSource, type TranscriptSource } from "../transcript/source"
import { transcriptView } from "../transcript/view"
import { ArrowLeft, MessageCircle, SquareArrowOutUpRight } from "../ui/icons"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"
import type { Model } from "./model"
import type { PreviewModel } from "./previewModel"
import { chatStatusDot } from "./statusDot"
import { viewerIconButton, viewerSurface, type LayerContext } from "./surface"

// ChatPreview (app/ChatPage/ChatPreview.tsx): another chat in the viewer, the
// chat itself, live, with a composer that sends to it. Built from the main
// view's own parts (the transcript and the composer) on a second chat
// session (core/chatSession.ts, as React built it on useChatSession), so it
// is not a summary of the chat: tool calls open, older messages load,
// questions can be answered and a turn can be stopped.
//
// The transcript and the composer ask the root for things as the page's
// do; what they ask of "the chat" (`AppAction.Chat`) is this session's,
// and a chat opened from in here opens as one clicked in the previewer
// (`from: "preview"`): it replaces this one and leaves a way back.

type H = HtmlBuilder<Message>
type AnyCommand = Command.Command<Message, never, KannaSocketService>

export const PREVIEW_CARD_KEY = "chat"

/** The transcript starts under the card's header, so all it clears at the top is a little air. */
const PREVIEW_HEADER_OFFSET_PX = 12

type ChatItem = Extract<ViewerStore.ViewerItem, { kind: "chat" }>

// THE SESSION'S VIEW OF THE ROOT

/** The root as the previewed chat's transcript reads it: the route and the chat are the previewed one's. */
export function previewApp(app: AppModel, preview: PreviewModel): AppModel {
  return { ...app, route: AppRoute.Chat({ chatId: preview.chatId }), chat: preview.session, commandError: preview.commandError }
}

function windowSize(app: AppModel) {
  return AppSettings.appSettings(app.stores.appSettings)?.transcript?.windowAssistantMessages ?? 50
}

function projectOf(app: AppModel, preview: PreviewModel) {
  const runtime = ChatSession.snapshotOf(preview.session)?.runtime ?? null
  const thread = sidebarThread(app, preview.chatId)
  return {
    projectId: runtime?.projectId ?? thread?.projectId ?? null,
    projectPath: runtime?.localPath ?? thread?.row.localPath ?? null,
  }
}

export function previewSource(app: AppModel, preview: PreviewModel, transcript: TranscriptModel.Model): TranscriptSource {
  const source = pageSource(previewApp(app, preview), undefined, transcript)
  const { projectPath } = projectOf(app, preview)
  return {
    ...source,
    localPath: projectPath ?? undefined,
    headerOffsetPx: PREVIEW_HEADER_OFFSET_PX,
    transcriptPaddingBottom: getTranscriptPaddingBottom(preview.dockHeight),
    showEmptyState: false,
    isPageFileDragActive: false,
    jump: null,
  }
}

export function previewComposerProps(app: AppModel, preview: PreviewModel): Composer.ComposerProps {
  const { chatId, session } = preview
  const snapshot = ChatSession.snapshotOf(session)
  const thread = sidebarThread(app, chatId)
  const title = thread?.title ?? "Chat"
  const sidebarStatus = Sidebar.sidebarChatStatus(app.stores.sidebar, chatId)
  const { projectId, projectPath } = projectOf(app, preview)
  const settings = AppSettings.appSettings(app.stores.appSettings)
  const fallbackProviders = withPiFaveModels(settings?.availableProviders ?? PROVIDERS, app.llmProvider?.faveModels ?? [])
  return {
    chatId,
    projectId,
    projectPath,
    projectRepoLabel: Sidebar.navbarRepoLabel(app.stores.sidebar, projectId, projectPath ?? undefined),
    disabled: false,
    canCancel: ChatSession.canCancel(session, sidebarStatus),
    activeProvider: snapshot?.runtime.provider ?? thread?.row.provider ?? null,
    accountIds: snapshot?.runtime.accountIds,
    availableProviders: ChatSession.availableProviders(session, fallbackProviders),
    contextWindowSnapshot: deriveLatestContextWindowSnapshot(snapshot?.messages ?? []),
    previousPrompt: ChatSession.previousPrompt(session),
    listSkills: true,
    editModels: true,
    placeholder: `Message ${title}`,
    secondary: true,
    delegate: null,
  }
}

// UPDATE

export interface PreviewStep {
  preview: PreviewModel
  commands: AnyCommand[]
  actions: AppAction[]
}

const liftSession = (chatId: string, commands: ReadonlyArray<Command.Command<ChatSession.Message, never, unknown>> | undefined) =>
  Command.mapMessages((commands ?? []) as never, (message: ChatSession.Message) => Message.GotPreviewSessionMessage({ chatId, message })) as unknown as AnyCommand[]
const liftTranscript = (chatId: string, commands: ReadonlyArray<Command.Command<TranscriptMessage, never, unknown>> | undefined) =>
  Command.mapMessages((commands ?? []) as never, (message: TranscriptMessage) => Message.GotPreviewTranscriptMessage({ chatId, message })) as unknown as AnyCommand[]
const liftComposer = (chatId: string, commands: ReadonlyArray<Command.Command<Composer.Message, never, unknown>> | undefined) =>
  Command.mapMessages((commands ?? []) as never, (message: Composer.Message) => Message.GotPreviewComposerMessage({ chatId, message })) as unknown as AnyCommand[]

const store = (message: Stores.Message) => AppAction.Store({ message })
const viewerStore = (message: ViewerStore.Message) => store(Stores.Message.GotViewerMessage({ message }))

/** A new session for `chatId` (ChatPreviewSession mounting), holding its live subscription. */
export function openPreview(app: AppModel, chatId: string, fadesIn: boolean): PreviewStep {
  const opened = ChatSession.init(chatId, { windowSize: windowSize(app), starting: false })
  return {
    preview: {
      chatId,
      session: opened.model,
      transcript: TranscriptModel.init(),
      composer: Composer.init(),
      dockHeight: 0,
      fadesIn,
      commandError: null,
    },
    commands: liftSession(chatId, opened.commands),
    // Tells the background follower this chat has a full-rate subscription.
    actions: [viewerStore(ViewerStore.Message.HeldLiveChat({ chatId }))],
  }
}

/** The session going away: its read position and cache write go out, and the live hold is let go. */
export function closePreview(preview: PreviewModel): { commands: AnyCommand[]; actions: AppAction[] } {
  const closed = ChatSession.close(preview.session, Date.now())
  return {
    commands: liftSession(preview.chatId, closed.commands),
    actions: [viewerStore(ViewerStore.Message.ReleasedLiveChat({ chatId: preview.chatId }))],
  }
}

function flatten(action: AppAction): AppAction[] {
  return action._tag === "Batch" ? (action.actions as AppAction[]).flatMap(flatten) : [action]
}

/** What the transcript and the composer asked for: this chat's go to its session, the rest to the root. */
function routeActions(app: AppModel, step: PreviewStep, asked: ReadonlyArray<AppAction>): PreviewStep {
  let next = step
  for (const action of asked.flatMap(flatten)) {
    if (action._tag === "Chat") {
      const result = sessionStep(app, next.preview, action.message)
      next = { preview: result.preview, commands: [...next.commands, ...result.commands], actions: [...next.actions, ...result.actions] }
    } else {
      next = { ...next, actions: [...next.actions, action] }
    }
  }
  return next
}

export function sessionStep(app: AppModel, preview: PreviewModel, message: ChatSession.Message): PreviewStep {
  const sidebarStatus = Sidebar.sidebarChatStatus(app.stores.sidebar, preview.chatId)
  const result = ChatSession.update(preview.session, message, { windowSize: windowSize(app), sidebarStatus })
  let step: PreviewStep = { preview: { ...preview, session: result.model }, commands: liftSession(preview.chatId, result.commands), actions: [] }
  const out = result.outMessage
  if (!out) return step
  return ChatSession.OutMessage.match<PreviewStep>(out, {
    ChangedCommandError: ({ message: error }) => ({ ...step, preview: { ...step.preview, commandError: error } }),
    MarkedSending: ({ chatId, sentAt }) => ({ ...step, actions: [store(Stores.Message.GotPendingSendMessage({ message: PendingSend.Message.StartedSending({ chatId, sentAt }) }))] }),
    ClearedSending: ({ chatId }) => ({ ...step, actions: [store(Stores.Message.GotPendingSendMessage({ message: PendingSend.Message.ClearedSending({ chatId }) }))] }),
    SucceededSend: () => composerStep(app, step.preview, Composer.Message.SucceededSend(), step),
    FailedSend: ({ content, error }) => {
      step = { ...step, preview: { ...step.preview, commandError: error } }
      return composerStep(app, step.preview, Composer.Message.FailedSend({ content, error }), step)
    },
    ConfirmedExitPlanMode: ({ chatId }) => ({
      ...step,
      actions: [store(Stores.Message.GotChatPreferencesMessage({ message: ChatPreferences.Message.ClearedChatComposerPlanMode({ chatId }) }))],
    }),
  })
}

export function composerStep(app: AppModel, preview: PreviewModel, message: Composer.Message, before: PreviewStep | null = null): PreviewStep {
  const context = { props: previewComposerProps(app, preview), stores: app.stores }
  const result = Composer.updateWith(preview.composer, message, context)
  const step: PreviewStep = {
    preview: { ...preview, composer: result.model },
    commands: [...(before?.commands ?? []), ...liftComposer(preview.chatId, result.commands as never)],
    actions: [...(before?.actions ?? [])],
  }
  const out = result.outMessage
  return out ? routeActions(app, step, [out.action]) : step
}

export function transcriptStep(app: AppModel, preview: PreviewModel, message: TranscriptMessage): PreviewStep {
  // A chat opened from in here is a click in the previewer.
  const opened = message._tag === "ClickedChatCard"
    ? message.chatId
    : message._tag === "GotMessagesMessage" && message.message._tag === "ClickedChatLink"
      ? message.message.chatId
      : null
  if (opened) return { preview, commands: [], actions: openChatActions(app, opened, { from: "preview" }) }
  const result = Transcript.update(preview.transcript, message, previewApp(app, preview))
  const step: PreviewStep = { preview: { ...preview, transcript: result.model }, commands: liftTranscript(preview.chatId, result.commands as never), actions: [] }
  const out = result.outMessage
  return out ? routeActions(app, step, [out.action]) : step
}

// MOUNTS

/** ChatPreviewSession mounted for a chat: its session starts. */
export const MountPreviewSession = Mount.define("ViewerMountPreviewSession", {
  args: { chatId: Schema.String, fadesIn: Schema.Boolean },
  messages: [Message.MountedPreviewSession],
  execute: ({ chatId, fadesIn }) => Effect.succeed(Message.MountedPreviewSession({ chatId, fadesIn })),
})

/** A chat deleted while it is in the previewer has nothing to show. */
export const ReportLostChat = Mount.define("ViewerReportLostChat", {
  messages: [Message.LostPreviewedChat],
  execute: () => Effect.succeed(Message.LostPreviewedChat()),
})

/** The composer dock's height (useTranscriptPaddingBottom). */
export const ObservePreviewDock = Mount.defineStream("ViewerObservePreviewDock", {
  args: { chatId: Schema.String },
  messages: [Message.ResizedPreviewDock],
  execute: ({ element, chatId }) => domStream<typeof Message.ResizedPreviewDock.Type>((emit) => {
    const read = () => emit(Message.ResizedPreviewDock({ chatId, height: element.getBoundingClientRect().height }))
    const observer = new ResizeObserver(read)
    observer.observe(element)
    read()
    return () => observer.disconnect()
  }),
})

/**
 * Files dropped on the previewed chat go to its composer. Handled here even
 * though the page has a drop target of its own: a drop that nothing takes
 * makes the browser open the file.
 */
export const PreviewFileDrop = Mount.defineStream("ViewerPreviewFileDrop", {
  args: { chatId: Schema.String },
  messages: [Message.GotPreviewComposerMessage],
  execute: ({ element, chatId }) => domStream<typeof Message.GotPreviewComposerMessage.Type>((emit) => {
    const onDragOver = (raw: Event) => {
      const event = raw as DragEvent
      if (!hasFileDragTypes(event.dataTransfer?.types ?? [])) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    }
    const onDrop = (raw: Event) => {
      const event = raw as DragEvent
      if (!hasFileDragTypes(event.dataTransfer?.types ?? [])) return
      event.preventDefault()
      void snapshotDroppedFiles([...(event.dataTransfer?.files ?? [])]).then((files) => {
        emit(Message.GotPreviewComposerMessage({ chatId, message: Composer.Message.ReceivedFiles({ files }) }))
      })
    }
    element.addEventListener("dragover", onDragOver)
    element.addEventListener("drop", onDrop)
    return () => {
      element.removeEventListener("dragover", onDragOver)
      element.removeEventListener("drop", onDrop)
    }
  }),
})

export const OpenPreviewInTab = Command.define("ViewerOpenPreviewInTab", {
  messages: [Message.CompletedSideEffect],
  execute: Effect.succeed(Message.CompletedSideEffect()),
})

// VIEW

const PreviewTranscriptSlot = Submodel.defineView<TranscriptModel.Model, TranscriptMessage, { source: TranscriptSource }>((transcript, inputs, h) =>
  transcriptView(transcript, inputs.source, {}, h))

export function chatPreview(
  model: Model,
  context: LayerContext,
  app: AppModel,
  requests: ChatPageRequests | undefined,
  item: ChatItem,
  h: H,
): Html {
  const { chatId } = item
  const thread = sidebarThread(app, chatId)
  const parentThread = sidebarThread(app, thread?.row.parentChatId)
  const backChatId = item.back?.[item.back.length - 1] ?? null
  const backThread = sidebarThread(app, backChatId)
  const floor = app.stores.viewer.floor
  // What Back goes to, which the pane's levels say (`viewerLevelBelow`).
  const below = viewerLevelBelow({ item }, floor)
  const backLabel = below === "closed"
    ? null
    : below.item.kind === "chat"
      ? (backThread ? `Back to ${backThread.title}` : "Back")
      : "Back to delegated chats"
  const chatTabsEnabled = app.stores.appSettings.settings?.chatTabsEnabled === true
  const title = thread?.title ?? "Chat"
  const statusDot = thread && !thread.archived ? chatStatusDot(thread.row, h) : null
  const motion = model.card?.key === PREVIEW_CARD_KEY ? model.card : context.motion
  const live = model.card?.key === PREVIEW_CARD_KEY && model.preview?.chatId === chatId ? model.preview : null

  return viewerSurface(model, context, {
    cardKey: PREVIEW_CARD_KEY,
    label: `Chat ${title}`,
    icon: statusDot ?? MessageCircle({}, h),
    title,
    subtitle: thread?.archived ? "Archived" : parentThread ? `Sub-chat of ${parentThread.title}` : null,
    leading: backLabel ? viewerIconButton(model, { id: "preview-back", label: backLabel, onClick: Message.ClickedBack() }, ArrowLeft({}, h), h) : null,
    toolbar: [
      viewerIconButton(model, {
        id: "preview-open",
        label: chatTabsEnabled ? "Open in tab" : "Open chat",
        onClick: Message.ClickedOpenPreviewInTab({ chatId }),
      }, SquareArrowOutUpRight({}, h), h),
    ],
    bodyClassName: "overflow-hidden",
    fieldsKeepEscape: true,
    body: [
      previewSession(app, requests, chatId, live, motion.bodyEnters || motion.cardEnters, h),
      // A chat deleted while it is in the previewer: shut the pane past it.
      app.stores.sidebar.ready && !Sidebar.chatExists(app.stores.sidebar, chatId)
        ? h.keyed("span")(`preview-lost:${chatId}`, [h.Hidden(true), h.OnMount(ReportLostChat())], [])
        : null,
    ],
  }, h)
}

/** The previewed chat while it is subscribed. Keyed per chat, so nothing in it resets by hand. */
function previewSession(app: AppModel, requests: ChatPageRequests | undefined, chatId: string, live: PreviewModel | null, fadesIn: boolean, h: H): Html {
  // Until its session starts, the chat's skeleton: the composer and an empty column.
  const preview: PreviewModel = live ?? {
    chatId,
    session: ChatSession.init(chatId, { windowSize: windowSize(app), starting: false }).model,
    transcript: TranscriptModel.init(),
    composer: Composer.init(),
    dockHeight: 0,
    fadesIn,
    commandError: null,
  }
  const transcriptReady = preview.session.messages.length > 0 || ChatSession.snapshotOf(preview.session) !== null
  return h.keyed("div")(`preview-session:${chatId}`, [
    h.Class("relative flex h-full min-h-0 flex-col overflow-hidden"),
    // The transcript publishes its scrollbar's width on the card it is in (useScrollbarGutterVar).
    h.DataAttribute("chat-card", ""),
    h.OnMount(PreviewFileDrop({ chatId })),
  ], [
    h.div([
      ...(transcriptReady ? [h.DataAttribute("ready", "")] : []),
      h.Class(cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden opacity-0 data-[ready]:opacity-100",
        preview.fadesIn && "transition-opacity duration-150 ease-snappy motion-reduce:transition-none",
      )),
    ], [
      h.submodel({
        slotId: `preview-transcript:${chatId}`,
        model: preview.transcript,
        view: PreviewTranscriptSlot,
        viewInputs: { source: previewSource(app, preview, preview.transcript) },
        toParentMessage: (message: TranscriptMessage) => Message.GotPreviewTranscriptMessage({ chatId, message }),
      }),
    ]),
    // ChatInputDock
    h.div([h.Class("absolute bottom-0 left-0 right-0 z-20 pointer-events-none")], [
      h.div([h.Class("relative pointer-events-auto"), h.OnMount(ObservePreviewDock({ chatId }))], [
        h.div([h.Class("absolute inset-y-0 left-0 right-[var(--transcript-scrollbar-w,0px)] bg-gradient-to-t from-surface via-surface to-surface/10 md:to-surface/0 pointer-events-none")], []),
        h.div([h.Class("relative")], [
          h.submodel({
            slotId: `preview-composer:${chatId}`,
            model: preview.composer,
            view: Composer.view,
            viewInputs: { app, props: previewComposerProps(app, preview), ...(requests ? { requests } : {}) },
            toParentMessage: (message: Composer.Message) => Message.GotPreviewComposerMessage({ chatId, message }),
          }),
        ]),
      ]),
    ]),
    live ? null : h.keyed("span")(`preview-mount:${chatId}`, [h.Hidden(true), h.OnMount(MountPreviewSession({ chatId, fadesIn }))], []),
  ])
}

export { TranscriptMessage }
