import { Effect, Schema } from "effect"
import type {
  AppSettingsSnapshot,
  ChatDiffSnapshot,
  KeybindingsSnapshot,
  LlmProviderSnapshot,
  LocalProjectsSnapshot,
  ProviderAuthSnapshot,
  SidebarData,
  UpdateSnapshot,
} from "../../shared/types"
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "../../client/lib/storageKeys"
import { opaque } from "../core/schema"
import { readStorageItem } from "../core/storage"
import * as ChatSession from "../core/chatSession"
import * as Delegate from "../core/stores/delegate"
import { AppRoute } from "./route"

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

/**
 * The sidebar snapshot as the client holds it. `held` is the server's last
 * snapshot exactly as sent, which patches apply to (shared/sidebar-patch.ts);
 * `data` is what is drawn. A patch that doesn't start from `held` means the
 * two fell out of step, and `epoch` moves to resubscribe from scratch.
 */
export const SidebarState = Schema.Struct({
  ready: Schema.Boolean,
  data: opaque<SidebarData>("SidebarData"),
  heldRevision: Schema.NullOr(Schema.Number),
  epoch: Schema.Number,
  /** A drag's order, shown until the server's snapshot carries it. */
  optimisticProjectOrder: Schema.NullOr(Schema.Array(Schema.String)),
})
export type SidebarState = typeof SidebarState.Type

export const EMPTY_SIDEBAR_DATA: SidebarData = { projectGroups: [] } as unknown as SidebarData

/** A running chat followed in the background, or one let go of after its grace. */
export const BackgroundChatState = Schema.Literals(["following", "dropping"])

export const Model = Schema.Struct({
  route: AppRoute,
  auth: AuthState,
  /** True between the socket's onAcquired and onReleased. */
  socketReady: Schema.Boolean,
  connectionStatus: ConnectionStatus,
  sidebar: SidebarState,
  localProjects: Schema.NullOr(opaque<LocalProjectsSnapshot>("LocalProjectsSnapshot")),
  localProjectsReady: Schema.Boolean,
  updateSnapshot: Schema.NullOr(opaque<UpdateSnapshot>("UpdateSnapshot")),
  keybindings: Schema.NullOr(opaque<KeybindingsSnapshot>("KeybindingsSnapshot")),
  appSettings: Schema.NullOr(opaque<AppSettingsSnapshot>("AppSettingsSnapshot")),
  llmProvider: Schema.NullOr(opaque<LlmProviderSnapshot>("LlmProviderSnapshot")),
  providerAuth: Schema.NullOr(opaque<ProviderAuthSnapshot>("ProviderAuthSnapshot")),
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
  delegate: Delegate.Model,
})
export type Model = typeof Model.Type

// FLAGS: what the browser held before the app started.

export const Flags = Schema.Struct({
  sidebarCollapsed: Schema.Boolean,
  systemTheme: Schema.Literals(["light", "dark"]),
  /** Seeded by the demo and the parity fixture, as their React entries seed the store. */
  initialAppSettings: Schema.NullOr(opaque<AppSettingsSnapshot>("AppSettingsSnapshot")),
  delegate: Delegate.Model,
})
export type Flags = typeof Flags.Type

export function readFlags(options: { initialAppSettings?: AppSettingsSnapshot | null } = {}): Effect.Effect<Flags> {
  return Effect.sync(() => ({
    // Remembered in this browser: collapsing the sidebar is how a window is
    // arranged, and a reload should not put it back.
    sidebarCollapsed: readStorageItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1",
    systemTheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" as const : "light" as const,
    initialAppSettings: options.initialAppSettings ?? null,
    delegate: Delegate.load(),
  }))
}
