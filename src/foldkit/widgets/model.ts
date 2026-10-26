import { Schema } from "effect"
import type { LocalHttpServerInfo, ProjectQuickAction } from "../../shared/protocol"
import type {
  ChatBranchDetails,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatCommitDetails,
  ChatMergePreviewResult,
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
import { Hovered } from "./hoverCard"

// The widget column's state: what WidgetsSidebar's widgets held in
// component state (GitWidgets, BranchPicker, the two modals, TasksWidget,
// useStopTask, PortsWidget, QuickActionsWidget), the hover cards' rows and
// fetched details, and the overlays' Models. Everything the column shows
// from the server comes in as view inputs (app, page); this is only what
// the column itself keeps.

export const Entry = opaque<ChatBranchListEntry>("ChatBranchListEntry")
export const BranchList = opaque<ChatBranchListResult>("ChatBranchListResult")

/** The page as the column last saw it (WidgetsSidebar's props its effects ran on). */
export const Watch = Schema.Struct({
  projectId: Schema.String,
  chatId: Schema.NullOr(Schema.String),
  /** The column is on screen: its widgets poll. */
  active: Schema.Boolean,
  isMobile: Schema.Boolean,
  widgetsChatKey: Schema.NullOr(Schema.String),
  /** The changed files, as a short fingerprint (the selection reconciles to them). */
  filesKey: Schema.String,
  /** The file the viewer's diff list is on. */
  reviewedPath: Schema.NullOr(Schema.String),
  /** How often the column's clock ticks: 1s while a task runs, 20s while a schedule counts down. */
  clockMs: Schema.NullOr(Schema.Number),
})
export type Watch = typeof Watch.Type

/** Whose row a right-click menu (or a kebab) opened on: one menu for the column. */
export const MenuTarget = Schema.Union([
  Schema.TaggedStruct("DiffFile", { path: Schema.String }),
  Schema.TaggedStruct("Task", { taskId: Schema.String }),
  Schema.TaggedStruct("Schedule", { scheduleId: Schema.String }),
  Schema.TaggedStruct("Port", { port: Schema.Number }),
  Schema.TaggedStruct("QuickAction", { id: Schema.String }),
])
export type MenuTarget = typeof MenuTarget.Type

export const CommitMode = Schema.Literals(["commit_and_push", "commit_only"])
export type CommitMode = typeof CommitMode.Type

export const SyncAction = Schema.Literals(["fetch", "pull", "push", "publish"])
export type SyncAction = typeof SyncAction.Type

export const PickerSection = Schema.Literals(["recent", "pullRequests", "local", "remote"])
export type PickerSection = typeof PickerSection.Type

/** BranchPicker's state; reset each time the picker opens (it remounted). */
export const Picker = Schema.Struct({
  isLoading: Schema.Boolean,
  isMutating: Schema.Boolean,
  query: Schema.String,
  showAllLocal: Schema.Boolean,
  showAllRemote: Schema.Boolean,
  showAllPullRequests: Schema.Boolean,
  collapsedSections: Schema.Array(PickerSection),
  branchList: Schema.NullOr(BranchList),
  error: Schema.NullOr(Schema.String),
  mode: Schema.Literals(["pointer", "keyboard"]),
  keyboardActiveId: Schema.NullOr(Schema.String),
  /** Bumped per opening, so a list read for an earlier opening is dropped. */
  token: Schema.Number,
})
export type Picker = typeof Picker.Type

export function initialPicker(token: number): Picker {
  return {
    isLoading: true,
    isMutating: false,
    query: "",
    showAllLocal: false,
    showAllRemote: false,
    showAllPullRequests: false,
    collapsedSections: [],
    branchList: null,
    error: null,
    mode: "pointer",
    keyboardActiveId: null,
    token,
  }
}

/** GitWidgets' own state. */
export const Git = Schema.Struct({
  isGenerating: Schema.Boolean,
  commitModeInFlight: Schema.NullOr(CommitMode),
  isGeneratedCommitInFlight: Schema.Boolean,
  isSyncing: Schema.Boolean,
  visibleFileCount: Schema.Number,
  fileQuery: Schema.String,
  /** The Branch card's picker, open in place of its body. */
  branchesExpanded: Schema.Boolean,
  showAllHistory: Schema.Boolean,
  /** The commit message fields: open from the first look when a draft was there. Null until then. */
  commitEditorOpen: Schema.NullOr(Schema.Boolean),
  picker: Picker,
})
export type Git = typeof Git.Type

export const INITIAL_VISIBLE_DIFF_FILE_COUNT = 5

export const MergePreview = opaque<ChatMergePreviewResult>("ChatMergePreviewResult")

/** MergeBranchModal. */
export const Merge = Schema.Struct({
  dialog: Dialog.Model,
  branchList: Schema.NullOr(BranchList),
  query: Schema.String,
  selectedName: Schema.NullOr(Schema.String),
  preview: Schema.NullOr(MergePreview),
  previewError: Schema.NullOr(Schema.String),
  isPreviewLoading: Schema.Boolean,
  isMerging: Schema.Boolean,
  /** Bumped per selection and opening, so a stale preview or list is dropped. */
  token: Schema.Number,
})
export type Merge = typeof Merge.Type

/** GitHubPublishModal. */
export const Publish = Schema.Struct({
  dialog: Dialog.Model,
  info: Schema.NullOr(opaque<GitHubPublishInfo>("GitHubPublishInfo")),
  isLoadingInfo: Schema.Boolean,
  owner: Schema.String,
  name: Schema.String,
  visibility: Schema.Literals(["public", "private"]),
  description: Schema.String,
  availability: Schema.NullOr(opaque<GitHubRepoAvailabilityResult>("GitHubRepoAvailabilityResult")),
  isCheckingAvailability: Schema.Boolean,
  isPublishing: Schema.Boolean,
  ownerSelect: Select.Model,
  visibilitySelect: Select.Model,
  token: Schema.Number,
})
export type Publish = typeof Publish.Type

/** What answering the column's app dialog goes on to do. */
export const DialogContinuation = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("DiscardFile", { chatId: Schema.String, path: Schema.String }),
  Schema.TaggedStruct("IgnoreFile", { chatId: Schema.String }),
  Schema.TaggedStruct("CheckoutBranch", { chatId: Schema.String, branch: Entry, pickerToken: Schema.Number }),
])
export type DialogContinuation = typeof DialogContinuation.Type

