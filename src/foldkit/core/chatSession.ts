import { Effect, Equivalence, Option, Schema, Stream } from "effect"
import { measureReadAnchor } from "./readAnchorMeasure"
import { Command, Dom, Render, Subscription, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import {
  latchReadAnchor,
  readRememberedReadAnchor,
  rememberReadAnchor,
  sameReadAnchor,
  type LatchedReadAnchor,
  type RememberedReadAnchor,
} from "../../client/app/chatReadAnchorCache"
import {
  canPaintCachedWindow,
  cachedWindowToMessages,
  createTranscriptCacheWriter,
  readCachedWindow,
  readMemoryCachedWindow,
  trimCachedWindow,
  type CachedTranscriptWindow,
} from "../../client/app/chatTranscriptCache"
import { canCancelStatus, getLatestToolIds, hasNoTurnStatus, isProcessingStatus } from "../../client/app/derived"
import {
  countMatchingUserPrompts,
  getPreviousPrompt,
  getUserPromptSignature,
  reconcileOptimisticUserPrompts,
  type OptimisticUserPrompt,
} from "../../client/app/kannaStateHelpers"
import { foldChatSnapshot } from "./snapshotEquality"
import { processTranscriptMessages } from "../../client/lib/parseTranscript"
import { generateUUID } from "../../client/lib/utils"
import type { SubscriptionTopic } from "../../shared/protocol"
import type {
  AgentProvider,
  AskUserQuestionAnswerMap,
  ChatAttachment,
  ChatSnapshot,
  HydratedTranscriptMessage,
  ModelOptions,
  ProviderCatalogEntry,
  ResolvedChatReadAnchor,
  TranscriptEntry,
} from "../../shared/types"
import { opaque } from "./schema"
import { errorMessage, sendCommand, topicStream, type KannaSocketService } from "./socket"

// One chat, live: its transcript window, status, queue, and what drives
// them. The page's chat and the previewer's each hold one. Port of the chat
// half of useKannaState, useChatSession, useSendMessage, useChatCommands'
// per-chat handlers and useChatReadAnchor, which those shared.
//
// The subscription carries the span the local cache holds, so the server
// answers with a tail; a reconnect resubscribes naming what is held by then.
// Snapshots fold with `foldChatSnapshot`. A sent prompt shows at once
// (optimistic) and is reconciled against the server's transcript by content
// signature. The read position is latched once per chat and written back,
// throttled.

/** How long an open waits on the disk cache before subscribing without it. */
const DISK_CACHE_WAIT_MS = 30
/**
 * Minimum gap between `chat.setReadAnchor` writes while the user keeps
 * scrolling. Also bounds how long after they stop before the final position
 * lands (the trailing write fires at most this late).
 */
const READ_ANCHOR_WRITE_INTERVAL_MS = 1500
/** How long the optimistic "starting" holds after the ack if no push comes. */
const OPTIMISTIC_ACK_FALLBACK_MS = 5_000

export interface SendOptions {
  accountId?: string
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
  autoPlan?: boolean
  attachments?: ChatAttachment[]
  steer?: boolean
}

export interface ReadAnchorLayout {
  transcriptWidth: number
  offsetFromMessage: number
}

type Span = { start: number; end: number; endEntryId: string }

const SpanSchema = Schema.Struct({ start: Schema.Number, end: Schema.Number, endEntryId: Schema.String })

export const Model = Schema.Struct({
  chatId: Schema.String,
  /** The chat's snapshot, folded. Null until the first push. */
  snapshot: Schema.NullOr(opaque<ChatSnapshot>("ChatSnapshot")),
  /** The cached window the first incremental push builds on. */
  base: Schema.NullOr(opaque<Pick<ChatSnapshot, "messages" | "startIndex">>("TranscriptWindow")),
  /** Drawn until the snapshot comes, when it can be drawn in place. */
  cachedTranscript: Schema.NullOr(opaque<CachedTranscriptWindow>("CachedTranscriptWindow")),
  /** The cache has been read (or given up on): the subscription may start. */
  cacheResolved: Schema.Boolean,
  /** The span named in the first subscribe. */
  subscribeSpan: Schema.NullOr(SpanSchema),
  chatReady: Schema.Boolean,
  /** Pushes received; lets the optimistic status tell whether it heard back. */
  snapshotSeq: Schema.Number,
  optimisticPrompts: Schema.Array(opaque<OptimisticUserPrompt>("OptimisticUserPrompt")),
  optimisticProcessing: Schema.NullOr(Schema.Struct({
    /** Set once `chat.send` is acked: the push count then, and a token for its timer. */
    acked: Schema.NullOr(Schema.Struct({ atSeq: Schema.Number, token: Schema.Number })),
  })),
  ackTokens: Schema.Number,
  isLoadingOlder: Schema.Boolean,
  /** Hydrated rows, kept so a push that appended entries hydrates only those. */
  messages: opaque<HydratedTranscriptMessage[]>("HydratedTranscriptMessages"),
  readAnchor: Schema.Struct({
    latch: opaque<LatchedReadAnchor>("LatchedReadAnchor"),
    pending: Schema.NullOr(Schema.Struct({
      messageId: Schema.String,
      atEnd: Schema.Boolean,
      layout: Schema.NullOr(Schema.Struct({ transcriptWidth: Schema.Number, offsetFromMessage: Schema.Number })),
      settled: Schema.Boolean,
    })),
    timerScheduled: Schema.Boolean,
    /**
     * The scheduled write is the throttle's first (no wait): the hook's
     * timer then ran before the next frame, on the position as it was
     * reported, so the write keeps the report's own measure.
     */
    immediate: Schema.Boolean,
    lastWriteAt: Schema.Number,
    lastWrittenKey: Schema.NullOr(Schema.String),
  }),
})
export type Model = typeof Model.Type

export const OutMessage = defineMessageUnion({
  /** What setCommandError was called with. The host decides where it shows. */
  ChangedCommandError: { message: Schema.NullOr(Schema.String) },
  /** pendingSendStore's markSending / clearSending. */
  MarkedSending: { chatId: Schema.String, sentAt: Schema.Number },
  ClearedSending: { chatId: Schema.String },
  /** A send went through; the composer's draft is gone for good. */
  SucceededSend: {},
  /**
   * A send failed: the error is the command error, and the composer puts
   * its draft back (handleSend threw).
   */
  FailedSend: { content: Schema.String, error: Schema.String },
  /** ExitPlanMode was confirmed: plan mode clears on this chat's composer. */
  ConfirmedExitPlanMode: { chatId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

export const Message = defineMessageUnion({
  ResolvedCache: {
    window: Schema.NullOr(opaque<CachedTranscriptWindow>("CachedTranscriptWindow")),
    remembered: Schema.NullOr(opaque<RememberedReadAnchor>("RememberedReadAnchor")),
    /** The disk read lost the race; a late result may still paint. */
    timedOut: Schema.Boolean,
  },
  ReadLateDiskCache: { window: Schema.NullOr(opaque<CachedTranscriptWindow>("CachedTranscriptWindow")) },
  ReceivedSnapshot: { snapshot: Schema.NullOr(opaque<ChatSnapshot>("ChatSnapshot")) },
  RequestedResubscribe: {},

  SubmittedMessage: { content: Schema.String, options: opaque<SendOptions>("SendOptions") },
  PreparedSend: { content: Schema.String, options: opaque<SendOptions>("SendOptions"), optimisticId: Schema.String, sentAt: Schema.Number },
  SucceededEnqueue: {},
  FailedEnqueue: { content: Schema.String, error: Schema.String },
  SucceededChatSend: { optimisticId: Schema.String },
  FailedChatSend: { optimisticId: Schema.String, content: Schema.String, error: Schema.String },
  ElapsedOptimisticAck: { token: Schema.Number },

  ClickedLoadOlder: { untilMessageId: Schema.NullOr(Schema.String), all: Schema.Boolean },
  CompletedLoadOlder: {},
  FailedLoadOlder: { error: Schema.String },

  ClickedSteerQueued: { queuedMessageId: Schema.String },
  ClickedRemoveQueued: { queuedMessageId: Schema.String },
  ClickedUsageLimitResume: { action: Schema.Literals(["cancel", "now"]) },
  ClickedCancel: {},
  ClickedStopDraining: {},
  AnsweredQuestion: { toolUseId: Schema.String, questions: Schema.Array(Schema.Unknown), answers: opaque<AskUserQuestionAnswerMap>("AskUserQuestionAnswerMap") },
  AnsweredExitPlanMode: { toolUseId: Schema.String, confirmed: Schema.Boolean, clearContext: Schema.Boolean, message: Schema.NullOr(Schema.String) },
  /** Commands whose ack clears the command error. */
  SucceededCommand: {},
  /** Commands whose ack leaves it alone (cancel, stop draining, tool responses). */
  CompletedCommand: {},
  FailedCommand: { error: Schema.String },

  /** The transcript reports what is at the top of its viewport. */
  ReportedReadAnchor: {
    messageId: Schema.String,
    atEnd: Schema.Boolean,
    layout: Schema.NullOr(Schema.Struct({ transcriptWidth: Schema.Number, offsetFromMessage: Schema.Number })),
    at: Schema.Number,
    /** No render was outstanding as the transcript took it: the page showed its Model. */
    settled: Schema.Boolean,
  },
  ElapsedReadAnchorTimer: { at: Schema.Number },
  ChangedVisibility: { hidden: Schema.Boolean, at: Schema.Number },
  CompletedSideEffect: {},
})
export type Message = typeof Message.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, KannaSocketService>

// INIT

export function init(
  chatId: string,
  options: {
    windowSize: number
    starting: boolean
    /** When the last read position went out from any chat: the hook's throttle outlived a chat. */
    readAnchorLastWriteAt?: number
  },
): Update.Return<Model, Message, KannaSocketService> {
  return {
    model: {
      chatId,
      snapshot: null,
      base: null,
      cachedTranscript: null,
      cacheResolved: false,
      subscribeSpan: null,
      chatReady: false,
      snapshotSeq: 0,
      optimisticPrompts: [],
      optimisticProcessing: null,
      ackTokens: 0,
      isLoadingOlder: false,
      messages: [],
      readAnchor: {
        latch: { chatId: null, anchor: null, source: "none" },
        pending: null,
        timerScheduled: false,
        immediate: false,
        lastWriteAt: options.readAnchorLastWriteAt ?? 0,
        lastWrittenKey: null,
      },
    },
    commands: [LoadCache({ chatId, windowSize: options.windowSize, starting: options.starting })],
  }
}

// COMMANDS

/**
 * Memory seeds the subscription at once. On a miss the disk read gets a
 * short head start: it averages under 10 ms, and a subscription that names
 * the span it holds gets a tail back instead of the whole window. A chat
 * started a moment ago has no cache to wait on.
 */
const LoadCache = Command.define("LoadChatCache", {
  args: { chatId: Schema.String, windowSize: Schema.Number, starting: Schema.Boolean },
  messages: [Message.ResolvedCache],
  execute: ({ chatId, windowSize, starting }) => Effect.gen(function* () {
    const remembered = readRememberedReadAnchor(chatId)
    const memory = readMemoryCachedWindow(chatId)
    if (memory) return Message.ResolvedCache({ window: trimCachedWindow(memory, windowSize), remembered, timedOut: false })
    if (starting) return Message.ResolvedCache({ window: null, remembered, timedOut: false })
    const disk = yield* Effect.tryPromise(() => readCachedWindow(chatId)).pipe(
      Effect.map((window) => Option.some(window ? trimCachedWindow(window, windowSize) : null)),
      Effect.catch(() => Effect.succeed(Option.some(null))),
      Effect.timeoutOption(DISK_CACHE_WAIT_MS),
      Effect.map(Option.flatten),
    )
    return Option.match(disk, {
      onNone: () => Message.ResolvedCache({ window: null, remembered, timedOut: true }),
      onSome: (window) => Message.ResolvedCache({ window, remembered, timedOut: false }),
    })
  }),
})

const ReadLateDiskCache = Command.define("ReadLateDiskCache", {
  args: { chatId: Schema.String, windowSize: Schema.Number },
  messages: [Message.ReadLateDiskCache],
  execute: ({ chatId, windowSize }) => Effect.tryPromise(() => readCachedWindow(chatId)).pipe(
    Effect.map((window) => Message.ReadLateDiskCache({ window: window ? trimCachedWindow(window, windowSize) : null })),
    Effect.catch(() => Effect.succeed(Message.ReadLateDiskCache({ window: null }))),
  ),
})

/** The optimistic prompt needs an id and a time: update has neither. */
const PrepareSend = Command.define("PrepareSend", {
  args: { content: Schema.String, options: opaque<SendOptions>("SendOptions") },
  messages: [Message.PreparedSend],
  execute: ({ content, options }) => Effect.sync(() => Message.PreparedSend({ content, options, optimisticId: generateUUID(), sentAt: Date.now() })),
})

const Enqueue = Command.define("EnqueueMessage", {
  args: { chatId: Schema.String, content: Schema.String, options: opaque<SendOptions>("SendOptions") },
  messages: [Message.SucceededEnqueue, Message.FailedEnqueue],
  execute: ({ chatId, content, options }) => sendCommand<{ queuedMessageId: string }>({
    type: "message.enqueue",
    chatId,
    content,
    attachments: options.attachments ?? [],
    provider: options.provider,
    accountId: options.accountId,
    model: options.model,
    modelOptions: options.modelOptions,
    planMode: options.planMode,
    autoPlan: options.autoPlan,
    // Only meaningful here: off a running turn there is nothing to
    // interrupt, and the message starts immediately either way.
    steer: options.steer,
  }).pipe(
    Effect.as(Message.SucceededEnqueue()),
    Effect.catch((error) => Effect.succeed(Message.FailedEnqueue({ content, error: errorMessage(error) }))),
  ),
})

const ChatSend = Command.define("ChatSend", {
  args: { chatId: Schema.String, content: Schema.String, options: opaque<SendOptions>("SendOptions"), optimisticId: Schema.String },
  messages: [Message.SucceededChatSend, Message.FailedChatSend],
  execute: ({ chatId, content, options, optimisticId }) => sendCommand<{ chatId?: string }>({
    type: "chat.send",
    chatId,
    projectId: undefined,
    provider: options.provider,
    accountId: options.accountId,
    content,
    attachments: options.attachments ?? [],
    model: options.model,
    modelOptions: options.modelOptions,
    planMode: options.planMode,
    autoPlan: options.autoPlan,
  }).pipe(
    Effect.as(Message.SucceededChatSend({ optimisticId })),
    Effect.catch((error) => Effect.succeed(Message.FailedChatSend({ optimisticId, content, error: errorMessage(error) }))),
  ),
})

const DelayOptimisticAck = Command.define("DelayOptimisticAck", {
  args: { token: Schema.Number, ms: Schema.Number },
  messages: [Message.ElapsedOptimisticAck],
  execute: ({ token, ms }) => Effect.sleep(ms).pipe(Effect.as(Message.ElapsedOptimisticAck({ token }))),
})

const LoadOlder = Command.define("LoadOlderMessages", {
  args: { chatId: Schema.String, untilMessageId: Schema.NullOr(Schema.String), all: Schema.Boolean },
  messages: [Message.CompletedLoadOlder, Message.FailedLoadOlder],
  execute: ({ chatId, untilMessageId, all }) => sendCommand<{ startIndex: number }>({
    type: "chat.loadOlder",
    chatId,
    ...(untilMessageId !== null ? { untilMessageId } : {}),
    ...(all ? { all: true } : {}),
  }).pipe(
    Effect.as(Message.CompletedLoadOlder()),
    Effect.catch((error) => Effect.succeed(Message.FailedLoadOlder({ error: errorMessage(error) }))),
  ),
})

/** useChatCommands' wrapCommand: clears the error on success unless `keep`. */
const ChatCommand = Command.define("ChatCommand", {
  args: { command: opaque<Parameters<typeof sendCommand>[0]>("ClientCommand"), keep: Schema.Boolean },
  messages: [Message.SucceededCommand, Message.CompletedCommand, Message.FailedCommand],
  execute: ({ command, keep }) => sendCommand(command).pipe(
    Effect.as(keep ? Message.CompletedCommand() : Message.SucceededCommand()),
    Effect.catch((error) => Effect.succeed(Message.FailedCommand({ error: errorMessage(error) }))),
  ),
})

const DelayReadAnchorWrite = Command.define("DelayReadAnchorWrite", {
  args: { ms: Schema.Number },
  messages: [Message.ElapsedReadAnchorTimer],
  execute: ({ ms }) => Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(() => Message.ElapsedReadAnchorTimer({ at: Date.now() })))),
})

/**
 * Writes a read position: this browser's copy at once, then the server's.
 * Ack-only; every pending command rejects with "Disconnected" on socket
 * close even though the envelope may still be delivered, so a failure is
 * never surfaced.
 */
/** The next animation frame, where there is one (none in tests: it goes on at once). */
const nextFrame = Effect.callback<void>((resume) => {
  if (typeof requestAnimationFrame === "undefined") {
    resume(Effect.void)
    return
  }
  const frame = requestAnimationFrame(() => resume(Effect.void))
  return Effect.sync(() => cancelAnimationFrame(frame))
})

/** When a write measures the reader's position (see WriteReadAnchor). */
const WriteMeasure = Schema.Literals(["sample", "after-render", "next-frame"])

const WriteReadAnchor = Command.define("WriteReadAnchor", {
  args: {
    chatId: Schema.String,
    messageId: Schema.String,
    atEnd: Schema.Boolean,
    layout: Schema.NullOr(Schema.Struct({ transcriptWidth: Schema.Number, offsetFromMessage: Schema.Number })),
    measure: WriteMeasure,
  },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId, messageId, atEnd, layout: sampled, measure }) => Effect.gen(function* () {
    // The hook measured as its timer ran, after React's synchronous render.
    // A throttled write measures a frame on (Foldkit renders on the next
    // one). The first write of a burst ran before the next frame, ahead of
    // what that frame moves (the scroller following the end a frame behind
    // a change in height): it keeps the report's own measure, unless the
    // report came in while the press that caused it was still to render
    // (React had drawn it already), and then it measures once that render
    // is in. The sample is also what the transcript left as it was taken
    // down.
    let layout = sampled
    if (measure !== "sample") {
      yield* (measure === "after-render" ? Render.afterCommit : nextFrame)
      layout = measureReadAnchor(chatId, messageId) ?? sampled
    }
    rememberReadAnchor(chatId, { messageId, atEnd, ...(layout ?? {}) })
    yield* sendCommand({ type: "chat.setReadAnchor", chatId, messageId, atEnd, ...(layout ?? {}) }).pipe(Effect.ignore)
    return Message.CompletedSideEffect()
  }),
})

