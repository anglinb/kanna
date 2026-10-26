import { Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { OpenLocalLinkTarget } from "../core/localLink"
import { shouldOpenLocalFileLinkInEditor } from "../../client/lib/pathUtils"
import type { TranscriptEntry } from "../../shared/types"
import { AppAction, batch } from "../app/action"
import { requestAction, type AppModel, type SliceReturn } from "../app/slice"
import { chatSchedules, chooseChatOpenMenuItem, openChatActions, openChatAtActions, sidebarThread } from "../chat/chatReference"
import * as ScheduleCard from "../widgets/scheduleCard"
import { scheduleEditPrompt } from "../widgets/schedules"
import { chooseChatRowMenuItem } from "../chat/chatRowMenu"
import { cardMenuContext, cardMenuOf, DismissChatCardHover, sharedCardData } from "./chatCard"
import * as Stores from "../app/stores"
import * as ViewerStore from "../core/stores/viewer"
import * as ChatCard from "../ui/chat-hover-card"
import * as ChatSession from "../core/chatSession"
import { errorMessage, sendCommand, type KannaSocketService } from "../core/socket"
import * as Messages from "./messages"
import { Message } from "./message"
import { minimapResetKey } from "./minimap"
import type { Model } from "./model"
import { pageChat, pageLinkMenu, viewportKey } from "./source"
import { openAppValueOfMenuValue, openAppValueRequest } from "../chat/openExternal"
import * as ContextMenu from "../ui/context-menu"
import { DriveViewport, JumpViewportToRow, LocateLinkMenu } from "./viewport"
import { RESUME_KEY } from "./view"
import { routeChatId } from "../app/route"

// What the viewport's Messages do. `step` is the part every host shares
// (the chat page, the export viewer): the scroll button, the flash, the
// minimap, what the controller reports. What the rows ask for, and what goes
// to the page's chat, is the chat page's (`update`).

/** ChatPage's delay before the scroll-to-bottom button shows, once the reader leaves the end. */
const SCROLL_BUTTON_DELAY_MS = 150
/** Length of `.kanna-jump-flash`, plus the grace before the class comes off. */
const JUMP_FLASH_DURATION_MS = 2236
const JUMP_FLASH_CLEANUP_SLACK_MS = 120

type AnyCommand = Command.Command<Message, never, KannaSocketService>

export interface Step {
  model: Model
  commands: ReadonlyArray<AnyCommand>
  /** What the root is asked to do (the chat page's OutMessage; ignored by the export viewer). */
  actions: AppAction[]
}

export const DelayScrollButton = Command.define("DelayTranscriptScrollButton", {
  args: { token: Schema.Number },
  messages: [Message.ElapsedScrollButtonDelay],
  execute: ({ token }) => Effect.sleep(SCROLL_BUTTON_DELAY_MS).pipe(Effect.as(Message.ElapsedScrollButtonDelay({ token }))),
})

/** Dropped for a frame before being set, so jumping to the row already lit replays the flash. */
export const RaiseFlash = Command.define("RaiseTranscriptJumpFlash", {
  args: { token: Schema.Number },
  messages: [Message.RaisedFlash],
  execute: ({ token }) => Effect.callback<ReturnType<typeof Message.RaisedFlash>>((resume) => {
    const frame = window.requestAnimationFrame(() => resume(Effect.succeed(Message.RaisedFlash({ token }))))
    return Effect.sync(() => window.cancelAnimationFrame(frame))
  }),
})

/** Cleared on a timer rather than on animation end, which may never fire. */
export const ClearFlash = Command.define("ClearTranscriptJumpFlash", {
  args: { token: Schema.Number },
  messages: [Message.ElapsedFlash],
  execute: ({ token }) => Effect.sleep(JUMP_FLASH_DURATION_MS + JUMP_FLASH_CLEANUP_SLACK_MS).pipe(Effect.as(Message.ElapsedFlash({ token }))),
})

const FetchToolEntries = Command.define("FetchTranscriptToolEntries", {
  args: { chatId: Schema.String, entryIds: Schema.Array(Schema.String) },
  messages: [Message.ReceivedToolEntries, Message.FailedToolEntries],
  execute: ({ chatId, entryIds }) => sendCommand<TranscriptEntry[]>({ type: "chat.getToolEntries", chatId, entryIds: [...entryIds] }).pipe(
    Effect.map((entries) => Message.ReceivedToolEntries({ chatId, entryIds, entries: entries ?? [] })),
    Effect.catch(() => Effect.succeed(Message.FailedToolEntries({ chatId, entryIds }))),
  ),
})

const FetchDebugRaw = Command.define("FetchTranscriptDebugRaw", {
  args: { chatId: Schema.String, entryId: Schema.String },
  messages: [Message.ReceivedDebugRaw],
  execute: ({ chatId, entryId }) => sendCommand<string | null>({ type: "chat.getEntryDebugRaw", chatId, entryId }).pipe(
    Effect.map((body) => Message.ReceivedDebugRaw({ chatId, entryId, body: body ?? null, failed: false })),
    Effect.catch((error) => Effect.sync(() => {
      void errorMessage(error)
      return Message.ReceivedDebugRaw({ chatId, entryId, body: null, failed: true })
    })),
  ),
})

const done = (model: Model, commands: ReadonlyArray<AnyCommand> = [], actions: AppAction[] = []): Step => ({ model, commands, actions })

/**
 * The chat page went (to Settings, home): what ChatPage held in state and
 * refs for the scroll button starts over when it mounts again, at the end
 * with the button down. A pending show is dropped with its token.
 */
export function leftPage(model: Model): Model {
  return modifyFields(model, { isAtEnd: () => true, showScrollToBottom: () => false, scrollButtonToken: (token) => token + 1 })
}

/** The minimap's reset effect: a change in capacity, room or overflow drops the cursor and the hold. */
function withMinimapReset(previous: Model, next: Model): Model {
  const before = minimapResetKey(previous.minimap.height, previous.viewportWidth, previous.overflows)
  const after = minimapResetKey(next.minimap.height, next.viewportWidth, next.overflows)
  return before === after ? next : modifyFields(next, { minimap: (minimap) => ({ ...minimap, pointerY: null, heldTurnId: null }) })
}

const chat = (message: ChatSession.Message) => AppAction.Chat({ message })

/**
 * The part of update every host shares, or null for a Message it leaves to
 * the host. `key` finds the viewport for the Commands that drive it.
 */
export function step(model: Model, message: Message, env: { key: string }): Step | null {
  switch (message._tag) {
    case "MountedViewport":
      // A viewport per showing of a chat, as React keyed and mounted it
      // (another chat, or the same one after leaving the page): the rows'
      // state, the flash, the minimap's cursor and anything aimed at the
      // last showing go.
      return done(modifyFields(model, {
        chatId: () => message.chatId,
        messages: (rows) => Messages.reset(rows),
        flash: () => null,
        lastJump: () => null,
        unloadedJump: () => null,
        visibleRange: () => null,
        minimap: (minimap) => ({ ...minimap, pointerY: null, heldTurnId: null }),
        linkMenuTarget: () => null,
        cardMenus: () => ({}),
        scheduleCards: () => ({}),
        chatCardHover: () => null,
        chatCard: ChatCard.closedCard,
      }))

    case "ChangedAtEnd": {
      // ChatPage's onIsAtEndChange.
      if (model.isAtEnd === message.isAtEnd) return done(model)
      const token = model.scrollButtonToken + 1
      if (message.isAtEnd) return done(modifyFields(model, { isAtEnd: () => true, scrollButtonToken: () => token, showScrollToBottom: () => false }))
      return done(modifyFields(model, { isAtEnd: () => false, scrollButtonToken: () => token }), [DelayScrollButton({ token })])
    }
    case "ElapsedScrollButtonDelay":
      return done(message.token === model.scrollButtonToken && !model.isAtEnd ? modifyFields(model, { showScrollToBottom: () => true }) : model)
    case "ClickedScrollToBottom":
      // scrollToTranscriptEnd: an explicit read-position choice.
      return done(
        modifyFields(model, { isAtEnd: () => true, scrollButtonToken: (token) => token + 1, showScrollToBottom: () => false }),
        [DriveViewport({ key: env.key, action: "scroll-to-bottom" })],
      )

    case "ChangedOverflow":
      return done(withMinimapReset(model, modifyFields(model, { overflows: () => message.overflows })))
    case "ResizedViewport":
      return done(withMinimapReset(model, modifyFields(model, { viewportWidth: () => message.width })))
    case "MeasuredMinimap":
      return done(withMinimapReset(model, modifyFields(model, { minimap: (minimap) => ({ ...minimap, height: message.height }) })))
    case "ChangedFinePointer":
      return done(modifyFields(model, { minimap: (minimap) => ({ ...minimap, finePointer: message.fine }) }))
    case "ChangedVisibleRange":
      return done(modifyFields(model, { visibleRange: () => message.range }))

    case "JumpedToRow": {
      const token = model.flashTokens + 1
      return done(
        modifyFields(model, { flashTokens: () => token, flash: () => ({ rowId: message.rowId, token, raised: false }) }),
        [RaiseFlash({ token }), ClearFlash({ token })],
      )
    }
    case "RaisedFlash":
      return done(model.flash?.token === message.token ? modifyFields(model, { flash: (flash) => (flash ? { ...flash, raised: true } : flash) }) : model)
    case "ElapsedFlash":
      return done(model.flash?.token === message.token ? modifyFields(model, { flash: () => null }) : model)

    case "SpentJump":
      return done(modifyFields(model, { lastJump: () => ({ requestId: message.requestId, target: message.target }) }), [], [AppAction.SpentChatJump({ requestId: message.requestId })])
    case "AppliedUnloadedJump":
      return done(model.unloadedJump?.seq === message.seq ? modifyFields(model, { unloadedJump: () => null }) : model)

    case "SelectedTurn": {
      // The minimap's handleSelect, then the viewport's handleSelectTurn.
      const dismissed = modifyFields(model, { minimap: (minimap) => ({ ...minimap, pointerY: null, heldTurnId: null }) })
      if (!message.loaded || message.rowId === null) {
        // Load until that prompt is in the window; the jump lands when its row appears.
        const seq = model.unloadedSeq + 1
        return done(
          modifyFields(dismissed, { unloadedSeq: () => seq, unloadedJump: () => ({ messageId: message.turnId, seq }) }),
          [DriveViewport({ key: env.key, action: "jump-to-unloaded" })],
          [chat(ChatSession.Message.ClickedLoadOlder({ untilMessageId: message.turnId, all: false }))],
        )
      }
      return done(dismissed, [JumpViewportToRow({ key: env.key, rowId: message.rowId })])
    }
    case "MovedOverMinimap":
      return done(modifyFields(model, { minimap: (minimap) => ({ ...minimap, pointerY: message.y, heldTurnId: null }) }))
    case "LeftMinimap":
      return done(modifyFields(model, { minimap: (minimap) => ({ ...minimap, pointerY: null, heldTurnId: message.heldTurnId }) }))
    case "LeftMinimapCard":
      return done(modifyFields(model, { minimap: (minimap) => ({ ...minimap, heldTurnId: null }) }))

    case "ReportedReadAnchor":
      return done(model, [], [chat(ChatSession.Message.ReportedReadAnchor({ messageId: message.messageId, atEnd: message.atEnd, layout: message.layout, at: message.at }))])
    case "RequestedLoadOlder":
      return done(model, [], [chat(ChatSession.Message.ClickedLoadOlder({ untilMessageId: null, all: false }))])
    case "ClickedLoadMore":
      // Where the first row sits is taken before the older rows can land.
      return done(model, [DriveViewport({ key: env.key, action: "load-more" })], [chat(ChatSession.Message.ClickedLoadOlder({ untilMessageId: null, all: false }))])

    case "CompletedViewportCommand":
    case "CompletedOpenLinkMenu":
      return done(model)
    default:
      return null
  }
}

// THE CHAT PAGE

/** handleOpenLocalLinkClick: a click opens; a right click puts up the menu at the link. */
function openLocalLink(model: Model, target: OpenLocalLinkTarget): Step {
  if (target.trigger !== "contextmenu") {
    const action = shouldOpenLocalFileLinkInEditor(target.path) ? "open_editor" : "open_default"
    return done(model, [], [AppAction.OpenLocalLink({ target, action, editor: null })])
  }
  // The link's handler hears the right click but not where it was: that is
  // read next, and the menu opens there (`openLinkMenuAt`).
  return done(modifyFields(model, { linkMenuTarget: () => target }), [LocateLinkMenu()])
}

/**
 * The menu at the right click, as the contextmenu event React re-dispatched
 * on its trigger put it (Chromium truncates that event's coordinates).
 */
function openLinkMenuAt(model: Model, point: { x: number; y: number }): Step {
  const target = model.linkMenuTarget
  if (!target) return done(model)
  const x = Math.trunc(point.x)
  const y = Math.trunc(point.y)
  const pressed = ContextMenu.update(model.linkMenu, ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x, y }))
  const opened = ContextMenu.update(pressed.model, ContextMenu.Message.RequestedContextMenu())
  return done(
    modifyFields(model, { linkMenuTarget: () => ({ ...target, clientX: point.x, clientY: point.y }), linkMenu: () => opened.model }),
    liftLinkMenu([...(pressed.commands ?? []), ...(opened.commands ?? [])]),
  )
}