/** PortsWidget. */
export const Ports = Schema.Struct({
  servers: Schema.Array(opaque<LocalHttpServerInfo>("LocalHttpServerInfo")),
  loaded: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  scope: Schema.Literals(["project", "all"]),
  exposingPorts: Schema.Array(Schema.Number),
  /** A read in flight (refreshCachedLocalHttpServers shares one). */
  reading: Schema.Boolean,
  /** Bumped per quick action run: the 1s and 2s re-checks after it. */
  postRunToken: Schema.Number,
  filter: Popover.Model,
})
export type Ports = typeof Ports.Type

/** QuickActionsWidget. */
export const QuickActions = Schema.Struct({
  /** The list as this column last wrote it, for its project: wins over the page's read. */
  written: Schema.NullOr(Schema.Struct({ projectId: Schema.String, actions: Schema.Array(opaque<ProjectQuickAction>("ProjectQuickAction")) })),
  error: Schema.NullOr(Schema.String),
  newCommand: Schema.String,
  isAdding: Schema.Boolean,
  ranActionId: Schema.NullOr(Schema.String),
  ranToken: Schema.Number,
  /** A press began inside the widget: the form's blur leaves the decision to the click. */
  pressInWidget: Schema.Boolean,
})
export type QuickActions = typeof QuickActions.Type

