import { Effect, Option, Schema } from "effect"
import { Command, Update } from "foldkit"
import * as AppNavigation from "../core/navigation"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import {
  getMostRecentlyActiveProjectId,
  getNewestRemainingChatId,
  getProjectIdForChat,
  resolveComposeIntent,
  type ProjectRequest,
  type StartChatIntent,
} from "../../client/app/kannaStateHelpers"
import { editorPresetFromOpenAppValue, resolveEffectiveEditorPreset } from "../../client/lib/effective-editor"
import { resolveProjectNewChat } from "../../client/lib/new-chat-resume"
import { flattenSidebarThreads } from "../../client/lib/thread-sections"
import { UI_UPDATE_RESTART_STORAGE_KEY } from "../../client/lib/storageKeys"
import { generateUUID } from "../../client/lib/utils"
import type { ChatJumpTarget } from "../../client/lib/chat-navigation"
import type { ClientCommand, OpenExternalAction, EditorOpenSettings, TerminalPreset } from "../../shared/protocol"
import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  BranchActionFailure,
  BranchActionSuccess,
  LlmProviderSnapshot,
  StandaloneTranscriptExportCommandResult,
  UpdateInstallResult,
} from "../../shared/types"
import { opaque } from "../core/schema"
import { errorMessage, sendCommand, type KannaSocketService } from "../core/socket"
import * as AppSettings from "../core/stores/appSettings"
import * as ChatInput from "../core/stores/chatInput"
import * as ChatPreferences from "../core/stores/chatPreferences"
import * as RightSidebar from "../core/stores/rightSidebar"
import * as Sidebar from "../core/stores/sidebar"
import * as TerminalLayout from "../core/stores/terminalLayout"
import { getDefaultEditorCommandTemplate } from "../core/stores/terminalPreferences"
import * as AppDialog from "../ui/app-dialog"
import { AppAction } from "./action"
import { resolveTheme, themePreference } from "./theme"
import type * as Stores from "./stores"

// The root's half of AppAction: what each request does. Port of the
// handlers in useKannaState, useChatCommands (project/external ones),
// useShareExport and useUpdateRestart, with the app dialog's confirm,
// prompt and alert held here as `AppDialog`.
//
// This module is a set of Steps over a minimal view of the root Model
// (`ActionsHost`), so it doesn't import the root and the root wires it.

// THE APP DIALOG (ui/app-dialog.ts holds it; the root embeds it once)

/** A request as the React call sites wrote it; `openDialog` adds the id. */
export type DialogRequest =
  | { kind: "confirm"; options: Omit<Parameters<typeof AppDialog.confirm>[0], "requestId"> }
  | { kind: "prompt"; options: Omit<Parameters<typeof AppDialog.prompt>[0], "requestId"> }
  | { kind: "alert"; options: Omit<Parameters<typeof AppDialog.alert>[0], "requestId"> }

/** What answering the dialog goes on to do. */
export const DialogContinuation = defineTaggedUnion({
  None: {},
  DeleteChat: { chatId: Schema.String },
  SetupGit: { chatId: Schema.String },
  RenameChat: { chatId: Schema.String, currentTitle: Schema.String },
  RenameProject: { target: opaque<string | { localPath: string }>("ProjectTarget"), currentTitle: Schema.String },
  DownloadTranscript: { fileName: Schema.String, json: Schema.String },
  InstallNightly: {},
  InstallStable: {},
})
export type DialogContinuation = typeof DialogContinuation.Type

// THE STATE THESE ACTIONS KEEP (a part of the root Model)

export const ActionsModel = Schema.Struct({
  /** A chat gone to before the server has said it exists. */
  pendingChatId: Schema.NullOr(Schema.String),
  /** Until its snapshot comes, all that is known of a chat started here: it is empty, and its project. */
  startedChat: Schema.NullOr(Schema.Struct({ chatId: Schema.String, projectId: Schema.String })),
  /** Chats whose `chat.create` is still in flight. */
  startingChatIds: Schema.Array(Schema.String),
  startingLocalPath: Schema.NullOr(Schema.String),
  isExportingStandalone: Schema.Boolean,
  standaloneShareUrl: Schema.NullOr(Schema.String),
  standaloneShareComplete: Schema.Boolean,
  /** What answering the open app dialog goes on to do, by its request id. */
  pendingDialog: Schema.NullOr(Schema.Struct({ requestId: Schema.String, then: DialogContinuation })),
  dialogSeq: Schema.Number,
  /** The failure of the last project request, for the palette's inline error. */
  projectRequestError: Schema.NullOr(Schema.String),
  /** A message to land on in a chat being opened (AppAction.OpenChatAt), until the transcript spends it. */
  pendingChatJump: Schema.NullOr(Schema.Struct({ chatId: Schema.String, jump: opaque<ChatJumpTarget>("ChatJumpTarget"), requestId: Schema.Number })),
  chatJumpSeq: Schema.Number,
})
export type ActionsModel = typeof ActionsModel.Type

export const initialActionsModel: ActionsModel = {
  pendingChatId: null,
  startedChat: null,
  startingChatIds: [],
  startingLocalPath: null,
  isExportingStandalone: false,
  standaloneShareUrl: null,
  standaloneShareComplete: false,
  pendingDialog: null,
  dialogSeq: 0,
  projectRequestError: null,
  pendingChatJump: null,
  chatJumpSeq: 0,
}

/** What actions read and write of the root Model. */
export interface ActionsHost {
  actions: ActionsModel
  appDialog: AppDialog.Model
  stores: Stores.Model
  selectedProjectId: string | null
  commandError: string | null
  systemTheme: "light" | "dark"
}

// MESSAGES

