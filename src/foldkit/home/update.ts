import { Command } from "foldkit"
import { parseRepoRef, resolveCloneDestination } from "../../client/lib/project-fs"
import { getEditorPresetLabel } from "../../shared/editor-presets"
import { editorPresetFromOpenAppValue, resolveEffectiveEditorPreset } from "../../client/lib/effective-editor"
import { DEFAULT_NEW_PROJECTS_DIRECTORY, type LocalProjectSummary } from "../../shared/types"
import { AppAction } from "../app/action"
import { routePath } from "../app/route"
import { requestAction, type AppModel, type SliceObserve, type SliceReturn } from "../app/slice"
import * as Stores from "../app/stores"
import * as Connection from "../core/stores/connection"
import * as ProviderAuth from "../core/stores/providerAuth"
import * as ContextMenu from "../ui/context-menu"
import * as CopyButton from "../ui/copy-button"
import * as Dialog from "../ui/dialog"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"
import {
  FetchRecentRepos,
  OpenArchive,
  OpenMachineInMacApp,
  OpenWindow,
  WaitArrivalFade,
} from "./commands"
import { FLEET_URL } from "./environment"
import { initProjectsHome, Message, type Model } from "./model"

type Return = SliceReturn<Model, Message>
type Commands = NonNullable<Return["commands"]>

/** Most connections land well inside this; past it the page fades in instead of cutting. */
export const CONNECTING_REVEAL_DELAY_MS = 400

/** How long attempts must keep failing before the page offers setup help. */
export const SETUP_HELP_AFTER_MS = 1_500

// READS OF THE ROOT

/** useAuthService("gh")?.authStatus, as a key: "none" before the snapshot. */
export function ghAuthStatus(app: AppModel): string {
  return ProviderAuth.authService(app.stores.providerAuth, "gh")?.authStatus ?? "none"
}

export function newProjectsDirectory(app: AppModel) {
  return app.stores.appSettings.settings?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY
}

/**
 * state.editorLabel: the editor the navbar button would open, never one this
 * machine doesn't have (useEffectiveEditorPreset).
 */
export function editorLabel(app: AppModel) {
  return getEditorPresetLabel(resolveEffectiveEditorPreset({
    preferred: app.stores.terminalPreferences.editorPreset,
    remembered: editorPresetFromOpenAppValue(app.stores.openDestination.value),
    installedEditors: app.stores.appSettings.settings?.installedEditors ?? null,
  }))
}

export function isConnected(app: AppModel) {
  return app.connectionStatus === "connected" && app.localProjectsReady
}

/** Where a repo clones to, as the row's tooltip and the clone request name it. */
export function cloneDestination(nameWithOwner: string, app: AppModel) {
  const ref = parseRepoRef(nameWithOwner)
  return ref ? { ref, destination: resolveCloneDestination(newProjectsDirectory(app), ref) } : null
}

/**
 * The clone this page started, while it is still going. React held
 * `cloningRepo` until onCloneRepo's promise settled; that promise is the
 * root's start-chat flow, which holds startingLocalPath on the clone's folder
 * for exactly as long.
 */
export function cloningRepo(model: Model, app: AppModel): string | null {
  if (model.cloningRepo === null) return null
  const clone = cloneDestination(model.cloningRepo, app)
  return clone && app.actions.startingLocalPath === clone.destination.localPath ? model.cloningRepo : null
}

/** setCloneError: the failure of this page's last clone, once it has settled. */
export function cloneError(model: Model, app: AppModel): string | null {
  return model.cloningRepo !== null && cloningRepo(model, app) === null ? app.actions.projectRequestError : null
}

function findProject(app: AppModel, localPath: string): LocalProjectSummary | undefined {
  return app.localProjects?.projects.find((project) => project.localPath === localPath)
}

function sidebarGroup(app: AppModel, localPath: string) {
  return app.stores.sidebar.data.projectGroups.find((group) => group.localPath === localPath)
}

// CHILD FOLDS (by hand: a row's tooltip and menu are made the first time they're touched)

/** A DOM-safe id for a child keyed by a path: aria-describedby can't hold a space. */
export function childId(prefix: string, key: string) {
  let hash = 5381
  for (let index = 0; index < key.length; index++) hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0
  return `${prefix}-${key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-48)}-${(hash >>> 0).toString(36)}`
}

export function tooltipFor(model: Model, key: string): Tooltip.Model {
  return model.tooltips[key] ?? Tooltip.init({ id: childId("home-tooltip", key) })
}