const RememberReadAnchor = Command.define("RememberReadAnchor", {
  args: { chatId: Schema.String, anchor: Schema.NullOr(opaque<ResolvedChatReadAnchor>("ResolvedChatReadAnchor")) },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId, anchor }) => Effect.sync(() => {
    rememberReadAnchor(chatId, anchor)
    return Message.CompletedSideEffect()
  }),
})

// One transcript cache writer per chat, as each hook instance held one.
const cacheWriters = new Map<string, ReturnType<typeof createTranscriptCacheWriter>>()
function cacheWriter(chatId: string) {
  let writer = cacheWriters.get(chatId)
  if (!writer) {
    writer = createTranscriptCacheWriter()
    cacheWriters.set(chatId, writer)
  }
  return writer
}

/**
 * Written after a turn settles, not during: the window changes many times a
 * second while streaming and the server is the source of truth throughout.
 */
const ScheduleCacheWrite = Command.define("ScheduleTranscriptCacheWrite", {
  args: { chatId: Schema.String, snapshot: opaque<ChatSnapshot>("ChatSnapshot"), isProcessing: Schema.Boolean },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId, snapshot, isProcessing }) => Effect.sync(() => {
    cacheWriter(chatId).schedule(chatId, snapshot, isProcessing)
    return Message.CompletedSideEffect()
  }),
})

