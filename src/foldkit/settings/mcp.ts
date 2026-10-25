import { Duration, Effect, Schema, Stream } from "effect"
import { Command, Submodel, Subscription } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { MCP_PROVIDERS, type McpConnectResult, type McpProvider, type McpServerInput, type McpServerSummary, type McpSnapshot } from "../../shared/mcp"
import { opaque } from "../core/schema"
import { errorMessage, sendCommand, type KannaSocketService } from "../core/socket"
import { button } from "../ui/button"
import { ExternalLink, Plus, RefreshCw, Trash2 } from "../ui/icons"
import { input } from "../ui/input"
import * as Select from "../ui/select"
import { switchControl } from "../ui/switch"
import { textarea } from "../ui/textarea"
import { makeSectionMount } from "./activeSection"
import { liftChild, sectionLabel, sectionSubtitle, type AppModel, type SectionReturn, type SectionViewInputs } from "./section"
import {
  sectionContainer,
  settingsActionButton,
  settingsBadge,
  settingsGroup,
  settingsGroups,
  settingsNotice,
  settingsPlaceholder,
  settingsRow,
  settingsSelect,
} from "./shared"

// Settings › MCP Servers (app/settings/McpSection.tsx).

const LABELS: Record<McpProvider, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", pi: "Pi" }
const STATUS = { unconnected: "Not tested", connected: "Connected", needsAuth: "Sign-in required", error: "Connection failed" }
const TRANSPORT_OPTIONS = [
  { value: "http", label: "Remote HTTP" },
  { value: "sse", label: "Remote SSE" },
  { value: "stdio", label: "Local command" },
]
const empty = (): McpServerInput => ({ name: "", transport: "http", url: "", providers: [...MCP_PROVIDERS] })
const inputOf = (server: McpServerSummary): McpServerInput => ({
  id: server.id, name: server.name, transport: server.transport, command: server.command,
  url: server.url, providers: [...server.providers], projectPath: server.projectPath, clientId: server.clientId,
})
const ADVANCED_KEYS = ["args", "env", "headers", "clientId", "clientSecret"]

// MODEL

const Snapshot = opaque<McpSnapshot>("McpSnapshot")
const ServerInput = opaque<McpServerInput>("McpServerInput")

export const Model = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  error: Schema.NullOr(Schema.String),
  busy: Schema.Boolean,
  draft: Schema.NullOr(ServerInput),
  advanced: Schema.String,
  importing: Schema.Boolean,
  importContent: Schema.String,
  /** Servers waiting on a browser sign-in, with the URL to continue it. */
  authorization: Schema.Record(Schema.String, Schema.String),
  transport: Select.Model,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    snapshot: null,
    error: null,
    busy: false,
    draft: null,
    advanced: "{}",
    importing: false,
    importContent: "",
    authorization: {},
    transport: Select.init({ id: "settings-mcp-transport" }),
  }
}

// OPERATIONS: each was one `perform(...)` in React: busy while it runs, its
// failure the section's error.

const Operation = Schema.Union([
  Schema.TaggedStruct("Refresh", {}),
  Schema.TaggedStruct("Save", { server: ServerInput, closeDraft: Schema.Boolean }),
  Schema.TaggedStruct("ImportProvider", { provider: Schema.Literals(["claude", "codex", "cursor"]) }),
  Schema.TaggedStruct("ImportConfig", { content: Schema.String }),
  Schema.TaggedStruct("Connect", { id: Schema.String }),
  Schema.TaggedStruct("Remove", { id: Schema.String }),
  Schema.TaggedStruct("Disconnect", { id: Schema.String }),
])
type Operation = typeof Operation.Type

// MESSAGE

export const Message = defineMessageUnion({
  MountedSection: {},
  UnmountedSection: {},
  SucceededInitialRead: { snapshot: Snapshot },
  FailedInitialRead: {},
  SucceededOperation: { operation: Operation, snapshot: Snapshot, authorizationUrl: Schema.NullOr(Schema.String) },
  FailedOperation: { error: Schema.String },
  ReceivedPolledSnapshot: { snapshot: Snapshot },
  FailedPoll: {},
  ClickedAddServer: {},
  ClickedImportConfiguration: {},
  ClickedRefresh: {},
  ClickedEditServer: { id: Schema.String },
  ChangedDraft: { draft: ServerInput },
  ChangedAdvanced: { value: Schema.String },
  SubmittedDraft: {},
  ClickedCancelDraft: {},
  ClickedImportProvider: { provider: Schema.Literals(["claude", "codex", "cursor"]) },
  ChangedImportContent: { value: Schema.String },
  ClickedImportServers: {},
  ClickedCancelImport: {},
  ClickedConnect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  ToggledProvider: { id: Schema.String, provider: Schema.Literals(MCP_PROVIDERS), enabled: Schema.Boolean },
  ClickedSignOut: { id: Schema.String },
  GotTransportMessage: { message: Select.Message },
})
export type Message = typeof Message.Type