export function rowMenuFor(model: Model, localPath: string): ContextMenu.Model {
  return model.rowMenus[localPath] ?? ContextMenu.init({ id: childId("home-project-menu", localPath) })
}

function foldTooltip(model: Model, key: string, message: Tooltip.Message): Return {
  const result = Tooltip.update(tooltipFor(model, key), message)
  return {
    model: { ...model, tooltips: { ...model.tooltips, [key]: result.model } },
    commands: Command.mapMessages(result.commands, (child) => Message.GotTooltipMessage({ key, message: child })),
  }
}

function foldFilterPopover(model: Model, message: Popover.Message): Return {
  const result = Popover.update(model.filterPopover, message)
  return {
    model: { ...model, filterPopover: result.model },
    commands: Command.mapMessages(result.commands, (child) => Message.GotFilterPopoverMessage({ message: child })),
  }
}

function foldCommandCopy(model: Model, message: CopyButton.Message): Return {
  const result = CopyButton.update(model.commandCopy, message)
  return {
    model: { ...model, commandCopy: result.model },
    commands: Command.mapMessages(result.commands, (child) => Message.GotCommandCopyMessage({ message: child })),
  }
}

const liftDialog = (commands: ReadonlyArray<Command.Command<Dialog.Message>> | undefined): Commands =>
  Command.mapMessages(commands, (child) => Message.GotArchiveDialogMessage({ message: child }))

function foldArchiveDialog(model: Model, message: Dialog.Message): Return {
  const result = Dialog.update(model.archiveDialog, message)
  const next = { ...model, archiveDialog: result.model }
  return {
    // onOpenChange(false): the archive goes, and the dialog fades out.
    model: result.outMessage?._tag === "Closed" ? { ...next, archive: null } : next,
    commands: liftDialog(result.commands),
  }
}

function closeArchive(model: Model): { model: Model; commands: Commands } {
  const result = Dialog.close(model.archiveDialog)
  return { model: { ...model, archive: null, archiveDialog: result.model }, commands: liftDialog(result.commands) }
}

function foldRowMenu(model: Model, localPath: string, message: ContextMenu.Message, app: AppModel): Return {
  const menu = rowMenuFor(model, localPath)
  // OpenRepoMenuItem's onSelect called preventDefault, which keeps a Radix
  // menu open: the choice never reaches the menu, so it stays as it was.
  if (message._tag === "ChoseItem" && message.value === "open-repo" && ContextMenu.isOpen(menu)) {
    return chooseMenuItem(model, localPath, message.value, app)
  }
  const result = ContextMenu.update(menu, message)
  const next = { ...model, rowMenus: { ...model.rowMenus, [localPath]: result.model } }
  const commands = Command.mapMessages(result.commands, (child) => Message.GotRowMenuMessage({ localPath, message: child }))
  const outMessage = result.outMessage
  if (outMessage?._tag !== "Selected") return { model: next, commands }
  const chosen = chooseMenuItem(next, localPath, outMessage.value, app)
  return { ...chosen, commands: [...commands, ...(chosen.commands ?? [])] }
}

/** ProjectSectionMenu's handlers, as LocalProjectsPage wired them. */
function chooseMenuItem(model: Model, localPath: string, value: string, app: AppModel): Return {
  const project = findProject(app, localPath)
  switch (value) {
    case "new-chat":
      return requestAction(model, AppAction.OpenLocalProject({ localPath }))
    case "rename":
      return project
        ? requestAction(model, AppAction.RenameProject({ target: { localPath }, sidebarTitle: project.sidebarTitle ?? null, realTitle: project.title }))
        : { model }
    case "copy-path":
      return requestAction(model, AppAction.CopyPath({ localPath }))
    case "show-archived":
      return { model, commands: [OpenArchive({ localPath })] }
    case "open-finder":
      return requestAction(model, AppAction.OpenExternalPath({ action: "open_finder", localPath }))
    case "open-editor":
      return requestAction(model, AppAction.OpenExternalPath({ action: "open_editor", localPath }))
    case "open-repo": {
      // In this browser, not through system.openExternal: that opens things on
      // the machine the project lives on (OpenRepoMenuItem).
      const repoUrl = sidebarGroup(app, localPath)?.repoUrl
      return repoUrl ? { model, commands: [OpenWindow({ url: repoUrl, features: "noopener,noreferrer" })] } : { model }
    }
    case "hide":
      return requestAction(model, AppAction.HideProject({ target: { localPath } }))
    default:
      return { model }
  }
}