const liftLinkMenu = (commands: ReadonlyArray<Command.Command<ContextMenu.Message>> | undefined) =>
  Command.mapMessages(commands ?? [], (message: ContextMenu.Message) => Message.GotLinkMenuMessage({ message })) as unknown as ReadonlyArray<AnyCommand>

/** The link menu: a destination opens the link there; any close drops the link. */
function linkMenuStep(model: Model, message: ContextMenu.Message, app: AppModel): Step {
  const result = ContextMenu.update(model.linkMenu, message)
  const next = modifyFields(model, { linkMenu: () => result.model })
  const commands = liftLinkMenu(result.commands)
  const out = result.outMessage
  if (!out || out._tag === "Opened") return done(next, commands)
  const target = model.linkMenuTarget
  const cleared = modifyFields(next, { linkMenuTarget: () => null })
  if (out._tag === "Closed" || !target) return done(cleared, commands)
  const value = openAppValueOfMenuValue(out.value)
  const request = value ? openAppValueRequest({ value, editorCommandTemplate: pageLinkMenu(app).editorCommandTemplate }) : null
  if (request?._tag !== "Action" || request.action._tag !== "OpenExternal") return done(cleared, commands)
  return done(cleared, commands, [AppAction.OpenLocalLink({ target, action: request.action.action, editor: request.action.editor })])
}