/** A chat closed mid-turn never reaches a settled write, so take what is pending. */
const FlushCacheWrite = Command.define("FlushTranscriptCacheWrite", {
  args: { chatId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId }) => Effect.sync(() => {
    cacheWriter(chatId).flush()
    return Message.CompletedSideEffect()
  }),
})

// DERIVED

/** The snapshot, if it is this chat's. */
export function snapshotOf(model: Model): ChatSnapshot | null {
  return model.snapshot?.runtime.chatId === model.chatId ? model.snapshot : null
}

/** The server's entries, or the cached window's until the snapshot comes. */
export function serverEntries(model: Model): TranscriptEntry[] {
  return snapshotOf(model)?.messages
    ?? (model.cachedTranscript?.chatId === model.chatId ? model.cachedTranscript.entries : [])
}

/**
 * Status: the optimistic "starting" first, then the server's, and while the
 * snapshot is still on its way the sidebar's word for the chat (`sidebarStatus`).
 */
export function runtimeStatus(model: Model, sidebarStatus: string | null): string | null {
  const runtime = snapshotOf(model)?.runtime ?? null
  const optimistic = model.optimisticProcessing && (!runtime || hasNoTurnStatus(runtime.status)) ? "starting" : null
  return optimistic ?? runtime?.status ?? (snapshotOf(model) ? null : sidebarStatus) ?? null
}