type Return = SectionReturn<Model, Message>

const readSnapshot = sendCommand<McpSnapshot>({ type: "mcp.read" })

const InitialRead = Command.define("ReadMcpServers", {
  messages: [Message.SucceededInitialRead, Message.FailedInitialRead],
  execute: readSnapshot.pipe(
    Effect.map((snapshot) => Message.SucceededInitialRead({ snapshot })),
    Effect.catch(() => Effect.succeed(Message.FailedInitialRead())),
  ),
})

const Perform = Command.define("PerformMcpOperation", {
  args: { operation: Operation },
  messages: [Message.SucceededOperation, Message.FailedOperation],
  execute: ({ operation }) => Effect.gen(function* () {
    let authorizationUrl: string | null = null
    let snapshot: McpSnapshot
    switch (operation._tag) {
      case "Refresh":
        snapshot = yield* readSnapshot
        break
      case "Save":
        snapshot = yield* sendCommand<McpSnapshot>({ type: "mcp.save", server: operation.server })
        break
      case "ImportProvider":
        snapshot = yield* sendCommand<McpSnapshot>({ type: "mcp.importProvider", provider: operation.provider })
        break
      case "ImportConfig":
        snapshot = yield* sendCommand<McpSnapshot>({ type: "mcp.importConfig", content: operation.content, providers: [...MCP_PROVIDERS] })
        break
      case "Connect": {
        const result = yield* sendCommand<McpConnectResult>({ type: "mcp.connect", id: operation.id })
        authorizationUrl = result.authorizationUrl ?? null
        snapshot = yield* readSnapshot
        break
      }
      case "Remove":
        snapshot = yield* sendCommand<McpSnapshot>({ type: "mcp.remove", id: operation.id })
        break
      case "Disconnect":
        snapshot = yield* sendCommand<McpSnapshot>({ type: "mcp.disconnect", id: operation.id })
        break
    }
    return Message.SucceededOperation({ operation, snapshot, authorizationUrl })
  }).pipe(
    Effect.catch((error) => Effect.succeed(Message.FailedOperation({ error: errorMessage(error) || "Unable to update MCP servers." }))),
  ),
})

// UPDATE

function perform(model: Model, operation: Operation): Return {
  return { model: { ...model, busy: true, error: null }, commands: [Perform({ operation })] }
}

/** `load`: the snapshot, and sign-ins only for servers that still need one. */
function withSnapshot(model: Model, snapshot: McpSnapshot, authorization = model.authorization): Model {
  return {
    ...model,
    snapshot,
    authorization: Object.fromEntries(Object.entries(authorization).filter(([id]) =>
      snapshot.servers.some((server) => server.id === id && server.status === "needsAuth"))),
  }
}

function edit(model: Model, server?: McpServerSummary): Model {
  return { ...model, error: null, importing: false, draft: server ? inputOf(server) : empty(), advanced: "{}" }
}

function findServer(model: Model, id: string) {
  return model.snapshot?.servers.find((server) => server.id === id)
}

