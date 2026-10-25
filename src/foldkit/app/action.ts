import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import type { ProjectRequest } from "../../client/app/kannaStateHelpers"
import type { OpenLocalLinkTarget } from "../../client/components/messages/shared"
import type { ChatJumpTarget } from "../../client/lib/chat-navigation"
import type { ClientCommand, EditorOpenSettings, OpenExternalAction, TerminalPreset } from "../../shared/protocol"
import type { AppSettingsPatch, FaveModel, LlmProviderSnapshot } from "../../shared/types"
import * as ChatSession from "../core/chatSession"
import { opaque } from "../core/schema"
import * as Stores from "./stores"

// What a slice asks the root to do: the handlers useKannaState handed down
// (handleCreateChat, handleArchiveChat, handleWriteAppSettings, …) and
// navigation, as data. A slice's OutMessage carries one in
// `RequestedAppAction({ action })`; the root runs it (app/actions.ts).
//
// Store changes go as `Store` with a Stores Message, and anything for the
// page's chat session (send, cancel, load older, read anchor) as `Chat`.
// Slices import this from app/; it imports no slice, so there is no cycle.

export const AppAction = defineTaggedUnion({
  // Navigation
  Navigate: { path: Schema.String, replace: Schema.Boolean },
  /** The chat's Back on mobile: through history when there is history, else `/`. */
  OpenSidebar: {},
  CollapseSidebar: {},
  ExpandSidebar: {},

  // Chats
  CreateChat: { projectId: Schema.String },
  /** A click on a project, as against on something that says New Chat. */
  OpenProjectNewChat: { projectId: Schema.String },
  /** The sidebar's New Chat: a chat in the project you're looking at. */
  Compose: {},
  ForkChat: { chatId: Schema.String },
  RenameChat: { chatId: Schema.String, title: Schema.String },
  ShareChat: { chatId: Schema.NullOr(Schema.String) },
  TogglePinChat: { chatId: Schema.String, pinned: Schema.Boolean },
  ArchiveChat: { chatId: Schema.String },
  OpenArchivedChat: { chatId: Schema.String },
  RestoreChat: { chatId: Schema.String },
  DeleteChat: { chatId: Schema.String, title: Schema.String },
  SetupGit: { chatId: Schema.String },
  SetDelegator: { chatId: Schema.String, delegator: Schema.Boolean },
  /**
   * New Delegator (chat-ui/create-delegator.ts): asks for its name, creates
   * it empty, and picks it as what the project's new chat page delegates to.
   */
  CreateDelegator: { projectId: Schema.String },

  // Projects
  OpenLocalProject: { localPath: Schema.String },
  CreateProject: { project: opaque<ProjectRequest>("ProjectRequest") },
  RenameProject: { target: opaque<string | { localPath: string }>("ProjectTarget"), sidebarTitle: Schema.NullOr(Schema.String), realTitle: Schema.String },
  HideProject: { target: opaque<string | { localPath: string }>("ProjectTarget") },
  ReorderProjectGroups: { projectIds: Schema.Array(Schema.String) },
  SetProjectPinned: { projectId: Schema.String, pinned: Schema.Boolean },

  // Outside the app
  CopyPath: { localPath: Schema.String },
  OpenExternal: { action: opaque<OpenExternalAction>("OpenExternalAction"), editor: Schema.NullOr(opaque<EditorOpenSettings>("EditorOpenSettings")), terminal: Schema.NullOr(opaque<TerminalPreset>("TerminalPreset")) },
  OpenExternalPath: { action: Schema.Literals(["open_finder", "open_editor"]), localPath: Schema.String },
  OpenLocalLink: { target: opaque<OpenLocalLinkTarget>("OpenLocalLinkTarget"), action: opaque<OpenExternalAction>("OpenExternalAction"), editor: Schema.NullOr(opaque<EditorOpenSettings>("EditorOpenSettings")) },

  // Settings and the machine
  WriteAppSettings: { patch: opaque<AppSettingsPatch>("AppSettingsPatch") },
  ReadAppSettings: {},
  WriteLlmProvider: { value: opaque<Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl"> & Partial<Pick<LlmProviderSnapshot, "faveModels">>>("LlmProviderWrite") },
  WriteFaveModels: { faveModels: opaque<FaveModel[]>("FaveModels") },
  CheckForUpdates: { force: Schema.Boolean },
  InstallUpdate: {},
  InstallNightly: {},
  InstallStable: {},
  SignOut: {},

  /**
   * Several actions from one gesture, run in order (Archive All, Restore).
   * Typed `unknown` only because the union can't name itself here; build
   * one with `batch(...)`.
   */
  Batch: { actions: Schema.Array(Schema.Unknown) },
  /**
   * Open a chat at a message (the sidebar card's clickable previews): React
   * passed the target in the location state; here it waits in
   * `app.actions.pendingChatJump` until the transcript spends it.
   */
  OpenChatAt: { chatId: Schema.String, jump: opaque<ChatJumpTarget>("ChatJumpTarget") },
  /** The transcript scrolled to the pending jump. */
  SpentChatJump: { requestId: Schema.Number },
  /** React's `kanna:open-command-palette` window event, optionally on a page. */
  OpenCommandPalette: { page: Schema.NullOr(Schema.String) },

  /** Any other ClientCommand whose result arrives on a snapshot. */
  SendCommand: { command: opaque<ClientCommand>("ClientCommand") },
  /** A Stores Message (app/stores.ts), e.g. a draft or a layout change. */
  Store: { message: Stores.Message },
  /** A ChatSession Message for the page's chat (core/chatSession.ts). */
  Chat: { message: ChatSession.Message },
})
export type AppAction = typeof AppAction.Type

/** `AppAction.Batch`, typed. */
export function batch(...actions: AppAction[]): AppAction {
  return AppAction.Batch({ actions })
}
