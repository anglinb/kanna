// The chat page's terminal workspace without the chat page around it, as
// gallery/terminal-workspace.tsx shows it on the React side: src/foldkit/terminal
// embedded as the chat page embeds it (its `page` context), for one
// project's shells, on the demo's fake shell. The root's part is played
// here: an app Model to read, the socket, and the layout store changes the
// slice asks for.
import { Effect, Option, Schema, Stream } from "effect"
import { Command, ManagedResource, Runtime, Subscription, type Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { fromString } from "foldkit/url"
import { createDemoAppSettings } from "../../../demo/backend"
import { readThemeParam } from "../../../demo/environment"
import { type Flags, Model as AppModel } from "../../../foldkit/app/model"
import * as Stores from "../../../foldkit/app/stores"
import { init as initApp } from "../../../foldkit/app/update"
import { acquireSocket, KannaSocketResource, type KannaSocketService, releaseSocket, statusStream } from "../../../foldkit/core/socket"
import * as TerminalLayout from "../../../foldkit/core/stores/terminalLayout"
import * as Terminal from "../../../foldkit/terminal"
import type { GalleryPage } from "../gallery-page"

const PROJECT_ID = "demo-project-tidepool"

const Model = Schema.Struct({ app: AppModel, terminal: Terminal.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotTerminalMessage: { message: Terminal.Message },
  GotStoresMessage: { message: Stores.Message },
  AcquiredSocket: {},
  ReleasedSocket: {},
  FailedAcquireSocket: { error: Schema.String },
  ChangedConnectionStatus: { status: Schema.Literals(["connecting", "connected", "disconnected"]) },
})
type Message = typeof Message.Type

type Return = Update.Return<Model, Message, KannaSocketService>

function bootApp(): Model["app"] {
  const flags: Flags = {
    sidebarCollapsed: false,
    systemTheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    initialAppSettings: createDemoAppSettings(readThemeParam()),
    stores: Stores.load(),
  }
  return initApp(flags, Option.getOrThrow(fromString(window.location.href))).model
}

/** The chat page's toggle adds the first pane; here the page does, as the React page's effect. */
function seedPane(model: Model): Return {
  if ((model.app.stores.terminalLayout.projects[PROJECT_ID]?.terminals.length ?? 0) > 0) return { model }
  const nextTerminalIndex = model.app.stores.terminalLayout.projects[PROJECT_ID]?.nextTerminalIndex ?? 0
  return {
    model,
    commands: [Command.mapMessage(
      TerminalLayout.AddTerminal({ projectId: PROJECT_ID, afterTerminalId: null, chatKey: null, nextTerminalIndex }),
      (message) => Message.GotStoresMessage({ message: Stores.Message.GotTerminalLayoutMessage({ message }) }),
    )],
  }
}

function applyStores(model: Model, message: Stores.Message): Return {
  const next = Stores.update(model.app.stores, message)
  const app = { ...model.app, stores: next.model }
  return {
    model: { ...model, app },
    commands: Command.mapMessages(next.commands ?? [], (child: Stores.Message) => Message.GotStoresMessage({ message: child })),
  }
}

function update(model: Model, message: Message): Return {
  return Message.match<Return>(message, {
    GotTerminalMessage: ({ message: child }) => {
      const next = Terminal.update(model.terminal, child, model.app)
      const commands = Command.mapMessages(next.commands ?? [], (inner: Terminal.Message) => Message.GotTerminalMessage({ message: inner }))
      const stepped: Model = { ...model, terminal: next.model }
      const action = next.outMessage?.action
      if (action?._tag !== "Store") return { model: stepped, commands }
      const stored = applyStores(stepped, action.message)
      return { model: stored.model, commands: [...commands, ...(stored.commands ?? [])] }
    },
    GotStoresMessage: ({ message: child }) => applyStores(model, child),
    AcquiredSocket: () => ({ model: { ...model, app: { ...model.app, socketReady: true } } }),
    ReleasedSocket: () => ({ model: { ...model, app: { ...model.app, socketReady: false } } }),
    FailedAcquireSocket: () => ({ model }),
    ChangedConnectionStatus: ({ status }) => ({ model: { ...model, app: { ...model.app, connectionStatus: status } } }),
  })
}

function view(model: Model, h: HtmlBuilder<Message>): Document {
  const { app } = model
  const layout = app.stores.terminalLayout.projects[PROJECT_ID] ?? null
  const hasTerminals = (layout?.terminals.length ?? 0) > 0
  const shown = layout ? TerminalLayout.isTerminalVisible(layout, null) : false
  return {
    title: "Kanna",
    body: h.div([h.Class("flex min-h-dvh flex-col bg-background text-foreground")], [
      h.p([h.Class("px-4 py-2 text-sm")], [shown ? "Panel shown" : "Panel hidden"]),
      h.div([h.Class("h-[420px] min-h-0 overflow-hidden relative border-t border-border"), h.DataAttribute("terminal-visual", "true")], [
        layout && hasTerminals && app.connectionStatus === "connected"
          ? h.submodel({
            slotId: "terminal",
            model: model.terminal,
            view: Terminal.view,
            viewInputs: {
              app,
              page: { projectId: PROJECT_ID, terminal: { focusRequestVersion: 0, pendingCommandsByTerminalId: {}, chatKey: null } },
            },
            toParentMessage: (message: Terminal.Message) => Message.GotTerminalMessage({ message }),
          })
          : null,
      ]),
    ]),
  }
}

const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  socket: entry(Schema.Option(Schema.Null), {
    resource: KannaSocketResource,
    modelToMaybeRequirements: () => Option.some(null),
    acquire: () => acquireSocket(`ws://${window.location.host}/ws`),
    release: (socket) => releaseSocket(socket),
    onAcquired: () => Message.AcquiredSocket(),
    onReleased: () => Message.ReleasedSocket(),
    onAcquireError: (error) => Message.FailedAcquireSocket({ error: String(error) }),
  }),
}))

const subscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  connectionStatus: entry({ socketReady: Schema.Boolean }, {
    modelToDependencies: (model) => ({ socketReady: model.app.socketReady }),
    dependenciesToStream: ({ socketReady }) =>
      Stream.when(statusStream.pipe(Stream.map((status) => Message.ChangedConnectionStatus({ status }))), Effect.sync(() => socketReady)),
  }),
}))

const page: GalleryPage = {
  run(container) {
    Runtime.run(Runtime.makeApplication({
      Model,
      init: () => seedPane({ app: bootApp(), terminal: Terminal.init() }),
      update,
      view,
      subscriptions,
      managedResources,
      container,
    }))
  },
}

export default page
