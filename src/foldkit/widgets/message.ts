import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { LocalHttpServerInfo, ProjectQuickAction } from "../../shared/protocol"
import type {
  BranchActionFailure,
  BranchActionSuccess,
  ChatBranchDetails,
  ChatCheckoutBranchResult,
  ChatCommitDetails,
  ChatCreateBranchResult,
  ChatMergeBranchResult,
  ChatSyncResult,
  DiffCommitResult,
  GitHubPublishInfo,
  GitHubRepoAvailabilityResult,
  UsageLimitsSnapshot,
} from "../../shared/types"
import { opaque } from "../core/schema"
import * as AppDialog from "../ui/app-dialog"
import * as ContextMenu from "../ui/context-menu"
import * as Dialog from "../ui/dialog"
import * as Popover from "../ui/popover"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import { HoverMessage } from "./hoverCard"
import { BranchList, CommitMode, Entry, MenuTarget, MergePreview, PickerSection, SyncAction, Watch } from "./model"
import { PartsMessage } from "./parts"

// The column's Messages, by widget. Results of socket commands carry the
// token of the request they answer where a newer request can overtake
// them (a picker opened again, another branch selected).

const ActionResult = opaque<BranchActionSuccess | BranchActionFailure>("BranchActionResult")

export const Message = defineMessageUnion({
  // THE PAGE

  /** WidgetsSidebar's props, as its effects ran on them. */
  ObservedPage: { watch: Watch, paths: Schema.Array(Schema.String) },
  TickedClock: { now: Schema.Number },
  CompletedSideEffect: {},

  // PRIMITIVES

  PressedMenuTrigger: { target: MenuTarget, pointerType: Schema.String, button: Schema.Number, x: Schema.Number, y: Schema.Number },
  RequestedMenu: { target: MenuTarget },
  MovedOnMenuTrigger: {},
  /** A row's kebab (openContextMenuFromButton): the menu under its middle. */
  PressedRowKebab: { target: MenuTarget, x: Schema.Number, y: Schema.Number },
  GotMenuMessage: { message: ContextMenu.Message },
  GotCommitMenuMessage: { message: ContextMenu.Message },
  GotTooltipMessage: { id: Schema.String, message: Tooltip.Message },
  GotHoverMessage: { message: HoverMessage },
  GotPartsMessage: { message: PartsMessage },
  GotAppDialogMessage: { message: AppDialog.Message },
  ClickedOpenUrl: { url: Schema.String },
  /** A button inside a hover card that leaves for the web: the card goes first. */
  ClickedCardUrl: { list: Schema.String, url: Schema.String },

  // GIT: THE BRANCH CARD

  ToggledBranches: {},
  ClickedSync: { action: SyncAction },
  SucceededSync: { result: opaque<ChatSyncResult>("ChatSyncResult") },
  FailedSync: { error: Schema.String },
  ClickedPushToGitHub: {},
  ClickedMergeInto: {},
  ChangedCommitSummary: { value: Schema.String },
  ChangedCommitDescription: { value: Schema.String },
  PressedCommitShortcut: {},
  ClickedGenerateMessage: {},
  ClickedCommit: {},
  ClickedCommitOnly: {},
  ToggledCommitEditor: {},
  SucceededGenerateMessage: { subject: Schema.String, body: Schema.String, thenCommit: Schema.NullOr(CommitMode) },
  FailedGenerateMessage: {},
  SucceededCommit: { result: opaque<DiffCommitResult>("DiffCommitResult") },
  FailedCommit: { error: Schema.String },
  ChangedFileQuery: { value: Schema.String },
  ClearedFileQuery: {},
  ClickedShowMoreFiles: {},
  ClickedShowFewerFiles: {},
  ToggledFile: { path: Schema.String },
  ToggledAllFiles: {},
  ClickedReviewFile: { path: Schema.String },
  ClickedReviewChecked: {},
  ToggledHistory: {},
  ClickedShowAllHistory: { shown: Schema.Boolean },
  ClickedPullIncoming: {},
  ClickedInitGit: {},
  SucceededInitGit: { result: ActionResult },
  FailedInitGit: { error: Schema.String },
  ClickedCopySha: { sha: Schema.String },
  ExpiredCopiedSha: { token: Schema.Number },

  // GIT: THE BRANCH PICKER

  SucceededListBranches: { token: Schema.Number, result: BranchList },
  FailedListBranches: { token: Schema.Number, error: Schema.String },
  ChangedPickerQuery: { value: Schema.String },
  PressedPickerKey: { key: Schema.String },
  /** Real pointer movement over the list hands the highlight back to it. */
  MovedPointerOverPicker: {},
  ToggledPickerSection: { section: PickerSection },
  ClickedPickerShowAll: { section: PickerSection, shown: Schema.Boolean },
  ChoseBranch: { entry: Entry },
  ChoseCreateBranch: { name: Schema.String, baseBranchName: Schema.NullOr(Schema.String) },
  SucceededCheckout: { pickerToken: Schema.Number, result: opaque<ChatCheckoutBranchResult>("ChatCheckoutBranchResult") },
  SucceededCreateBranch: { pickerToken: Schema.Number, result: opaque<ChatCreateBranchResult>("ChatCreateBranchResult") },
  FailedBranchMutation: { pickerToken: Schema.Number, title: Schema.String, error: Schema.String },
  /** useBranchDetails: a row that shows its branch's state (a PR's checks) appeared. */
  RequestedBranchDetails: { entry: Entry },
  SucceededReadBranch: { key: Schema.String, details: opaque<ChatBranchDetails>("ChatBranchDetails") },
  FailedReadBranch: { key: Schema.String },
  SucceededReadCommit: { key: Schema.String, details: opaque<ChatCommitDetails>("ChatCommitDetails") },
  FailedReadCommit: { key: Schema.String },
  SucceededReadPatch: { key: Schema.String, patch: Schema.String },
  FailedReadPatch: { key: Schema.String },

  // GIT: MERGE DIALOG

  GotMergeDialogMessage: { message: Dialog.Message },
  SucceededMergeList: { token: Schema.Number, result: BranchList },
  ChangedMergeQuery: { value: Schema.String },
  SelectedMergeBranch: { name: Schema.String },
  SucceededMergePreview: { token: Schema.Number, result: MergePreview },
  FailedMergePreview: { token: Schema.Number, error: Schema.String },
  ClickedMerge: {},
  ClickedMergeCancel: {},
  SucceededMerge: { result: opaque<ChatMergeBranchResult>("ChatMergeBranchResult") },
  FailedMerge: { error: Schema.String },

  // GIT: PUBLISH DIALOG

  GotPublishDialogMessage: { message: Dialog.Message },
  SucceededPublishInfo: { token: Schema.Number, info: opaque<GitHubPublishInfo>("GitHubPublishInfo") },
  FailedPublishInfo: { token: Schema.Number },
  GotOwnerSelectMessage: { message: Select.Message },
  GotVisibilitySelectMessage: { message: Select.Message },
  ChangedPublishName: { value: Schema.String },
  ChangedPublishDescription: { value: Schema.String },
  ElapsedAvailabilityDelay: { token: Schema.Number },
  SucceededAvailability: { token: Schema.Number, result: opaque<GitHubRepoAvailabilityResult>("GitHubRepoAvailabilityResult") },
  FailedAvailability: { token: Schema.Number },
  ClickedPublish: {},
  ClickedPublishCancel: {},
  SucceededPublish: { result: ActionResult },
  FailedPublish: { error: Schema.String },

  // DIFF FILE ACTIONS (after their confirm)

  FailedDiffFileAction: { title: Schema.String, error: Schema.String },

  // TASKS, WORKFLOWS, SCHEDULES, ATTACHMENTS

  ClickedShowAllTasks: { shown: Schema.Boolean },
  ClickedTask: { toolId: Schema.String },
  ClickedSubChat: { chatId: Schema.String },
  ClickedStopTask: { taskId: Schema.String },
  FailedStopTask: { taskId: Schema.String, error: Schema.String },
  ClickedEditSchedule: { scheduleId: Schema.String, fromCard: Schema.Boolean },
  ClickedScheduleRunChat: { chatId: Schema.String },
  ClickedAttachment: { key: Schema.String },

  // PORTS

  TickedPorts: {},
  SucceededListPorts: { servers: Schema.Array(opaque<LocalHttpServerInfo>("LocalHttpServerInfo")) },
  FailedListPorts: { error: Schema.String },
  ElapsedPostRunRefresh: { token: Schema.Number },
  GotPortsFilterMessage: { message: Popover.Message },
  ChosePortsScope: { scope: Schema.Literals(["project", "all"]) },
  ToggledPorts: {},
  ClickedPortsElsewhere: {},
  ClickedPort: { port: Schema.Number },
  SucceededExposePort: { port: Schema.Number, publicUrl: Schema.String },
  FailedPortCommand: { port: Schema.NullOr(Schema.Number), error: Schema.String },
  SucceededKillPort: {},

  // QUICK ACTIONS

  ToggledQuickActions: {},
  ClickedAddQuickAction: {},
  ChangedNewCommand: { value: Schema.String },
  SubmittedQuickAction: {},
  /** Focus left the add form for somewhere outside it. */
  LeftQuickActionForm: {},
  PressedInQuickActions: {},
  ReleasedPressInQuickActions: {},
  RanQuickAction: { id: Schema.String },
  ExpiredRanQuickAction: { token: Schema.Number },
  SucceededWriteQuickActions: { projectId: Schema.String, actions: Schema.Array(opaque<ProjectQuickAction>("ProjectQuickAction")) },
  FailedWriteQuickActions: { error: Schema.String },

  // USAGE

  ToggledUsage: { provider: Schema.String },
  ClickedRefreshUsage: { basis: Schema.String },
  CompletedRefreshUsage: { basis: Schema.String, snapshot: Schema.NullOr(opaque<UsageLimitsSnapshot>("UsageLimitsSnapshot")) },
})
export type Message = typeof Message.Type
