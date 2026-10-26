import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { HomeSource } from "../../client/components/home/homeItems"
import type { GitHubRecentReposResult } from "../../shared/types"
import * as Connection from "../core/stores/connection"
import { opaque } from "../core/schema"
import * as ContextMenu from "../ui/context-menu"
import * as CopyButton from "../ui/copy-button"
import * as Dialog from "../ui/dialog"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"
import { defaultEnvironment, PageEnvironment } from "./environment"

// The projects page's state: what LocalProjectsPage, LocalDev and
// ProjectsHome held in React state and refs. Everything else it shows
// (projects, sidebar groups, sign-in, settings, connection) is the root's,
// read through `app`.

export const SOURCES = ["all", "local", "github"] as const satisfies ReadonlyArray<HomeSource>
export const Source = Schema.Literals(SOURCES)

export const ConnectionStatus = Schema.Literals(["connecting", "connected", "disconnected"])

/** The accessory buttons' tooltips, by name; rows use `row:<item key>`. */
export const CLEAR_SEARCH_TOOLTIP = "clear-search"
export const FILTER_TOOLTIP = "filter"
export const ADD_PROJECT_TOOLTIP = "add-project"
export const rowTooltipKey = (itemKey: string) => `row:${itemKey}`

export const Archive = Schema.Struct({ localPath: Schema.String, nowMs: Schema.Number })

export const Model = Schema.Struct({
  // LocalProjectsPage / LocalDev

  /** Read when the page mounts: host, port, the Mac app, `?preview=`. */
  environment: PageEnvironment,
  /** LocalDev is on screen (between MountedPage and LeftPage). */
  pageMounted: Schema.Boolean,
  /**
   * GitHub's sign-in changed on a projects page before the list was up.
   * React's list was up by then (see `observe`), so the list's mount owes
   * the request for that change as well as its own.
   */
  signInChangedBeforeList: Schema.Boolean,
  /** useConnectionFailed: when attempts started failing, and whether help is showing. */
  failingSince: Schema.NullOr(Schema.Number),
  connectionFailed: Schema.Boolean,
  /** useRevealAfterWait: when the connecting screen went up, and whether the page fades in. */
  waitingSince: Schema.NullOr(Schema.Number),
  revealChildren: Schema.Boolean,
  /** The start command's copy button (ConnectHelp's CodeBlock). */
  commandCopy: CopyButton.Model,
  /** The project whose archived chats are open (LocalProjectsPage's `archive`). */
  archive: Schema.NullOr(Archive),
  archiveDialog: Dialog.Model,

  // ProjectsHome

  query: Schema.String,
  source: Source,
  account: Schema.String,
  /** The repo whose clone this page started; in flight while the root's startingLocalPath is its folder. */
  cloningRepo: Schema.NullOr(Schema.String),
  /** useGitHubRecentRepos: null while they load. */
  recentRepos: Schema.NullOr(opaque<GitHubRecentReposResult>("GitHubRecentReposResult")),
  /** Bumped per request and when the list unmounts, so a stale answer is dropped (the hook's `cancelled`). */
  reposRequestVersion: Schema.Number,
  /** Newly arrived GitHub rows fade in for ARRIVAL_FADE_MS; later renders don't. */
  reposJustArrived: Schema.Boolean,
  reposArrivedAt: Schema.NullOr(Schema.Number),
  /**
   * The GitHub sign-in state useGitHubRecentRepos's effect last ran with;
   * null while the list is off screen. A change while it is on screen
   * fetches again (`observe`).
   */
  reposFetchedFor: Schema.NullOr(Schema.String),
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
  rowMenus: Schema.Record(Schema.String, ContextMenu.Model),
  filterPopover: Popover.Model,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    environment: defaultEnvironment,
    failingSince: null,
    connectionFailed: false,
    waitingSince: null,
    revealChildren: false,
    commandCopy: CopyButton.init({ id: "home-start-command" }),
    archive: null,
    archiveDialog: Dialog.init({ id: "home-archived-chats" }),
    pageMounted: false,
    signInChangedBeforeList: false,
    ...initProjectsHome(),
  }
}

/** ProjectsHome's own state, as it is when the list mounts. */
export function initProjectsHome() {
  return {
    query: "",
    source: "all" as const,
    account: "all",
    cloningRepo: null,
    recentRepos: null,
    reposRequestVersion: 0,
    reposJustArrived: false,
    reposArrivedAt: null,
    reposFetchedFor: null,
    tooltips: {},
    rowMenus: {},
    filterPopover: Popover.init({ id: "home-projects-filter" }),
  } satisfies Partial<Model>
}

export const Message = defineMessageUnion({
  // The page's lifetime
  /** The page is on screen; its surroundings as read then. */
  MountedPage: { environment: PageEnvironment },
  LeftPage: {},
  /** The list is on screen: fetch the recent repos (again on a sign-in change: `observe`). */
  MountedProjectsList: {},
  LeftProjectsList: {},
  ChangedSocketStatus: { status: ConnectionStatus, at: Schema.Number },
  GotConnectionMessage: { message: Connection.Message },
  GotCommandCopyMessage: { message: CopyButton.Message },

  // LocalDev's preview bar
  ChosePreview: { preview: Schema.String },
  ClosedPreview: {},
  ClickedFleetMachine: { subdomain: Schema.String },
  ClickedManageFleet: {},

  // Search and filter
  ChangedQuery: { value: Schema.String },
  PressedSearchKey: { key: Schema.String },
  ClickedClearSearch: {},
  ChoseFilter: { source: Source, account: Schema.String },
  ClickedAddProject: {},
  ClickedSearchGitHub: {},
  ClickedSetup: {},

  // Rows
  ClickedLocalProject: { localPath: Schema.String },
  ClickedRepo: { nameWithOwner: Schema.String },
  ReceivedRecentRepos: { version: Schema.Number, result: opaque<GitHubRecentReposResult>("GitHubRecentReposResult"), at: Schema.Number },
  ElapsedArrivalFade: { arrivedAt: Schema.Number },

  // Children
  GotTooltipMessage: { key: Schema.String, message: Tooltip.Message },
  GotRowMenuMessage: { localPath: Schema.String, message: ContextMenu.Message },
  GotFilterPopoverMessage: { message: Popover.Message },
  GotArchiveDialogMessage: { message: Dialog.Message },

  // Archived chats
  OpenedArchive: { localPath: Schema.String, nowMs: Schema.Number },
  ClickedArchivedChat: { chatId: Schema.String },
  ClickedRestoreChat: { chatId: Schema.String },

  CompletedSideEffect: {},
})
export type Message = typeof Message.Type