export function update(model: Model, message: Message, _app: AppModel): Return {
  return Message.match<Return>(message, {
    MountedSection: () => ({ model, commands: [InitialRead()] }),
    UnmountedSection: () => ({ model: init() }),
    SucceededInitialRead: ({ snapshot }) => ({ model: { ...model, snapshot } }),
    FailedInitialRead: () => ({ model: { ...model, error: "Unable to load MCP servers." } }),
    SucceededOperation: ({ operation, snapshot, authorizationUrl }) => {
      const done = { ...model, busy: false }
      switch (operation._tag) {
        case "Refresh":
          return { model: withSnapshot(done, snapshot) }
        case "Save":
          return { model: { ...done, snapshot, draft: operation.closeDraft ? null : done.draft } }
        case "ImportProvider":
          return { model: { ...done, snapshot, importing: false } }
        case "ImportConfig":
          return { model: { ...done, snapshot, importing: false, importContent: "" } }
        case "Connect":
          return {
            model: withSnapshot(done, snapshot, authorizationUrl ? { ...done.authorization, [operation.id]: authorizationUrl } : done.authorization),
          }
        case "Remove":
        case "Disconnect":
          return { model: { ...done, snapshot } }
      }
    },
    FailedOperation: ({ error }) => ({ model: { ...model, busy: false, error } }),
    ReceivedPolledSnapshot: ({ snapshot }) => ({ model: withSnapshot(model, snapshot) }),
    FailedPoll: () => ({ model }),
    ClickedAddServer: () => ({ model: edit(model) }),
    ClickedImportConfiguration: () => ({ model: { ...model, draft: null, importing: !model.importing } }),
    ClickedRefresh: () => perform(model, { _tag: "Refresh" }),
    ClickedEditServer: ({ id }) => {
      const server = findServer(model, id)
      return server ? { model: edit(model, server) } : { model }
    },
    ChangedDraft: ({ draft }) => ({ model: { ...model, draft } }),
    ChangedAdvanced: ({ value }) => ({ model: { ...model, advanced: value } }),
    SubmittedDraft: () => {
      if (!model.draft) return { model }
      let extra: Record<string, unknown>
      try {
        extra = JSON.parse(model.advanced)
        if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error()
      } catch {
        return { model: { ...model, error: "Advanced settings must be a JSON object." } }
      }
      if (Object.keys(extra).some((key) => !ADVANCED_KEYS.includes(key))) {
        return { model: { ...model, error: `Advanced settings accept: ${ADVANCED_KEYS.join(", ")}.` } }
      }
      return perform(model, { _tag: "Save", server: { ...model.draft, ...extra }, closeDraft: true })
    },
    ClickedCancelDraft: () => ({ model: { ...model, draft: null } }),
    ClickedImportProvider: ({ provider }) => perform(model, { _tag: "ImportProvider", provider }),
    ChangedImportContent: ({ value }) => ({ model: { ...model, importContent: value } }),
    ClickedImportServers: () => perform(model, { _tag: "ImportConfig", content: model.importContent }),
    ClickedCancelImport: () => ({ model: { ...model, importing: false } }),
    ClickedConnect: ({ id }) => perform(model, { _tag: "Connect", id }),
    ClickedRemove: ({ id }) => perform(model, { _tag: "Remove", id }),
    ToggledProvider: ({ id, provider, enabled }) => {
      const server = findServer(model, id)
      if (!server) return { model }
      const providers = enabled ? [...server.providers, provider] : server.providers.filter((value) => value !== provider)
      return perform(model, { _tag: "Save", server: { ...inputOf(server), providers }, closeDraft: false })
    },
    ClickedSignOut: ({ id }) => perform(model, { _tag: "Disconnect", id }),
    GotTransportMessage: ({ message: child }) => {
      const lifted = liftChild(Select.update(model.transport, child), (transport) => ({ ...model, transport }), (selectMessage) => Message.GotTransportMessage({ message: selectMessage }))
      if (!lifted.outMessage || !lifted.model.draft) return { model: lifted.model, commands: lifted.commands }
      return {
        model: { ...lifted.model, draft: { ...lifted.model.draft, transport: lifted.outMessage.value as McpServerInput["transport"] } },
        commands: lifted.commands,
      }
    },
  })
}

// SUBSCRIPTIONS: while a browser sign-in is waiting, re-read every 2s.

export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  signInPoll: entry({ waiting: Schema.Boolean }, {
    modelToDependencies: (model) => ({ waiting: Object.keys(model.authorization).length > 0 }),
    dependenciesToStream: ({ waiting }) => Stream.when(
      Stream.tick(Duration.seconds(2)).pipe(
        Stream.drop(1),
        Stream.mapEffect(() => readSnapshot.pipe(
          Effect.map((snapshot) => Message.ReceivedPolledSnapshot({ snapshot })),
          Effect.catch(() => Effect.succeed(Message.FailedPoll())),
        )),
      ),
      Effect.sync(() => waiting),
    ),
  }),
}))

// VIEW

const renderTransport = (value: string) => [TRANSPORT_OPTIONS.find((option) => option.value === value)?.label ?? value]