// CONNECTION TIMING (LocalDev's useConnectionFailed and useRevealAfterWait)

function changedSocketStatus(model: Model, status: "connecting" | "connected" | "disconnected", at: number): Model {
  if (status === "connected") {
    return {
      ...model,
      failingSince: null,
      connectionFailed: false,
      revealChildren: model.waitingSince !== null ? at - model.waitingSince > CONNECTING_REVEAL_DELAY_MS : model.revealChildren,
      waitingSince: null,
    }
  }
  const failingSince = model.failingSince ?? at
  return {
    ...model,
    failingSince,
    // Once help is showing it stays through the retries, until a connection lands.
    connectionFailed: model.connectionFailed || (status === "disconnected" && at - failingSince > SETUP_HELP_AFTER_MS),
    waitingSince: model.waitingSince ?? at,
    revealChildren: false,
  }
}

// UPDATE

export function update(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    MountedPage: ({ environment }) => {
      // Fresh refs, as a newly mounted LocalDev has: its first render starts
      // the clocks when it isn't connected yet.
      const waiting = !isConnected(app)
      const next: Model = {
        ...model,
        environment,
        pageMounted: true,
        // The preview shows no list: a sign-in change has no request to owe.
        signInChangedBeforeList: environment.preview === null && model.signInChangedBeforeList,
        failingSince: app.connectionStatus === "connected" ? null : environment.nowMs,
        connectionFailed: false,
        waitingSince: waiting ? environment.nowMs : null,
        revealChildren: false,
      }
      // useConnectHelpContext: the sidebar's switcher normally loads the
      // machine list, but the sidebar is closed on phones.
      return app.stores.connection.mode === "unknown"
        ? { model: next, commands: [Command.mapMessage(Connection.LoadConnection(), (child) => Message.GotConnectionMessage({ message: child }))] }
        : { model: next }
    },
    LeftPage: () => ({ model: { ...model, ...closeArchiveNow(model), pageMounted: false, signInChangedBeforeList: false, failingSince: null, connectionFailed: false, waitingSince: null, revealChildren: false } }),
    MountedProjectsList: () => {
      // The mount's request, and the one owed for a sign-in that changed
      // while the list was on its way (`observe`): only the later one lands.
      const owed = model.signInChangedBeforeList
      const version = model.reposRequestVersion + (owed ? 2 : 1)
      return {
        model: { ...model, reposRequestVersion: version, reposFetchedFor: ghAuthStatus(app), signInChangedBeforeList: false },
        commands: owed ? [FetchRecentRepos({ version: version - 1 }), FetchRecentRepos({ version })] : [FetchRecentRepos({ version })],
      }
    },
    // ProjectsHome's state goes with it; an answer still on its way is dropped.
    LeftProjectsList: () => ({ model: { ...model, ...initProjectsHome(), reposRequestVersion: model.reposRequestVersion + 1 } }),
    ChangedSocketStatus: ({ status, at }) => ({ model: changedSocketStatus(model, status, at) }),
    GotConnectionMessage: ({ message: child }) =>
      requestAction(model, AppAction.Store({ message: Stores.Message.GotConnectionMessage({ message: child }) })),
    GotCommandCopyMessage: ({ message: child }) => foldCommandCopy(model, child),

    ChosePreview: ({ preview }) => requestAction(
      { ...model, environment: { ...model.environment, preview } },
      AppAction.Navigate({ path: `${routePath(app.route)}?preview=${encodeURIComponent(preview)}`, replace: true }),
    ),
    ClosedPreview: () => requestAction(
      { ...model, environment: { ...model.environment, preview: null } },
      AppAction.Navigate({ path: routePath(app.route), replace: true }),
    ),
    ClickedFleetMachine: ({ subdomain }) => ({ model, commands: [OpenMachineInMacApp({ subdomain })] }),
    ClickedManageFleet: () => ({ model, commands: [OpenWindow({ url: FLEET_URL, features: "noopener" })] }),

    ChangedQuery: ({ value }) => ({ model: { ...model, query: value } }),
    PressedSearchKey: ({ key }) => (key === "Escape" ? { model: { ...model, query: "" } } : { model }),
    ClickedClearSearch: () => ({ model: { ...model, query: "" } }),
    ChoseFilter: ({ source, account }) => ({ model: { ...model, source, account } }),
    ClickedAddProject: () => requestAction(model, AppAction.OpenCommandPalette({ page: "add-project" })),
    ClickedSearchGitHub: () => requestAction(model, AppAction.OpenCommandPalette({ page: "clone-github" })),
    ClickedSetup: () => requestAction(model, AppAction.Store({
      message: Stores.Message.GotProviderAuthMessage({ message: ProviderAuth.Message.OpenedSetupWizard() }),
    })),

    ClickedLocalProject: ({ localPath }) => requestAction(model, AppAction.OpenLocalProject({ localPath })),
    ClickedRepo: ({ nameWithOwner }) => {
      if (cloningRepo(model, app) !== null) return { model }
      const clone = cloneDestination(nameWithOwner, app)
      if (!clone) return { model }
      return requestAction({ ...model, cloningRepo: nameWithOwner }, AppAction.CreateProject({
        project: {
          mode: "clone",
          localPath: clone.destination.localPath,
          fallbackPath: clone.destination.fallbackPath,
          title: clone.destination.title,
          cloneUrl: clone.ref.cloneUrl,
        },
      }))
    },
    ReceivedRecentRepos: ({ version, result, at }) => {
      if (version !== model.reposRequestVersion) return { model }
      const next = { ...model, recentRepos: result }
      const hasRepos = result.available && result.repos.length > 0
      if (!hasRepos || model.reposArrivedAt !== null) return { model: next }
      return {
        model: { ...next, reposArrivedAt: at, reposJustArrived: true },
        commands: [WaitArrivalFade({ arrivedAt: at })],
      }
    },
    ElapsedArrivalFade: ({ arrivedAt }) =>
      arrivedAt === model.reposArrivedAt ? { model: { ...model, reposJustArrived: false } } : { model },

    GotTooltipMessage: ({ key, message: child }) => foldTooltip(model, key, child),
    GotRowMenuMessage: ({ localPath, message: child }) => foldRowMenu(model, localPath, child, app),
    GotFilterPopoverMessage: ({ message: child }) => foldFilterPopover(model, child),
    GotArchiveDialogMessage: ({ message: child }) => foldArchiveDialog(model, child),

    OpenedArchive: ({ localPath, nowMs }) => {
      const result = Dialog.open(model.archiveDialog)
      return {
        model: { ...model, archive: { localPath, nowMs }, archiveDialog: result.model },
        commands: liftDialog(result.commands),
      }
    },
    // Opening a chat closes the dialog (you're leaving for it); restoring
    // leaves it open.
    ClickedArchivedChat: ({ chatId }) => {
      const closed = closeArchive(model)
      return { ...requestAction(closed.model, AppAction.OpenArchivedChat({ chatId })), commands: closed.commands }
    },
    ClickedRestoreChat: ({ chatId }) => requestAction(model, AppAction.RestoreChat({ chatId })),

    CompletedSideEffect: () => ({ model }),
  })
}

