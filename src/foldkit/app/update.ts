import { Option } from "effect"
import { Command, Navigation, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { fromString as urlFromString, toString as urlToString, type Url } from "foldkit/url"
import { getChatNotificationEvents, getChatSoundBurstCount } from "../../client/app/chatNotifications"
import { isProcessingStatus } from "../../client/app/derived"
import { getMostRecentlyActiveProjectId, getProjectIdForChat } from "../../client/app/kannaStateHelpers"
import { sameDiffs, shouldPreserveExistingProjectDiffs } from "../core/snapshotEquality"
import { DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES } from "../../shared/transcript-window"
import type { AppSettingsSnapshot, SidebarData } from "../../shared/types"
import * as ChatSession from "../core/chatSession"
import type { KannaSocketService } from "../core/socket"
import * as ChatPreferences from "../core/stores/chatPreferences"
import * as PendingSend from "../core/stores/pendingSend"
import * as Composer from "../composer"
import * as Sidebar from "../core/stores/sidebar"
import * as ViewerStore from "../core/stores/viewer"
import {
  ApplyTheme,
  DelayAuthRetry,
  DelayBackgroundChatDrop,
  FetchAuthStatus,
  FollowBackgroundChat,
  LoadExternal,
  PlayChatSound,
  PushUrl,
  ReadAppSettings,
  ReadLlmProvider,
  ReplaceUrl,
  SaveSidebarCollapsed,
  SendCommand,
  ShowChatNotification,
  SubmitPassword,
  UnfollowBackgroundChat,
} from "./commands"
import { Message } from "./message"
import type { Flags, Model } from "./model"
import { routeChatId, settingsRouter, urlToAppRoute, type AppRoute } from "./route"
import * as SidebarSlice from "../sidebar"
import * as HomeSlice from "../home"
import * as SettingsSlice from "../settings"
import * as ChatPageSlice from "../chat"
import * as PaletteSlice from "../palette"
import * as SetupSlice from "../setup"
import * as WorkflowsSlice from "../workflows"
import * as TerminalPageSlice from "../terminal"
import * as AppDialog from "../ui/app-dialog"
import { isNightlyVersion } from "../../shared/types"
import * as OpenRouterCallback from "./openRouterCallback"
import { FollowRestart, HandleReloadRequest, MigrateChannelPins, MigrateLegacyBrowserSettings, MigrateLegacySetupFlags, updateCheckInterval } from "./maintenance"
import { ActionMessage as ActionMessageUnion, initialActionsModel, makeActions, type ActionMessage } from "./actions"
import * as ShareDialog from "../chat/shareDialog"
import { SliceOutMessage, type AppModel, type SliceObserve, type SliceReturn } from "./slice"
import type { AppAction } from "./action"
import * as Stores from "./stores"
import { resolveTheme, themePreference } from "./theme"

/** What the root's Commands may need: the socket. */
export type AppServices = KannaSocketService
type UpdateReturn = Update.Return<Model, Message, AppServices>
type AppCommand = Command.Command<Message, never, AppServices>
type Commands = ReadonlyArray<AppCommand>
type Step = Update.Step<Model, Message, AppServices>

const liftStores = (commands: Update.Return<Stores.Model, Stores.Message, AppServices>["commands"]) =>
  Command.mapMessages(commands, (message: Stores.Message) => Message.GotStoresMessage({ message }))

// INIT

export function init(flags: Flags, frameUrl: Url): UpdateReturn {
  // The demo starts where its memory history does, not at the frame's address.
  const url = flags.memoryUrl ? Option.getOrElse(urlFromString(flags.memoryUrl), () => frameUrl) : frameUrl
  const route = urlToAppRoute(url)
  // The demo and the parity fixture seed settings before the first render,
  // as their React entries seed the store.
  const stores: Stores.Model = flags.initialAppSettings
    ? { ...flags.stores, appSettings: { settings: flags.initialAppSettings } }
    : flags.stores
  const model: Model = {
    route,
    auth: { _tag: "Checking" },
    socketReady: false,
    connectionStatus: "connecting",
    localProjects: null,
    localProjectsReady: false,
    updateSnapshot: null,
    keybindings: null,
    llmProvider: null,
    projectDiffs: {},
    selectedProjectId: null,
    sidebarCollapsed: flags.sidebarCollapsed,
    commandError: null,
    backgroundChats: {},
    systemTheme: flags.systemTheme,
    chat: null,
    stores,
    actions: initialActionsModel,
    appDialog: AppDialog.init(),
    shareDialog: ShareDialog.init(),
    openRouterCallback: OpenRouterCallback.init(Option.getOrElse(url.search, () => "")),
    legacySettingsMigrationStarted: false,
    pageHidden: false,
    draftIdsSeen: draftIdsOf(stores),
    sidebar: SidebarSlice.init(),
    home: HomeSlice.init(),
    settings: SettingsSlice.init(),
    chatPage: ChatPageSlice.init(),
    palette: PaletteSlice.init(),
    setup: SetupSlice.init(),
    workflows: WorkflowsSlice.init(),
    terminalPage: TerminalPageSlice.init(),
  }
  const session = syncChatSession(model, 0)
  return {
    model: session.model,
    commands: [
      FetchAuthStatus(),
      ApplyTheme({ resolved: resolveTheme(themePreference(appSettings(model)), model.systemTheme) }),
      ...routeRedirect(route),
      ...liftStores(Stores.initCommands),
      ...(session.commands ?? []),
    ],
  }
}

/** `/settings` is <Navigate to="/settings/general" replace />. */
function routeRedirect(route: AppRoute): Commands {
  return route._tag === "SettingsIndex" ? [ReplaceUrl({ url: settingsRouter({ sectionId: "general" }) })] : []
}

// DERIVED

export function appSettings(model: Model): AppSettingsSnapshot | null {
  return model.stores.appSettings.settings
}

export function sidebarData(model: Model): SidebarData {
  return model.stores.sidebar.data
}

export function activeChatId(model: Model): string | null {
  return routeChatId(model.route)
}

/** The page's chat snapshot, if it is the open chat's. */
export function activeChatSnapshot(model: Model) {
  return model.chat && model.chat.chatId === activeChatId(model) ? ChatSession.snapshotOf(model.chat) : null
}

/** useKannaState's activeProjectId. */
export function activeProjectId(model: Model): string | null {
  const chatId = activeChatId(model)
  return activeChatSnapshot(model)?.runtime.projectId
    ?? (chatId ? getProjectIdForChat(sidebarData(model).projectGroups, chatId) : null)
    ?? model.selectedProjectId
}

/** The sidebar's status for a chat, which stands in until its snapshot lands. */
export function sidebarChatStatus(model: Model, chatId: string | null): string | null {
  if (!chatId) return null
  for (const group of sidebarData(model).projectGroups) {
    const chat = group.chats.find((row) => row.chatId === chatId)
    if (chat) return chat.status
  }
  return null
}

function transcriptWindowSize(model: Model) {
  return appSettings(model)?.transcript?.windowAssistantMessages ?? DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES
}

function commandError(model: Model, message: string | null): Model {
  return model.commandError === message ? model : modifyFields(model, { commandError: () => message })
}

// STORES

/** A Step on the stores, run from the root. */
function onStores(step: Update.StepWithOutMessage<Stores.Model, Stores.Message, Stores.OutMessage, AppServices>): Step {
  return (model) => {
    const result = step(model.stores)
    return { model: modifyFields(model, { stores: () => result.model }), commands: liftStores(result.commands) }
  }
}

// BACKGROUND CHATS (useBackgroundChatSubscriptions)

function runningChatIds(data: SidebarData): string[] {
  const ids: string[] = []
  for (const group of data.projectGroups) {
    for (const chat of group.chats) {
      if (isProcessingStatus(chat.status)) ids.push(chat.chatId)
    }
  }
  return ids.sort()
}

/**
 * Hold a subscription on every running chat except the open ones, so opening
 * a running chat paints from a current window and the server only has to
 * send what landed since the last background push. Open means the chat the
 * page is on, and the one in the previewer beside it (the viewer store's
 * live chat). A chat that stops running is let go after a grace period.
 */
function reconcileBackgroundChats(model: Model): UpdateReturn {
  if (!model.socketReady) return { model }
  const openChatId = activeChatId(model)
  const previewChatId = ViewerStore.previewedChatId(model.stores.viewer)
  const wanted = new Set(runningChatIds(sidebarData(model)))
  if (openChatId) wanted.delete(openChatId)
  if (previewChatId) wanted.delete(previewChatId)

  const next: Record<string, "following" | "dropping"> = { ...model.backgroundChats }
  const commands: AppCommand[] = []
  for (const [chatId, state] of Object.entries(model.backgroundChats)) {
    if (wanted.has(chatId)) {
      next[chatId] = "following"
      continue
    }
    if (chatId === openChatId || chatId === previewChatId) {
      delete next[chatId]
      commands.push(UnfollowBackgroundChat({ chatId }))
      continue
    }
    if (state === "following") {
      next[chatId] = "dropping"
      commands.push(DelayBackgroundChatDrop({ chatId }))
    }
  }
  for (const chatId of wanted) {
    if (next[chatId]) continue
    next[chatId] = "following"
    commands.push(FollowBackgroundChat({ chatId, windowSize: transcriptWindowSize(model) }))
  }
  const changed = commands.length > 0 || Object.keys(next).some((chatId) => next[chatId] !== model.backgroundChats[chatId])
  return changed ? { model: modifyFields(model, { backgroundChats: () => next }), commands } : { model }
}

// SNAPSHOTS

function themeCommands(before: Model, after: Model): Commands {
  const previous = resolveTheme(themePreference(appSettings(before)), before.systemTheme)
  const next = resolveTheme(themePreference(appSettings(after)), after.systemTheme)
  return previous === next && themePreference(appSettings(before)) === themePreference(appSettings(after))
    ? []
    : [ApplyTheme({ resolved: next })]
}

/** useAppSettingsSync: the snapshot fans out to the stores; the theme follows. */
function receiveAppSettings(model: Model, snapshot: AppSettingsSnapshot): UpdateReturn {
  const fanned = onStores(Stores.receivedAppSettings(snapshot))(model)
  let next = commandError(fanned.model, null)
  const migrations: AppCommand[] = []
  if (next.connectionStatus === "connected") {
    // useAppSettingsSync's legacy migrations, once connected.
    if (snapshot.browserSettingsMigrated === false && !next.legacySettingsMigrationStarted) {
      next = modifyFields(next, { legacySettingsMigrationStarted: () => true })
      migrations.push(MigrateLegacyBrowserSettings())
    }
    migrations.push(MigrateLegacySetupFlags({ snapshot }))
  }
  return { model: next, commands: [...(fanned.commands ?? []), ...migrations] }
}

/** App.tsx's sidebar store subscription: chime and notify on what changed. */
function notificationCommands(model: Model, previous: SidebarData, next: SidebarData): Commands {
  const settings = appSettings(model)
  if (!settings) return []
  const commands: AppCommand[] = []
  const burstCount = getChatSoundBurstCount(previous, next)
  if (burstCount > 0) {
    commands.push(PlayChatSound({ preference: settings.chatSoundPreference, soundId: settings.chatSoundId, burstCount }))
  }
  for (const event of getChatNotificationEvents(previous, next)) {
    commands.push(ShowChatNotification({ preference: settings.chatBrowserNotificationPreference, ...event }))
  }
  return commands
}

/**
 * After a sidebar push: the command error clears, the selected project is
 * seeded from the most recently active one the first time, chimes and
 * notifications go out for what changed, and running chats are followed.
 */
function appliedSidebarSnapshot(before: Model): Step {
  return (afterPush) => {
    const bounced = bounceUnknownChat(afterPush)
    const model = bounced.model
    let next = commandError(model, null)
    if (!next.selectedProjectId) {
      const seed = getMostRecentlyActiveProjectId(sidebarData(next).projectGroups)
      if (seed) next = modifyFields(next, { selectedProjectId: () => seed })
    }
    // The first snapshot has nothing to compare against, and treating the
    // empty starting state as "previous" would chime once per unread chat on
    // every page load.
    const notifications: AppCommand[] = before.stores.sidebar.ready ? [...notificationCommands(next, sidebarData(before), sidebarData(next))] : []
    // useMigrateChannelPins: once the sidebar is in.
    if (!before.stores.sidebar.ready) notifications.push(MigrateChannelPins({ projectGroups: sidebarData(next).projectGroups }))
    const background = reconcileBackgroundChats(next)
    return { model: background.model, commands: [...(bounced.commands ?? []), ...notifications, ...(background.commands ?? [])] }
  }
}

function updateStores(model: Model, message: Stores.Message): UpdateReturn {
  const result = foldStores(model, message)
  // A previewer taking or letting go of a chat changes what the background follows.
  if (ViewerStore.previewedChatId(result.model.stores.viewer) === ViewerStore.previewedChatId(model.stores.viewer)) return result
  const background = reconcileBackgroundChats(result.model)
  return { model: background.model, commands: [...(result.commands ?? []), ...(background.commands ?? [])] }
}

function foldStores(model: Model, message: Stores.Message): UpdateReturn {
  return Update.foldChild({
    update: Stores.update,
    read: (parent: Model) => Option.some(parent.stores),
    write: (parent, stores) => modifyFields(parent, { stores: () => stores }),
    toParentMessage: (child: Stores.Message) => Message.GotStoresMessage({ message: child }),
    foldOutMessage: Stores.OutMessage.match<Step>({
      AppliedSidebarSnapshot: () => appliedSidebarSnapshot(model),
    }),
  })(model, message)
}

// THE PAGE'S CHAT

/**
 * One session per open chat: a route to another chat closes the one held
 * (its pending read position and cache write go out) and opens the next.
 */
function syncChatSession(model: Model, at: number): UpdateReturn {
  const chatId = activeChatId(model)
  if (model.chat?.chatId === chatId) return { model }
  const commands: AppCommand[] = []
  let lastWriteAt = model.readAnchorLastWriteAt ?? 0
  if (model.chat) {
    const closed = ChatSession.close(model.chat, at)
    lastWriteAt = closed.model.readAnchor.lastWriteAt
    commands.push(...Command.mapMessages(closed.commands, (message: ChatSession.Message) => Message.GotChatMessage({ message })))
  }
  if (!chatId) return { model: modifyFields(model, { chat: () => null, readAnchorLastWriteAt: () => lastWriteAt }), commands }
  // A chat started a moment ago has no cache to wait on: its subscription
  // goes out right behind its `chat.create`.
  const opened = ChatSession.init(chatId, {
    windowSize: transcriptWindowSize(model),
    starting: model.actions.startingChatIds.includes(chatId),
    readAnchorLastWriteAt: lastWriteAt,
  })
  commands.push(...Command.mapMessages(opened.commands, (message: ChatSession.Message) => Message.GotChatMessage({ message })))
  return { model: modifyFields(model, { chat: () => opened.model, readAnchorLastWriteAt: () => lastWriteAt }), commands }
}

const toComposer = (message: Composer.Message) => ChatPageSlice.Message.GotComposerMessage({ message })

const handleChatOutMessage = ChatSession.OutMessage.match<Step>({
  ChangedCommandError: ({ message }) => (model) => ({ model: commandError(model, message) }),
  MarkedSending: ({ chatId, sentAt }) => (model) => updateStores(model, Stores.Message.GotPendingSendMessage({ message: PendingSend.Message.StartedSending({ chatId, sentAt }) })),
  ClearedSending: ({ chatId }) => (model) => updateStores(model, Stores.Message.GotPendingSendMessage({ message: PendingSend.Message.ClearedSending({ chatId }) })),
  // The composer lets go of the draft it took out for the send, or puts it back.
  SucceededSend: () => (model) => foldChatPage(model, toComposer(Composer.Message.SucceededSend())),
  FailedSend: ({ content, error }) => (model) => foldChatPage(commandError(model, error), toComposer(Composer.Message.FailedSend({ content, error }))),
  // The plan is accepted: the composer leaves plan mode for this chat.
  ConfirmedExitPlanMode: ({ chatId }) => (model) => updateStores(model, Stores.Message.GotChatPreferencesMessage({
    message: ChatPreferences.Message.ClearedChatComposerPlanMode({ chatId }),
  })),
})

/**
 * After the page's chat moved: its snapshot names the project, and the
 * server has spoken for a chat started here, so `startedChat` and
 * `pendingChatId` let go. An unknown chat (not in the sidebar, archived
 * ones included, and not one being started) bounces home.
 */
function afterChatChanged(model: Model): UpdateReturn {
  const snapshot = activeChatSnapshot(model)
  let next = model
  if (snapshot) {
    const chatId = snapshot.runtime.chatId
    next = modifyFields(next, {
      selectedProjectId: () => snapshot.runtime.projectId,
      actions: (actions) => ({
        ...actions,
        pendingChatId: actions.pendingChatId === chatId ? null : actions.pendingChatId,
        startedChat: actions.startedChat?.chatId === chatId ? null : actions.startedChat,
      }),
    })
  }
  return bounceUnknownChat(next)
}

/** Archived chats are viewable in place, so they count as existing. */
function bounceUnknownChat(model: Model): UpdateReturn {
  const chatId = activeChatId(model)
  if (!chatId || !model.stores.sidebar.ready || !model.chat?.chatReady) return { model }
  if (Sidebar.chatExists(model.stores.sidebar, chatId)) {
    return model.actions.pendingChatId === chatId
      ? { model: modifyFields(model, { actions: (actions) => ({ ...actions, pendingChatId: null }) }) }
      : { model }
  }
  if (model.actions.pendingChatId === chatId) return { model }
  return { model, commands: [PushUrl({ url: "/" })] }
}

/**
 * The open chat is one this client started and has not heard back about:
 * known to be empty, so its page is the new chat page without waiting.
 */
export function activeChatStarted(model: Model): boolean {
  const chatId = activeChatId(model)
  return Boolean(chatId && model.actions.startedChat?.chatId === chatId && !activeChatSnapshot(model))
}

const foldChat = Update.foldChild({
  update: (chat: ChatSession.Model, input: { message: ChatSession.Message; sidebarStatus: string | null; windowSize: number }) =>
    ChatSession.update(chat, input.message, { windowSize: input.windowSize, sidebarStatus: input.sidebarStatus }),
  read: (model: Model) => Option.fromNullishOr(model.chat),
  write: (model, chat) => modifyFields(model, { chat: () => chat }),
  toParentMessage: (message: ChatSession.Message) => Message.GotChatMessage({ message }),
  foldOutMessage: handleChatOutMessage,
})

// ROUTES

function changeRoute(model: Model, route: AppRoute): UpdateReturn {
  const previousChatId = activeChatId(model)
  const next = modifyFields(model, { route: () => route })
  const nextChatId = activeChatId(next)
  const session = syncChatSession(next, 0)
  const commands: AppCommand[] = [...routeRedirect(route), ...(session.commands ?? [])]
  // Mark a chat read when the user navigates *away* from it, not when it
  // opens. Chats that no longer exist are skipped.
  if (previousChatId && previousChatId !== nextChatId) {
    const left = sidebarData(model).projectGroups.flatMap((group) => group.chats).find((chat) => chat.chatId === previousChatId)
    if (left?.unread) commands.push(SendCommand({ command: { type: "chat.markRead", chatId: previousChatId } }))
  }
  const background = reconcileBackgroundChats(session.model)
  return { model: background.model, commands: [...commands, ...(background.commands ?? [])] }
}

// ACTIONS (app/actions.ts)

function navigateStep(path: string, replace = false): Step {
  return (model) => ({ model, commands: [replace ? ReplaceUrl({ url: path }) : PushUrl({ url: path })] })
}

const actions = makeActions<Model>({
  navigate: navigateStep as never,
  activeChatId,
  activeRuntimeProjectId: (model) => activeChatSnapshot(model)?.runtime.projectId ?? null,
  navbarLocalPath: (model) => navbarLocalPath(model),
  fallbackLocalProjectPath: (model) => model.localProjects?.projects[0]?.localPath ?? null,
  activeProjectId,
  receivedAppSettings: ((snapshot: AppSettingsSnapshot) => (model: Model) => receiveAppSettings(model, snapshot)) as never,
  readAppSettings: () => ReadAppSettings() as never,
  setLlmProvider: ((snapshot: Model["llmProvider"]) => (model: Model) => ({ model: modifyFields(model, { llmProvider: () => snapshot }) })) as never,
  llmProvider: (model) => model.llmProvider,
  sendStores: ((message: Stores.Message) => (model: Model) => updateStores(model, message)) as never,
  storesMessage: {
    chatInput: (message) => Stores.Message.GotChatInputMessage({ message }),
    chatPreferences: (message) => Stores.Message.GotChatPreferencesMessage({ message }),
    sidebar: (message) => Stores.Message.GotSidebarMessage({ message }),
    terminalLayout: (message) => Stores.Message.GotTerminalLayoutMessage({ message }),
    rightSidebar: (message) => Stores.Message.GotRightSidebarMessage({ message }),
    appSettings: (message) => Stores.Message.GotAppSettingsMessage({ message }),
  },
  toMessage: (message: ActionMessage) => Message.GotActionMessage({ message }),
  toAppDialogMessage: (message: AppDialog.Message) => Message.GotAppDialogMessage({ message }),
})

// An answer resumes the action that asked (app/actions.ts answeredDialog).
const foldAppDialog = Update.foldChild({
  update: AppDialog.update,
  read: (model: Model) => Option.some(model.appDialog),
  write: (model, appDialog) => modifyFields(model, { appDialog: () => appDialog }),
  toParentMessage: (message: AppDialog.Message) => Message.GotAppDialogMessage({ message }),
  foldOutMessage: AppDialog.OutMessage.match<Step>({
    Answered: ({ requestId, answer }) => (model) => actions.answeredDialog(model, requestId, answer) as UpdateReturn,
  }),
})

/** Runs a slice's request. Sidebar collapse and the page's chat are the root's own. */
export function performAction(model: Model, action: AppAction): UpdateReturn {
  // Once per action, a batch as a whole: React's effect ran once after
  // the render that applied it.
  return withDraftProtection(model, performUnprotected(model, action))
}

function performUnprotected(model: Model, action: AppAction): UpdateReturn {
  switch (action._tag) {
    case "Batch":
      return Update.combine(model, (action.actions as ReadonlyArray<AppAction>).map((each) => (step: Model) => performUnprotected(step, each)))
    case "OpenCommandPalette":
      return foldPaletteResult(model, PaletteSlice.requestOpen(model.palette, action.page, model))
    case "PrefillComposer":
      return foldChatPage(model, toComposer(Composer.Message.RequestedPrefill({ text: action.text })))
    case "CollapseSidebar":
      return update(model, Message.ClickedCollapseSidebar())
    case "ExpandSidebar":
      return update(model, Message.ClickedExpandSidebar())
    case "Chat":
      return update(model, Message.GotChatMessage({ message: action.message }))
    default:
      return actions.performAction(model, action) as UpdateReturn
  }
}

/**
 * The open chat's project folder: the snapshot's, else the sidebar's for
 * the chat, else the first local project's, else the first group's.
 */
export function navbarLocalPath(model: Model): string | null {
  const projectId = activeProjectId(model)
  const fromSidebar = activeChatId(model) && projectId
    ? sidebarData(model).projectGroups.find((group) => group.groupKey === projectId)?.localPath ?? null
    : null
  return activeChatSnapshot(model)?.runtime.localPath
    ?? fromSidebar
    ?? model.localProjects?.projects[0]?.localPath
    ?? sidebarData(model).projectGroups[0]?.localPath
    ?? null
}

// SLICES (app/slice.ts)

/** A slice's request runs as the root's action. */
const handleSliceOutMessage = SliceOutMessage.match<Step>({
  RequestedAppAction: ({ action }) => (model) => performAction(model, action),
})

function sliceFold<Key extends keyof Model, ChildModel, ChildMessage>(
  key: Key,
  childUpdate: (model: ChildModel, message: ChildMessage, app: AppModel) => SliceReturn<ChildModel, ChildMessage>,
  wrap: (message: ChildMessage) => Message,
) {
  return (model: Model, message: ChildMessage): UpdateReturn => Update.foldChild({
    update: (child: ChildModel, input: ChildMessage) => childUpdate(child, input, model),
    read: (parent: Model) => Option.some(parent[key] as unknown as ChildModel),
    write: (parent: Model, next: ChildModel) => ({ ...parent, [key]: next }),
    toParentMessage: wrap,
    foldOutMessage: handleSliceOutMessage,
  })(model, message) as UpdateReturn
}

const foldSidebar = sliceFold("sidebar", SidebarSlice.update, (message: SidebarSlice.Message) => Message.GotSidebarMessage({ message }))
const foldHome = sliceFold("home", HomeSlice.update, (message: HomeSlice.Message) => Message.GotHomeMessage({ message }))
const foldSettings = sliceFold("settings", SettingsSlice.update, (message: SettingsSlice.Message) => Message.GotSettingsMessage({ message }))
const foldChatPage = sliceFold("chatPage", ChatPageSlice.update, (message: ChatPageSlice.Message) => Message.GotChatPageMessage({ message }))
const foldPalette = sliceFold("palette", PaletteSlice.update, (message: PaletteSlice.Message) => Message.GotPaletteMessage({ message }))
const foldSetup = sliceFold("setup", SetupSlice.update, (message: SetupSlice.Message) => Message.GotSetupMessage({ message }))
const foldWorkflows = sliceFold("workflows", WorkflowsSlice.update, (message: WorkflowsSlice.Message) => Message.GotWorkflowsMessage({ message }))
const foldTerminalPage = sliceFold("terminalPage", TerminalPageSlice.update, (message: TerminalPageSlice.Message) => Message.GotTerminalPageMessage({ message }))

/** A palette result the root started (requestOpen), folded as a palette message would be. */
function foldPaletteResult(model: Model, result: SliceReturn<PaletteSlice.Model, PaletteSlice.Message>): UpdateReturn {
  const next = modifyFields(model, { palette: () => result.model })
  const commands = Command.mapMessages(result.commands, (message: PaletteSlice.Message) => Message.GotPaletteMessage({ message }))
  if (!result.outMessage) return { model: next, commands }
  const acted = performAction(next, result.outMessage.action)
  return { model: acted.model, commands: [...commands, ...(acted.commands ?? [])] }
}

// SLICE OBSERVERS (app/slice.ts `observe`)

type AnySliceModule = { observe?: SliceObserve<unknown, unknown> }
const observers: ReadonlyArray<[keyof Model, AnySliceModule, (message: never) => Message]> = [
  ["sidebar", SidebarSlice as AnySliceModule, (message: SidebarSlice.Message) => Message.GotSidebarMessage({ message })],
  ["home", HomeSlice as AnySliceModule, (message: HomeSlice.Message) => Message.GotHomeMessage({ message })],
  ["settings", SettingsSlice as AnySliceModule, (message: SettingsSlice.Message) => Message.GotSettingsMessage({ message })],
  ["chatPage", ChatPageSlice as AnySliceModule, (message: ChatPageSlice.Message) => Message.GotChatPageMessage({ message })],
  ["palette", PaletteSlice as AnySliceModule, (message: PaletteSlice.Message) => Message.GotPaletteMessage({ message })],
  ["setup", SetupSlice as AnySliceModule, (message: SetupSlice.Message) => Message.GotSetupMessage({ message })],
  ["workflows", WorkflowsSlice as AnySliceModule, (message: WorkflowsSlice.Message) => Message.GotWorkflowsMessage({ message })],
  ["terminalPage", TerminalPageSlice as AnySliceModule, (message: TerminalPageSlice.Message) => Message.GotTerminalPageMessage({ message })],
]

function observeSlices(previous: Model, result: UpdateReturn): UpdateReturn {
  if (result.model === previous) return result
  let model = result.model
  const commands: AppCommand[] = [...(result.commands ?? [])]
  for (const [key, module, wrap] of observers) {
    if (!module.observe) continue
    const observed = module.observe(model[key], previous, model)
    if (observed.model !== model[key]) model = { ...model, [key]: observed.model }
    commands.push(...Command.mapMessages(observed.commands, wrap as (message: unknown) => Message) as AppCommand[])
    if (observed.outMessage) {
      const acted = performAction(model, observed.outMessage.action)
      model = acted.model
      commands.push(...(acted.commands ?? []))
    }
  }
  return { model, commands }
}

// THE SHARE DIALOG (chat/shareDialog.ts), open while there is a link

const liftShare = (commands: Update.Return<ShareDialog.Model, ShareDialog.Message>["commands"]) =>
  Command.mapMessages(commands, (message: ShareDialog.Message) => Message.GotShareDialogMessage({ message }))

function syncShareDialog(previous: Model, result: UpdateReturn): UpdateReturn {
  if (result.model.actions.standaloneShareUrl === previous.actions.standaloneShareUrl) return result
  const synced = ShareDialog.sync(result.model.shareDialog, result.model.actions.standaloneShareUrl)
  return {
    model: modifyFields(result.model, { shareDialog: () => synced.model }),
    commands: [...(result.commands ?? []), ...liftShare(synced.commands)],
  }
}

function updateShareDialog(model: Model, message: ShareDialog.Message): UpdateReturn {
  const result = ShareDialog.update(model.shareDialog, message)
  const next = modifyFields(model, { shareDialog: () => result.model })
  const commands = liftShare(result.commands)
  if (!result.outMessage) return { model: next, commands }
  const answer = ShareDialog.OutMessage.match<ActionMessage>(result.outMessage, {
    Closed: () => ActionMessageUnion.ClosedShareDialog(),
    OpenedLink: () => ActionMessageUnion.ClickedOpenShareLink(),
    FailedCopy: ({ error }) => ActionMessageUnion.FailedCopyShareLink({ error }),
  })
  const acted = actions.handleActionMessage(next, answer) as UpdateReturn
  return { model: acted.model, commands: [...commands, ...(acted.commands ?? [])] }
}

// UPDATE

/**
 * The theme follows whatever changed it: a settings snapshot, the system
 * theme, or a write's optimistic patch (ThemeProvider applied the
 * preference the moment it changed).
 */
function syncTheme(previous: Model, result: UpdateReturn): UpdateReturn {
  const commands = themeCommands(previous, result.model)
  return commands.length === 0 ? result : { ...result, commands: [...(result.commands ?? []), ...commands] }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  syncTheme(model, syncShareDialog(model, observeSlices(model, updateRoot(model, message))))

const updateRoot = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      Navigation.UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({ model, commands: [PushUrl({ url: urlToString(url) })] }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) => changeRoute(model, urlToAppRoute(url)),
    CompletedNavigation: () => ({ model }),

    ReceivedAuthStatus: ({ enabled, authenticated }) => ({
      model: modifyFields(model, {
        auth: () => (!enabled || authenticated ? { _tag: "Ready" as const } : { _tag: "Locked" as const, error: null, password: "", submitting: false }),
      }),
    }),
    FailedAuthStatus: () => ({ model, commands: [DelayAuthRetry()] }),
    ElapsedAuthRetry: () => ({ model, commands: [FetchAuthStatus()] }),
    ChangedPassword: ({ value }) => model.auth._tag === "Locked"
      ? { model: modifyFields(model, { auth: () => ({ ...model.auth, password: value }) as Model["auth"] }) }
      : { model },
    SubmittedPassword: () => {
      const auth = model.auth
      if (auth._tag !== "Locked" || !auth.password || auth.submitting) return { model }
      return {
        model: modifyFields(model, { auth: () => ({ ...auth, submitting: true }) }),
        commands: [SubmitPassword({ password: auth.password })],
      }
    },
    SucceededLogin: () => ({
      model: model.auth._tag === "Locked" ? modifyFields(model, { auth: () => ({ ...model.auth, password: "", submitting: false }) as Model["auth"] }) : model,
      commands: [FetchAuthStatus()],
    }),
    FailedLogin: () => ({
      model: modifyFields(model, {
        auth: () => ({ _tag: "Locked" as const, error: "Incorrect password. Try again.", password: model.auth._tag === "Locked" ? model.auth.password : "", submitting: false }),
      }),
    }),

    AcquiredSocket: () => {
      const next = modifyFields(model, { socketReady: () => true })
      if (next.route._tag !== "OpenRouterCallback") return { model: next }
      const started = OpenRouterCallback.start(next.openRouterCallback)
      return {
        model: modifyFields(next, { openRouterCallback: () => started.model }),
        commands: Command.mapMessages(started.commands, (message: OpenRouterCallback.Message) => Message.GotOpenRouterCallbackMessage({ message })),
      }
    },
    ReleasedSocket: () => ({ model: modifyFields(model, { socketReady: () => false, backgroundChats: () => ({}) }) }),
    FailedAcquireSocket: ({ error }) => ({ model: commandError(model, error) }),
    ChangedConnectionStatus: ({ status }) => {
      const next = modifyFields(model, { connectionStatus: () => status })
      const restart = FollowRestart({ connectionStatus: status })
      if (status !== "connected" || model.connectionStatus === "connected") return { model: next, commands: [restart] }
      // In the order React's effects ran on connect: draft protection
      // (useKannaState), the forced update check (useUpdateRestart), then
      // settings and the LLM provider (useAppSettingsSync).
      return {
        model: next,
        commands: [
          SendCommand({ command: { type: "chat.setDraftProtection", chatIds: draftProtectedChatIds(next) } }),
          SendCommand({ command: { type: "update.check", force: true } }),
          ReadAppSettings(),
          ReadLlmProvider(),
          restart,
        ],
      }
    },

    ReceivedLocalProjects: ({ snapshot }) => ({
      model: modifyFields(model, { localProjects: () => snapshot, localProjectsReady: () => true, commandError: () => null }),
    }),
    ReceivedUpdate: ({ snapshot }) => ({
      model: modifyFields(model, { updateSnapshot: () => snapshot, commandError: () => null }),
      commands: snapshot.reloadRequestedAt ? [HandleReloadRequest({ reloadRequestedAt: snapshot.reloadRequestedAt })] : [],
    }),
    ReachedUpdateCheckPoint: ({ at, visible }) => {
      if (model.connectionStatus !== "connected" || !visible) return { model }
      const lastCheckedAt = model.updateSnapshot?.lastCheckedAt
      const interval = updateCheckInterval(isNightlyVersion(model.updateSnapshot?.currentVersion ?? ""))
      if (lastCheckedAt && at - lastCheckedAt < interval) return { model }
      return { model, commands: [SendCommand({ command: { type: "update.check" } })] }
    },
    ChangedPageVisibility: ({ shown }) => ({ model: modifyFields(model, { pageHidden: () => !shown }) }),
    ReceivedKeybindings: ({ snapshot }) => ({ model: modifyFields(model, { keybindings: () => snapshot, commandError: () => null }) }),
    ReceivedAppSettings: ({ snapshot }) => receiveAppSettings(model, snapshot),
    SucceededReadAppSettings: ({ snapshot }) => receiveAppSettings(model, snapshot),
    SucceededReadLlmProvider: ({ snapshot }) => ({ model: modifyFields(model, { llmProvider: () => snapshot, commandError: () => null }) }),
    ReceivedProjectGit: ({ projectId, snapshot }) => {
      const current = model.projectDiffs[projectId] ?? null
      if (shouldPreserveExistingProjectDiffs(current, snapshot) || sameDiffs(current, snapshot)) {
        return { model: commandError(model, null) }
      }
      return {
        model: modifyFields(model, {
          projectDiffs: (diffs) => ({ ...diffs, [projectId]: snapshot }),
          commandError: () => null,
        }),
      }
    },

    CompletedCommand: () => ({ model }),
    FailedCommand: ({ message }) => ({ model: commandError(model, message) }),
    ClickedChatNotification: ({ chatId }) => ({ model, commands: [PushUrl({ url: `/chat/${chatId}` })] }),
    CompletedSideEffect: () => ({ model }),

    ChangedSystemTheme: ({ theme }) => {
      const next = modifyFields(model, { systemTheme: () => theme })
      return { model: next }
    },

    ElapsedBackgroundChatGrace: ({ chatId }) => {
      if (model.backgroundChats[chatId] !== "dropping") return { model }
      return {
        model: modifyFields(model, {
          backgroundChats: (chats) => {
            const next = { ...chats }
            delete next[chatId]
            return next
          },
        }),
        commands: [UnfollowBackgroundChat({ chatId })],
      }
    },

    ClickedCollapseSidebar: () => ({
      model: modifyFields(model, { sidebarCollapsed: () => true }),
      commands: [SaveSidebarCollapsed({ collapsed: true })],
    }),
    ClickedExpandSidebar: () => ({
      model: modifyFields(model, { sidebarCollapsed: () => false }),
      commands: [SaveSidebarCollapsed({ collapsed: false })],
    }),

    GotChatMessage: ({ message: chatMessage }) => Update.combine(model, [
      (step: Model) => foldChat(step, {
        message: chatMessage,
        sidebarStatus: sidebarChatStatus(step, step.chat?.chatId ?? null),
        windowSize: transcriptWindowSize(step),
      }),
      afterChatChanged,
    ]),
    GotStoresMessage: ({ message: storesMessage }) => withDraftProtection(model, updateStores(model, storesMessage)),
    RequestedAppAction: ({ action }) => performAction(model, action),
    GotSidebarMessage: ({ message: child }) => foldSidebar(model, child),
    GotHomeMessage: ({ message: child }) => foldHome(model, child),
    GotSettingsMessage: ({ message: child }) => foldSettings(model, child),
    GotChatPageMessage: ({ message: child }) => foldChatPage(model, child),
    GotPaletteMessage: ({ message: child }) => foldPalette(model, child),
    GotSetupMessage: ({ message: child }) => foldSetup(model, child),
    GotWorkflowsMessage: ({ message: child }) => foldWorkflows(model, child),
    GotTerminalPageMessage: ({ message: child }) => foldTerminalPage(model, child),
    GotAppDialogMessage: ({ message: dialogMessage }) => foldAppDialog(model, dialogMessage),
    GotShareDialogMessage: ({ message: shareMessage }) => updateShareDialog(model, shareMessage),
    GotOpenRouterCallbackMessage: ({ message: callbackMessage }) => {
      const result = OpenRouterCallback.update(model.openRouterCallback, callbackMessage)
      return {
        model: modifyFields(model, { openRouterCallback: () => result.model }),
        commands: Command.mapMessages(result.commands, (message: OpenRouterCallback.Message) => Message.GotOpenRouterCallbackMessage({ message })),
      }
    },
    GotActionMessage: ({ message: actionMessage }) => withDraftProtection(model, actions.handleActionMessage(model, actionMessage) as UpdateReturn),
  })