function draftForm(model: Model, draft: McpServerInput, h: HtmlBuilder<Message>): Html {
  const change = (patch: Partial<McpServerInput>) => Message.ChangedDraft({ draft: { ...draft, ...patch } })
  return h.form([h.OnSubmit(Message.SubmittedDraft())], [
    settingsGroup({ title: [draft.id ? "Edit server" : "New server"] }, [
      settingsRow({ title: "Name", wideControl: true }, [
        input({ value: draft.name, placeholder: "github", onInput: (name) => change({ name }), attributes: [h.AriaLabel("Server name"), h.Required(true)] }, h),
      ], h),
      settingsRow({
        title: "Connection",
        control: (wrap) => settingsSelect({
          slotId: "transport",
          model: model.transport,
          value: draft.transport,
          items: TRANSPORT_OPTIONS,
          renderItem: renderTransport,
          ariaLabel: "Connection type",
          inForm: true,
          container: wrap,
          toParentMessage: (message) => Message.GotTransportMessage({ message }),
        }, h),
      }, [], h),
      draft.transport === "stdio"
        ? settingsRow({ title: "Command", wideControl: true }, [
          input({ value: draft.command ?? "", placeholder: "npx", onInput: (command) => change({ command }), attributes: [h.AriaLabel("Server command"), h.Required(true)] }, h),
        ], h)
        : settingsRow({ title: "Server URL", wideControl: true }, [
          input({ type: "url", value: draft.url ?? "", placeholder: "https://example.com/mcp", onInput: (url) => change({ url }), attributes: [h.AriaLabel("Server URL"), h.Required(true)] }, h),
        ], h),
      settingsRow({ title: "Project folder", description: ["Leave empty to use this server in every project."], wideControl: true }, [
        input({ value: draft.projectPath ?? "", placeholder: "All projects", onInput: (projectPath) => change({ projectPath: projectPath || undefined }), attributes: [h.AriaLabel("Project folder")] }, h),
      ], h),
      h.div([h.Class("flex flex-col gap-3 px-4 py-3")], [
        h.label([h.For("mcp-advanced"), h.Class("text-sm font-medium")], ["Arguments and authentication"]),
        textarea({
          value: model.advanced,
          rows: 5,
          placeholder: "{\"args\": [\"-y\", \"my-mcp-server\"], \"env\": {\"API_KEY\": \"…\"}}",
          onInput: (value) => Message.ChangedAdvanced({ value }),
          attributes: [h.Id("mcp-advanced"), h.Spellcheck(false)],
        }, h),
        h.p([h.Class("text-xs text-muted-foreground")], ["Optional JSON: args, env, headers, clientId, clientSecret. Existing arguments and credentials are retained unless you replace them or change the connection target. Sign in to OAuth servers after saving."]),
        h.div([h.Class("flex gap-2")], [
          button({ type: "submit", size: "sm", disabled: model.busy }, ["Save server"], h),
          button({ type: "button", variant: "ghost", size: "sm", disabled: model.busy, attributes: [h.OnClick(Message.ClickedCancelDraft())] }, ["Cancel"], h),
        ]),
      ]),
    ], h),
  ])
}

function importPanel(model: Model, h: HtmlBuilder<Message>): Html {
  return settingsGroup({ title: ["Import into Kanna"] }, [
    h.div([h.Class("flex flex-col gap-3 px-4 py-4")], [
      h.p([h.Class("text-sm text-muted-foreground")], ["Import server definitions, then sign in once in Kanna. Original provider files stay unchanged; existing provider OAuth logins cannot be transferred."]),
      h.div([h.Class("flex flex-wrap gap-2")], (["claude", "codex", "cursor"] as const).map((provider) =>
        button({ variant: "secondary", size: "sm", disabled: model.busy, attributes: [h.OnClick(Message.ClickedImportProvider({ provider }))] }, [`Import from ${LABELS[provider]}`], h))),
      h.label([h.For("mcp-import"), h.Class("text-sm font-medium")], ["Or paste JSON / TOML configuration"]),
      textarea({
        value: model.importContent,
        rows: 7,
        placeholder: "{\"mcpServers\": {\"example\": {\"url\": \"https://example.com/mcp\"}}}",
        onInput: (value) => Message.ChangedImportContent({ value }),
        attributes: [h.Id("mcp-import"), h.Spellcheck(false)],
      }, h),
      h.div([h.Class("flex gap-2")], [
        button({ size: "sm", disabled: model.busy || !model.importContent.trim(), attributes: [h.OnClick(Message.ClickedImportServers())] }, ["Import servers"], h),
        button({ size: "sm", variant: "ghost", disabled: model.busy, attributes: [h.OnClick(Message.ClickedCancelImport())] }, ["Cancel"], h),
      ]),
    ]),
  ], h)
}