function rowsStep(model: Model, message: Messages.Message, app: AppModel, chatId: string | null): Step {
  const result = Messages.update(model.messages, message)
  const next = modifyFields(model, { messages: () => result.model })
  const commands = Command.mapMessages(result.commands, (inner: Messages.Message) => Message.GotMessagesMessage({ message: inner })) as unknown as ReadonlyArray<AnyCommand>
  const out = result.outMessage
  if (!out) return done(next, commands)
  return Messages.OutMessage.match<Step>(out, {
    RequestedAppAction: ({ action }) => done(next, commands, [action]),
    RequestedToolEntries: ({ entryIds }) => chatId
      ? done(next, [...commands, FetchToolEntries({ chatId, entryIds })])
      : done(modifyFields(next, { messages: (messages) => Messages.failedToolEntries(messages, entryIds) }), commands),
    RequestedDebugRaw: ({ entryId }) => chatId
      ? done(next, [...commands, FetchDebugRaw({ chatId, entryId })])
      : done(modifyFields(next, { messages: (messages) => Messages.receivedDebugRaw(messages, entryId, Option.some(null)) }), commands),
    SubmittedAskUserQuestion: ({ toolUseId, questions, answers }) =>
      done(next, commands, [chat(ChatSession.Message.AnsweredQuestion({ toolUseId, questions: [...questions], answers }))]),
    ConfirmedExitPlanMode: ({ toolUseId, confirmed, clearContext, message: text }) =>
      done(next, commands, [chat(ChatSession.Message.AnsweredExitPlanMode({ toolUseId, confirmed, clearContext: clearContext ?? false, message: text ?? null }))]),
    OpenedLocalLink: ({ target }) => {
      const opened = openLocalLink(next, target)
      return { ...opened, commands: [...commands, ...opened.commands] }
    },
    OpenedChat: ({ chatId: target }) => done(next, commands, openChatActions(app, target)),
    // The press settles at once: the queue the server pushes is what moves the row.
    RequestedQueueAction: ({ messageId, action }) => done(
      modifyFields(next, { messages: (messages) => Messages.settledQueued(messages, messageId) }),
      commands,
      [chat(action === "remove" ? ChatSession.Message.ClickedRemoveQueued({ queuedMessageId: messageId }) : ChatSession.Message.ClickedSteerQueued({ queuedMessageId: messageId }))],
    ),
    RequestedResumeAction: ({ action }) => done(
      modifyFields(next, { messages: (messages) => Messages.settledResume(messages, RESUME_KEY) }),
      commands,
      [chat(ChatSession.Message.ClickedUsageLimitResume({ action }))],
    ),
    RequestedStop: () => done(next, commands, [chat(ChatSession.Message.ClickedStopDraining())]),
    EscapedVisualization: () => done(next, commands),
  })
}