// OBSERVE (app/slice.ts): useGitHubRecentRepos's `[ghAuthStatus]` dependency

/**
 * GitHub's sign-in changed (the setup wizard just connected it): with the
 * list up, fetch again, as the hook's effect reran.
 *
 * A change on a projects page before the list is up is owed to the list's
 * mount instead. React's list was up by then: its root subscribes
 * `local-projects`, which gates the list, ahead of `provider-auth`, so the
 * sign-in landed under a mounted list and made a second request. This root
 * subscribes them the other way round, and draws a frame later, so the
 * sign-in can land first; the boot still sends React's two requests.
 */
export const observe: SliceObserve<Model, Message> = (model, previousApp, app) => {
  const status = ghAuthStatus(app)
  if (model.reposFetchedFor !== null) {
    if (status === model.reposFetchedFor) return { model }
    const version = model.reposRequestVersion + 1
    return {
      model: { ...model, reposRequestVersion: version, reposFetchedFor: status },
      commands: [FetchRecentRepos({ version })],
    }
  }
  const onPage = isProjectsRoute(app) && !(model.pageMounted && model.environment.preview !== null)
  if (model.signInChangedBeforeList || !onPage || status === ghAuthStatus(previousApp)) return { model }
  return { model: { ...model, signInChangedBeforeList: true } }
}

function isProjectsRoute(app: AppModel) {
  const route = app.route._tag
  return route === "Root" || route === "Home" || route === "Project"
}

/** The dialog leaves with the page: no exit to wait for. */
function closeArchiveNow(model: Model): Pick<Model, "archive" | "archiveDialog"> {
  return { archive: null, archiveDialog: Dialog.init({ id: model.archiveDialog.id }) }
}