export const ActionMessage = defineMessageUnion({
  PreparedCreateChat: {
    projectId: Schema.String,
    chatId: Schema.String,
    carryDraftFrom: Schema.NullOr(Schema.String),
    background: Schema.Boolean,
    cameFrom: Schema.String,
    at: Schema.Number,
  },
  SucceededCreateChat: { chatId: Schema.String, resultChatId: Schema.String, projectId: Schema.String },
  FailedCreateChat: { chatId: Schema.String, cameFrom: Schema.String, error: Schema.String },
  ResolvedStartChatProject: { projectId: Schema.String },
  FailedStartChat: { error: Schema.String, projectRequest: Schema.Boolean },
  SucceededForkChat: { sourceChatId: Schema.String, chatId: Schema.String },
  SucceededArchiveChat: { chatId: Schema.String },
  SucceededDeleteChat: { chatId: Schema.String },
  SucceededHideProject: { projectId: Schema.String },
  ReceivedInitGitResult: { result: opaque<BranchActionSuccess | BranchActionFailure>("BranchActionResult") },
  FailedInitGit: { error: Schema.String },
  ReceivedExportResult: { result: opaque<StandaloneTranscriptExportCommandResult>("StandaloneTranscriptExportCommandResult") },
  FailedExport: { error: Schema.String },
  SucceededWriteAppSettings: { snapshot: opaque<AppSettingsSnapshot>("AppSettingsSnapshot") },
  FailedWriteAppSettings: { error: Schema.String },
  SucceededWriteLlmProvider: { snapshot: opaque<LlmProviderSnapshot>("LlmProviderSnapshot") },
  FailedReorderProjectGroups: { error: Schema.String },
  ReceivedInstallResult: { result: opaque<UpdateInstallResult>("UpdateInstallResult"), failureTitle: Schema.String, failureMessage: Schema.String },
  FailedInstall: { error: Schema.String },
  /** A command whose ack clears the command error. */
  SucceededCommand: {},
  FailedCommand: { error: Schema.String },
  CompletedSideEffect: {},

  // The share dialog (StandaloneShareDialog)
  ClosedShareDialog: {},
  ClickedOpenShareLink: {},
  ClickedCopyShareLink: {},
  FailedCopyShareLink: { error: Schema.String },
})
export type ActionMessage = typeof ActionMessage.Type

/**
 * Root effects the actions need but don't own: navigation, the page's chat
 * session, the app settings fan-out. The root supplies these.
 */
export interface RootEffects<Host> {
  navigate: (path: string, replace?: boolean) => Update.Step<Host, unknown, KannaSocketService>
  activeChatId: (host: Host) => string | null
  activeRuntimeProjectId: (host: Host) => string | null
  navbarLocalPath: (host: Host) => string | null
  fallbackLocalProjectPath: (host: Host) => string | null
  activeProjectId: (host: Host) => string | null
  receivedAppSettings: (snapshot: AppSettingsSnapshot) => Update.Step<Host, unknown, KannaSocketService>
  readAppSettings: () => Command.Command<unknown, never, KannaSocketService>
  setLlmProvider: (snapshot: LlmProviderSnapshot) => Update.Step<Host, unknown, KannaSocketService>
  llmProvider: (host: Host) => LlmProviderSnapshot | null
  sendStores: (message: Stores.Message) => Update.Step<Host, unknown, KannaSocketService>
  storesMessage: {
    chatInput: (message: ChatInput.Message) => Stores.Message
    chatPreferences: (message: ChatPreferences.Message) => Stores.Message
    sidebar: (message: Sidebar.Message) => Stores.Message
    terminalLayout: (message: TerminalLayout.Message) => Stores.Message
    rightSidebar: (message: RightSidebar.Message) => Stores.Message
    appSettings: (message: AppSettings.Message) => Stores.Message
  }
  toMessage: (message: ActionMessage) => unknown
  toAppDialogMessage: (message: AppDialog.Message) => unknown
}

// COMMANDS

const fail = (error: unknown) => ActionMessage.FailedCommand({ error: errorMessage(error) })

const Send = Command.define("SendActionCommand", {
  args: { command: opaque<ClientCommand>("ClientCommand") },
  messages: [ActionMessage.SucceededCommand, ActionMessage.FailedCommand],
  execute: ({ command }) => sendCommand(command).pipe(
    Effect.as(ActionMessage.SucceededCommand()),
    Effect.catch((error) => Effect.succeed(fail(error))),
  ),
})

/** The chat needs an id before the server answers, and the click its place. */
const PrepareCreateChat = Command.define("PrepareCreateChat", {
  args: { projectId: Schema.String, carryDraftFrom: Schema.NullOr(Schema.String), background: Schema.Boolean },
  messages: [ActionMessage.PreparedCreateChat],
  execute: ({ projectId, carryDraftFrom, background }) => Effect.sync(() => ActionMessage.PreparedCreateChat({
    projectId,
    chatId: generateUUID(),
    carryDraftFrom,
    background,
    cameFrom: AppNavigation.currentPathAndSearch(),
    at: Date.now(),
  })),
})

const CreateChat = Command.define("CreateChat", {
  args: { projectId: Schema.String, chatId: Schema.String, cameFrom: Schema.String },
  messages: [ActionMessage.SucceededCreateChat, ActionMessage.FailedCreateChat],
  execute: ({ projectId, chatId, cameFrom }) => sendCommand<{ chatId: string }>({ type: "chat.create", projectId, chatId }).pipe(
    Effect.map((result) => ActionMessage.SucceededCreateChat({ chatId, resultChatId: result.chatId, projectId })),
    Effect.catch((error) => Effect.succeed(ActionMessage.FailedCreateChat({ chatId, cameFrom, error: errorMessage(error) }))),
  ),
})

const ResolveStartChatProject = Command.define("ResolveStartChatProject", {
  args: { intent: opaque<StartChatIntent>("StartChatIntent") },
  messages: [ActionMessage.ResolvedStartChatProject, ActionMessage.FailedStartChat],
  execute: ({ intent }) => {
    const command: ClientCommand = intent.kind === "local_path"
      ? { type: "project.open", localPath: intent.localPath }
      : intent.kind === "project_request" && intent.project.mode === "clone" && intent.project.cloneUrl
        ? { type: "project.clone", cloneUrl: intent.project.cloneUrl, localPath: intent.project.localPath, fallbackPath: intent.project.fallbackPath, title: intent.project.title }
        : intent.kind === "project_request" && intent.project.mode === "create"
          ? { type: "project.create", localPath: intent.project.localPath, title: intent.project.title }
          : { type: "project.open", localPath: intent.kind === "project_request" ? intent.project.localPath : "" }
    return sendCommand<{ projectId: string }>(command).pipe(
      Effect.map((result) => ActionMessage.ResolvedStartChatProject({ projectId: result.projectId })),
      Effect.catch((error) => Effect.succeed(ActionMessage.FailedStartChat({ error: errorMessage(error), projectRequest: intent.kind === "project_request" }))),
    )
  },
})

