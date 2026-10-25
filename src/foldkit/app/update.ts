import { Option } from "effect"
import { Command, Navigation, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { toString as urlToString, type Url } from "foldkit/url"
import { getChatNotificationEvents, getChatSoundBurstCount } from "../../client/app/chatNotifications"
import { isProcessingStatus } from "../../client/app/derived"
import { getMostRecentlyActiveProjectId, getProjectIdForChat } from "../../client/app/kannaStateHelpers"
import { sameDiffs, shouldPreserveExistingProjectDiffs } from "../../client/app/snapshotEquality"
import { DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES } from "../../shared/transcript-window"
import type { AppSettingsSnapshot, SidebarData } from "../../shared/types"
import * as ChatSession from "../core/chatSession"
import type { KannaSocketService } from "../core/socket"
import * as PendingSend from "../core/stores/pendingSend"
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

export function init(flags: Flags, url: Url): UpdateReturn {
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
 * Hold a subscription on every running chat except the open one, so opening
 * a running chat paints from a current window and the server only has to
 * send what landed since the last background push. A chat that stops
 * running is let go after a grace period.
 */
function reconcileBackgroundChats(model: Model): UpdateReturn {
  if (!model.socketReady) return { model }
  const openChatId = activeChatId(model)
  const wanted = new Set(runningChatIds(sidebarData(model)))
  if (openChatId) wanted.delete(openChatId)

  const next: Record<string, "following" | "dropping"> = { ...model.backgroundChats }
  const commands: AppCommand[] = []
  for (const [chatId, state] of Object.entries(model.backgroundChats)) {
    if (wanted.has(chatId)) {
      next[chatId] = "following"
      continue
    }
    if (chatId === openChatId) {
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
  const next = commandError(fanned.model, null)
  return { model: next, commands: [...(fanned.commands ?? []), ...themeCommands(model, next)] }
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
  return (model) => {
    let next = commandError(model, null)
    if (!next.selectedProjectId) {
      const seed = getMostRecentlyActiveProjectId(sidebarData(next).projectGroups)
      if (seed) next = modifyFields(next, { selectedProjectId: () => seed })
    }
    // The first snapshot has nothing to compare against, and treating the
    // empty starting state as "previous" would chime once per unread chat on
    // every page load.
    const notifications = before.stores.sidebar.ready ? notificationCommands(next, sidebarData(before), sidebarData(next)) : []
    const background = reconcileBackgroundChats(next)
    return { model: background.model, commands: [...notifications, ...(background.commands ?? [])] }
  }
}

function updateStores(model: Model, message: Stores.Message): UpdateReturn {
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
  if (model.chat) {
    const closed = ChatSession.close(model.chat, at)
    commands.push(...Command.mapMessages(closed.commands, (message: ChatSession.Message) => Message.GotChatMessage({ message })))
  }
  if (!chatId) return { model: modifyFields(model, { chat: () => null }), commands }
  const opened = ChatSession.init(chatId, { windowSize: transcriptWindowSize(model), starting: false })
  commands.push(...Command.mapMessages(opened.commands, (message: ChatSession.Message) => Message.GotChatMessage({ message })))
  return { model: modifyFields(model, { chat: () => opened.model }), commands }
}

const handleChatOutMessage = ChatSession.OutMessage.match<Step>({
  ChangedCommandError: ({ message }) => (model) => ({ model: commandError(model, message) }),
  MarkedSending: ({ chatId, sentAt }) => (model) => updateStores(model, Stores.Message.GotPendingSendMessage({ message: PendingSend.Message.StartedSending({ chatId, sentAt }) })),
  ClearedSending: ({ chatId }) => (model) => updateStores(model, Stores.Message.GotPendingSendMessage({ message: PendingSend.Message.ClearedSending({ chatId }) })),
  // The composer and chatPreferences hear of these with their slices.
  SucceededSend: () => (model) => ({ model }),
  FailedSend: ({ error }) => (model) => ({ model: commandError(model, error) }),
  ConfirmedExitPlanMode: () => (model) => ({ model }),
})

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

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
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

    AcquiredSocket: () => ({ model: modifyFields(model, { socketReady: () => true }) }),
    ReleasedSocket: () => ({ model: modifyFields(model, { socketReady: () => false, backgroundChats: () => ({}) }) }),
    FailedAcquireSocket: ({ error }) => ({ model: commandError(model, error) }),
    ChangedConnectionStatus: ({ status }) => {
      const next = modifyFields(model, { connectionStatus: () => status })
      if (status !== "connected" || model.connectionStatus === "connected") return { model: next }
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
        ],
      }
    },

    ReceivedLocalProjects: ({ snapshot }) => ({
      model: modifyFields(model, { localProjects: () => snapshot, localProjectsReady: () => true, commandError: () => null }),
    }),
    ReceivedUpdate: ({ snapshot }) => ({ model: modifyFields(model, { updateSnapshot: () => snapshot, commandError: () => null }) }),
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
      return { model: next, commands: themeCommands(model, next) }
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

    GotChatMessage: ({ message: chatMessage }) => foldChat(model, {
      message: chatMessage,
      sidebarStatus: sidebarChatStatus(model, model.chat?.chatId ?? null),
      windowSize: transcriptWindowSize(model),
    }),
    GotStoresMessage: ({ message: storesMessage }) => withDraftProtection(model, updateStores(model, storesMessage)),
  })

// DRAFT PROTECTION

/** Chats with a draft (text or attachments): the server must not prune them. */
export function draftProtectedChatIds(model: Model): string[] {
  const chatInput = model.stores.chatInput
  return [...new Set([...Object.keys(chatInput.drafts), ...Object.keys(chatInput.attachmentDrafts)])].sort()
}

/** useKannaState re-sent `chat.setDraftProtection` whenever that list changed while connected. */
function withDraftProtection(before: Model, result: UpdateReturn): UpdateReturn {
  if (result.model.connectionStatus !== "connected") return result
  const previous = draftProtectedChatIds(before)
  const next = draftProtectedChatIds(result.model)
  if (previous.length === next.length && previous.every((id, index) => id === next[index])) return result
  return { ...result, commands: [...(result.commands ?? []), SendCommand({ command: { type: "chat.setDraftProtection", chatIds: next } })] }
}

