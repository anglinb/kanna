import { Effect, Option, Schema, Stream } from "effect"
import { Dom, ManagedResource, Subscription } from "foldkit"
import type {
  AppSettingsSnapshot,
  ChatDiffSnapshot,
  KeybindingsSnapshot,
  LocalProjectsSnapshot,
  UpdateSnapshot,
} from "../../shared/types"
import { forgetAllFollowed } from "../core/backgroundChats"
import * as ChatSession from "../core/chatSession"
import * as SidebarSlice from "../sidebar"
import * as HomeSlice from "../home"
import * as SettingsSlice from "../settings"
import * as ChatPageSlice from "../chat"
import * as PaletteSlice from "../palette"
import * as SetupSlice from "../setup"
import * as WorkflowsSlice from "../workflows"
import * as TerminalPageSlice from "../terminal"
import * as Stores from "./stores"
import { KannaSocketResource, acquireSocket, releaseSocket, statusStream, topicStream, type KannaSocketService } from "../core/socket"
import { Message } from "./message"
import type { Model } from "./model"
import { activeProjectId } from "./update"

// The socket lives while the auth check says the app may load (KannaLayout
// mounted only then). Every snapshot subscription waits for it.

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  socket: entry(Schema.Option(Schema.Null), {
    resource: KannaSocketResource,
    modelToMaybeRequirements: (model) => (model.auth._tag === "Ready" ? Option.some(null) : Option.none()),
    acquire: () => acquireSocket(),
    release: (socket) => Effect.andThen(releaseSocket(socket), forgetAllFollowed()),
    onAcquired: () => Message.AcquiredSocket(),
    onReleased: () => Message.ReleasedSocket(),
    onAcquireError: (error) => Message.FailedAcquireSocket({ error: String(error) }),
  }),
}))

/** A topic's snapshots while the socket is up. */
function whileReady<A>(socketReady: boolean, stream: Stream.Stream<A, never, KannaSocketService>) {
  return Stream.when(stream, Effect.sync(() => socketReady))
}

const ReadyDependency = { socketReady: Schema.Boolean }
const readyFrom = (model: Model) => ({ socketReady: model.socketReady })

const rootSubscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  connectionStatus: entry(ReadyDependency, {
    modelToDependencies: readyFrom,
    dependenciesToStream: ({ socketReady }) =>
      whileReady(socketReady, statusStream.pipe(Stream.map((status) => Message.ChangedConnectionStatus({ status })))),
  }),

  localProjects: entry(ReadyDependency, {
    modelToDependencies: readyFrom,
    dependenciesToStream: ({ socketReady }) =>
      whileReady(socketReady, topicStream<LocalProjectsSnapshot>({ type: "local-projects" }).pipe(
        Stream.map((snapshot) => Message.ReceivedLocalProjects({ snapshot })),
      )),
  }),

  update: entry(ReadyDependency, {
    modelToDependencies: readyFrom,
    dependenciesToStream: ({ socketReady }) =>
      whileReady(socketReady, topicStream<UpdateSnapshot>({ type: "update" }).pipe(
        Stream.map((snapshot) => Message.ReceivedUpdate({ snapshot })),
      )),
  }),

  keybindings: entry(ReadyDependency, {
    modelToDependencies: readyFrom,
    dependenciesToStream: ({ socketReady }) =>
      whileReady(socketReady, topicStream<KeybindingsSnapshot>({ type: "keybindings" }).pipe(
        Stream.map((snapshot) => Message.ReceivedKeybindings({ snapshot })),
      )),
  }),

  appSettings: entry(ReadyDependency, {
    modelToDependencies: readyFrom,
    dependenciesToStream: ({ socketReady }) =>
      whileReady(socketReady, topicStream<AppSettingsSnapshot>({ type: "app-settings" }).pipe(
        Stream.map((snapshot) => Message.ReceivedAppSettings({ snapshot })),
      )),
  }),

  projectGit: entry({ socketReady: Schema.Boolean, projectId: Schema.NullOr(Schema.String) }, {
    modelToDependencies: (model) => ({ socketReady: model.socketReady, projectId: activeProjectId(model) }),
    dependenciesToStream: ({ socketReady, projectId }) =>
      whileReady(socketReady && projectId !== null, topicStream<ChatDiffSnapshot | null>({ type: "project-git", projectId: projectId ?? "" }).pipe(
        Stream.map((snapshot) => Message.ReceivedProjectGit({ projectId: projectId ?? "", snapshot })),
      )),
  }),

  systemTheme: Subscription.persistentEntry(
    Dom.streamFromMediaQuery({
      query: "(prefers-color-scheme: dark)",
      mapMatches: (matches) => Message.ChangedSystemTheme({ theme: matches ? "dark" : "light" }),
    }),
  ),
}))