export function isProcessing(model: Model, sidebarStatus: string | null) {
  return isProcessingStatus(runtimeStatus(model, sidebarStatus) ?? undefined)
}

export function canCancel(model: Model, sidebarStatus: string | null) {
  return canCancelStatus(runtimeStatus(model, sidebarStatus) ?? undefined)
}

/**
 * From the cached window until the snapshot says. Load More is part of the
 * transcript's height, and a button that came in with the snapshot pushed a
 * transcript already on screen down by its height.
 */
export function hasOlderMessages(model: Model) {
  return (snapshotOf(model)?.startIndex ?? (model.cachedTranscript?.chatId === model.chatId ? model.cachedTranscript.startIndex : 0)) > 0
}

export function availableProviders(model: Model, fallback: ProviderCatalogEntry[]) {
  return snapshotOf(model)?.availableProviders ?? fallback
}

export const previousPrompt = (model: Model) => getPreviousPrompt(model.messages)
export const latestToolIds = (model: Model) => getLatestToolIds(model.messages)

/** useChatReadAnchor's state, for the transcript's restore. */
export function readAnchorState(model: Model) {
  const latch = model.readAnchor.latch
  return {
    resolved: latch.source !== "none",
    anchor: latch.anchor,
    confirmed: latch.source === "server",
  }
}