function toReturn(result: Step): SliceReturn<Model, Message> {
  const [first, ...rest] = result.actions
  if (!first) return { model: result.model, commands: result.commands }
  return { ...requestAction(result.model, rest.length === 0 ? first : batch(first, ...rest)), commands: result.commands }
}

export function update(model: Model, message: Message, app: AppModel): SliceReturn<Model, Message> {
  const chatId = pageChat(app)?.chatId ?? null
  const shared = step(model, message, { key: viewportKey(routeChatId(app.route)) })
  if (shared) return toReturn(shared)
  switch (message._tag) {
    case "GotMessagesMessage":
      return toReturn(rowsStep(model, message.message, app, chatId))
    case "ReceivedToolEntries":
      if (message.chatId !== model.chatId) return { model }
      return { model: modifyFields(model, { messages: (messages) => Messages.receivedToolEntries(messages, message.entryIds, message.entries) }) }
    case "FailedToolEntries":
      if (message.chatId !== model.chatId) return { model }
      return { model: modifyFields(model, { messages: (messages) => Messages.failedToolEntries(messages, message.entryIds) }) }
    case "ReceivedDebugRaw":
      // Matches React, which never shows it: RawMessageSection's effect
      // re-runs on its own `setState("loading")` (state is a dep), and that
      // cleanup marks the request cancelled, so the answer (or the error) is
      // dropped and the section says "Loading…" for good. A React bug, to
      // be filed; `Messages.receivedDebugRaw` is what fixing it takes.
      return { model }
    case "GotLinkMenuMessage":
      return toReturn(linkMenuStep(model, message.message, app))
    case "LocatedLinkMenu":
      return toReturn(openLinkMenuAt(model, message))
    case "ClickedChatCard":
      return toReturn(done(model, [], openChatActions(app, message.chatId)))
    case "GotCardMenuMessage":
      return toReturn(cardMenuStep(model, message.chatId, message.message, app))
    case "GotScheduleCardMessage":
      return toReturn(scheduleCardStep(model, message.scheduleId, message.message, app))
    case "ChangedChatCardHover": {
      const { instance, chatId: cardChatId, key } = message
      if (key !== null) return { model: modifyFields(model, { chatCardHover: () => ({ instance, chatId: cardChatId, key }) }) }
      // A card that leaves stops waiting on its answers.
      if (model.chatCardHover?.instance !== instance) return { model }
      return { model: modifyFields(model, { chatCardHover: () => null, chatCard: ChatCard.closedCard }) }
    }
    case "GotChatCardMessage":
      return toReturn(chatCardStep(model, message.message, app))
    case "MadePreviewJump":
      return toReturn(done(model, [], [AppAction.Store({ message: Stores.Message.GotViewerMessage({ message: message.message }) })]))
    default:
      return { model }
  }
}

