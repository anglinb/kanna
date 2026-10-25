import { Duration, Effect, Option, Schema } from "effect"
import { Command, Update } from "foldkit"
import * as AppNavigation from "../core/navigation"
import { modifyFields } from "foldkit/struct"
import { resolveDiffFilePath } from "../../client/app/ChatPage/utils"
import { copyTextToClipboard } from "../../client/lib/clipboard"
import { getPathBasename } from "../../client/lib/formatters"
import { fetchPairSession, startPairSession } from "../../client/lib/pairSession"
import type { ChatPreview, ChatTouchedFilesResult } from "../../shared/types"
import { AppAction } from "../app/action"
import { requestAction, type AppModel, type SliceOutMessage, type SliceReturn } from "../app/slice"
import * as Stores from "../app/stores"
import { sendCommand } from "../core/socket"
import * as ChatInput from "../core/stores/chatInput"
import * as ChatTabs from "../core/stores/chatTabs"
import * as Connection from "../core/stores/connection"
import * as FocusMode from "../core/stores/focusMode"
import * as SidebarSection from "../core/stores/sidebarSection"
import * as SidebarView from "../core/stores/sidebarView"
import * as ContextMenu from "../ui/context-menu"
import * as Dialog from "../ui/dialog"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"
import { activeChatId, appSettings, currentProjectId, isProjectCollapsed, routeProjectId, sidebarData, visibleProjectGroups, newSidebarEnabled } from "./derived"
import { CARD_CACHE_LIMIT, SyncHoverTracker } from "./hoverCard"
import { FLEET_URL } from "./machine"
import { findProject, findThread } from "./menus"
import { Message } from "./message"
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  type HoverList,
  type MenuTarget,
  type Model,
} from "./model"
import { CaptureOutgoingPage, captureOutgoingPage } from "./motion"
import { arrayMove } from "./projects"
import { SIDEBAR_WIDTH_STORAGE_KEY } from "../../client/lib/storageKeys"
import { writeStorageItem } from "../core/storage"

type Return = SliceReturn<Model, Message>
type Cmd = Command.Command<Message, never, never>

// COMMANDS

const done = () => Message.CompletedSideEffect()

/** The palette's own window event (CommandPalette.tsx's `openCommandPalette`). */
const OpenCommandPalette = Command.define("SidebarOpenCommandPalette", {
  args: { page: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedSideEffect],
  execute: ({ page }) => Effect.sync(() => {
    window.dispatchEvent(new CustomEvent("kanna:open-command-palette", { detail: page ? { page } : undefined }))
    return done()
  }),
})

export const SaveSidebarWidth = Command.define("SaveSidebarWidth", {
  args: { width: Schema.Number },
  messages: [Message.CompletedSideEffect],
  execute: ({ width }) => writeStorageItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width))).pipe(Effect.as(done())),
})

/** Opens a page in this browser rather than on the project's machine (`OpenRepoMenuItem`). */
const OpenWindow = Command.define("SidebarOpenWindow", {
  args: { url: Schema.String, features: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ url, features }) => Effect.sync(() => {
    window.open(url, "_blank", features)
    return done()
  }),
})

const HistoryStep = Command.define("SidebarHistoryStep", {
  args: { direction: Schema.Literals(["back", "forward"]) },
  messages: [Message.CompletedSideEffect],
  execute: ({ direction }) => (direction === "back" ? AppNavigation.back() : AppNavigation.forward()).pipe(Effect.as(done())),
})

/**
 * Leaving a project's page: back through the history where there is one to
 * go back through, so the Back button and the system's swipe land in the
 * same place, and to the menu for a page opened directly.
 */
const LeaveProjectPage = Command.define("SidebarLeaveProjectPage", {
  messages: [Message.CompletedSideEffect, Message.FoundNoHistoryToLeave],
  execute: Effect.gen(function* () {
    // The pop animates, as the back button's does (motion.ts).
    captureOutgoingPage()
    if (AppNavigation.historyIndex() <= 0) return Message.FoundNoHistoryToLeave()
    yield* AppNavigation.back()
    return done()
  }),
})

const ContinueActions = Command.define("SidebarContinueActions", {
  args: { actions: Schema.Array(AppAction) },
  messages: [Message.ContinuedActions],
  execute: ({ actions }) => Effect.succeed(Message.ContinuedActions({ actions })),
})

const MeasureMoreButton = Command.define("SidebarMeasureMoreButton", {
  args: { buttonId: Schema.String, target: Schema.Unknown },
  messages: [Message.MeasuredMoreButton, Message.CompletedSideEffect],
  execute: ({ buttonId, target }) => Effect.sync(() => {
    const rect = document.getElementById(buttonId)?.getBoundingClientRect()
    if (!rect) return done()
    // Where LocalProjectsSection's `openContextMenuFromButton` dispatched
    // its contextmenu: under the button's middle.
    return Message.MeasuredMoreButton({ target: target as MenuTarget, x: Math.trunc(rect.left + rect.width / 2), y: Math.trunc(rect.bottom) })
  }),
})