// HELPERS

/** Rows again after the entries or the optimistic prompts changed. */
function rehydrate(model: Model): Model {
  const entries = serverEntries(model)
  const prompts = reconcileOptimisticUserPrompts(model.optimisticPrompts as OptimisticUserPrompt[], model.chatId, entries)
  const optimisticPrompts = prompts.length === model.optimisticPrompts.length && prompts.every((prompt, index) => prompt === model.optimisticPrompts[index])
    ? model.optimisticPrompts
    : prompts
  const transcript = optimisticPrompts.length === 0 ? entries : [...entries, ...optimisticPrompts.map((prompt) => prompt.entry)]
  return modifyFields(model, {
    optimisticPrompts: () => optimisticPrompts,
    messages: (previous) => processTranscriptMessages(transcript, previous),
  })
}

/**
 * Latches the read anchor (chatReadAnchorCache.latchReadAnchor): the
 * browser's copy when the chat opens, the server's first word once its
 * snapshot is in, and nothing after.
 */
function latch(model: Model, remembered: RememberedReadAnchor | null): Return {
  const serverAnchor = model.chatReady ? snapshotOf(model)?.readAnchor : undefined
  const previous = model.readAnchor.latch
  const latched = latchReadAnchor(previous, model.chatId, serverAnchor, previous.chatId !== model.chatId ? remembered : null)
  if (latched === previous) return { model }
  const commands: Command.Command<Message, never, KannaSocketService>[] = []
  // The server's first word becomes this browser's copy, unless the copy has
  // moved since the chat opened: the reader scrolled in the moment before
  // the snapshot came, and their position is the newer one.
  if (latched.source === "server" && serverAnchor !== undefined) {
    const local = remembered
    const wasWaiting = previous.chatId === model.chatId
    if (!local || (wasWaiting && sameReadAnchor(local.anchor, previous.anchor))) {
      commands.push(RememberReadAnchor({ chatId: model.chatId, anchor: serverAnchor }))
    }
  }
  return { model: modifyFields(model, { readAnchor: (anchor) => ({ ...anchor, latch: latched }) }), commands }
}