function serverGroup(model: Model, server: McpServerSummary, h: HtmlBuilder<Message>): Html {
  const authorizationUrl = model.authorization[server.id]
  return settingsGroup({
    key: server.id,
    title: [server.name],
    trailing: settingsBadge({}, [STATUS[server.status], server.toolCount === undefined ? "" : ` · ${server.toolCount} tools`], h),
  }, [
    settingsRow({
      title: server.transport === "stdio" ? "Local command" : "Remote server",
      description: [h.span([h.Class("break-all")], [
        (server.transport === "stdio" ? server.command : server.url) ?? "",
        h.br([]),
        server.message ?? (server.projectPath ? `Project: ${server.projectPath}` : "All projects"),
      ])],
      wideControl: true,
    }, [
      h.div([h.Class("flex flex-wrap items-center gap-3")], [
        authorizationUrl
          ? h.a([h.Class("inline-flex items-center gap-1 text-sm underline underline-offset-2"), h.Href(authorizationUrl), h.Target("_blank"), h.Rel("noopener noreferrer")], [
            "Continue sign-in",
            ExternalLink({ class: "size-3" }, h),
          ])
          : settingsActionButton({ disabled: model.busy, onClick: Message.ClickedConnect({ id: server.id }) }, [server.status === "needsAuth" ? "Sign in" : "Test connection"], h),
        settingsActionButton({ disabled: model.busy, onClick: Message.ClickedEditServer({ id: server.id }) }, ["Edit"], h),
        button({
          variant: "ghost",
          size: "icon",
          disabled: model.busy,
          attributes: [h.AriaLabel(`Remove ${server.name}`), h.OnClick(Message.ClickedRemove({ id: server.id }))],
        }, [Trash2({ attributes: [h.DataAttribute("icon", "inline-start")] }, h)], h),
      ]),
    ], h),
    ...MCP_PROVIDERS.map((provider) => settingsRow({
      key: provider,
      title: LABELS[provider],
      description: [`Use ${server.name} in ${LABELS[provider]} chats.`],
    }, [
      switchControl({
        checked: server.providers.includes(provider),
        disabled: model.busy,
        onCheckedChange: (enabled) => Message.ToggledProvider({ id: server.id, provider, enabled }),
        ariaLabel: `Use ${server.name} in ${LABELS[provider]}`,
      }, h),
    ], h)),
    settingsRow({ title: "Kanna sign-in", description: ["Shared by all enabled providers."] }, [
      settingsActionButton({ disabled: model.busy, onClick: Message.ClickedSignOut({ id: server.id }) }, ["Sign out"], h),
    ], h),
  ], h)
}

const SectionMount = makeSectionMount("SettingsMcpSection", Message.MountedSection, () => Message.MountedSection())

export const view = Submodel.defineView<Model, Message, SectionViewInputs>((model, { switched }, h) =>
  sectionContainer({
    sectionId: "mcp",
    switched,
    mount: SectionMount(),
    unmounted: Message.UnmountedSection(),
    label: sectionLabel("mcp"),
    subtitle: sectionSubtitle("mcp"),
  }, [
    h.div([h.Class("flex flex-col gap-6")], [
      model.error ? settingsNotice({}, [model.error], h) : null,
      h.div([h.Class("flex flex-wrap items-center gap-4 px-4")], [
        settingsActionButton({ disabled: model.busy, icon: Plus({}, h), onClick: Message.ClickedAddServer() }, ["Add server"], h),
        settingsActionButton({ disabled: model.busy, onClick: Message.ClickedImportConfiguration() }, ["Import configuration"], h),
        settingsActionButton({ disabled: model.busy, icon: RefreshCw({}, h), onClick: Message.ClickedRefresh() }, ["Refresh"], h),
      ]),
      model.draft ? draftForm(model, model.draft, h) : null,
      model.importing ? importPanel(model, h) : null,
      !model.snapshot
        ? settingsPlaceholder({ loading: true }, ["Loading MCP servers…"], h)
        : model.snapshot.servers.length === 0
          ? settingsPlaceholder({}, ["Add a remote server URL or a local command. Sign in once and use its tools across providers."], h)
          : settingsGroups(model.snapshot.servers.map((server) => serverGroup(model, server, h)), h),
      h.p([h.Class("px-4 text-xs leading-5 text-muted-foreground")], ["Provider changes apply with the next message. Grok does not yet support Kanna-managed MCPs. Provider-native servers remain available through their existing configurations."]),
    ]),
  ], h))