export const LoadTouchedFiles = Command.define("SidebarLoadTouchedFiles", {
  args: { chatId: Schema.String, cacheKey: Schema.String },
  messages: [Message.SucceededLoadTouchedFiles, Message.FailedLoadCard],
  execute: ({ chatId, cacheKey }) => sendCommand<ChatTouchedFilesResult>({ type: "chat.touchedFiles", chatId }).pipe(
    Effect.map((result) => Message.SucceededLoadTouchedFiles({ chatId, cacheKey, result })),
    Effect.catch(() => Effect.succeed(Message.FailedLoadCard())),
  ),
})

const LoadPreview = Command.define("SidebarLoadPreview", {
  args: { chatId: Schema.String, cacheKey: Schema.String },
  messages: [Message.SucceededLoadPreview, Message.FailedLoadCard],
  execute: ({ chatId, cacheKey }) => sendCommand<ChatPreview>({ type: "chat.getPreview", chatId }).pipe(
    Effect.map((preview) => Message.SucceededLoadPreview({ chatId, cacheKey, preview })),
    Effect.catch(() => Effect.succeed(Message.FailedLoadCard())),
  ),
})

const FetchPairSession = Command.define("SidebarFetchPairSession", {
  messages: [Message.ReceivedPairSession],
  execute: Effect.promise(() => fetchPairSession()).pipe(Effect.map((session) => Message.ReceivedPairSession({ session }))),
})

const StartPairSession = Command.define("SidebarStartPairSession", {
  messages: [Message.FinishedPairStart],
  execute: Effect.promise(() => startPairSession()).pipe(Effect.map((session) => Message.FinishedPairStart({ session }))),
})

/** useCloudPairSession's poll while a claim is outstanding: the machine's own cadence. */
const PAIR_POLL_MS = 2_000
const WaitPairPoll = Command.define("SidebarWaitPairPoll", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedPairPoll],
  execute: ({ version }) => Effect.sleep(Duration.millis(PAIR_POLL_MS)).pipe(Effect.as(Message.ElapsedPairPoll({ version }))),
})

const CopyPairLink = Command.define("SidebarCopyPairLink", {
  args: { text: Schema.String },
  messages: [Message.CopiedPairLink, Message.CompletedSideEffect],
  execute: ({ text }) => Effect.promise(() => copyTextToClipboard(text)).pipe(Effect.map((ok) => (ok ? Message.CopiedPairLink() : done()))),
})

const WaitPairCopied = Command.define("SidebarWaitPairCopied", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedPairCopied],
  execute: ({ version }) => Effect.sleep(Duration.millis(1600)).pipe(Effect.as(Message.ElapsedPairCopied({ version }))),
})

/**
 * How long the machine picker shows a switch as pending. Leaving the page
 * normally ends it first; this covers a switch that went nowhere.
 */
const SWITCH_PENDING_MS = 8_000
const WaitSwitchPending = Command.define("SidebarWaitSwitchPending", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedSwitchPending],
  execute: ({ version }) => Effect.sleep(Duration.millis(SWITCH_PENDING_MS)).pipe(Effect.as(Message.ElapsedSwitchPending({ version }))),
})

const OpenMachine = Command.define("SidebarOpenMachine", {
  args: { subdomain: Schema.NullOr(Schema.String), appOrigin: Schema.NullOr(Schema.String), fromMacApp: Schema.Boolean },
  messages: [Message.CompletedSideEffect],
  execute: ({ subdomain, appOrigin, fromMacApp }) => Effect.sync(() => {
    if (fromMacApp) {
      const webkit = (window as { webkit?: { messageHandlers?: { kanna?: { postMessage: (message: unknown) => void } } } }).webkit
      webkit?.messageHandlers?.kanna?.postMessage({ type: "openMachine", subdomain })
    } else if (appOrigin) {
      window.location.href = appOrigin
    }
    return done()
  }),
})

const LoadConnection = Command.mapMessage(Connection.LoadConnection(), (message) => Message.GotConnectionMessage({ message }))

// HELPERS

/** Asks the root for several things in order: the first now, the rest a tick later each. */
function requestActions(model: Model, actions: ReadonlyArray<AppAction>, commands: ReadonlyArray<Cmd> = []): Return {
  const [first, ...rest] = actions
  if (!first) return { model, commands: [...commands] }
  return {
    ...requestAction(model, first),
    commands: [...commands, ...(rest.length > 0 ? [ContinueActions({ actions: rest })] : [])],
  }
}

function withCommands(result: Return, commands: ReadonlyArray<Cmd>): Return {
  return { ...result, commands: [...(result.commands ?? []), ...commands] }
}

const store = (message: Stores.Message) => AppAction.Store({ message })
const navigate = (path: string, replace = false) => AppAction.Navigate({ path, replace })
const leaveArchived = store(Stores.Message.GotSidebarViewMessage({ message: SidebarView.Message.LeftArchived() }))