export const Model = Schema.Struct({
  watch: Schema.NullOr(Watch),
  menu: ContextMenu.Model,
  menuTarget: Schema.NullOr(MenuTarget),
  /** The commit button's own menu (Commit Only). */
  commitMenu: ContextMenu.Model,
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
  hovered: Hovered,
  /** Fetched card details, by their cache keys (useCardDetails). */
  branchDetails: Schema.Record(Schema.String, opaque<ChatBranchDetails>("ChatBranchDetails")),
  branchReads: Schema.Array(Schema.String),
  commitDetails: Schema.Record(Schema.String, opaque<ChatCommitDetails>("ChatCommitDetails")),
  commitReads: Schema.Array(Schema.String),
  patches: Schema.Record(Schema.String, Schema.String),
  patchReads: Schema.Array(Schema.String),
  /** A commit card's sha copy check, by sha, until it fades. */
  copiedSha: Schema.NullOr(Schema.String),
  copiedToken: Schema.Number,
  git: Git,
  merge: Merge,
  publish: Publish,
  appDialog: AppDialog.Model,
  pendingDialog: Schema.NullOr(Schema.Struct({ requestId: Schema.String, then: DialogContinuation })),
  dialogSeq: Schema.Number,
  /** useStopTask. */
  stopping: Schema.Array(Schema.String),
  stopError: Schema.NullOr(Schema.String),
  showAllTasks: Schema.Boolean,
  ports: Ports,
  quickActions: QuickActions,
  /** The Usage card's refresh button: its own `usage.refresh`, and the snapshot it returned while the page's is the one it answered. */
  usageRefreshing: Schema.Boolean,
  usageOverride: Schema.NullOr(Schema.Struct({ basis: Schema.String, snapshot: opaque<UsageLimitsSnapshot>("UsageLimitsSnapshot") })),
  /** Wall clock for elapsed times and "in 4m": ticked while something counts. */
  now: Schema.Number,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    watch: null,
    menu: ContextMenu.init({ id: "widgets-row" }),
    menuTarget: null,
    commitMenu: ContextMenu.init({ id: "widgets-commit" }),
    tooltips: {},
    hovered: {},
    branchDetails: {},
    branchReads: [],
    commitDetails: {},
    commitReads: [],
    patches: {},
    patchReads: [],
    copiedSha: null,
    copiedToken: 0,
    git: {
      isGenerating: false,
      commitModeInFlight: null,
      isGeneratedCommitInFlight: false,
      isSyncing: false,
      visibleFileCount: INITIAL_VISIBLE_DIFF_FILE_COUNT,
      fileQuery: "",
      branchesExpanded: false,
      showAllHistory: false,
      commitEditorOpen: null,
      picker: initialPicker(0),
    },
    merge: {
      dialog: Dialog.init({ id: "widgets-merge" }),
      branchList: null,
      query: "",
      selectedName: null,
      preview: null,
      previewError: null,
      isPreviewLoading: false,
      isMerging: false,
      token: 0,
    },
    publish: {
      dialog: Dialog.init({ id: "widgets-publish" }),
      info: null,
      isLoadingInfo: false,
      owner: "",
      name: "",
      visibility: "private",
      description: "",
      availability: null,
      isCheckingAvailability: false,
      isPublishing: false,
      ownerSelect: Select.init({ id: "widgets-publish-owner" }),
      visibilitySelect: Select.init({ id: "widgets-publish-visibility" }),
      token: 0,
    },
    appDialog: AppDialog.init(),
    pendingDialog: null,
    dialogSeq: 0,
    stopping: [],
    stopError: null,
    showAllTasks: false,
    ports: {
      servers: [],
      loaded: false,
      error: null,
      scope: "project",
      exposingPorts: [],
      reading: false,
      postRunToken: 0,
      filter: Popover.init({ id: "widgets-ports-filter" }),
    },
    quickActions: {
      written: null,
      error: null,
      newCommand: "",
      isAdding: false,
      ranActionId: null,
      ranToken: 0,
      pressInWidget: false,
    },
    usageRefreshing: false,
    usageOverride: null,
    now: Date.now(),
  }
}
