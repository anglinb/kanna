import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { MacSetupState } from "../../client/lib/macApp"
import type { ChatBrowserNotificationPreference, FsListResult, GitHubRecentReposResult } from "../../shared/types"
import { opaque } from "../core/schema"
import * as AppDialog from "../ui/app-dialog"
import type { RepoMeta } from "./model"
import * as Usage from "./usage"

export const Message = defineMessageUnion({
  // Opening and closing
  /** The openCommandPalette keybinding, anywhere on the page. */
  PressedPaletteShortcut: { at: Schema.Number },
  /**
   * An open on a page: AppAction.OpenCommandPalette (through `requestOpen`),
   * or `kanna:open-command-palette`, which pages not yet moved to the action
   * still dispatch. `at` snaps the age labels' clock.
   */
  ReceivedOpenRequest: { page: Schema.NullOr(Schema.String), at: Schema.Number },
  /** Escape at the root, or a pointerdown outside (Radix's onOpenChange(false)). */
  DismissedPalette: {},
  CompletedExitAnimation: { version: Schema.Number },
  CompletedMountContent: {},
  CompletedMountRoot: {},

  // Typing and the highlight
  ChangedQuery: { value: Schema.String },
  /** A key cmdk moves the highlight with (arrows, Home/End, Ctrl+N/J/P/K). */
  PressedNavigationKey: { key: Schema.String, ctrlKey: Schema.Boolean, metaKey: Schema.Boolean, altKey: Schema.Boolean },
  /** Enter; `withModifier` is ⌘/Ctrl held without Shift or Alt (the browse footer's ⌘↵). */
  PressedEnter: { withModifier: Schema.Boolean },
  HoveredItem: { value: Schema.String },
  ClickedItem: { value: Schema.String },

  // The page stack
  ClickedBack: {},
  /** Backspace in the empty input, or Escape, on a sub-page. */
  PressedBackKey: {},
  /** ⌘C / Ctrl+C on a row with a project path, nothing selected in the input. */
  PressedCopyShortcut: {},
  ClickedBrowseFooter: {},

  // Results of the palette's own commands
  ReceivedGithubRepos: { seq: Schema.Number, result: opaque<GitHubRecentReposResult>("GitHubRecentReposResult") },
  ReceivedCreateDirNames: { seq: Schema.Number, names: Schema.Array(Schema.String) },
  ReceivedDirectory: { seq: Schema.Number, result: opaque<FsListResult>("FsListResult") },
  FailedDirectory: { seq: Schema.Number, error: Schema.String },
  ReceivedJump: { seq: Schema.Number, result: opaque<FsListResult>("FsListResult") },
  FailedJump: { seq: Schema.Number, error: Schema.String },
  /** useRepoMetadata's 350ms timer, unless a newer run of its effect cleared it (`seq`). */
  ElapsedRepoMetaDebounce: { seq: Schema.Number, key: Schema.String },
  ReceivedRepoMeta: { key: Schema.String, meta: opaque<RepoMeta>("RepoMeta") },
  FailedRepoMeta: { key: Schema.String, error: Schema.String },
  ElapsedCloneSuccess: { cloneSeq: Schema.Number },
  ReceivedMacSetup: { state: Schema.NullOr(opaque<MacSetupState>("MacSetupState")) },
  ChangedPhoneLayout: { phone: Schema.Boolean },
  ReceivedNotificationPermission: { preference: opaque<ChatBrowserNotificationPreference>("ChatBrowserNotificationPreference") },
  GeneratedTerminalId: { projectId: Schema.String, terminalId: Schema.String, chatKey: Schema.NullOr(Schema.String) },

  GotUsageMessage: { message: Usage.Message },

  // New Delegator (chat-ui/create-delegator.ts)
  GotDialogMessage: { message: AppDialog.Message },
  SucceededCreateDelegator: { projectId: Schema.String, chatId: Schema.String },
  FailedCreateDelegator: { error: Schema.String },

  CompletedSideEffect: {},
})
export type Message = typeof Message.Type
