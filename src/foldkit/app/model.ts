import { Effect, Schema } from "effect"
import type {
  AppSettingsSnapshot,
  ChatDiffSnapshot,
  KeybindingsSnapshot,
  LlmProviderSnapshot,
  LocalProjectsSnapshot,
  UpdateSnapshot,
} from "../../shared/types"
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "../../client/lib/storageKeys"
import { opaque } from "../core/schema"
import { currentHref, isMemoryHistory } from "../core/navigation"
import { readStorageItem } from "../core/storage"
import * as ChatSession from "../core/chatSession"
import { AppRoute } from "./route"
import * as SidebarSlice from "../sidebar"
import * as HomeSlice from "../home"
import * as SettingsSlice from "../settings"
import * as ChatPageSlice from "../chat"
import * as PaletteSlice from "../palette"
import * as SetupSlice from "../setup"
import * as WorkflowsSlice from "../workflows"
import * as TerminalPageSlice from "../terminal"
import * as AppDialog from "../ui/app-dialog"
import * as ShareDialog from "../chat/shareDialog"
import * as OpenRouterCallback from "./openRouterCallback"
import { ActionsModel } from "./actions"
import * as Stores from "./stores"

// The root Model: what useKannaState and App.tsx held for the whole app.
// Pages and panels are Submodels below it; this is the state they share.

export const AuthState = Schema.Union([
  Schema.TaggedStruct("Checking", {}),
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Locked", { error: Schema.NullOr(Schema.String), password: Schema.String, submitting: Schema.Boolean }),
])
export type AuthState = typeof AuthState.Type

export const ConnectionStatus = Schema.Literals(["connecting", "connected", "disconnected"])
export type ConnectionStatus = typeof ConnectionStatus.Type

/** A running chat followed in the background, or one let go of after its grace. */
export const BackgroundChatState = Schema.Literals(["following", "dropping"])

export const Model = Schema.Struct({
  route: AppRoute,
  auth: AuthState,
  /** True between the socket's onAcquired and onReleased. */
  socketReady: Schema.Boolean,
  connectionStatus: ConnectionStatus,
  localProjects: Schema.NullOr(opaque<LocalProjectsSnapshot>("LocalProjectsSnapshot")),
  localProjectsReady: Schema.Boolean,
  updateSnapshot: Schema.NullOr(opaque<UpdateSnapshot>("UpdateSnapshot")),
  keybindings: Schema.NullOr(opaque<KeybindingsSnapshot>("KeybindingsSnapshot")),
  llmProvider: Schema.NullOr(opaque<LlmProviderSnapshot>("LlmProviderSnapshot")),
  /** Diffs per project, kept as useKannaState's projectDiffSnapshots. */
  projectDiffs: Schema.Record(Schema.String, Schema.NullOr(opaque<ChatDiffSnapshot>("ChatDiffSnapshot"))),
  selectedProjectId: Schema.NullOr(Schema.String),
  sidebarCollapsed: Schema.Boolean,
  commandError: Schema.NullOr(Schema.String),
  backgroundChats: Schema.Record(Schema.String, BackgroundChatState),
  /** System theme while the preference is "system" (prefers-color-scheme). */
  systemTheme: Schema.Literals(["light", "dark"]),
  /** The page's chat, live (useKannaState's chat half). Null off a chat route. */
  chat: Schema.NullOr(ChatSession.Model),
  /**
   * When the last read position went out, carried from one chat's session to
   * the next: useChatReadAnchor's throttle (`lastWriteAtRef`) lived as long
   * as the app, not the chat. Unset until a session closes.
   */
  readAnchorLastWriteAt: Schema.optional(Schema.Number),
  /** Every client store: sidebar, app settings, drafts, layouts, preferences. */
  stores: Stores.Model,
  /** What the root's actions keep: chats being started, the share and app dialogs. */
  actions: ActionsModel,
  /** Started the one-time legacy browser settings migration this session. */
  legacySettingsMigrationStarted: Schema.Boolean,
  /** pagehide puts the bare app name in the title, for the bfcache; pageshow brings it back. */
  pageHidden: Schema.Boolean,
  /**
   * A chat left for another chat, marked read once the next chat page's
   * effects have run (`changeRoute`).
   */
  pendingMarkRead: Schema.NullOr(Schema.String),
  /**
   * The draft ids as draft protection last looked (useKannaState's effect
   * dependencies): text drafts and attachment drafts, sorted.
   */
  draftIdsSeen: Schema.Struct({ drafts: Schema.Array(Schema.String), attachments: Schema.Array(Schema.String) }),
  /** /oauth/openrouter/callback, outside the layout. */
  openRouterCallback: OpenRouterCallback.Model,
  /** StandaloneShareDialog: open while `actions.standaloneShareUrl` is set. */
  shareDialog: ShareDialog.Model,
  /** The app's confirm/prompt/alert dialog (React's AppDialogProvider). */
  appDialog: AppDialog.Model,
  // The slices (app/slice.ts): each a Submodel in its own folder.
  sidebar: SidebarSlice.Model,
  home: HomeSlice.Model,
  settings: SettingsSlice.Model,
  chatPage: ChatPageSlice.Model,
  palette: PaletteSlice.Model,
  setup: SetupSlice.Model,
  workflows: WorkflowsSlice.Model,
  terminalPage: TerminalPageSlice.Model,
})
export type Model = typeof Model.Type

// FLAGS: what the browser held before the app started.

export const Flags = Schema.Struct({
  sidebarCollapsed: Schema.Boolean,
  systemTheme: Schema.Literals(["light", "dark"]),
  /** Seeded by the demo and the parity fixture, as their React entries seed the store. */
  initialAppSettings: Schema.NullOr(opaque<AppSettingsSnapshot>("AppSettingsSnapshot")),
  stores: Stores.Model,
  /** The demo's memory history (core/navigation.ts): where it starts, in place of the frame's own address. */
  memoryUrl: Schema.optional(Schema.NullOr(Schema.String)),
})
export type Flags = typeof Flags.Type

export function readFlags(options: { initialAppSettings?: AppSettingsSnapshot | null } = {}): Effect.Effect<Flags> {
  return Effect.sync(() => ({
    // Remembered in this browser: collapsing the sidebar is how a window is
    // arranged, and a reload should not put it back.
    sidebarCollapsed: readStorageItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1",
    systemTheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" as const : "light" as const,
    initialAppSettings: options.initialAppSettings ?? null,
    stores: Stores.load(),
    memoryUrl: isMemoryHistory() ? currentHref() : null,
  }))
}