// DRAFT PROTECTION

/** Chats with a draft (text or attachments): the server must not prune them. */
export function draftProtectedChatIds(model: Model): string[] {
  const chatInput = model.stores.chatInput
  return [...new Set([...Object.keys(chatInput.drafts), ...Object.keys(chatInput.attachmentDrafts)])].sort()
}

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((id, index) => id === b[index])

/**
 * useKannaState re-sent `chat.setDraftProtection` whenever either list
 * changed while connected: the text drafts' ids or the attachment drafts'
 * ids, each its own effect dependency. So a chat that swaps its text for
 * an attachment sends again, though the union stays the same.
 */
function withDraftProtection(_before: Model, result: UpdateReturn): UpdateReturn {
  const seen = result.model.draftIdsSeen
  const now = draftIdsOf(result.model.stores)
  // Against what it last saw, not the step's own start: a batch, or an
  // action that runs update again, is one change and sends once.
  if (sameIds(seen.drafts, now.drafts) && sameIds(seen.attachments, now.attachments)) return result
  const model = modifyFields(result.model, { draftIdsSeen: () => now })
  // Disconnected, the effect returned early; connecting sends the list then.
  if (model.connectionStatus !== "connected") return { ...result, model }
  return { ...result, model, commands: [...(result.commands ?? []), SendCommand({ command: { type: "chat.setDraftProtection", chatIds: draftProtectedChatIds(model) } })] }
}

function draftIdsOf(stores: Stores.Model): Model["draftIdsSeen"] {
  return {
    drafts: Object.keys(stores.chatInput.drafts).sort(),
    attachments: Object.keys(stores.chatInput.attachmentDrafts).sort(),
  }
}