interface ChildStep<ChildModel, ChildMessage> {
  readonly model: ChildModel
  readonly commands?: ReadonlyArray<Command.Command<ChildMessage, never, never>>
}

function popoverStep(model: Model, key: "viewSwitcher" | "machineSwitcher", step: ChildStep<Popover.Model, Popover.Message>): { model: Model; commands: Cmd[] } {
  const wrap = (message: Popover.Message): Message => key === "viewSwitcher"
    ? Message.GotViewSwitcherMessage({ message })
    : Message.GotMachineSwitcherMessage({ message })
  return {
    model: modifyFields(model, { [key]: () => step.model } as never) as Model,
    commands: (step.commands ?? []).map((command) => Command.mapMessage(command, wrap)),
  }
}

function closePopover(model: Model, key: "viewSwitcher" | "machineSwitcher"): { model: Model; commands: Cmd[] } {
  return popoverStep(model, key, Popover.close(model[key]))
}

function dialogStep(model: Model, key: "archivedDialog" | "pairDialog", step: ChildStep<Dialog.Model, Dialog.Message>): { model: Model; commands: Cmd[] } {
  const wrap = (message: Dialog.Message): Message => key === "archivedDialog"
    ? Message.GotArchivedDialogMessage({ message })
    : Message.GotPairDialogMessage({ message })
  return {
    model: modifyFields(model, { [key]: () => step.model } as never) as Model,
    commands: (step.commands ?? []).map((command) => Command.mapMessage(command, wrap)),
  }
}

function rowMenuStep(model: Model, step: Update.ReturnWithOutMessage<ContextMenu.Model, ContextMenu.Message, ContextMenu.OutMessage>): { model: Model; commands: Cmd[]; outMessage: Option.Option<ContextMenu.OutMessage> } {
  return {
    model: modifyFields(model, { rowMenu: () => step.model }),
    commands: (step.commands ?? []).map((command) => Command.mapMessage(command, (message: ContextMenu.Message) => Message.GotRowMenuMessage({ message }))),
    outMessage: Option.fromNullishOr(step.outMessage),
  }
}

/** The list's tracker hears that the card closed (ListHoverCard's `dismiss`). */
function dismissCard(model: Model, list: HoverList): { model: Model; commands: Cmd[] } {
  return {
    model: modifyFields(model, { hovered: (hovered) => ({ ...hovered, [list]: null }) }),
    commands: [SyncHoverTracker({ list, action: "dismiss", key: null })],
  }
}

/** A channel card let go of: unpinned is closed, even under the pointer. */
function unpinChannel(model: Model): { model: Model; commands: Cmd[] } {
  const pinned = model.pinnedChannelId
  if (pinned === null) return { model, commands: [] }
  return {
    model: modifyFields(model, { pinnedChannelId: () => null, hovered: (hovered) => ({ ...hovered, channels: null }) }),
    commands: [SyncHoverTracker({ list: "channels", action: "unpinned", key: pinned })],
  }
}

/** Closes the channel's card, pinned or not (ChannelPeek's `onClose`). */
function closeChannelCard(model: Model): { model: Model; commands: Cmd[] } {
  const unpinned = unpinChannel(model)
  const dismissed = dismissCard(unpinned.model, "channels")
  return { model: dismissed.model, commands: [...unpinned.commands, ...dismissed.commands] }
}

/**
 * A click on a chat (KannaSidebar's `selectChat`): with chat tabs on, a
 * Cmd/Ctrl-click opens a tab for it and you stay where you are, as a
 * browser opens a link in the background.
 */
function selectChat(model: Model, app: AppModel, chatId: string, background: boolean): Return {
  if (appSettings(app)?.chatTabsEnabled === true && background) {
    return requestAction(model, store(Stores.Message.GotChatTabsMessage({
      message: ChatTabs.Message.OpenedTab({ chatId, afterChatId: activeChatId(app) }),
    })))
  }
  return requestAction(model, navigate(`/chat/${chatId}`))
}

/** Leaving the focused page (KannaSidebar's `exitFocusMode`). */
function exitFocusMode(model: Model, app: AppModel): Return {
  if (routeProjectId(app) === null) {
    const off = store(Stores.Message.GotFocusModeMessage({ message: FocusMode.Message.ChangedFocusMode({ enabled: false }) }))
    return { model, commands: [CaptureOutgoingPage({ then: [off] })] }
  }
  return { model, commands: [LeaveProjectPage()] }
}

function persistWidth(model: Model, width: number): Return {
  const clamped = clampSidebarWidth(width)
  return { model: modifyFields(model, { sidebarWidth: () => clamped }), commands: [SaveSidebarWidth({ width: clamped })] }
}

function cacheInsert<Value>(cache: Readonly<Record<string, Value>>, key: string, value: Value): Record<string, Value> {
  const next: Record<string, Value> = { ...cache }
  const keys = Object.keys(next)
  if (!(key in next) && keys.length >= CARD_CACHE_LIMIT) delete next[keys[0]!]
  next[key] = value
  return next
}