const ForkChat = Command.define("ForkChat", {
  args: { chatId: Schema.String },
  messages: [ActionMessage.SucceededForkChat, ActionMessage.FailedCommand],
  execute: ({ chatId }) => sendCommand<{ chatId: string }>({ type: "chat.fork", chatId }).pipe(
    Effect.map((result) => ActionMessage.SucceededForkChat({ sourceChatId: chatId, chatId: result.chatId })),
    Effect.catch((error) => Effect.succeed(fail(error))),
  ),
})

const ArchiveChat = Command.define("ArchiveChat", {
  args: { chatId: Schema.String },
  messages: [ActionMessage.SucceededArchiveChat, ActionMessage.FailedCommand],
  execute: ({ chatId }) => sendCommand({ type: "chat.archive", chatId }).pipe(
    Effect.as(ActionMessage.SucceededArchiveChat({ chatId })),
    Effect.catch((error) => Effect.succeed(fail(error))),
  ),
})

const DeleteChat = Command.define("DeleteChat", {
  args: { chatId: Schema.String },
  messages: [ActionMessage.SucceededDeleteChat, ActionMessage.FailedCommand],
  execute: ({ chatId }) => sendCommand({ type: "chat.delete", chatId }).pipe(
    Effect.as(ActionMessage.SucceededDeleteChat({ chatId })),
    Effect.catch((error) => Effect.succeed(fail(error))),
  ),
})

const InitGit = Command.define("InitGit", {
  args: { chatId: Schema.String },
  messages: [ActionMessage.ReceivedInitGitResult, ActionMessage.FailedInitGit],
  execute: ({ chatId }) => sendCommand<BranchActionSuccess | BranchActionFailure>({ type: "chat.initGit", chatId }).pipe(
    Effect.map((result) => ActionMessage.ReceivedInitGitResult({ result })),
    Effect.catch((error) => Effect.succeed(ActionMessage.FailedInitGit({ error: errorMessage(error) }))),
  ),
})

const HideProject = Command.define("HideProject", {
  args: { target: opaque<string | { localPath: string }>("ProjectTarget") },
  messages: [ActionMessage.SucceededHideProject, ActionMessage.FailedCommand],
  execute: ({ target }) => sendCommand<{ projectId: string }>({
    type: "project.remove",
    ...(typeof target === "string" ? { projectId: target } : target),
  } as ClientCommand).pipe(
    // React destructured the reply inside its try, so a null reply (the
    // demo's) became a command error with Chromium's TypeError text.
    Effect.flatMap((result) => result
      ? Effect.succeed(ActionMessage.SucceededHideProject({ projectId: result.projectId }))
      : Effect.fail(new Error("Cannot destructure property 'projectId' of '(intermediate value)' as it is null."))),
    Effect.catch((error) => Effect.succeed(fail(error))),
  ),
})

const ReorderProjectGroups = Command.define("ReorderProjectGroups", {
  args: { projectIds: Schema.Array(Schema.String) },
  messages: [ActionMessage.SucceededCommand, ActionMessage.FailedReorderProjectGroups],
  execute: ({ projectIds }) => sendCommand({ type: "sidebar.reorderProjectGroups", projectIds: [...projectIds] }).pipe(
    Effect.as(ActionMessage.SucceededCommand()),
    Effect.catch((error) => Effect.succeed(ActionMessage.FailedReorderProjectGroups({ error: errorMessage(error) }))),
  ),
})

/** Pins come back on the sidebar snapshot; a failure is ignored, as React did. */
const SetProjectPinned = Command.define("SetProjectPinned", {
  args: { projectId: Schema.String, pinned: Schema.Boolean },
  messages: [ActionMessage.CompletedSideEffect],
  execute: ({ projectId, pinned }) => sendCommand({ type: "project.setPinned", projectId, pinned }).pipe(
    Effect.ignore,
    Effect.as(ActionMessage.CompletedSideEffect()),
  ),
})

const SetDelegator = Command.define("SetDelegator", {
  args: { chatId: Schema.String, delegator: Schema.Boolean },
  messages: [ActionMessage.CompletedSideEffect],
  execute: ({ chatId, delegator }) => sendCommand({ type: "chat.setDelegator", chatId, delegator }).pipe(
    Effect.catch((error) => Effect.sync(() => console.warn("[kanna] could not change whether the chat delegates:", error))),
    Effect.as(ActionMessage.CompletedSideEffect()),
  ),
})

const CopyText = Command.define("CopyText", {
  args: { text: Schema.String, onFailure: Schema.Literals(["commandError", "alert"]) },
  messages: [ActionMessage.SucceededCommand, ActionMessage.FailedCommand, ActionMessage.CompletedSideEffect, ActionMessage.FailedCopyShareLink],
  execute: ({ text, onFailure }) => Effect.tryPromise(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("Clipboard is not available")
    }
    await navigator.clipboard.writeText(text)
  }).pipe(
    Effect.as(onFailure === "commandError" ? ActionMessage.SucceededCommand() : ActionMessage.CompletedSideEffect()),
    Effect.catch((error) => Effect.succeed(onFailure === "commandError" ? fail(error) : ActionMessage.FailedCopyShareLink({ error: errorMessage(error) }))),
  ),
})

const ExportStandalone = Command.define("ExportStandalone", {
  args: { chatId: Schema.String, theme: Schema.Literals(["light", "dark"]) },
  messages: [ActionMessage.ReceivedExportResult, ActionMessage.FailedExport],
  execute: ({ chatId, theme }) => sendCommand<StandaloneTranscriptExportCommandResult>({
    type: "chat.exportStandalone",
    chatId,
    theme,
    attachmentMode: "bundle",
    sourceOrigin: window.location.origin,
  }).pipe(
    Effect.map((result) => ActionMessage.ReceivedExportResult({ result })),
    Effect.catch((error) => Effect.succeed(ActionMessage.FailedExport({ error: errorMessage(error) }))),
  ),
})