/**
 * The optimistic "starting" gives way to the server's word: at once when the
 * turn shows as running, otherwise on the first push after the send's ack
 * that still says idle, or after 5 s if none comes.
 */
function settleOptimistic(model: Model): Return {
  const processing = model.optimisticProcessing
  if (!processing) return { model }
  const runtime = snapshotOf(model)?.runtime
  if (runtime?.status && !hasNoTurnStatus(runtime.status)) {
    return { model: modifyFields(model, { optimisticProcessing: () => null }) }
  }
  if (!processing.acked) return { model }
  const heardBack = snapshotOf(model) !== null && model.snapshotSeq > processing.acked.atSeq
  return heardBack ? { model: modifyFields(model, { optimisticProcessing: () => null }) } : { model }
}

function flushReadAnchor(model: Model, at: number): Return {
  const pending = model.readAnchor.pending
  const cleared = modifyFields(model, { readAnchor: (anchor) => ({ ...anchor, pending: null, timerScheduled: false, immediate: false }) })
  if (!pending) return { model: cleared }
  // While parked at the bottom the top-visible message churns with every
  // streamed chunk, but restore only needs "was at the end", so all of those
  // collapse to a single write. Scrolling within one long message changes
  // only the offset, so that is part of the key.
  const key = pending.atEnd
    ? `${model.chatId}:atEnd`
    : `${model.chatId}:${pending.messageId}:${pending.layout?.offsetFromMessage ?? ""}`
  if (key === model.readAnchor.lastWrittenKey) return { model: cleared }
  const measure = !model.readAnchor.immediate ? "next-frame" as const : pending.settled ? "sample" as const : "after-render" as const
  return {
    model: modifyFields(cleared, { readAnchor: (anchor) => ({ ...anchor, lastWrittenKey: key, lastWriteAt: at }) }),
    commands: [WriteReadAnchor({ chatId: model.chatId, messageId: pending.messageId, atEnd: pending.atEnd, layout: pending.layout, measure })],
  }
}

/**
 * What a host returns when this session goes away (the page leaves the
 * chat, the previewer moves on): the queued read position is written
 * against this chat, and a pending cache write is flushed.
 */
export function close(model: Model, at: number): Update.Return<Model, Message, KannaSocketService> {
  const flushed = flushReadAnchor(model, at)
  return { model: flushed.model, commands: [...(flushed.commands ?? []), FlushCacheWrite({ chatId: model.chatId })] }
}

const withError = (result: Return, message: string | null): Return =>
  ({ ...result, outMessage: OutMessage.ChangedCommandError({ message }) })

// UPDATE

