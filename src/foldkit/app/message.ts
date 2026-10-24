import { Schema } from "effect"
import { Navigation } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { Url } from "foldkit/url"
import type { SidebarPatch } from "../../shared/sidebar-patch"
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
import { opaque } from "../core/schema"
import * as Delegate from "../core/stores/delegate"
import { ConnectionStatus } from "./model"

export const Message = defineMessageUnion({
  // Routing
  ClickedLink: { request: Navigation.UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigation: {},

  // Auth (App.tsx useAppAuthState)
  ReceivedAuthStatus: { enabled: Schema.Boolean, authenticated: Schema.Boolean },
  FailedAuthStatus: {},
  ElapsedAuthRetry: {},
  ChangedPassword: { value: Schema.String },
  SubmittedPassword: {},
  SucceededLogin: {},
  FailedLogin: {},

  // The socket and its status
  AcquiredSocket: {},
  ReleasedSocket: {},
  FailedAcquireSocket: { error: Schema.String },
  ChangedConnectionStatus: { status: ConnectionStatus },

  // Snapshots
  ReceivedSidebar: { snapshot: opaque<SidebarData | SidebarPatch>("SidebarSnapshot") },
  ReceivedLocalProjects: { snapshot: opaque<LocalProjectsSnapshot>("LocalProjectsSnapshot") },
  ReceivedUpdate: { snapshot: opaque<UpdateSnapshot>("UpdateSnapshot") },
  ReceivedKeybindings: { snapshot: opaque<KeybindingsSnapshot>("KeybindingsSnapshot") },
  ReceivedAppSettings: { snapshot: opaque<AppSettingsSnapshot>("AppSettingsSnapshot") },
  ReceivedProviderAuth: { snapshot: opaque<ProviderAuthSnapshot>("ProviderAuthSnapshot") },
  ReceivedProjectGit: { projectId: Schema.String, snapshot: Schema.NullOr(opaque<ChatDiffSnapshot>("ChatDiffSnapshot")) },

  // Command results
  /** A command whose ack changes nothing here: its effect arrives on a snapshot. */
  CompletedCommand: {},
  /** Any command's failure, shown as the app's command error. */
  FailedCommand: { message: Schema.String },
  SucceededReadAppSettings: { snapshot: opaque<AppSettingsSnapshot>("AppSettingsSnapshot") },
  SucceededReadLlmProvider: { snapshot: opaque<LlmProviderSnapshot>("LlmProviderSnapshot") },
  ClickedChatNotification: { chatId: Schema.String },
  CompletedSideEffect: {},

  // Theme
  ChangedSystemTheme: { theme: Schema.Literals(["light", "dark"]) },

  // Background chats (useBackgroundChatSubscriptions)
  ElapsedBackgroundChatGrace: { chatId: Schema.String },

  // Sidebar
  ClickedCollapseSidebar: {},
  ClickedExpandSidebar: {},

  // Stores
  GotDelegateMessage: { message: Delegate.Message },
})
export type Message = typeof Message.Type