const OpenUrl = Command.define("OpenTranscriptChatCardUrl", {
  args: { url: Schema.String },
  messages: [Message.CompletedOpenUrl],
  execute: ({ url }) => Effect.sync(() => {
    window.open(url, "_blank", "noopener,noreferrer")
    return Message.CompletedOpenUrl()
  }),
})

/**
 * A live schedule card: Edit starts the sentence that changes it in the
 * composer (the chat page's handleEditSchedule), a run's chat opens.
 */
function scheduleCardStep(model: Model, scheduleId: string, message: ScheduleCard.Message, app: AppModel): Step {
  const result = ScheduleCard.update(model.scheduleCards[scheduleId] ?? ScheduleCard.init(scheduleId), message)
  const next = modifyFields(model, { scheduleCards: (cards) => ({ ...cards, [scheduleId]: result.model }) })
  const commands = Command.mapMessages(result.commands ?? [], (inner: ScheduleCard.Message) => Message.GotScheduleCardMessage({ scheduleId, message: inner })) as unknown as ReadonlyArray<AnyCommand>
  const out = result.outMessage
  if (!out) return done(next, commands)
  if (out._tag === "RequestedOpenChat") return done(next, commands, openChatActions(app, out.chatId))
  const schedule = chatSchedules(app).schedules.find((candidate) => candidate.id === out.scheduleId)
  return done(next, commands, schedule ? [AppAction.PrefillComposer({ text: scheduleEditPrompt(schedule) })] : [])
}