export function update(model: Model, message: Message, input: { windowSize: number; sidebarStatus: string | null }): Return {
  return Message.match<Return>(message, {
    ResolvedCache: ({ window, remembered, timedOut }) => {
      const lastEntryId = window?.entries[window.entries.length - 1]?._id
      const span: Span | null = window && lastEntryId
        ? { start: window.startIndex, end: window.startIndex + window.entries.length, endEntryId: lastEntryId }
        : null
      let next: Model = modifyFields(model, {
        cacheResolved: () => true,
        subscribeSpan: () => span,
        base: () => (window && span ? cachedWindowToMessages(window) : null),
        // Drawn now only if it can be drawn in place; it seeds the
        // subscription either way.
        cachedTranscript: () => (window && span && canPaintCachedWindow(window) ? window : null),
      })
      next = rehydrate(next)
      const latched = latch(next, remembered)
      return {
        model: latched.model,
        commands: [...(latched.commands ?? []), ...(timedOut ? [ReadLateDiskCache({ chatId: model.chatId, windowSize: input.windowSize })] : [])],
      }
    },
    ReadLateDiskCache: ({ window }) => {
      if (snapshotOf(model) || !window || !canPaintCachedWindow(window)) return { model }
      return { model: rehydrate(modifyFields(model, { cachedTranscript: () => window })) }
    },
    ReceivedSnapshot: ({ snapshot }) => {
      let next: Model = modifyFields(model, {
        snapshot: (current) => foldChatSnapshot(current, model.base, snapshot),
        cachedTranscript: () => null,
        chatReady: () => true,
        snapshotSeq: (seq) => seq + 1,
      })
      next = rehydrate(next)
      const latched = latch(next, readRememberedReadAnchorSafe(model.chatId))
      const settled = settleOptimistic(latched.model)
      const folded = snapshotOf(settled.model)
      const commands = [...(latched.commands ?? [])]
      if (folded) commands.push(ScheduleCacheWrite({ chatId: model.chatId, snapshot: folded, isProcessing: isProcessing(settled.model, input.sidebarStatus) }))
      return withError({ model: settled.model, commands }, null)
    },
    RequestedResubscribe: () => ({ model }),

    SubmittedMessage: ({ content, options }) => {
      if (isProcessing(model, input.sidebarStatus)) {
        return { model, commands: [Enqueue({ chatId: model.chatId, content, options })] }
      }
      return { model, commands: [PrepareSend({ content, options })] }
    },
    PreparedSend: ({ content, options, optimisticId, sentAt }) => {
      const attachments = options.attachments ?? []
      const signature = getUserPromptSignature(content, attachments)
      const requiredMatchCount = countMatchingUserPrompts(serverEntries(model), signature)
        + model.optimisticPrompts.filter((prompt) => prompt.scopeId === model.chatId && prompt.signature === signature).length
        + 1
      const prompt: OptimisticUserPrompt = {
        id: optimisticId,
        scopeId: model.chatId,
        signature,
        requiredMatchCount,
        entry: { _id: `optimistic:${optimisticId}`, kind: "user_prompt", content, attachments, createdAt: sentAt },
      }
      const next = rehydrate(modifyFields(model, {
        optimisticProcessing: () => ({ acked: null }),
        optimisticPrompts: (prompts) => [...prompts, prompt],
      }))
      return {
        model: next,
        commands: [ChatSend({ chatId: model.chatId, content, options, optimisticId })],
        // Holds the chat's place in the sidebar across the round trip.
        outMessage: OutMessage.MarkedSending({ chatId: model.chatId, sentAt }),
      }
    },
    SucceededEnqueue: () => ({ model, outMessage: OutMessage.ChangedCommandError({ message: null }) }),
    FailedEnqueue: ({ content, error }) => ({ model, outMessage: OutMessage.FailedSend({ content, error }) }),
    SucceededChatSend: () => {
      if (!model.optimisticProcessing) return { model, outMessage: OutMessage.SucceededSend() }
      const token = model.ackTokens + 1
      const next = modifyFields(model, {
        ackTokens: () => token,
        optimisticProcessing: () => ({ acked: { atSeq: model.snapshotSeq, token } }),
      })
      const settled = settleOptimistic(next)
      return {
        model: settled.model,
        commands: settled.model.optimisticProcessing ? [DelayOptimisticAck({ token, ms: OPTIMISTIC_ACK_FALLBACK_MS })] : [],
        outMessage: OutMessage.SucceededSend(),
      }
    },
    FailedChatSend: ({ optimisticId, content, error }) => ({
      model: rehydrate(modifyFields(model, {
        optimisticPrompts: (prompts) => prompts.filter((prompt) => prompt.id !== optimisticId),
        optimisticProcessing: () => null,
      })),
      // The send failed, so the row goes back to being placed by what the
      // server knows, and by the draft the composer restores.
      outMessage: OutMessage.FailedSend({ content, error }),
    }),
    ElapsedOptimisticAck: ({ token }) => model.optimisticProcessing?.acked?.token === token
      ? { model: modifyFields(model, { optimisticProcessing: () => null }) }
      : { model },

    ClickedLoadOlder: ({ untilMessageId, all }) => ({
      model: modifyFields(model, { isLoadingOlder: () => true }),
      commands: [LoadOlder({ chatId: model.chatId, untilMessageId, all })],
    }),
    CompletedLoadOlder: () => ({ model: modifyFields(model, { isLoadingOlder: () => false }) }),
    FailedLoadOlder: ({ error }) => withError({ model: modifyFields(model, { isLoadingOlder: () => false }) }, error),

    ClickedSteerQueued: ({ queuedMessageId }) => ({ model, commands: [ChatCommand({ command: { type: "message.steer", chatId: model.chatId, queuedMessageId }, keep: false })] }),
    ClickedRemoveQueued: ({ queuedMessageId }) => ({ model, commands: [ChatCommand({ command: { type: "message.dequeue", chatId: model.chatId, queuedMessageId }, keep: false })] }),
    ClickedUsageLimitResume: ({ action }) => ({ model, commands: [ChatCommand({ command: { type: "chat.usageLimitResume", chatId: model.chatId, action }, keep: false })] }),
    ClickedCancel: () => ({ model, commands: [ChatCommand({ command: { type: "chat.cancel", chatId: model.chatId }, keep: true })] }),
    ClickedStopDraining: () => ({ model, commands: [ChatCommand({ command: { type: "chat.stopDraining", chatId: model.chatId }, keep: true })] }),
    AnsweredQuestion: ({ toolUseId, questions, answers }) => ({
      model,
      commands: [ChatCommand({ command: { type: "chat.respondTool", chatId: model.chatId, toolUseId, result: { questions: questions as never, answers } }, keep: true })],
    }),
    AnsweredExitPlanMode: ({ toolUseId, confirmed, clearContext, message: text }) => ({
      model,
      commands: [ChatCommand({
        command: {
          type: "chat.respondTool",
          chatId: model.chatId,
          toolUseId,
          result: { confirmed, ...(clearContext ? { clearContext: true } : {}), ...(text ? { message: text } : {}) },
        },
        keep: true,
      })],
      // Clears plan mode only: an Auto Plan chat stays in Auto Plan.
      ...(confirmed ? { outMessage: OutMessage.ConfirmedExitPlanMode({ chatId: model.chatId }) } : {}),
    }),
    SucceededCommand: () => ({ model, outMessage: OutMessage.ChangedCommandError({ message: null }) }),
    CompletedCommand: () => ({ model }),
    FailedCommand: ({ error }) => withError({ model }, error),

    ReportedReadAnchor: ({ messageId, atEnd, layout, at, settled }) => {
      const next = modifyFields(model, { readAnchor: (anchor) => ({ ...anchor, pending: { messageId, atEnd, layout, settled } }) })
      // A measured position is kept in this browser's copy at once.
      const remember = RememberReadAnchor({ chatId: model.chatId, anchor: { messageId, atEnd, ...(layout ?? {}) } as ResolvedChatReadAnchor })
      // Already scheduled: the newer position just replaces the pending one.
      if (model.readAnchor.timerScheduled) return { model: next, commands: [remember] }
      const delay = Math.max(0, READ_ANCHOR_WRITE_INTERVAL_MS - (at - model.readAnchor.lastWriteAt))
      return {
        model: modifyFields(next, { readAnchor: (anchor) => ({ ...anchor, timerScheduled: true, immediate: delay === 0 }) }),
        commands: [remember, DelayReadAnchorWrite({ ms: delay })],
      }
    },
    ElapsedReadAnchorTimer: ({ at }) => model.readAnchor.timerScheduled ? flushReadAnchor(model, at) : { model },
    // Backgrounding a tab is the common way a session ends: write now. A
    // resumed subscription must learn whether this tab still follows the tail.
    ChangedVisibility: ({ hidden, at }) => hidden
      ? flushReadAnchor(model, at)
      : { model: modifyFields(model, { readAnchor: (anchor) => ({ ...anchor, lastWrittenKey: null }) }) },
    CompletedSideEffect: () => ({ model }),
  })
}