/** What a chosen menu item does, by what the menu was opened on. */
function chooseMenuItem(model: Model, app: AppModel, target: MenuTarget, value: string): Return {
  if (target._tag === "Section") {
    return value === "archive-all" ? requestActions(model, target.chatIds.map((chatId) => AppAction.ArchiveChat({ chatId }))) : { model }
  }
  if (target._tag === "Project") {
    const group = findProject(app, target.projectId)
    if (!group) return { model }
    const { groupKey, localPath } = group
    switch (value) {
      case "new-chat": {
        if (target.channel) return requestAction(model, AppAction.CreateChat({ projectId: groupKey }))
        // The Projects view's New Chat goes by path, as `onNewLocalChat` did.
        const projectId = sidebarData(app).projectGroups.find((item) => item.localPath === localPath)?.groupKey
        return projectId ? requestAction(model, AppAction.CreateChat({ projectId })) : { model }
      }
      case "pin": return requestAction(model, AppAction.SetProjectPinned({ projectId: groupKey, pinned: group.pinnedAt == null }))
      case "rename": return requestAction(model, AppAction.RenameProject({
        target: groupKey,
        sidebarTitle: group.sidebarTitle ?? null,
        realTitle: group.realTitle || getPathBasename(localPath),
      }))
      case "copy-path": return requestAction(model, AppAction.CopyPath({ localPath }))
      case "show-archived": {
        const opened = dialogStep(modifyFields(model, { archivedProjectId: () => groupKey }), "archivedDialog", Dialog.open(model.archivedDialog))
        return { model: opened.model, commands: opened.commands }
      }
      case "open-finder": return requestAction(model, AppAction.OpenExternalPath({ action: "open_finder", localPath }))
      case "open-editor": return requestAction(model, AppAction.OpenExternalPath({ action: "open_editor", localPath }))
      case "open-repo": return group.repoUrl ? { model, commands: [OpenWindow({ url: group.repoUrl, features: "noopener,noreferrer" })] } : { model }
      case "hide": return requestAction(model, AppAction.HideProject({ target: groupKey }))
      default: return { model }
    }
  }
  const thread = findThread(app, target.chatId)
  if (!thread) return { model }
  const row = thread.row
  // The chats in a channel's card: what takes you elsewhere or opens a
  // dialog closes the card first; the rest leave it where it was.
  const closingCard = (actions: ReadonlyArray<AppAction>): Return => {
    if (!target.inCard) return requestActions(model, actions)
    const closed = closeChannelCard(model)
    return requestActions(closed.model, actions, closed.commands)
  }
  switch (value) {
    case "pin": return requestAction(model, AppAction.TogglePinChat({ chatId: row.chatId, pinned: !row.pinnedAt }))
    case "delegator": return requestAction(model, AppAction.SetDelegator({ chatId: row.chatId, delegator: !row.delegator }))
    case "clear-draft": return requestAction(model, store(Stores.Message.GotChatInputMessage({ message: ChatInput.Message.ClearedDraft({ chatId: row.chatId }) })))
    case "restore": return requestActions(model, [leaveArchived, AppAction.RestoreChat({ chatId: row.chatId })])
    case "rename": return closingCard([AppAction.RenameChat({ chatId: row.chatId, title: row.title })])
    case "share": return closingCard([AppAction.ShareChat({ chatId: row.chatId })])
    case "fork": return row.canFork ? closingCard([AppAction.ForkChat({ chatId: row.chatId })]) : { model }
    case "new-chat": return closingCard([AppAction.CreateChat({ projectId: thread.projectId })])
    case "copy-path": return requestAction(model, AppAction.CopyPath({ localPath: row.localPath }))
    case "open-finder": return requestAction(model, AppAction.OpenExternalPath({ action: "open_finder", localPath: row.localPath }))
    case "open-editor": return requestAction(model, AppAction.OpenExternalPath({ action: "open_editor", localPath: row.localPath }))
    case "open-repo": {
      const url = thread.projectLabel.repoUrl
      return url ? { model, commands: [OpenWindow({ url, features: "noopener,noreferrer" })] } : { model }
    }
    case "archive": return target.archived ? { model } : requestAction(model, AppAction.ArchiveChat({ chatId: row.chatId }))
    case "delete": return closingCard([AppAction.DeleteChat({ chatId: row.chatId, title: row.title })])
    default: return { model }
  }
}

/** The pair dialog's first open mints a claim URL; the server reuses a live session. */
function beginPairIfNeeded(model: Model): Return {
  const status = model.pairSession.status
  if (model.pairBegun || status === "paired" || status === "unsupported") return { model }
  return {
    model: modifyFields(model, { pairBegun: () => true, pairStarting: () => true }),
    commands: [StartPairSession()],
  }
}