const DownloadTextFile = Command.define("DownloadTextFile", {
  args: { fileName: Schema.String, contents: Schema.String },
  messages: [ActionMessage.CompletedSideEffect],
  execute: ({ fileName, contents }) => Effect.sync(() => {
    const blob = new Blob([contents], { type: "application/json; charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = fileName
    anchor.style.display = "none"
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    return ActionMessage.CompletedSideEffect()
  }),
})

const OpenWindow = Command.define("OpenWindow", {
  args: { url: Schema.String },
  messages: [ActionMessage.CompletedSideEffect],
  execute: ({ url }) => Effect.sync(() => {
    window.open(url, "_blank", "noopener,noreferrer")
    return ActionMessage.CompletedSideEffect()
  }),
})

const WriteAppSettings = Command.define("WriteAppSettings", {
  args: { patch: opaque<AppSettingsPatch>("AppSettingsPatch") },
  messages: [ActionMessage.SucceededWriteAppSettings, ActionMessage.FailedWriteAppSettings],
  execute: ({ patch }) => sendCommand<AppSettingsSnapshot>({ type: "settings.writeAppSettingsPatch", patch }).pipe(
    Effect.map((snapshot) => ActionMessage.SucceededWriteAppSettings({ snapshot })),
    Effect.catch((error) => Effect.succeed(ActionMessage.FailedWriteAppSettings({ error: errorMessage(error) }))),
  ),
})

const WriteLlmProvider = Command.define("WriteLlmProvider", {
  args: { value: opaque<Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl"> & Partial<Pick<LlmProviderSnapshot, "faveModels">>>("LlmProviderWrite") },
  messages: [ActionMessage.SucceededWriteLlmProvider, ActionMessage.FailedCommand],
  execute: ({ value }) => sendCommand<LlmProviderSnapshot>({
    type: "settings.writeLlmProvider",
    provider: value.provider,
    apiKey: value.apiKey,
    model: value.model,
    baseUrl: value.baseUrl,
    faveModels: value.faveModels,
  }).pipe(
    Effect.map((snapshot) => ActionMessage.SucceededWriteLlmProvider({ snapshot })),
    Effect.catch((error) => Effect.succeed(fail(error))),
  ),
})

const Install = Command.define("InstallUpdate", {
  args: { command: Schema.Literals(["update.install", "update.installNightly", "update.installStable"]), failureTitle: Schema.String, failureMessage: Schema.String },
  messages: [ActionMessage.ReceivedInstallResult, ActionMessage.FailedInstall],
  execute: ({ command, failureTitle, failureMessage }) => sendCommand<UpdateInstallResult>({ type: command }).pipe(
    Effect.map((result) => ActionMessage.ReceivedInstallResult({ result, failureTitle, failureMessage })),
    Effect.catch((error) => Effect.succeed(ActionMessage.FailedInstall({ error: errorMessage(error) }))),
  ),
})

const SetRestartPhase = Command.define("SetUpdateRestartPhase", {
  args: { phase: Schema.NullOr(Schema.Literals(["awaiting_disconnect", "awaiting_server_ready"])) },
  messages: [ActionMessage.CompletedSideEffect],
  execute: ({ phase }) => Effect.sync(() => {
    if (phase === null) window.sessionStorage.removeItem(UI_UPDATE_RESTART_STORAGE_KEY)
    else window.sessionStorage.setItem(UI_UPDATE_RESTART_STORAGE_KEY, phase)
    return ActionMessage.CompletedSideEffect()
  }),
})

const ReloadPage = Command.define("ReloadPage", {
  messages: [ActionMessage.CompletedSideEffect],
  execute: Effect.sync(() => {
    window.location.reload()
    return ActionMessage.CompletedSideEffect()
  }),
})

const SignOut = Command.define("SignOut", {
  messages: [ActionMessage.CompletedSideEffect, ActionMessage.FailedCommand],
  execute: Effect.tryPromise(async () => {
    const response = await fetch("/auth/logout", { method: "POST", headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error(`Sign out failed with status ${response.status}`)
    window.location.reload()
  }).pipe(
    Effect.as(ActionMessage.CompletedSideEffect()),
    Effect.catch((error) => Effect.succeed(fail(error))),
  ),
})

/**
 * On mobile the sidebar is a page, so "open" means go to it: back through
 * the history when the chat was opened from somewhere, `/` otherwise.
 */
const OpenSidebar = Command.define("OpenSidebar", {
  messages: [ActionMessage.CompletedSideEffect],
  execute: Effect.gen(function* () {
    if (AppNavigation.historyIndex() > 0) yield* AppNavigation.back()
    else yield* AppNavigation.pushUrl("/")
    return ActionMessage.CompletedSideEffect()
  }),
})

export const ActionCommands = { Send, ReloadPage, SetRestartPhase }

// STEPS

type Return<Host> = Update.Return<Host, unknown, KannaSocketService>

export function makeActions<Host extends ActionsHost>(root: RootEffects<Host>) {
  type Step = (host: Host) => Return<Host>
  const lift = (command: Command.Command<ActionMessage, never, KannaSocketService>) =>
    Command.mapMessage(command, root.toMessage) as Command.Command<unknown, never, KannaSocketService>
  const withActions = (host: Host, change: (actions: ActionsModel) => ActionsModel): Host =>
    ({ ...host, actions: change(host.actions) })
  const withError = (host: Host, error: string | null): Host =>
    host.commandError === error ? host : { ...host, commandError: error }
  const commands = (...list: Command.Command<ActionMessage, never, KannaSocketService>[]) => list.map(lift)
  const seq = (host: Host, steps: Step[]): Return<Host> => Update.combine(host, steps as never) as Return<Host>
  const stores = (message: Stores.Message): Step => root.sendStores(message) as Step

  /** Shows the app dialog; `then` runs when it is answered (React awaited the promise). */
  function openDialog(host: Host, request: DialogRequest, then: DialogContinuation = DialogContinuation.None()): Return<Host> {
    const requestId = `app-dialog-${host.actions.dialogSeq + 1}`
    const opened = AppDialog.open(host.appDialog, { _tag: request.kind === "confirm" ? "Confirm" : request.kind === "prompt" ? "Prompt" : "Alert", ...request.options, requestId } as AppDialog.Request)
    return {
      model: { ...withActions(host, (actions) => ({ ...actions, dialogSeq: actions.dialogSeq + 1, pendingDialog: { requestId, then } })), appDialog: opened.model },
      commands: Command.mapMessages(opened.commands, root.toAppDialogMessage) as unknown as Command.Command<unknown, never, KannaSocketService>[],
    }
  }

  const resolvedTheme = (host: Host) => resolveTheme(themePreference(host.stores.appSettings.settings), host.systemTheme)

  function editorFor(host: Host) {
    const preferences = host.stores.terminalPreferences
    const preset = resolveEffectiveEditorPreset({
      preferred: preferences.editorPreset,
      remembered: editorPresetFromOpenAppValue(host.stores.openDestination.value),
      installedEditors: host.stores.appSettings.settings?.installedEditors ?? null,
    })
    return {
      preset,
      commandTemplate: preset === "custom" ? preferences.editorCommandTemplate : getDefaultEditorCommandTemplate(preset),
    }
  }

  function openExternal(host: Host, command: { action: OpenExternalAction; localPath: string; line?: number; column?: number; editor?: EditorOpenSettings | null; terminal?: TerminalPreset | null }): Return<Host> {
    return {
      model: withError(host, null),
      commands: commands(Send({
        command: {
          type: "system.openExternal",
          action: command.action,
          localPath: command.localPath,
          ...(command.line !== undefined ? { line: command.line } : {}),
          ...(command.column !== undefined ? { column: command.column } : {}),
          ...(command.terminal ? { terminal: command.terminal } : {}),
          editor: command.action === "open_editor" ? command.editor ?? editorFor(host) : undefined,
        } as ClientCommand,
      })),
    }
  }

  /**
   * Goes to the new chat's page at once and creates the chat behind it.
   * The id is made first so the page has an address before the server
   * answers; `startedChat` is what the page is drawn from until the chat's
   * snapshot arrives.
   */
  function createChatForProject(host: Host, projectId: string, options: { carryDraftFrom?: string; background?: boolean } = {}): Return<Host> {
    return { model: host, commands: commands(PrepareCreateChat({ projectId, carryDraftFrom: options.carryDraftFrom ?? null, background: options.background ?? false })) }
  }

  function startChatFromIntent(host: Host, intent: StartChatIntent): Return<Host> {
    const localPath = intent.kind === "project_id" ? null : intent.kind === "local_path" ? intent.localPath : intent.project.localPath
    // A project already known is gone to in the same tick as the click.
    const knownProjectId = intent.kind === "project_id"
      ? intent.projectId
      : intent.kind === "local_path"
        ? host.stores.sidebar.data.projectGroups.find((group) => group.localPath === intent.localPath)?.groupKey
        : undefined
    if (knownProjectId) return createChatForProject(host, knownProjectId)
    return {
      model: withActions(host, (actions) => ({ ...actions, startingLocalPath: localPath, projectRequestError: null })),
      commands: commands(ResolveStartChatProject({ intent })),
    }
  }

  function leaveChat(host: Host, chatId: string): Return<Host> {
    if (chatId !== root.activeChatId(host)) return { model: host }
    const nextChatId = getNewestRemainingChatId(host.stores.sidebar.data.projectGroups, chatId)
    return root.navigate(nextChatId ? `/chat/${nextChatId}` : "/")(host) as Return<Host>
  }

  function runInstall(host: Host, command: "update.install" | "update.installNightly" | "update.installStable", failureTitle: string, failureMessage: string): Return<Host> {
    return { model: host, commands: commands(Install({ command, failureTitle, failureMessage })) }
  }

  function performAction(host: Host, action: AppAction): Return<Host> {
    return AppAction.match<Return<Host>>(action, {
      Navigate: ({ path, replace }) => root.navigate(path, replace)(host) as Return<Host>,
      OpenSidebar: () => ({ model: host, commands: commands(OpenSidebar()) }),
      CollapseSidebar: () => ({ model: host }),
      ExpandSidebar: () => ({ model: host }),

      CreateChat: ({ projectId }) => startChatFromIntent(host, { kind: "project_id", projectId }),
      OpenProjectNewChat: ({ projectId }) => {
        const sidebar = host.stores.sidebar
        const chatInput = host.stores.chatInput
        const group = sidebar.data.projectGroups.find((item) => item.groupKey === projectId)
        const decision = resolveProjectNewChat({
          entry: "project",
          projectId,
          projectThreads: group ? flattenSidebarThreads({ projectGroups: [group] }) : [],
          delegatorViewedAt: host.stores.delegate.viewedAt,
          isListed: sidebar.ready ? (chatId) => getProjectIdForChat(sidebar.data.projectGroups, chatId) !== null : null,
          drafts: {
            text: chatInput.drafts,
            attachments: chatInput.attachmentDrafts as Record<string, readonly unknown[]>,
            touchedAt: chatInput.draftTouchedAt,
            startedAt: chatInput.draftStartedAt,
          },
          startedChats: chatInput.startedChats,
          startingChatIds: new Set(host.actions.startingChatIds),
        })
        if (decision.kind === "delegator") {
          const created = decision.restoreDraftFrom
            ? createChatForProject(host, projectId, { carryDraftFrom: decision.restoreDraftFrom, background: true })
            : { model: host }
          const navigated = root.navigate(`/chat/${decision.chatId}`)(withError(created.model, null)) as Return<Host>
          return { model: navigated.model, commands: [...(created.commands ?? []), ...(navigated.commands ?? [])] }
        }
        if (decision.kind !== "open") {
          return createChatForProject(host, projectId, decision.kind === "carry" ? { carryDraftFrom: decision.fromChatId } : {})
        }
        // One whose `chat.create` has not been answered is not in the
        // sidebar yet, so its page is still drawn from `startedChat`.
        let next = host
        if (host.actions.startingChatIds.includes(decision.chatId)) {
          next = withActions(next, (actions) => ({ ...actions, pendingChatId: decision.chatId, startedChat: { chatId: decision.chatId, projectId } }))
        }
        next = withError({ ...next, selectedProjectId: projectId }, null)
        return root.navigate(`/chat/${decision.chatId}`)(next) as Return<Host>
      },
      Compose: () => {
        const intent = resolveComposeIntent({
          selectedProjectId: root.activeProjectId(host),
          sidebarProjectId: getMostRecentlyActiveProjectId(host.stores.sidebar.data.projectGroups),
          fallbackLocalProjectPath: root.fallbackLocalProjectPath(host),
        })
        return intent ? startChatFromIntent(host, intent) : root.navigate("/")(host) as Return<Host>
      },
      ForkChat: ({ chatId }) => ({ model: host, commands: commands(ForkChat({ chatId })) }),
      RenameChat: ({ chatId, title }) => openDialog(host, { kind: "prompt", options: { title: "Rename Chat", initialValue: title, confirmLabel: "Rename" } }, DialogContinuation.RenameChat({ chatId, currentTitle: title })),
      ShareChat: ({ chatId }) => {
        const target = chatId ?? root.activeChatId(host)
        if (!target || host.actions.isExportingStandalone) return { model: host }
        return {
          model: withActions(host, (actions) => ({ ...actions, standaloneShareComplete: false, isExportingStandalone: true })),
          commands: commands(ExportStandalone({ chatId: target, theme: resolvedTheme(host) })),
        }
      },
      TogglePinChat: ({ chatId, pinned }) => ({ model: host, commands: commands(Send({ command: { type: "chat.setPinned", chatId, pinned } })) }),
      ArchiveChat: ({ chatId }) => ({ model: host, commands: commands(ArchiveChat({ chatId })) }),
      // Viewing an archived chat is read-only navigation: it stays archived.
      OpenArchivedChat: ({ chatId }) => root.navigate(`/chat/${chatId}`)(host) as Return<Host>,
      RestoreChat: ({ chatId }) => ({ model: host, commands: commands(Send({ command: { type: "chat.unarchive", chatId } })) }),
      DeleteChat: ({ chatId, title }) => openDialog(host, { kind: "confirm", options: { title: "Delete Chat", description: `Delete "${title}"? This cannot be undone.`, confirmLabel: "Delete", confirmVariant: "destructive" } },
            DialogContinuation.DeleteChat({ chatId }),),
      SetupGit: ({ chatId }) => openDialog(host, { kind: "confirm", options: { title: "Initialize Git?", description: "Initialize a local git repository in this project?", confirmLabel: "Init Git", cancelLabel: "Cancel" } },
            DialogContinuation.SetupGit({ chatId }),),
      SetDelegator: ({ chatId, delegator }) => ({ model: host, commands: commands(SetDelegator({ chatId, delegator })) }),

      OpenLocalProject: ({ localPath }) => startChatFromIntent(host, { kind: "local_path", localPath }),
      CreateProject: ({ project }) => startChatFromIntent(host, { kind: "project_request", project: project as ProjectRequest }),
      RenameProject: ({ target, sidebarTitle, realTitle }) => openDialog(host, {
              kind: "prompt",
              options: {
                title: "Rename Project",
                description: "This changes the display name. The folder path on disk stays the same.",
                initialValue: sidebarTitle ?? "",
                placeholder: realTitle,
                allowEmpty: true,
                resetLabel: "Reset",
                resetValue: "",
                confirmLabel: "Rename",
              },
            },
            DialogContinuation.RenameProject({ target, currentTitle: sidebarTitle ?? "" }),),
      HideProject: ({ target }) => ({ model: host, commands: commands(HideProject({ target })) }),
      ReorderProjectGroups: ({ projectIds }) => {
        const ordered = stores(root.storesMessage.sidebar(Sidebar.Message.ChangedOptimisticProjectOrder({ projectIds })))(host)
        return { model: ordered.model, commands: [...(ordered.commands ?? []), ...commands(ReorderProjectGroups({ projectIds }))] }
      },
      SetProjectPinned: ({ projectId, pinned }) => ({ model: host, commands: commands(SetProjectPinned({ projectId, pinned })) }),

      CopyPath: ({ localPath }) => ({ model: host, commands: commands(CopyText({ text: localPath, onFailure: "commandError" })) }),
      OpenExternal: ({ action: externalAction, editor, terminal }) => {
        const localPath = root.navbarLocalPath(host)
        if (!localPath) return { model: host }
        return openExternal(host, { action: externalAction, localPath, editor, terminal })
      },
      OpenExternalPath: ({ action: externalAction, localPath }) => openExternal(host, { action: externalAction, localPath }),
      OpenLocalLink: ({ target, action: externalAction, editor }) => openExternal(host, {
        action: externalAction,
        localPath: target.path,
        ...(target.line !== undefined ? { line: target.line } : {}),
        ...(target.column !== undefined ? { column: target.column } : {}),
        editor,
      }),

      WriteAppSettings: ({ patch }) => {
        const patched = stores(root.storesMessage.appSettings(AppSettings.Message.AppliedOptimisticPatch({ patch })))(host)
        return { model: patched.model, commands: [...(patched.commands ?? []), ...commands(WriteAppSettings({ patch }))] }
      },
      ReadAppSettings: () => ({ model: host, commands: [root.readAppSettings()] }),
      WriteLlmProvider: ({ value }) => ({ model: host, commands: commands(WriteLlmProvider({ value })) }),
      // Save only the fave models, leaving the rest at their last-committed values.
      WriteFaveModels: ({ faveModels }) => {
        const current = root.llmProvider(host)
        if (!current) return { model: host }
        return {
          model: host,
          commands: commands(WriteLlmProvider({ value: { provider: current.provider, apiKey: current.apiKey, model: current.model, baseUrl: current.baseUrl, faveModels } })),
        }
      },
      CheckForUpdates: ({ force }) => ({ model: host, commands: commands(Send({ command: { type: "update.check", force } })) }),
      InstallUpdate: () => runInstall(host, "update.install", "Update failed", "Kanna could not install the update. Try again later."),
      InstallNightly: () => openDialog(host, {
            kind: "confirm",
            options: {
              title: "Update to nightly?",
              description: "Kanna will download the latest main branch from GitHub, build it from source on this machine, and restart into it. This takes a few minutes, and nightly builds can be less stable than releases. The next published release brings you back to stable automatically.",
              confirmLabel: "Build nightly",
            },
          }, DialogContinuation.InstallNightly()),
      InstallStable: () => openDialog(host, {
            kind: "confirm",
            options: { title: "Back to stable?", description: "Kanna will reinstall the latest published release and restart into it.", confirmLabel: "Reinstall stable" },
          }, DialogContinuation.InstallStable()),
      SignOut: () => ({ model: host, commands: commands(SignOut()) }),

      OpenChatAt: ({ chatId, jump }) => root.navigate(`/chat/${chatId}`)(withActions(host, (actions) => ({
        ...actions,
        chatJumpSeq: actions.chatJumpSeq + 1,
        pendingChatJump: { chatId, jump, requestId: actions.chatJumpSeq + 1 },
      }))) as Return<Host>,
      SpentChatJump: ({ requestId }) => ({
        model: withActions(host, (actions) => ({
          ...actions,
          pendingChatJump: actions.pendingChatJump?.requestId === requestId ? null : actions.pendingChatJump,
        })),
      }),
      // The root handles these two itself (app/update.ts performAction).
      Batch: () => ({ model: host }),
      OpenCommandPalette: () => ({ model: host }),
      SendCommand: ({ command }) => ({ model: host, commands: commands(Send({ command })) }),
      Store: ({ message }) => stores(message)(host),
      Chat: () => ({ model: host }),
    })
  }

  /** The dialog's answer, as the awaited `dialog.confirm/prompt` call continued. */
  /**
   * The app dialog answered `requestId` (ui/app-dialog's Answered): the
   * action that opened it carries on, as the awaited React promise did.
   * A request replaced before it was answered is never answered, as in React.
   */
  function answeredDialog(host: Host, requestId: string, answer: AppDialog.Answer): Return<Host> {
    const pending = host.actions.pendingDialog
    if (!pending || pending.requestId !== requestId) return { model: host }
    const closed = withActions(host, (actions) => ({ ...actions, pendingDialog: null }))
    const confirmed = answer._tag === "Confirm" ? answer.confirmed : answer._tag === "Prompt" ? Option.isSome(answer.value) : true
    if (!confirmed) return { model: closed }
    const value = answer._tag === "Prompt" ? Option.getOrElse(answer.value, () => "") : ""
    return DialogContinuation.match<Return<Host>>(pending.then, {
      None: () => ({ model: closed }),
      DeleteChat: ({ chatId }) => ({ model: closed, commands: commands(DeleteChat({ chatId })) }),
      SetupGit: ({ chatId }) => ({ model: closed, commands: commands(InitGit({ chatId })) }),
      RenameChat: ({ chatId, currentTitle }) => !value || value === currentTitle
        ? { model: closed }
        : { model: closed, commands: commands(Send({ command: { type: "chat.rename", chatId, title: value } })) },
      RenameProject: ({ target, currentTitle }) => value === currentTitle
        ? { model: closed }
        : {
          model: closed,
          commands: commands(Send({ command: { type: "project.rename", ...(typeof target === "string" ? { projectId: target } : target), title: value } as ClientCommand })),
        },
      DownloadTranscript: ({ fileName, json }) => ({ model: closed, commands: commands(DownloadTextFile({ fileName, contents: json })) }),
      InstallNightly: () => runInstall(closed, "update.installNightly", "Nightly update failed", "Kanna could not build the nightly version. Try again later."),
      InstallStable: () => runInstall(closed, "update.installStable", "Update failed", "Kanna could not reinstall the latest release. Try again later."),
    })
  }

  function alert(host: Host, options: DialogRequest["options"] & { title: string }, then?: DialogContinuation): Return<Host> {
    return openDialog(host, { kind: "alert", options } as DialogRequest, then)
  }

  function handleActionMessage(host: Host, message: ActionMessage): Return<Host> {
    return ActionMessage.match<Return<Host>>(message, {
      PreparedCreateChat: ({ projectId, chatId, carryDraftFrom, background, cameFrom, at }) => {
        const chatPreferences = host.stores.chatPreferences
        const sidebar = host.stores.sidebar.data
        const activeChatId = root.activeChatId(host)
        const sourceComposerState = carryDraftFrom && chatPreferences.chatStates[carryDraftFrom]
          ? ChatPreferences.getComposerState(chatPreferences, sidebar, carryDraftFrom)
          : activeChatId
            ? ChatPreferences.getComposerState(chatPreferences, sidebar, activeChatId)
            : ChatPreferences.getComposerState(chatPreferences, sidebar, ChatPreferences.NEW_CHAT_COMPOSER_ID)
        const steps: Step[] = []
        if (carryDraftFrom) {
          steps.push(stores(root.storesMessage.chatInput(ChatInput.Message.MovedDraft({ fromChatId: carryDraftFrom, toChatId: chatId }))))
          steps.push(stores(root.storesMessage.chatInput(ChatInput.Message.ForgotStartedChat({ chatId: carryDraftFrom }))))
        }
        steps.push(stores(root.storesMessage.chatInput(ChatInput.Message.RememberedStartedChat({ chatId, projectId, at }))))
        // Sent before the navigation, so it is on the wire ahead of
        // everything the page sends about the chat. The server holds those
        // until the chat is written.
        steps.push((step) => ({ model: step, commands: commands(CreateChat({ projectId, chatId, cameFrom })) }))
        steps.push((step) => ({ model: withActions(step, (actions) => ({ ...actions, startingChatIds: [...actions.startingChatIds, chatId] })) }))
        steps.push(stores(root.storesMessage.chatPreferences(ChatPreferences.Message.InitializedComposerForChat({ chatId, sourceState: sourceComposerState }))))
        if (!background) {
          steps.push((step) => ({
            model: withError({
              ...withActions(step, (actions) => ({ ...actions, pendingChatId: chatId, startedChat: { chatId, projectId } })),
              selectedProjectId: projectId,
            }, null),
          }))
          steps.push(root.navigate(`/chat/${chatId}`) as Step)
        }
        return seq(host, steps)
      },
      SucceededCreateChat: ({ chatId, resultChatId, projectId }) => {
        const settled = withActions(host, (actions) => ({ ...actions, startingChatIds: actions.startingChatIds.filter((id) => id !== chatId) }))
        if (resultChatId === chatId) return { model: settled }
        // A server from before it took an id made its own. Follow it there,
        // with whatever has been typed by now.
        const steps: Step[] = [
          stores(root.storesMessage.chatInput(ChatInput.Message.MovedDraft({ fromChatId: chatId, toChatId: resultChatId }))),
          stores(root.storesMessage.chatInput(ChatInput.Message.ForgotStartedChat({ chatId }))),
          (step) => ({
            model: withActions(step, (actions) => ({
              ...actions,
              startedChat: actions.startedChat?.chatId === chatId ? { chatId: resultChatId, projectId } : actions.startedChat,
              pendingChatId: actions.pendingChatId === chatId ? resultChatId : actions.pendingChatId,
            })),
          }),
        ]
        if (root.activeChatId(host) === chatId) steps.push(root.navigate(`/chat/${resultChatId}`, true) as Step)
        return seq(settled, steps)
      },
      FailedCreateChat: ({ chatId, cameFrom, error }) => {
        // The chat was not made, so its page comes down: the page the click
        // was on takes its place in the history, with the reason.
        const next = withError(withActions(host, (actions) => ({
          ...actions,
          startingChatIds: actions.startingChatIds.filter((id) => id !== chatId),
          startedChat: actions.startedChat?.chatId === chatId ? null : actions.startedChat,
        })), error)
        return root.activeChatId(host) === chatId ? root.navigate(cameFrom, true)(next) as Return<Host> : { model: next }
      },
      ResolvedStartChatProject: ({ projectId }) =>
        createChatForProject(withActions(host, (actions) => ({ ...actions, startingLocalPath: null })), projectId),
      FailedStartChat: ({ error, projectRequest }) => ({
        model: withError(withActions(host, (actions) => ({
          ...actions,
          startingLocalPath: null,
          projectRequestError: projectRequest ? error : actions.projectRequestError,
        })), error),
      }),
      SucceededForkChat: ({ sourceChatId, chatId }) => seq(host, [
        stores(root.storesMessage.chatPreferences(ChatPreferences.Message.InitializedComposerForChat({
          chatId,
          sourceState: ChatPreferences.getComposerState(host.stores.chatPreferences, host.stores.sidebar.data, sourceChatId),
        }))),
        (step) => ({ model: withError(withActions(step, (actions) => ({ ...actions, pendingChatId: chatId })), null) }),
        root.navigate(`/chat/${chatId}`) as Step,
      ]),
      SucceededArchiveChat: ({ chatId }) => seq(host, [
        // As for a delete: archiving a chat with no messages is one.
        stores(root.storesMessage.chatInput(ChatInput.Message.ForgotStartedChat({ chatId }))),
        (step) => leaveChat(step, chatId),
        (step) => ({ model: withError(step, null) }),
      ]),
      SucceededDeleteChat: ({ chatId }) => seq(host, [
        // Put away on purpose: a draft left in it is not to come back when
        // its project is next clicked.
        stores(root.storesMessage.chatInput(ChatInput.Message.ForgotStartedChat({ chatId }))),
        (step) => leaveChat(step, chatId),
      ]),
      SucceededHideProject: ({ projectId }) => {
        const steps: Step[] = [
          stores(root.storesMessage.terminalLayout(TerminalLayout.Message.ClearedProject({ projectId }))),
          stores(root.storesMessage.rightSidebar(RightSidebar.Message.ClearedProject({ projectId }))),
          (step) => ({ model: withError(step, null) }),
        ]
        if (root.activeRuntimeProjectId(host) === projectId) steps.push(root.navigate("/") as Step)
        return seq(host, steps)
      },
      ReceivedInitGitResult: ({ result }) => result.ok
        ? { model: host }
        : alert(host, { title: result.title, description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`, closeLabel: "OK" }),
      FailedInitGit: ({ error }) => alert(host, { title: "Initialize git failed", description: error, closeLabel: "OK" }),
      ReceivedExportResult: ({ result }) => {
        const exported = withError(withActions(host, (actions) => ({ ...actions, isExportingStandalone: false })), null)
        if (result.ok && result.shareUrl) {
          return { model: withActions(exported, (actions) => ({ ...actions, standaloneShareUrl: result.shareUrl ?? null, standaloneShareComplete: true })) }
        }
        if (!result.ok) {
          return openDialog(
            exported,
            { kind: "confirm", options: { title: "Share failed", description: result.error, confirmLabel: "Download transcript JSON", cancelLabel: "Close", confirmVariant: "secondary" } },
            DialogContinuation.DownloadTranscript({ fileName: result.transcriptFileName, json: result.transcriptJson }),
          )
        }
        return { model: exported }
      },
      FailedExport: ({ error }) => ({ model: withError(withActions(host, (actions) => ({ ...actions, isExportingStandalone: false })), error) }),
      SucceededWriteAppSettings: ({ snapshot }) => root.receivedAppSettings(snapshot)(withError(host, null)) as Return<Host>,
      FailedWriteAppSettings: ({ error }) => ({ model: withError(host, error), commands: [root.readAppSettings()] }),
      SucceededWriteLlmProvider: ({ snapshot }) => root.setLlmProvider(snapshot)(withError(host, null)) as Return<Host>,
      FailedReorderProjectGroups: ({ error }) => {
        const reverted = stores(root.storesMessage.sidebar(Sidebar.Message.ChangedOptimisticProjectOrder({ projectIds: null })))(host)
        return { model: withError(reverted.model, error), commands: reverted.commands }
      },
      ReceivedInstallResult: ({ result, failureTitle, failureMessage }) => {
        if (!result.ok) {
          const alerted = alert(withError(host, null), { title: result.userTitle ?? failureTitle, description: result.userMessage ?? failureMessage, closeLabel: "OK" })
          return { model: alerted.model, commands: [...(alerted.commands ?? []), ...commands(SetRestartPhase({ phase: null }))] }
        }
        if (result.action === "reload") return { model: host, commands: commands(ReloadPage()) }
        return {
          model: withError(host, null),
          commands: result.action === "restart" ? commands(SetRestartPhase({ phase: "awaiting_disconnect" })) : [],
        }
      },
      FailedInstall: ({ error }) => ({ model: withError(host, error), commands: commands(SetRestartPhase({ phase: null })) }),
      SucceededCommand: () => ({ model: withError(host, null) }),
      FailedCommand: ({ error }) => ({ model: withError(host, error) }),
      CompletedSideEffect: () => ({ model: host }),


      ClosedShareDialog: () => ({ model: withActions(host, (actions) => ({ ...actions, standaloneShareUrl: null, standaloneShareComplete: false })) }),
      ClickedOpenShareLink: () => host.actions.standaloneShareUrl
        ? {
          model: withActions(host, (actions) => ({ ...actions, standaloneShareUrl: null })),
          commands: commands(OpenWindow({ url: host.actions.standaloneShareUrl })),
        }
        : { model: host },
      ClickedCopyShareLink: () => host.actions.standaloneShareUrl
        ? { model: host, commands: commands(CopyText({ text: host.actions.standaloneShareUrl, onFailure: "alert" })) }
        : { model: host },
      FailedCopyShareLink: ({ error }) => alert(host, { title: "Copy failed", description: error, closeLabel: "Close" }),
    })
  }

  return { performAction, handleActionMessage, answeredDialog }
}