/**
 * The hover card beneath a live chat card (ChatPage's chat reference card
 * actions): every way it opens its chat is `openChat`, the previewer beside
 * this one; a preview's jump lands where it opens. Each dismisses the card first.
 */
function chatCardStep(model: Model, message: ChatCard.CardMessage, app: AppModel): Step {
  const step = ChatCard.updateCard(model.chatCard, message, sharedCardData(app))
  const next = step.data === model.chatCard ? model : modifyFields(model, { chatCard: () => step.data })
  const own = Command.mapMessages(step.commands, (inner: ChatCard.CardMessage) => Message.GotChatCardMessage({ message: inner })) as unknown as ReadonlyArray<AnyCommand>
  const intent = step.intent
  const hover = model.chatCardHover
  if (!intent) return done(next, own)
  const commands = [...(hover ? [DismissChatCardHover({ instance: hover.instance })] : []), ...own]
  switch (intent.kind) {
    case "openAt": {
      const opened = openChatAtActions(app, intent.chatId, intent.role)
      const jump = opened.jumpInPreview
        ? [Command.mapMessage(ViewerStore.JumpInPreviewedChat({ chatId: intent.chatId, target: intent.role }), (inner: ViewerStore.Message) => Message.MadePreviewJump({ message: inner })) as unknown as AnyCommand]
        : []
      return done(next, [...commands, ...jump], opened.actions)
    }
    // Archived ones too: reading one unarchives nothing.
    case "open":
      return done(next, commands, openChatActions(app, intent.chatId))
    case "setupGit":
      return done(next, commands, [AppAction.SetupGit({ chatId: intent.chatId })])
    case "openFile":
      return done(next, commands, [AppAction.OpenExternalPath({ action: "open_editor", localPath: intent.localPath })])
    case "dismiss":
      return done(next, commands)
  }
}

/** A live chat card's menu: the open-in items, then the chat's (ThreadRowMenu). */
function cardMenuStep(model: Model, chatId: string, message: ContextMenu.Message, app: AppModel): Step {
  const result = ContextMenu.update(cardMenuOf(model, chatId), message)
  const next = modifyFields(model, { cardMenus: (menus) => ({ ...menus, [chatId]: result.model }) })
  const commands = Command.mapMessages(result.commands ?? [], (inner: ContextMenu.Message) => Message.GotCardMenuMessage({ chatId, message: inner })) as unknown as ReadonlyArray<AnyCommand>
  const out = result.outMessage
  if (!out || out._tag !== "Selected") return done(next, commands)
  const opened = chooseChatOpenMenuItem(out.value, app, chatId)
  if (opened) return done(next, commands, opened)
  const thread = sidebarThread(app, chatId)
  const choice = thread ? chooseChatRowMenuItem(out.value, cardMenuContext(app, chatId, thread)) : null
  if (!choice || choice._tag === "None") return done(next, commands)
  if (choice._tag === "OpenUrl") return done(next, [...commands, OpenUrl({ url: choice.url })])
  return done(next, commands, [choice.action])
}