function receivedPairSession(model: Model, session: Model["pairSession"]): Return {
  const version = model.pairPollVersion + 1
  const next = modifyFields(model, { pairSession: () => session, pairPollVersion: () => version })
  return { model: next, commands: session.status === "waiting" ? [WaitPairPoll({ version })] : [] }
}

// UPDATE

export function update(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    TickedClock: ({ nowMs }) => ({ model: modifyFields(model, { nowMs: () => nowMs }) }),
    ChangedFinePointer: ({ matches }) => ({ model: modifyFields(model, { hasFinePointer: () => matches }) }),
    ChangedPhoneLayout: ({ matches }) => ({ model: modifyFields(model, { isPhoneLayout: () => matches }) }),
    ChangedStandalone: ({ matches }) => ({ model: modifyFields(model, { isStandalone: () => matches }) }),

    ClickedCollapseSidebar: () => requestAction(model, AppAction.CollapseSidebar()),
    ClickedExpandSidebar: () => requestAction(model, AppAction.ExpandSidebar()),
    ClickedLink: ({ path }) => requestAction(model, navigate(path)),
    ClickedSearch: () => ({ model, commands: [OpenCommandPalette({ page: null })] }),
    ClickedAddProject: () => ({ model, commands: [OpenCommandPalette({ page: "add-project" })] }),
    // On a project's page, a chat in that project; else the current one's.
    ClickedNewChat: () => {
      const projectId = routeProjectId(app)
      return requestAction(model, projectId ? AppAction.CreateChat({ projectId }) : AppAction.Compose())
    },
    ClickedExitFocus: () => exitFocusMode(model, app),
    ClickedHistoryBack: () => ({ model, commands: [HistoryStep({ direction: "back" })] }),
    ClickedHistoryForward: () => ({ model, commands: [HistoryStep({ direction: "forward" })] }),
    FoundNoHistoryToLeave: () => requestAction(model, navigate("/", true)),
    GotViewSwitcherMessage: ({ message: child }) => popoverStep(model, "viewSwitcher", Popover.update(model.viewSwitcher, child)),
    ChoseSidebarView: ({ view }) => {
      const closed = closePopover(model, "viewSwitcher")
      return withCommands(requestAction(closed.model, store(Stores.Message.GotSidebarViewMessage({ message: SidebarView.Message.ChangedView({ view }) }))), closed.commands)
    },

    ClickedChat: ({ chatId, archived }) => {
      const background = model.backgroundClickChatId === chatId
      const next = modifyFields(model, { backgroundClickChatId: () => null })
      if (archived) return requestAction(next, AppAction.OpenArchivedChat({ chatId }))
      return selectChat(next, app, chatId, background)
    },
    PressedChatInBackground: ({ chatId }) => ({ model: modifyFields(model, { backgroundClickChatId: () => chatId }) }),
    ClickedForkChat: ({ chatId }) => requestAction(model, AppAction.ForkChat({ chatId })),
    ClickedArchiveChat: ({ chatId }) => requestAction(model, AppAction.ArchiveChat({ chatId })),
    ClickedRestoreChat: ({ chatId }) => requestActions(model, [leaveArchived, AppAction.RestoreChat({ chatId })]),

    ToggledSection: ({ scope, sectionKey, expanded }) => requestAction(model, store(Stores.Message.GotSidebarSectionMessage({
      message: SidebarSection.Message.ChangedSectionExpanded({ scope, sectionKey, expanded }),
    }))),

    ToggledProjectGroup: ({ projectId }) => {
      const group = app.stores.sidebar.data.projectGroups.find((item) => item.groupKey === projectId)
      const collapsed = group ? isProjectCollapsed(model, group) : Boolean(model.projectFolds[projectId])
      return { model: modifyFields(model, { projectFolds: (folds) => ({ ...folds, [projectId]: !collapsed }) }) }
    },
    ToggledExpandedGroup: ({ projectId }) => ({
      model: modifyFields(model, {
        expandedGroups: (groups) => (groups.includes(projectId) ? groups.filter((key) => key !== projectId) : [...groups, projectId]),
      }),
    }),
    ClickedNewProjectChat: ({ localPath }) => {
      const projectId = sidebarData(app).projectGroups.find((group) => group.localPath === localPath)?.groupKey
      return projectId ? requestAction(model, AppAction.CreateChat({ projectId })) : { model }
    },
    PressedProjectHeader: ({ projectId, pointerId, y }) => ({
      model: modifyFields(model, {
        projectDrag: () => ({ projectId, pointerId, startY: y, active: false, deltaY: 0, overId: null, activeHeight: 0 }),
      }),
    }),
    ActivatedProjectDrag: ({ activeHeight }) => ({
      model: modifyFields(model, { projectDrag: (drag) => (drag ? { ...drag, active: true, activeHeight, overId: drag.projectId } : drag) }),
    }),
    MovedProjectDrag: ({ deltaY, overId }) => ({
      model: modifyFields(model, { projectDrag: (drag) => (drag ? { ...drag, deltaY, overId } : drag) }),
    }),
    ReleasedProjectDrag: () => {
      const drag = model.projectDrag
      const next = modifyFields(model, { projectDrag: () => null })
      if (!drag?.active || !drag.overId || drag.overId === drag.projectId) return { model: next }
      // In the order the Projects view lists them (LocalProjectsSection's `groupIds`).
      const groupIds = visibleProjectGroups(app, newSidebarEnabled(app) && app.stores.sidebarView.view === "projects").map((group) => group.groupKey)
      const from = groupIds.indexOf(drag.projectId)
      const to = groupIds.indexOf(drag.overId)
      if (from === -1 || to === -1) return { model: next }
      return requestAction(next, AppAction.ReorderProjectGroups({ projectIds: arrayMove(groupIds, from, to) }))
    },
    CancelledProjectDrag: () => ({ model: modifyFields(model, { projectDrag: () => null }) }),

    // A click on a channel goes to its delegator or its new chat page; on
    // touch, where there is no card, it opens the channel as a page.
    ClickedChannel: ({ projectId }) => {
      // As a page, pushed onto the history; the push animates as focus mode's does.
      if (!model.hasFinePointer || model.isPhoneLayout) {
        return { model, commands: [CaptureOutgoingPage({ then: [navigate(`/project/${encodeURIComponent(projectId)}`)] })] }
      }
      const unpinned = unpinChannel(model)
      return withCommands(requestAction(unpinned.model, AppAction.OpenProjectNewChat({ projectId })), unpinned.commands)
    },
    ClickedPeekNewChat: ({ projectId }) => {
      const closed = closeChannelCard(model)
      return withCommands(requestAction(closed.model, AppAction.CreateChat({ projectId })), closed.commands)
    },
    ClickedPeekShowMore: ({ projectId }) => ({ model: modifyFields(model, { pinnedChannelId: () => projectId }) }),
    ClickedPeekChat: ({ chatId }) => {
      // Opening in the background leaves you here, card and all, to open the next one.
      if (model.backgroundClickChatId === chatId) {
        return selectChat(modifyFields(model, { backgroundClickChatId: () => null }), app, chatId, true)
      }
      const closed = closeChannelCard(model)
      return withCommands(selectChat(closed.model, app, chatId, false), closed.commands)
    },

    PressedMenuTrigger: ({ target, pointerType, button, x, y }) => {
      const step = rowMenuStep(model, ContextMenu.update(model.rowMenu, ContextMenu.Message.PressedTrigger({ pointerType, button, x, y })))
      // A touch press opens on its own after the long-press delay: it names its target now.
      const next = pointerType === "touch" || pointerType === "pen" ? modifyFields(step.model, { menuTarget: () => target }) : step.model
      return { model: next, commands: step.commands }
    },
    RequestedMenu: ({ target }) => {
      const step = rowMenuStep(modifyFields(model, { menuTarget: () => target }), ContextMenu.update(model.rowMenu, ContextMenu.Message.RequestedContextMenu()))
      return { model: step.model, commands: step.commands }
    },
    MovedOnMenuTrigger: () => {
      if (Option.isNone(model.rowMenu.longPressVersion)) return { model }
      const step = rowMenuStep(model, ContextMenu.update(model.rowMenu, ContextMenu.Message.CancelledLongPress()))
      return { model: step.model, commands: step.commands }
    },
    ClickedMoreButton: ({ target, buttonId }) => ({ model, commands: [MeasureMoreButton({ buttonId, target })] }),
    MeasuredMoreButton: ({ target, x, y }) => {
      const pressed = ContextMenu.update(model.rowMenu, ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x, y }))
      const opened = ContextMenu.update(pressed.model, ContextMenu.Message.RequestedContextMenu())
      const step = rowMenuStep(modifyFields(model, { menuTarget: () => target }), opened)
      return { model: step.model, commands: [...rowMenuStep(model, pressed).commands, ...step.commands] }
    },
    GotRowMenuMessage: ({ message: child }) => {
      const step = rowMenuStep(model, ContextMenu.update(model.rowMenu, child))
      const out = step.outMessage
      if (Option.isSome(out) && out.value._tag === "Selected" && model.menuTarget) {
        return withCommands(chooseMenuItem(step.model, app, model.menuTarget, out.value.value), step.commands)
      }
      return { model: step.model, commands: step.commands }
    },

    GotTooltipMessage: ({ key, message: child }) => {
      const current = model.tooltips[key] ?? Tooltip.init({ id: key })
      const step = Tooltip.update(current, child)
      return {
        model: modifyFields(model, { tooltips: (tooltips) => ({ ...tooltips, [key]: step.model }) }),
        commands: (step.commands ?? []).map((command) => Command.mapMessage(command, (message: Tooltip.Message) => Message.GotTooltipMessage({ key, message }))),
      }
    },

    ChangedHoveredRow: ({ list, key }) => ({
      model: modifyFields(model, {
        hovered: (hovered) => ({ ...hovered, [list]: key }),
        // A card that leaves stops waiting on its answers.
        ...(key === null && list !== "channels" ? { cardFilesKey: () => null, cardPreviewKey: () => null } : {}),
      }),
    }),
    RequestedCardLoad: ({ chatId, kind, cacheKey }) => {
      if (kind === "files") {
        const cached = model.touchedFilesCache[cacheKey]
        if (cached) return { model: modifyFields(model, { heldTouchedFiles: () => ({ chatId, result: cached }), cardFilesKey: () => cacheKey }) }
        return {
          model: modifyFields(model, {
            heldTouchedFiles: (held) => (held?.chatId === chatId ? held : null),
            cardFilesKey: () => cacheKey,
          }),
          commands: [LoadTouchedFiles({ chatId, cacheKey })],
        }
      }
      const cached = model.previewCache[cacheKey]
      if (cached) return { model: modifyFields(model, { heldPreview: () => ({ chatId, preview: cached }), cardPreviewKey: () => cacheKey }) }
      return {
        model: modifyFields(model, {
          heldPreview: (held) => (held?.chatId === chatId ? held : null),
          cardPreviewKey: () => cacheKey,
        }),
        commands: [LoadPreview({ chatId, cacheKey })],
      }
    },
    SucceededLoadTouchedFiles: ({ chatId, cacheKey, result }) => ({
      model: modifyFields(model, {
        touchedFilesCache: (cache) => cacheInsert(cache, cacheKey, result),
        heldTouchedFiles: (held) => (model.cardFilesKey === cacheKey ? { chatId, result } : held),
      }),
    }),
    SucceededLoadPreview: ({ chatId, cacheKey, preview }) => ({
      model: modifyFields(model, {
        previewCache: (cache) => cacheInsert(cache, cacheKey, preview),
        heldPreview: (held) => (model.cardPreviewKey === cacheKey ? { chatId, preview } : held),
      }),
    }),
    FailedLoadCard: () => ({ model }),
    ClickedCardMessage: ({ list, chatId }) => {
      const dismissed = dismissCard(model, list)
      // TODO(root): React navigated with a jump target in the location state
      // (`buildChatJumpLocationState(role)`); AppAction.Navigate carries none.
      return withCommands(requestAction(dismissed.model, navigate(`/chat/${chatId}`)), dismissed.commands)
    },
    ClickedCardChat: ({ list, chatId, archived }) => {
      const dismissed = dismissCard(model, list)
      const result = archived
        ? requestAction(dismissed.model, AppAction.OpenArchivedChat({ chatId }))
        : selectChat(dismissed.model, app, chatId, false)
      return withCommands(result, dismissed.commands)
    },
    ClickedCardSetupGit: ({ list, chatId }) => {
      const dismissed = dismissCard(model, list)
      return withCommands(requestAction(dismissed.model, AppAction.SetupGit({ chatId })), dismissed.commands)
    },
    ClickedCardRepo: ({ list, url }) => {
      const dismissed = dismissCard(model, list)
      return { model: dismissed.model, commands: [...dismissed.commands, OpenWindow({ url, features: "noopener,noreferrer" })] }
    },
    ClickedCardFile: ({ list, localPath, filePath }) => {
      const dismissed = dismissCard(model, list)
      return withCommands(
        requestAction(dismissed.model, AppAction.OpenExternalPath({ action: "open_editor", localPath: resolveDiffFilePath(localPath, filePath) })),
        dismissed.commands,
      )
    },
    DismissedChannelCard: () => {
      const unpinned = unpinChannel(model)
      return { model: unpinned.model, commands: unpinned.commands }
    },

    GotArchivedDialogMessage: ({ message: child }) => {
      const step = Dialog.update(model.archivedDialog, child)
      const wrapped = dialogStep(model, "archivedDialog", step)
      const closed = step.outMessage?._tag === "Closed"
      return { model: closed ? modifyFields(wrapped.model, { archivedProjectId: () => null }) : wrapped.model, commands: wrapped.commands }
    },
    ClickedArchivedDialogChat: ({ chatId }) => {
      const closed = dialogStep(modifyFields(model, { archivedProjectId: () => null }), "archivedDialog", Dialog.close(model.archivedDialog))
      return withCommands(requestAction(closed.model, AppAction.OpenArchivedChat({ chatId })), closed.commands)
    },
    ClickedArchivedDialogRestore: ({ chatId }) => requestActions(model, [leaveArchived, AppAction.RestoreChat({ chatId })]),

    ChangedNumberJumpHints: ({ show }) => (show === model.showNumberJumpHints ? { model } : { model: modifyFields(model, { showNumberJumpHints: () => show }) }),
    PressedCreateChatShortcut: () => {
      const projectId = currentProjectId(app)
      return projectId ? requestAction(model, AppAction.CreateChat({ projectId })) : { model }
    },
    PressedAddProjectShortcut: () => ({ model, commands: [OpenCommandPalette({ page: "add-project" })] }),
    PressedToggleFocusShortcut: () => requestAction(
      // No copy of the page is taken: a shortcut lands at once (motion.ts).
      model,
      store(Stores.Message.GotFocusModeMessage({ message: FocusMode.Message.ToggledFocusMode() })),
    ),
    PressedJumpShortcut: ({ chatId }) => requestAction(model, navigate(`/chat/${chatId}`)),
    PressedEscapeToLeaveFocus: () => exitFocusMode(model, app),

    PressedResizeHandle: ({ pointerX }) => ({ model: modifyFields(model, { resizeStart: () => ({ pointerX, width: model.sidebarWidth }) }) }),
    MovedResize: ({ pointerX }) => {
      const start = model.resizeStart
      if (!start) return { model }
      return { model: modifyFields(model, { sidebarWidth: () => clampSidebarWidth(start.width + pointerX - start.pointerX) }) }
    },
    ReleasedResize: () => persistWidth(modifyFields(model, { resizeStart: () => null }), model.sidebarWidth),
    DoubleClickedResizeHandle: () => persistWidth(model, DEFAULT_SIDEBAR_WIDTH),
    PressedResizeKey: ({ key }) => {
      const width = key === "ArrowLeft" ? model.sidebarWidth - 16
        : key === "ArrowRight" ? model.sidebarWidth + 16
          : key === "Home" ? MIN_SIDEBAR_WIDTH
            : key === "End" ? MAX_SIDEBAR_WIDTH
              : key === "Enter" ? DEFAULT_SIDEBAR_WIDTH
                : null
      return width === null ? { model } : persistWidth(model, width)
    },

    ChangedPeek: ({ peeking }) => ({ model: modifyFields(model, { peeking: () => peeking }) }),

    RequestedConnectionLoad: () => ({ model, commands: [LoadConnection] }),
    GotConnectionMessage: ({ message: child }) => requestAction(model, store(Stores.Message.GotConnectionMessage({ message: child }))),
    RequestedPairSession: () => ({ model, commands: [FetchPairSession()] }),
    ReceivedPairSession: ({ session }) => receivedPairSession(model, session),
    ElapsedPairPoll: ({ version }) =>
      version === model.pairPollVersion && model.pairSession.status === "waiting" ? { model, commands: [FetchPairSession()] } : { model },
    ClickedRetryPair: () => ({ model: modifyFields(model, { pairStarting: () => true }), commands: [StartPairSession()] }),
    FinishedPairStart: ({ session }) => receivedPairSession(modifyFields(model, { pairStarting: () => false }), session),
    ClickedCopyPairLink: ({ text }) => ({ model, commands: [CopyPairLink({ text })] }),
    CopiedPairLink: () => {
      const version = model.pairCopyVersion + 1
      return { model: modifyFields(model, { pairCopied: () => true, pairCopyVersion: () => version }), commands: [WaitPairCopied({ version })] }
    },
    ElapsedPairCopied: ({ version }) => (version === model.pairCopyVersion ? { model: modifyFields(model, { pairCopied: () => false }) } : { model }),

    GotMachineSwitcherMessage: ({ message: child }) => popoverStep(model, "machineSwitcher", Popover.update(model.machineSwitcher, child)),
    ClosedMachineSwitcher: () => {
      const closed = closePopover(model, "machineSwitcher")
      return { model: closed.model, commands: closed.commands }
    },
    ChoseMachine: ({ subdomain, name, appOrigin }) => {
      const closed = closePopover(model, "machineSwitcher")
      const version = model.switchVersion + 1
      return {
        model: modifyFields(closed.model, { switchingTo: () => name, switchVersion: () => version }),
        commands: [
          ...closed.commands,
          WaitSwitchPending({ version }),
          OpenMachine({ subdomain, appOrigin, fromMacApp: app.stores.connection.fromMacApp }),
        ],
      }
    },
    ElapsedSwitchPending: ({ version }) => (version === model.switchVersion ? { model: modifyFields(model, { switchingTo: () => null }) } : { model }),
    ClickedManageFleet: () => {
      const closed = closePopover(model, "machineSwitcher")
      return { model: closed.model, commands: [...closed.commands, OpenWindow({ url: FLEET_URL, features: "noopener" })] }
    },
    ClickedSetupCloud: () => {
      const opened = dialogStep(model, "pairDialog", Dialog.open(model.pairDialog))
      return withCommands(beginPairIfNeeded(opened.model), opened.commands)
    },
    GotPairDialogMessage: ({ message: child }) => {
      const wrapped = dialogStep(model, "pairDialog", Dialog.update(model.pairDialog, child))
      return { model: wrapped.model, commands: wrapped.commands }
    },

    ObservedSendStarted: () => requestAction(model, leaveArchived),
    ContinuedActions: ({ actions }) => requestActions(model, actions),
    CompletedSideEffect: () => ({ model }),
  })
}

export type { SliceOutMessage }
