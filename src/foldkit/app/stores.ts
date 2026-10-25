import { Option, Schema } from "effect"
import { Command, Subscription, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import type { AppSettingsSnapshot } from "../../shared/types"
import type { KannaSocketService } from "../core/socket"
import * as AppSettings from "../core/stores/appSettings"
import * as ChatInput from "../core/stores/chatInput"
import * as ChatPreferences from "../core/stores/chatPreferences"
import * as ChatSoundPreferences from "../core/stores/chatSoundPreferences"
import * as ChatTabs from "../core/stores/chatTabs"
import * as Connection from "../core/stores/connection"
import * as Delegate from "../core/stores/delegate"
import * as DiffCommit from "../core/stores/diffCommit"
import * as FocusMode from "../core/stores/focusMode"
import * as OpenDestination from "../core/stores/openDestination"
import * as PendingSend from "../core/stores/pendingSend"
import * as ProviderAuth from "../core/stores/providerAuth"
import * as RightSidebar from "../core/stores/rightSidebar"
import * as ServerCapabilities from "../core/stores/serverCapabilities"
import * as Sidebar from "../core/stores/sidebar"
import * as SidebarSection from "../core/stores/sidebarSection"
import * as SidebarView from "../core/stores/sidebarView"
import * as TerminalLayout from "../core/stores/terminalLayout"
import * as TerminalPreferences from "../core/stores/terminalPreferences"
import * as Viewer from "../core/stores/viewer"

// Every client store (src/client/stores, ported to core/stores) in one
// Submodel, so the root holds one `stores` field and one wrapper Message.
// Cross-store reads happen here: chat preferences read the sidebar, the
// connection reads the server's capabilities, the viewer writes the right
// sidebar's layouts, and the app-settings snapshot fans out to the stores
// that mirrored it (useAppSettingsSync's syncRuntimeStoresFromAppSettings).

export const Model = Schema.Struct({
  appSettings: AppSettings.Model,
  chatInput: ChatInput.Model,
  chatPreferences: ChatPreferences.Model,
  chatSoundPreferences: ChatSoundPreferences.Model,
  chatTabs: ChatTabs.Model,
  connection: Connection.Model,
  delegate: Delegate.Model,
  diffCommit: DiffCommit.Model,
  focusMode: FocusMode.Model,
  openDestination: OpenDestination.Model,
  pendingSend: PendingSend.Model,
  providerAuth: ProviderAuth.Model,
  rightSidebar: RightSidebar.Model,
  serverCapabilities: ServerCapabilities.Model,
  sidebar: Sidebar.Model,
  sidebarSection: SidebarSection.Model,
  sidebarView: SidebarView.Model,
  terminalLayout: TerminalLayout.Model,
  terminalPreferences: TerminalPreferences.Model,
  viewer: Viewer.Model,
})
export type Model = typeof Model.Type

/** What the browser held, read once for the app's Flags. */
export function load(storage?: Storage): Model {
  return {
    appSettings: AppSettings.initialModel,
    chatInput: ChatInput.load(storage),
    chatPreferences: ChatPreferences.initialModel,
    chatSoundPreferences: ChatSoundPreferences.initialModel,
    chatTabs: ChatTabs.load(storage),
    connection: Connection.initialModel,
    delegate: Delegate.load(storage),
    diffCommit: DiffCommit.load(storage),
    focusMode: FocusMode.load(storage),
    openDestination: OpenDestination.load(storage),
    pendingSend: PendingSend.initialModel,
    providerAuth: ProviderAuth.initialModel,
    rightSidebar: RightSidebar.load(storage),
    serverCapabilities: ServerCapabilities.initialModel,
    sidebar: Sidebar.initialModel,
    sidebarSection: SidebarSection.load(storage),
    sidebarView: SidebarView.load(storage),
    terminalLayout: TerminalLayout.load(storage),
    terminalPreferences: TerminalPreferences.initialModel,
    viewer: Viewer.initialModel,
  }
}

export const Message = defineMessageUnion({
  GotAppSettingsMessage: { message: AppSettings.Message },
  GotChatInputMessage: { message: ChatInput.Message },
  GotChatPreferencesMessage: { message: ChatPreferences.Message },
  GotChatSoundPreferencesMessage: { message: ChatSoundPreferences.Message },
  GotChatTabsMessage: { message: ChatTabs.Message },
  GotConnectionMessage: { message: Connection.Message },
  GotDelegateMessage: { message: Delegate.Message },
  GotDiffCommitMessage: { message: DiffCommit.Message },
  GotFocusModeMessage: { message: FocusMode.Message },
  GotOpenDestinationMessage: { message: OpenDestination.Message },
  GotPendingSendMessage: { message: PendingSend.Message },
  GotProviderAuthMessage: { message: ProviderAuth.Message },
  GotRightSidebarMessage: { message: RightSidebar.Message },
  GotServerCapabilitiesMessage: { message: ServerCapabilities.Message },
  GotSidebarMessage: { message: Sidebar.Message },
  GotSidebarSectionMessage: { message: SidebarSection.Message },
  GotSidebarViewMessage: { message: SidebarView.Message },
  GotTerminalLayoutMessage: { message: TerminalLayout.Message },
  GotTerminalPreferencesMessage: { message: TerminalPreferences.Message },
  GotViewerMessage: { message: Viewer.Message },
})
export type Message = typeof Message.Type

/** Facts the root acts on. */
export const OutMessage = defineMessageUnion({
  /** A sidebar push landed: the root chimes, follows running chats, seeds its project. */
  AppliedSidebarSnapshot: {},
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, KannaSocketService>
type Step = Update.StepWithOutMessage<Model, Message, OutMessage, KannaSocketService>

// One fold per store. `update` closes over what a store reads of the others.

const fold = {
  appSettings: Update.foldChild({
    update: AppSettings.update,
    read: (model: Model) => Option.some(model.appSettings),
    write: (model, child) => modifyFields(model, { appSettings: () => child }),
    toParentMessage: (message: AppSettings.Message) => Message.GotAppSettingsMessage({ message }),
  }),
  chatInput: Update.foldChild({
    update: ChatInput.update,
    read: (model: Model) => Option.some(model.chatInput),
    write: (model, child) => modifyFields(model, { chatInput: () => child }),
    toParentMessage: (message: ChatInput.Message) => Message.GotChatInputMessage({ message }),
  }),
  chatSoundPreferences: Update.foldChild({
    update: ChatSoundPreferences.update,
    read: (model: Model) => Option.some(model.chatSoundPreferences),
    write: (model, child) => modifyFields(model, { chatSoundPreferences: () => child }),
    toParentMessage: (message: ChatSoundPreferences.Message) => Message.GotChatSoundPreferencesMessage({ message }),
  }),
  chatTabs: Update.foldChild({
    update: ChatTabs.update,
    read: (model: Model) => Option.some(model.chatTabs),
    write: (model, child) => modifyFields(model, { chatTabs: () => child }),
    toParentMessage: (message: ChatTabs.Message) => Message.GotChatTabsMessage({ message }),
  }),
  delegate: Update.foldChild({
    update: Delegate.update,
    read: (model: Model) => Option.some(model.delegate),
    write: (model, child) => modifyFields(model, { delegate: () => child }),
    toParentMessage: (message: Delegate.Message) => Message.GotDelegateMessage({ message }),
  }),
  diffCommit: Update.foldChild({
    update: DiffCommit.update,
    read: (model: Model) => Option.some(model.diffCommit),
    write: (model, child) => modifyFields(model, { diffCommit: () => child }),
    toParentMessage: (message: DiffCommit.Message) => Message.GotDiffCommitMessage({ message }),
  }),
  focusMode: Update.foldChild({
    update: FocusMode.update,
    read: (model: Model) => Option.some(model.focusMode),
    write: (model, child) => modifyFields(model, { focusMode: () => child }),
    toParentMessage: (message: FocusMode.Message) => Message.GotFocusModeMessage({ message }),
  }),
  openDestination: Update.foldChild({
    update: OpenDestination.update,
    read: (model: Model) => Option.some(model.openDestination),
    write: (model, child) => modifyFields(model, { openDestination: () => child }),
    toParentMessage: (message: OpenDestination.Message) => Message.GotOpenDestinationMessage({ message }),
  }),
  pendingSend: Update.foldChild({
    update: PendingSend.update,
    read: (model: Model) => Option.some(model.pendingSend),
    write: (model, child) => modifyFields(model, { pendingSend: () => child }),
    toParentMessage: (message: PendingSend.Message) => Message.GotPendingSendMessage({ message }),
  }),
  providerAuth: Update.foldChild({
    update: ProviderAuth.update,
    read: (model: Model) => Option.some(model.providerAuth),
    write: (model, child) => modifyFields(model, { providerAuth: () => child }),
    toParentMessage: (message: ProviderAuth.Message) => Message.GotProviderAuthMessage({ message }),
  }),
  rightSidebar: Update.foldChild({
    update: RightSidebar.update,
    read: (model: Model) => Option.some(model.rightSidebar),
    write: (model, child) => modifyFields(model, { rightSidebar: () => child }),
    toParentMessage: (message: RightSidebar.Message) => Message.GotRightSidebarMessage({ message }),
  }),
  serverCapabilities: Update.foldChild({
    update: ServerCapabilities.update,
    read: (model: Model) => Option.some(model.serverCapabilities),
    write: (model, child) => modifyFields(model, { serverCapabilities: () => child }),
    toParentMessage: (message: ServerCapabilities.Message) => Message.GotServerCapabilitiesMessage({ message }),
  }),
  sidebarSection: Update.foldChild({
    update: SidebarSection.update,
    read: (model: Model) => Option.some(model.sidebarSection),
    write: (model, child) => modifyFields(model, { sidebarSection: () => child }),
    toParentMessage: (message: SidebarSection.Message) => Message.GotSidebarSectionMessage({ message }),
  }),
  sidebarView: Update.foldChild({
    update: SidebarView.update,
    read: (model: Model) => Option.some(model.sidebarView),
    write: (model, child) => modifyFields(model, { sidebarView: () => child }),
    toParentMessage: (message: SidebarView.Message) => Message.GotSidebarViewMessage({ message }),
  }),
  terminalLayout: Update.foldChild({
    update: TerminalLayout.update,
    read: (model: Model) => Option.some(model.terminalLayout),
    write: (model, child) => modifyFields(model, { terminalLayout: () => child }),
    toParentMessage: (message: TerminalLayout.Message) => Message.GotTerminalLayoutMessage({ message }),
  }),
  terminalPreferences: Update.foldChild({
    update: TerminalPreferences.update,
    read: (model: Model) => Option.some(model.terminalPreferences),
    write: (model, child) => modifyFields(model, { terminalPreferences: () => child }),
    toParentMessage: (message: TerminalPreferences.Message) => Message.GotTerminalPreferencesMessage({ message }),
  }),
}

const foldChatPreferences = Update.foldChild({
  update: (child: ChatPreferences.Model, input: { message: ChatPreferences.Message; context: ChatPreferences.Context }) =>
    ChatPreferences.update(child, input.message, input.context),
  read: (model: Model) => Option.some(model.chatPreferences),
  write: (model, child) => modifyFields(model, { chatPreferences: () => child }),
  toParentMessage: (message: ChatPreferences.Message) => Message.GotChatPreferencesMessage({ message }),
})

const foldConnection = Update.foldChild({
  update: (child: Connection.Model, input: { message: Connection.Message; context: Connection.Context }) =>
    Connection.update(child, input.message, input.context),
  read: (model: Model) => Option.some(model.connection),
  write: (model, child) => modifyFields(model, { connection: () => child }),
  toParentMessage: (message: Connection.Message) => Message.GotConnectionMessage({ message }),
})

const foldViewer = Update.foldChild({
  update: Viewer.update,
  read: (model: Model) => Option.some({ viewer: model.viewer, rightSidebar: model.rightSidebar }),
  write: (model, state) => modifyFields(model, { viewer: () => state.viewer, rightSidebar: () => state.rightSidebar }),
  toParentMessage: (message: Viewer.Message) => Message.GotViewerMessage({ message }),
})

// The sidebar's report: the pending sends prune against the snapshot, and
// the root hears of it.
const foldSidebar = Update.foldChild({
  update: Sidebar.update,
  read: (model: Model) => Option.some(model.sidebar),
  write: (model, child) => modifyFields(model, { sidebar: () => child }),
  toParentMessage: (message: Sidebar.Message) => Message.GotSidebarMessage({ message }),
  foldOutMessage: Sidebar.OutMessage.match<Update.Step<Model, Message, KannaSocketService>>({
    AppliedSidebarSnapshot: ({ projectGroups }) => (model) =>
      fold.pendingSend(model, PendingSend.Message.ReceivedSidebarSnapshot({ projectGroups })),
  }),
  toParentOutMessage: Sidebar.OutMessage.match<OutMessage>({
    AppliedSidebarSnapshot: () => OutMessage.AppliedSidebarSnapshot(),
  }),
})

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    GotAppSettingsMessage: ({ message: child }) => fold.appSettings(model, child),
    GotChatInputMessage: ({ message: child }) => fold.chatInput(model, child),
    GotChatPreferencesMessage: ({ message: child }) => foldChatPreferences(model, { message: child, context: { sidebar: model.sidebar.data } }),
    GotChatSoundPreferencesMessage: ({ message: child }) => fold.chatSoundPreferences(model, child),
    GotChatTabsMessage: ({ message: child }) => fold.chatTabs(model, child),
    GotConnectionMessage: ({ message: child }) => foldConnection(model, { message: child, context: { capabilities: model.serverCapabilities.value } }),
    GotDelegateMessage: ({ message: child }) => fold.delegate(model, child),
    GotDiffCommitMessage: ({ message: child }) => fold.diffCommit(model, child),
    GotFocusModeMessage: ({ message: child }) => fold.focusMode(model, child),
    GotOpenDestinationMessage: ({ message: child }) => fold.openDestination(model, child),
    GotPendingSendMessage: ({ message: child }) => fold.pendingSend(model, child),
    GotProviderAuthMessage: ({ message: child }) => fold.providerAuth(model, child),
    GotRightSidebarMessage: ({ message: child }) => fold.rightSidebar(model, child),
    GotServerCapabilitiesMessage: ({ message: child }) => fold.serverCapabilities(model, child),
    GotSidebarMessage: ({ message: child }) => foldSidebar(model, child),
    GotSidebarSectionMessage: ({ message: child }) => fold.sidebarSection(model, child),
    GotSidebarViewMessage: ({ message: child }) => fold.sidebarView(model, child),
    GotTerminalLayoutMessage: ({ message: child }) => fold.terminalLayout(model, child),
    GotTerminalPreferencesMessage: ({ message: child }) => fold.terminalPreferences(model, child),
    GotViewerMessage: ({ message: child }) => foldViewer(model, child),
  })

/**
 * useAppSettingsSync's syncRuntimeStoresFromAppSettings: the snapshot, and
 * everything the stores mirrored from it.
 */
export function receivedAppSettings(snapshot: AppSettingsSnapshot): Step {
  const steps: ReadonlyArray<Update.Step<Model, Message, KannaSocketService>> = [
    (step: Model) => fold.appSettings(step, AppSettings.Message.ReceivedAppSettings({ settings: snapshot })),
    (step: Model) => fold.terminalPreferences(step, TerminalPreferences.Message.ChangedScrollbackLines({ scrollbackLines: snapshot.terminal.scrollbackLines })),
    (step: Model) => fold.terminalPreferences(step, TerminalPreferences.Message.ChangedMinColumnWidth({ minColumnWidth: snapshot.terminal.minColumnWidth })),
    (step: Model) => fold.terminalPreferences(step, TerminalPreferences.Message.ChangedWebglRenderer({ webglRenderer: snapshot.terminal.webglRenderer })),
    (step: Model) => fold.terminalPreferences(step, TerminalPreferences.Message.ChangedEditorPreset({ editorPreset: snapshot.editor.preset })),
    (step: Model) => fold.terminalPreferences(step, TerminalPreferences.Message.ChangedEditorCommandTemplate({ editorCommandTemplate: snapshot.editor.commandTemplate })),
    (step: Model) => fold.chatSoundPreferences(step, ChatSoundPreferences.Message.ChangedChatSoundPreference({ value: snapshot.chatSoundPreference })),
    (step: Model) => fold.chatSoundPreferences(step, ChatSoundPreferences.Message.ChangedChatSoundId({ value: snapshot.chatSoundId })),
    (step: Model) => fold.chatSoundPreferences(step, ChatSoundPreferences.Message.ChangedChatBrowserNotificationPreference({ value: snapshot.chatBrowserNotificationPreference })),
    (step: Model) => foldChatPreferences(step, {
      message: ChatPreferences.Message.SyncedProviderDefaults({ defaultProvider: snapshot.defaultProvider, providerDefaults: snapshot.providerDefaults }),
      context: { sidebar: step.sidebar.data },
    }),
    (step: Model) => fold.providerAuth(step, ProviderAuth.Message.ReceivedSetupFlags({
      setupShown: snapshot.setupShown,
      setupCompleted: snapshot.setupCompleted,
      setupDismissed: snapshot.setupDismissed,
    })),
  ]
  return (model) => Update.combine(model, steps)
}

/** For the root's init: the capabilities request the socket and connection share. */
export const initCommands = Command.mapMessages(
  [ServerCapabilities.FetchServerCapabilities()],
  (message: ServerCapabilities.Message) => Message.GotServerCapabilitiesMessage({ message }),
)

// The stores' own subscriptions. Those on the socket wait for it (the root
// lifts this record with a gate).
const sidebarSubscriptions = Subscription.lift(Sidebar.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.sidebar),
  toParentMessage: (message) => Message.GotSidebarMessage({ message }),
})
const providerAuthSubscriptions = Subscription.lift(ProviderAuth.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.providerAuth),
  toParentMessage: (message) => Message.GotProviderAuthMessage({ message }),
})
const connectionSubscriptions = Subscription.lift(Connection.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.connection),
  toParentMessage: (message) => Message.GotConnectionMessage({ message }),
})

export const socketSubscriptions = Subscription.aggregate(sidebarSubscriptions, providerAuthSubscriptions)
export const browserSubscriptions = connectionSubscriptions