function readRememberedReadAnchorSafe(chatId: string) {
  // Read inside update only to decide whether the server's first word
  // replaces the copy: chatReadAnchorCache is an in-memory map once loaded.
  return readRememberedReadAnchor(chatId)
}

// SUBSCRIPTIONS

const SessionDependencies = {
  chatId: Schema.String,
  cacheResolved: Schema.Boolean,
  subscribeSpan: Schema.NullOr(SpanSchema),
  heldSpan: Schema.NullOr(SpanSchema),
}

function heldSpan(model: Model): Span | null {
  const snapshot = snapshotOf(model)
  const last = snapshot?.messages[snapshot.messages.length - 1]
  return snapshot && last
    ? { start: snapshot.startIndex, end: snapshot.startIndex + snapshot.messages.length, endEntryId: last._id }
    : null
}

export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  chat: entry(SessionDependencies, {
    modelToDependencies: (model) => ({
      chatId: model.chatId,
      cacheResolved: model.cacheResolved,
      subscribeSpan: model.subscribeSpan,
      heldSpan: heldSpan(model),
    }),
    // The held span moves with every push; it only matters to a reconnect,
    // which reads it live.
    keepAliveEquivalence: Equivalence.Struct({
      chatId: Equivalence.String,
      cacheResolved: Equivalence.Boolean,
    }),
    dependenciesToStream: ({ chatId, cacheResolved, subscribeSpan }, readDependencies) =>
      Stream.when(
        topicStream<ChatSnapshot | null>(
          { type: "chat", chatId, ...(subscribeSpan ? { cachedSpan: subscribeSpan } : {}) },
          {
            // A reconnect used to resubscribe with the topic from the first
            // open, so every socket drop cost a full window. Naming what is
            // held by now makes it a tail, or nothing.
            topicOnReconnect: (): SubscriptionTopic => {
              const held = readDependencies().heldSpan
              return held ? { type: "chat", chatId, cachedSpan: held } : { type: "chat", chatId }
            },
          },
        ).pipe(Stream.map((snapshot) => Message.ReceivedSnapshot({ snapshot }))),
        Effect.sync(() => cacheResolved),
      ),
  }),
  visibility: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: () => document,
      type: "visibilitychange",
      mapEvent: () => Message.ChangedVisibility({ hidden: document.visibilityState === "hidden", at: Date.now() }),
    }),
  ),
}))