// The page's chat: its subscription waits for the socket too.
const chatSubscriptions = Subscription.lift(ChatSession.subscriptions)<Model, Message>({
  read: (model) => Option.fromNullishOr(model.chat),
  toParentMessage: (message) => Message.GotChatMessage({ message }),
  when: { chat: (model) => model.socketReady },
})

// The stores': the sidebar and provider-auth topics wait for the socket,
// the Mac app's fleet listener doesn't.
const storeSocketSubscriptions = Subscription.lift(Stores.socketSubscriptions)<Model, Message>({
  read: (model) => Option.some(model.stores),
  toParentMessage: (message) => Message.GotStoresMessage({ message }),
  when: (model) => model.socketReady,
})
const storeBrowserSubscriptions = Subscription.lift(Stores.browserSubscriptions)<Model, Message>({
  read: (model) => Option.some(model.stores),
  toParentMessage: (message) => Message.GotStoresMessage({ message }),
})

// The slices' (app/slice.ts), once the socket is up.
const sidebarSubscriptions = Subscription.lift(SidebarSlice.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.sidebar),
  toParentMessage: (message) => Message.GotSidebarMessage({ message: message as SidebarSlice.Message }),
  when: (model) => model.socketReady,
})
const homeSubscriptions = Subscription.lift(HomeSlice.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.home),
  toParentMessage: (message) => Message.GotHomeMessage({ message: message as HomeSlice.Message }),
  when: (model) => model.socketReady,
})
const settingsSubscriptions = Subscription.lift(SettingsSlice.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.settings),
  toParentMessage: (message) => Message.GotSettingsMessage({ message: message as SettingsSlice.Message }),
  when: (model) => model.socketReady,
})
const chatPageSubscriptions = Subscription.lift(ChatPageSlice.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.chatPage),
  toParentMessage: (message) => Message.GotChatPageMessage({ message: message as ChatPageSlice.Message }),
  when: (model) => model.socketReady,
})
const paletteSubscriptions = Subscription.lift(PaletteSlice.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.palette),
  toParentMessage: (message) => Message.GotPaletteMessage({ message: message as PaletteSlice.Message }),
  when: (model) => model.socketReady,
})
const setupSubscriptions = Subscription.lift(SetupSlice.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.setup),
  toParentMessage: (message) => Message.GotSetupMessage({ message: message as SetupSlice.Message }),
  when: (model) => model.socketReady,
})
const workflowsSubscriptions = Subscription.lift(WorkflowsSlice.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.workflows),
  toParentMessage: (message) => Message.GotWorkflowsMessage({ message: message as WorkflowsSlice.Message }),
  when: (model) => model.socketReady,
})
const terminalPageSubscriptions = Subscription.lift(TerminalPageSlice.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.terminalPage),
  toParentMessage: (message) => Message.GotTerminalPageMessage({ message: message as TerminalPageSlice.Message }),
  when: (model) => model.socketReady,
})

export const subscriptions = Subscription.aggregate(
  rootSubscriptions,
  chatSubscriptions,
  storeSocketSubscriptions,
  storeBrowserSubscriptions,
  sidebarSubscriptions,
  homeSubscriptions,
  settingsSubscriptions,
  chatPageSubscriptions,
  paletteSubscriptions,
  setupSubscriptions,
  workflowsSubscriptions,
  terminalPageSubscriptions,
)
