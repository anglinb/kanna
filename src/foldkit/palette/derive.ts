import type { Html, HtmlBuilder } from "foldkit/html"
import {
  computeSidebarThreadSections,
  computeThreadSections,
  flattenSidebarThreads,
  flattenVisibleProjectGroups,
  getSettingsPaletteEntries,
  scorePaletteItem,
  searchLocalProjects,
  searchProjects,
  searchSettingsEntries,
  searchThreadsByTitle,
  type SidebarThread,
} from "./search"
import { buildSettingsCommands, type SettingsCommandEffect } from "./settingsCommands"
import { delegatorDisplayTitle, projectDelegators, resolveDelegateTarget } from "../../client/lib/delegators"
import { formatSidebarAgeLabel, getPathBasename } from "../../client/lib/formatters"
import { getBindingsForAction } from "../../client/lib/keybindings"
import { formatPathWithTilde } from "../../client/lib/pathUtils"
import {
  abbreviateHomePath,
  classifyBrowserInput,
  filterDirEntries,
  isValidNewProjectName,
  joinDirPath,
  parseRepoRef,
  parseRepoRefFromUrl,
  pathBasename,
  type RepoRef,
} from "../../client/lib/project-fs"
import { filterProjects, getLocalProjectTitle, groupProjectsByRecency, groupProjectsForNewChat } from "../../client/lib/project-groups"
import { listedThreads } from "../../client/lib/thread-sections"
import type { ChatMode, ClaudeContextWindow, FsDirEntry, KeybindingAction, SidebarData } from "../../shared/types"
import { AppAction } from "../app/action"
import type { AppModel } from "../app/slice"
import * as Stores from "../app/stores"
import * as ChatInput from "../core/stores/chatInput"
import * as Delegate from "../core/stores/delegate"
import * as FocusMode from "../core/stores/focusMode"
import * as RightSidebar from "../core/stores/rightSidebar"
import * as SidebarView from "../core/stores/sidebarView"
import * as TerminalLayout from "../core/stores/terminalLayout"
import * as Viewer from "../core/stores/viewer"
import {
  Archive, Box, Brain, Check, CircleCheck, CircleDashed, Columns2, Copy, CornerDownRight, ExternalLink, EyeOff, File,
  Folder, FolderOpen, Gauge, GitBranch, GitFork, Hash, History, House, ListFilter, ListTodo, Loader2, Lock, LockOpen,
  MessageCircle, PanelLeft, PanelRight, Paperclip, Pin, PinOff, Plus, Settings2, Share2, Sparkles, SquareMenu,
  SquarePen, SquareTerminal, Terminal,
} from "../ui/icons"
import type { Icon } from "../ui/icon"
import { CHAT_MODE_LABELS, composerFor, type ComposerController } from "./composer"
import { block, effectiveSelection, group, item, type CmdkItem, type CmdkNode } from "./cmdk"
import * as Commands from "./commands"
import { activeChatId, activeProjectId, appSettings, availableProviders, isMac as machineIsMac, navbarLocalPath, paneChatKey, sidebarData, theme } from "./context"
import { DelegatorIcon, openAppIcon, providerIcon } from "./icons"
import { Message } from "./message"
import { currentPage, isLocked, pageKey, type Model, type PalettePage } from "./model"
import { getOpenAppItems, openAppAction } from "./openIn"
import {
  cloneProgressBlock,
  ICON_CLASS,
  paletteErrorRow,
  repoResultContent,
  rowSpinner,
  shortcutHint,
  titleSpan,
  trailingHint,
  trailingPath,
} from "./rows"
import { closeWith, newProjectsDir, pushPage, runProjectAction, startClone, withCommands, type Return } from "./steps"
import { DELEGATORS_GROUP_KEY, getProjectChatGroups, threadRowContent, type ThreadDetailScope } from "./threadRow"

// CommandPalette's render: everything it worked out from its state and the
// app's on each render (the `actions` memo, the result memos, the page's
// rows, firstResultValue, the footer), as one pure function of the palette's
// Model and the root's. update calls it to find what a key or click chose;
// the view calls it to draw the same list.

/** What choosing a row does. `byKey`: chosen with Enter rather than the pointer. */
export type Run = (byKey: boolean) => Return
export type Node = CmdkNode<Message, Run>
type Item = CmdkItem<Message, Run>
type IconRender = (h: HtmlBuilder<Message>) => Html

const icon = (Glyph: Icon, className = ICON_CLASS): IconRender => (h) => Glyph({ class: className }, h)

/**
 * How a Settings row ranks against the root's other results when typing. A
 * row only opens Settings, and its title is usually the bare setting name,
 * which outscores the command that flips it ("Chat Tabs" over "Enable Chat
 * Tabs"). Discounted, the command comes first and Enter does the thing.
 */
const ROOT_SETTINGS_RANK = 0.89

const MODE_COMMAND_ICONS: Record<ChatMode, Icon> = {
  "full-access": LockOpen,
  "plan": ListTodo,
  "auto-plan": Sparkles,
}

const MODE_COMMAND_KEYWORDS: Record<ChatMode, string[]> = {
  "full-access": ["execute", "yolo", "no approval"],
  "plan": ["review", "safe", "approve"],
  "auto-plan": ["automatic", "decide", "enter plan mode"],
}

/** The Add Project page's static rows (each pushes its own sub-page). */
const ADD_PROJECT_STATIC_ACTIONS = [
  { id: "clone-github", title: "Clone from GitHub…", keywords: ["repo", "git", "clone", "checkout"] },
  { id: "create-new", title: "Create New…", keywords: ["blank", "empty", "init", "new project", "start"] },
  { id: "choose-existing", title: "Choose Existing…", keywords: ["browse", "folder", "open", "filesystem", "directory", "path"] },
] as const

const SIDEBAR_VIEW_COMMANDS: { view: SidebarView.SidebarView; title: string; icon: Icon; keywords: string[] }[] = [
  { view: "recents", title: "Show Chats", icon: MessageCircle, keywords: ["recents", "chats view", "review", "in progress"] },
  { view: "projects", title: "Show Projects", icon: Folder, keywords: ["projects view", "folders"] },
  { view: "channels", title: "Show Channels", icon: Hash, keywords: ["channels view", "channel"] },
  { view: "archived", title: "Show Archived", icon: Archive, keywords: ["archived chats", "archive", "old chats"] },
]

/** Truncates from the head so the most specific path segments stay visible. */
export function truncatePathHead(path: string, maxLength = 40) {
  if (path.length <= maxLength) return path
  return `…${path.slice(path.length - (maxLength - 1))}`
}

interface PaletteAction {
  id: string
  title: string
  keywords: string[]
  icon: IconRender
  /** First keybinding rendered as a shortcut hint, e.g. "cmd+j". */
  shortcut?: string
  /** Muted trailing label (e.g. "Model", "Harness"). Ignored when `shortcut` is set. */
  hint?: string
  /** Only surfaced while the user is typing — keeps the empty-query list curated. */
  searchOnly?: boolean
  run: Run
}

export interface BrowseTarget {
  path: string
  name: string
  create?: boolean
}

export interface PaletteData {
  page: PalettePage | "root"
  trimmedQuery: string
  nodes: ReadonlyArray<Node>
  /** `<CommandEmpty>`, unless the page renders non-item content of its own. */
  empty: string | null
  placeholder: string
  /** The value of the first rendered result row (the selection reset's target). */
  firstResultValue: string
  /** The highlighted row: the controlled value, or cmdk's fallback to the first. */
  selected: string
  /** The ⌘C footer's path, for the highlighted row. */
  footerCopyPath: string | undefined
  /** The ⌘↵ footer's target, for the highlighted row (browse pages). */
  footerBrowseTarget: BrowseTarget | undefined
  isMac: boolean
  locked: boolean
  /** The Back button (and Backspace/Escape popping) is there. */
  canPop: boolean
  /** Opens the ⌘↵ footer's target as a project. */
  runBrowseTarget: (target: BrowseTarget) => Return
  /** The page's own fetch inputs, for update's effect checks. */
  effects: {
    pageKey: string
    browseDirPath: string | null
    typedRepo: RepoRef | null
    typedRepoEnabled: boolean
    typedRepoInputs: string
    createDir: string
  }
}

// A one-entry memo on the sidebar snapshot: every chat flattened, for a list
// that rebuilds on every keystroke.
let threadsMemo: { data: SidebarData; threads: SidebarThread[] } | null = null
function listThreads(data: SidebarData): SidebarThread[] {
  if (threadsMemo?.data !== data) threadsMemo = { data, threads: listedThreads(flattenSidebarThreads(data)) }
  return threadsMemo.threads
}

let settingsEntriesMemo: ReturnType<typeof getSettingsPaletteEntries> | null = null
function settingsEntries() {
  settingsEntriesMemo ??= getSettingsPaletteEntries()
  return settingsEntriesMemo
}

export function derive(model: Model, app: AppModel): PaletteData {
  const data = sidebarData(app)
  const page = currentPage(model)
  const query = model.query
  const trimmedQuery = query.trim()
  const locked = isLocked(model)
  const nowMs = model.nowMs
  const settings = appSettings(app)

  const chatId = activeChatId(app)
  const projectId = activeProjectId(app)
  const onChatPage = Boolean(chatId)
  const isMac = machineIsMac(app)
  const editorPreset = app.stores.terminalPreferences.editorPreset
  const editorCommandTemplate = app.stores.terminalPreferences.editorCommandTemplate
  const installedEditors = settings?.installedEditors ?? null
  const installedTerminals = settings?.installedTerminals ?? null
  const widgetsChatKey = paneChatKey(app, "widgets", chatId)
  const widgetsOpen = RightSidebar.widgetsOpen(app.stores.rightSidebar, projectId, widgetsChatKey)
  const focusModeEnabled = FocusMode.focusModeEnabled(app.stores.focusMode)
  const canShowPane = app.stores.viewer.chatPreviewHosts > 0
  const viewerShown = app.stores.rightSidebar.chatViewers[app.stores.viewer.chatKey] != null
  const composer = composerFor(app)
  const newDir = newProjectsDir(app)

  const close = (action: AppAction | null = null) => closeWith(model, action)
  const store = (message: Stores.Message) => AppAction.Store({ message })
  const navigate = (path: string) => AppAction.Navigate({ path, replace: false })
  const push = (target: PalettePage, path: string | null = null): Return => ({ model: pushPage(model, target, path) })
  const composerRun = (changes: Stores.Message[]): Run => () => closeWith(model, changes.length === 0 ? null : changes.length === 1 ? store(changes[0]!) : AppAction.Batch({ actions: changes.map(store) }))

  // The active chat's row plus the project group that owns it.
  let currentChatRow: SidebarData["projectGroups"][number]["chats"][number] | null = null
  let currentChatGroup: SidebarData["projectGroups"][number] | null = null
  if (chatId) {
    for (const projectGroup of data.projectGroups) {
      const row = projectGroup.chats.find((chat) => chat.chatId === chatId)
      if (row) {
        currentChatRow = row
        currentChatGroup = projectGroup
        break
      }
    }
  }

  const threads = listThreads(data)
  const paletteProjects = flattenVisibleProjectGroups(data.projectGroups)
  const projectDelegatorThreads = projectDelegators(threads, projectId)
  const delegatePreference = projectId ? app.stores.delegate.projects[projectId] : undefined
  const delegateTargetId = resolveDelegateTarget(projectDelegatorThreads, delegatePreference)?.chatId ?? null

  const currentProjectTitle = projectId
    ? data.projectGroups.find((projectGroup) => projectGroup.groupKey === projectId)?.title ?? null
    : null

  // The project the "Chats in <project>" sub-page browses.
  const projectChatsProjectId = model.projectChatsTargetId ?? projectId
  const projectChatsGroup = projectChatsProjectId
    ? data.projectGroups.find((projectGroup) => projectGroup.groupKey === projectChatsProjectId) ?? null
    : null
  const projectChatsTitle = projectChatsGroup?.title ?? null
  const projectChatsThreads = projectChatsProjectId
    ? threads
      .filter((thread) => thread.projectId === projectChatsProjectId)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    : []

  const openThread = (thread: SidebarThread): Run => () =>
    close(thread.archived ? AppAction.OpenArchivedChat({ chatId: thread.chatId }) : navigate(`/chat/${thread.chatId}`))

  const runSettingsEffect = (effect: SettingsCommandEffect): Return => {
    // A failed write already shows as the app's command error.
    const write = (patch: Parameters<typeof AppAction.WriteAppSettings>[0]["patch"]) => AppAction.WriteAppSettings({ patch })
    switch (effect.type) {
      case "theme":
        return close(write({ theme: effect.theme }))
      case "patch":
        return close(write(effect.patch))
      case "chatSounds": {
        const closed = close(write({ chatSoundPreference: effect.preference }))
        return effect.preference !== "never"
          ? withCommands(closed, Commands.PlayChatSound({ soundId: app.stores.chatSoundPreferences.chatSoundId }))
          : closed
      }
      case "notifications":
        return withCommands(close(), Commands.RequestNotificationPermission({ preference: effect.preference }))
      case "macLoginItem":
        return withCommands(close(), Commands.PostToMacApp({ message: { type: "macSetup.setLoginItem", enabled: effect.enabled } }))
      case "macOpenLoginItems":
        return withCommands(close(), Commands.PostToMacApp({ message: { type: "macSetup.openLoginItems" } }))
      case "macKeepAwake":
        return withCommands(close(), Commands.PostToMacApp({ message: { type: "macSetup.setKeepAwake", ...effect.change } }))
    }
  }

  const settingsCommands = buildSettingsCommands({ appSettings: settings, theme: theme(app), mac: model.mac })

  // THE ACTIONS

  const actions: PaletteAction[] = []
  const chatShortcuts = (action: KeybindingAction) => getBindingsForAction(app.keybindings, action)[0]

  if (projectId) {
    actions.push({
      id: "new-thread-current",
      title: currentProjectTitle ? `New Chat in ${currentProjectTitle}` : "New Chat in Current...",
      keywords: ["create chat", "compose", "start"],
      icon: icon(SquarePen),
      shortcut: chatShortcuts("createChatInCurrentProject"),
      run: () => close(AppAction.CreateChat({ projectId })),
    })
    actions.push({
      id: "project-chats",
      title: currentProjectTitle ? `Chats in ${currentProjectTitle}` : "Chats in Current Project…",
      keywords: ["threads", "history", "browse", "recent", "project chats"],
      icon: icon(History),
      // No explicit target: the sub-page falls back to the current project
      // and hides its "New Chat" row (the root already offers it).
      run: () => push("project-chats"),
    })
    // How a project gets its first delegator. Found by typing, as on iOS.
    actions.push({
      id: "new-delegator-current",
      title: currentProjectTitle ? `New Delegator in ${currentProjectTitle}…` : "New Delegator…",
      keywords: ["delegator", "delegate", "delegation", "delegated", "create delegator", "hand off", "orchestrate", "manager", "sub-chats", "subchats"],
      icon: (h) => DelegatorIcon({ class: ICON_CLASS }, h),
      searchOnly: true,
      // createDelegator: the root's prompt, then the server.
      run: () => close(AppAction.CreateDelegator({ projectId })),
    })
    // The new chat page's delegate control: where a message typed there goes.
    if (projectDelegatorThreads.length > 0) {
      for (const delegator of projectDelegatorThreads) {
        const title = delegatorDisplayTitle(delegator.title)
        actions.push({
          id: `delegate-to-${delegator.chatId}`,
          title: `Delegate to ${title}`,
          keywords: ["delegate", "delegator", "delegation", "hand off", "send to", title],
          icon: (h) => DelegatorIcon({ class: ICON_CLASS }, h),
          hint: delegator.chatId === delegateTargetId ? "Current delegator" : "New chats",
          searchOnly: true,
          run: () => close(store(Stores.Message.GotDelegateMessage({
            message: Delegate.Message.ChangedPreference({ projectId, preference: { on: true, chatId: delegator.chatId } }),
          }))),
        })
      }
      actions.push({
        id: "dont-delegate",
        title: "Don't Delegate",
        keywords: ["delegate", "delegator", "stop delegating", "no delegator", "new chat", "off"],
        icon: icon(SquarePen),
        hint: delegateTargetId ? "New chats" : "Current",
        searchOnly: true,
        // Keeps which one was last used, for turning it back on.
        run: () => close(store(Stores.Message.GotDelegateMessage({
          message: Delegate.Message.ChangedPreference({ projectId, preference: { on: false, chatId: app.stores.delegate.projects[projectId]?.chatId } }),
        }))),
      })
    }
  }

  // Focus mode narrows the sidebar to the current project. The exit variant
  // stays offered even with no current project.
  if (projectId || focusModeEnabled) {
    actions.push({
      id: "toggle-focus-mode",
      title: focusModeEnabled
        ? "Exit Focus Mode"
        : currentProjectTitle ? `Focus ${currentProjectTitle}` : "Focus Current Project",
      keywords: ["focus", "filter sidebar", "narrow", "only this project", "hide other projects", "single project"],
      icon: icon(ListFilter),
      shortcut: chatShortcuts("toggleFocusMode"),
      run: () => close(store(Stores.Message.GotFocusModeMessage({ message: FocusMode.Message.ChangedFocusMode({ enabled: !focusModeEnabled }) }))),
    })
  }

  if ((app.localProjects?.projects.length ?? 0) > 0) {
    actions.push({
      id: "new-thread-choose",
      title: "New Chat in…",
      keywords: ["create chat", "compose", "start", "project"],
      icon: icon(SquarePen),
      run: () => push("new-thread"),
    })
    actions.push({
      id: "hide-project-choose",
      title: "Hide",
      keywords: ["hide project", "remove project", "choose project"],
      icon: icon(EyeOff),
      run: () => push("hide-project"),
    })
  }

  actions.push({
    id: "new-project",
    title: "Add Project…",
    keywords: ["create", "add", "new", "open folder", "clone", "repo", "github"],
    icon: icon(Plus),
    shortcut: chatShortcuts("openAddProject"),
    run: () => push("add-project"),
  })

  // The three Add Project sub-actions are also directly searchable from the
  // root (surfaced only while typing).
  actions.push({
    id: "add-project-clone-github",
    title: "Clone from GitHub…",
    keywords: ["repo", "git", "clone", "checkout", "add project", "github"],
    icon: icon(GitBranch),
    searchOnly: true,
    run: () => push("clone-github"),
  })
  actions.push({
    id: "add-project-create-new",
    title: "Create New Project…",
    keywords: ["blank", "empty", "init", "new project", "start", "add project"],
    icon: icon(Plus),
    searchOnly: true,
    run: () => push("create-new"),
  })
  actions.push({
    id: "add-project-choose-existing",
    title: "Add Existing Project…",
    keywords: ["browse", "folder", "open", "filesystem", "directory", "path", "existing", "add project"],
    icon: icon(Folder),
    searchOnly: true,
    run: () => push("browse"),
  })

  actions.push({
    id: "go-home",
    title: "All Projects",
    keywords: ["home", "navigate", "local projects", "go to projects"],
    icon: icon(House),
    run: () => close(navigate("/")),
  })

  actions.push({
    id: "settings",
    title: "Settings…",
    keywords: ["preferences", "config", "options", "theme", "keybindings", "providers", "general"],
    icon: icon(Settings2),
    run: () => push("settings"),
  })

  actions.push({
    id: "usage",
    title: "Usage…",
    keywords: ["limits", "rate limit", "quota", "credits", "plan", "utilization", "claude", "codex", "grok"],
    icon: icon(Gauge),
    run: () => push("usage"),
  })

  // Settings that change outright: theme, the app-wide switches, This Mac.
  for (const command of settingsCommands) {
    actions.push({
      id: command.id,
      title: command.title,
      keywords: command.keywords,
      icon: icon(command.icon),
      searchOnly: command.searchOnly,
      run: () => runSettingsEffect(command.effect),
    })
  }

  // The sidebar's view switcher, which the New Sidebar has and the old one
  // doesn't. A collapsed sidebar opens, or the switch would show nothing.
  if (settings?.newSidebarEnabled !== false) {
    for (const command of SIDEBAR_VIEW_COMMANDS) {
      if (command.view === app.stores.sidebarView.view) continue
      actions.push({
        id: `sidebar-view-${command.view}`,
        title: command.title,
        keywords: ["sidebar", "view", "switch view", "filter", ...command.keywords],
        icon: icon(command.icon),
        searchOnly: true,
        run: () => {
          const viewChange = store(Stores.Message.GotSidebarViewMessage({ message: SidebarView.Message.ChangedView({ view: command.view }) }))
          return close(app.sidebarCollapsed && !model.phoneLayout ? AppAction.Batch({ actions: [viewChange, AppAction.ExpandSidebar()] }) : viewChange)
        },
      })
    }
  }

  if (!model.phoneLayout) {
    actions.push({
      id: "toggle-sidebar",
      title: app.sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar",
      keywords: ["sidebar", "left sidebar", "collapse", "expand", "panel", "toggle sidebar", "show", "hide"],
      icon: icon(PanelLeft),
      searchOnly: true,
      run: () => close(app.sidebarCollapsed ? AppAction.ExpandSidebar() : AppAction.CollapseSidebar()),
    })
  }

  if (onChatPage && projectId) {
    actions.push({
      id: "toggle-widgets",
      title: widgetsOpen ? "Hide Widgets" : "Show Widgets",
      // The widgets took over the git and browser panels, so their old
      // words still find the toggle.
      keywords: [
        "right sidebar", "panel", "git", "diff", "changes", "commit", "stage", "source control", "history", "log",
        "ports", "localhost", "servers", "browser", "todos", "agents", "subagents", "tasks", "monitors", "workflows", "attachments", "show", "hide",
      ],
      icon: icon(PanelRight),
      shortcut: chatShortcuts("toggleRightSidebar"),
      run: () => close(store(Stores.Message.GotRightSidebarMessage({ message: RightSidebar.Message.ToggledWidgets({ projectId, chatKey: widgetsChatKey }) }))),
    })
    const terminalChatKey = paneChatKey(app, "terminal", chatId)
    const terminalLayout = app.stores.terminalLayout.projects[projectId]
    const addTerminal = (): Return => withCommands(close(), Commands.MakeTerminalId({
      projectId,
      chatKey: terminalChatKey,
      nextTerminalIndex: terminalLayout?.nextTerminalIndex ?? 0,
    }))
    actions.push({
      id: "toggle-terminal",
      title: "Toggle Terminal",
      keywords: ["shell", "console", "embedded"],
      icon: icon(Terminal),
      shortcut: chatShortcuts("toggleEmbeddedTerminal"),
      run: () => !terminalLayout || terminalLayout.terminals.length === 0
        ? addTerminal()
        : close(store(Stores.Message.GotTerminalLayoutMessage({ message: TerminalLayout.Message.ToggledVisibility({ projectId, chatKey: terminalChatKey }) }))),
    })
    actions.push({
      id: "split-terminal",
      title: "Split Terminal",
      keywords: ["add terminal", "new terminal", "split", "pane", "shell", "console"],
      icon: icon(Columns2),
      shortcut: chatShortcuts("addSplitTerminal"),
      searchOnly: true,
      // Opens the terminal too, as the shortcut does (ChatPage).
      run: () => addTerminal(),
    })
    actions.push({
      id: "open-in",
      title: "Open in…",
      keywords: ["editor", "finder", "terminal", "external", "cursor", "xcode", "reveal"],
      icon: icon(ExternalLink),
      shortcut: chatShortcuts("openInEditor"),
      run: () => push("open-in"),
    })
    // Each destination is also a directly searchable action. Xcode and
    // Windsurf are intentionally omitted here; a few icons are swapped for
    // palette-specific ones (harness Cursor glyph, folder-open, terminal).
    const openInItems = getOpenAppItems({ editorPreset, isMac, installedEditors, installedTerminals })
      .filter((entry) => entry.installed && entry.value !== "editor:xcode" && entry.value !== "editor:windsurf")
    for (const entry of openInItems) {
      actions.push({
        id: `open-${entry.value}`,
        title: `Open in ${entry.label}`,
        keywords: ["open in", "editor", "external", "reveal", entry.label],
        icon: entry.value === "editor:cursor"
          ? (h) => providerIcon("cursor", ICON_CLASS, h)
          : entry.value === "finder"
            ? icon(FolderOpen)
            : entry.value === "terminal"
              ? icon(SquareTerminal)
              : (h) => openAppIcon(entry.value, isMac, ICON_CLASS, h),
        searchOnly: true,
        run: () => close(openAppAction(entry.value, editorCommandTemplate)),
      })
    }
    const projectPath = navbarLocalPath(app)
    if (projectPath) {
      actions.push({
        id: "copy-project-path",
        title: "Copy Path",
        keywords: ["copy project path", "clipboard", "directory", "folder", projectPath],
        icon: icon(Copy),
        hint: truncatePathHead(formatPathWithTilde(projectPath)),
        run: () => close(AppAction.CopyPath({ localPath: projectPath })),
      })
    }
  }

  // The navbar's button for a delegator: the list of its chats, in the pane.
  if (chatId && canShowPane && currentChatRow?.delegator) {
    const delegatorChatId = chatId
    actions.push({
      id: "toggle-delegated",
      title: viewerShown ? "Hide Delegated" : "Show Delegated",
      keywords: ["delegated", "delegator", "delegate", "sub-chats", "subchats", "sub chats", "chats", "list", "pane", "show", "hide", "toggle"],
      icon: (h) => DelegatorIcon({ class: ICON_CLASS }, h),
      run: (byKey) => close(store(Stores.Message.GotViewerMessage({
        message: app.stores.rightSidebar.chatViewers[delegatorChatId]
          ? Viewer.Message.ShutViewer({ byKey })
          : Viewer.Message.OpenedItem({ item: { kind: "delegated", chatId: delegatorChatId }, expanded: false, byKey }),
      }))),
    })
  }

  if (chatId) {
    actions.push({
      id: "share-chat",
      title: "Share Chat",
      keywords: ["export", "link", "standalone", "transcript"],
      icon: icon(Share2),
      run: () => close(AppAction.ShareChat({ chatId })),
    })
    if (currentChatRow && currentChatRow.canFork !== false) {
      const row = currentChatRow
      actions.push({
        id: "fork-chat",
        title: "Fork Chat",
        keywords: ["duplicate", "branch", "copy"],
        icon: icon(GitFork),
        run: () => close(AppAction.ForkChat({ chatId: row.chatId })),
      })
    }
    if (currentChatRow) {
      const chatRow = currentChatRow
      actions.push({
        id: "toggle-pin-chat",
        title: chatRow.pinnedAt ? "Unpin Chat" : "Pin Chat",
        keywords: ["pin", "unpin", "pinned", "keep", "favorite", "star", "top"],
        icon: icon(chatRow.pinnedAt ? PinOff : Pin),
        searchOnly: true,
        run: () => close(AppAction.TogglePinChat({ chatId: chatRow.chatId, pinned: !chatRow.pinnedAt })),
      })
      actions.push({
        id: "toggle-chat-done",
        title: chatRow.done ? "Mark Not Done" : "Mark Done",
        keywords: ["done", "finished", "complete", "resolve", "board", "not done", "reopen", "undone"],
        icon: icon(chatRow.done ? CircleDashed : CircleCheck),
        searchOnly: true,
        run: () => close(AppAction.SendCommand({ command: { type: "chat.setDone", chatId: chatRow.chatId, done: !chatRow.done } })),
      })
      // As the chat menu's item: Grok chats aren't given the chat tools, so
      // one can't start delegating, only stop.
      if (chatRow.delegator || chatRow.provider !== "grok") {
        actions.push({
          id: "toggle-delegator",
          title: chatRow.delegator ? "Stop Delegating" : "Make Delegator",
          keywords: ["delegator", "delegate", "delegation", "hand off", "orchestrate", "manager", "sub-chats", "subchats", "ordinary chat"],
          icon: (h) => DelegatorIcon({ class: ICON_CLASS }, h),
          hint: "Next turn",
          searchOnly: true,
          run: () => close(AppAction.SetDelegator({ chatId: chatRow.chatId, delegator: !chatRow.delegator })),
        })
      }
      actions.push({
        id: "archive-chat",
        title: "Archive Chat",
        keywords: ["hide", "close", "done"],
        icon: icon(Archive),
        run: () => close(AppAction.ArchiveChat({ chatId: chatRow.chatId })),
      })
    }
    if (currentChatGroup) {
      const chatGroup = currentChatGroup
      actions.push({
        id: "hide-project",
        title: `Hide ${chatGroup.title}`,
        keywords: ["hide", "project", "remove", "sidebar", chatGroup.title],
        icon: icon(EyeOff),
        run: () => close(AppAction.HideProject({ target: chatGroup.groupKey })),
      })
    }
  }

  if (onChatPage) {
    actions.push({
      id: "change-model",
      title: "Change Model…",
      keywords: ["llm", "switch", composer.effectiveState.model, composer.providerConfig?.label ?? ""],
      icon: icon(Box),
      run: () => push("models"),
    })
    if (composer.canChangeProvider && availableProviderCount(app, composer) > 1) {
      actions.push({
        id: "change-harness",
        title: "Switch Harness…",
        keywords: ["provider", "agent", "claude code", "codex", "cursor", "grok", "pi", "change provider"],
        icon: icon(Box),
        run: () => push("harness"),
      })
    }
    // Option controls come from the same availability registry that drives
    // the chat input's controls: nothing unavailable is ever offered.
    const { mode, fastMode, reasoning, contextWindow } = composer.optionControls
    if (mode) {
      for (const option of mode.options) {
        if (option === mode.selected) continue
        actions.push({
          id: `mode-${option}`,
          title: `Switch to ${CHAT_MODE_LABELS[option].label}`,
          keywords: ["mode", "permission", ...MODE_COMMAND_KEYWORDS[option]],
          icon: icon(MODE_COMMAND_ICONS[option]),
          run: composerRun(composer.setMode(option)),
        })
      }
    }
    if (fastMode) {
      actions.push(fastMode.enabled
        ? {
          id: "standard-mode",
          title: "Switch to Standard Mode",
          keywords: ["fast mode", "speed", "service tier"],
          icon: icon(Gauge, `${ICON_CLASS} -scale-x-100`),
          run: composerRun(composer.setFastMode(false)),
        }
        : {
          id: "fast-mode",
          title: "Switch to Fast Mode",
          keywords: ["standard", "speed", "service tier"],
          icon: icon(Gauge),
          run: composerRun(composer.setFastMode(true)),
        })
    }
    if (reasoning) {
      for (const option of reasoning.options) {
        if (option.disabled) continue
        const isCurrent = reasoning.selectedId === option.id
        actions.push({
          id: `set-reasoning-${option.id}`,
          title: `Reasoning: ${option.label}`,
          keywords: ["reasoning", "effort", "thinking", option.id],
          icon: icon(Brain),
          hint: isCurrent ? "Current effort" : option.description ?? "Reasoning effort",
          searchOnly: true,
          run: composerRun(composer.setReasoningEffort(option.id)),
        })
      }
    }
    if (contextWindow) {
      for (const option of contextWindow.options) {
        const isCurrent = contextWindow.selectedId === option.id
        actions.push({
          id: `set-context-${option.id}`,
          title: `Context Window: ${option.label}`,
          keywords: ["context window", "context length", "tokens", option.id],
          icon: icon(SquareMenu),
          hint: isCurrent ? "Current window" : "Context window",
          searchOnly: true,
          run: composerRun(composer.setContextWindow(option.id as ClaudeContextWindow)),
        })
      }
    }
    actions.push({
      id: "attach-files",
      title: "Attach Files",
      keywords: ["upload", "image", "screenshot", "paperclip", "add attachment"],
      icon: icon(Paperclip),
      run: () => withCommands(close(), Commands.RequestAttachFiles()),
    })

    // Direct model/harness switches, surfaced only while typing.
    const providerLabel = composer.providerConfig?.label ?? composer.selectedProvider
    for (const option of composer.models) {
      const isCurrent = composer.effectiveState.model === option.id
      actions.push({
        id: `set-model-${option.id}`,
        title: option.label,
        keywords: [option.id, "model", "switch model", providerLabel],
        icon: icon(Box),
        hint: isCurrent ? "Current model" : `${providerLabel} model`,
        searchOnly: true,
        run: composerRun(composer.selectModel(option.id)),
      })
    }
    if (composer.canChangeProvider) {
      for (const provider of providerList(app)) {
        if (provider.id === composer.selectedProvider) continue
        actions.push({
          id: `set-harness-${provider.id}`,
          title: `Switch to ${provider.label}`,
          keywords: [provider.id, "harness", "provider", "agent"],
          icon: (h) => providerIcon(provider.id, ICON_CLASS, h),
          hint: "Harness",
          searchOnly: true,
          run: composerRun(composer.selectProvider(provider.id)),
        })
      }
    }
  }

  // RESULTS

  const rankedActions = !trimmedQuery
    ? actions.filter((action) => !action.searchOnly).map((action) => ({ action, score: 1 }))
    : actions
      .map((action) => ({ action, score: scorePaletteItem(trimmedQuery, action.title, action.keywords) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)

  const settingsResults = page !== "settings"
    ? []
    : !trimmedQuery ? settingsEntries() : searchSettingsEntries(settingsEntries(), trimmedQuery, settingsEntries().length)

  // Settings rows also answer a search from the root, as their own group.
  const rootSettingsResults = page !== "root" || !trimmedQuery ? [] : searchSettingsEntries(settingsEntries(), trimmedQuery, 5)

  // Empty-query root sections: the sidebar's top sections' logic.
  const sections = trimmedQuery ? null : computeThreadSections(threads)
  const reviewResults = (sections?.review ?? []).map((thread) => ({ ...thread, score: 1 }))
  const inProgressResults = (sections?.inProgress ?? []).map((thread) => ({ ...thread, score: 1 }))
  const threadResults = trimmedQuery
    ? searchThreadsByTitle(threads, trimmedQuery)
    : (sections?.recent ?? []).map((thread) => ({ ...thread, score: 1 }))

  const projectSearchResults = trimmedQuery ? searchProjects(paletteProjects, trimmedQuery) : []

  // Search-only "All Projects" group: everything the "/" route lists, minus
  // the ones already in the Projects group above.
  const allProjectSearchResults = (() => {
    if (page !== "root" || !trimmedQuery) return []
    const shown = new Set(projectSearchResults.map((project) => project.localPath))
    for (const project of paletteProjects) shown.add(project.localPath)
    return searchLocalProjects(app.localProjects?.projects ?? [], trimmedQuery, shown)
  })()

  const modelResults = page !== "models"
    ? []
    : !trimmedQuery
      ? composer.models
      : composer.models
        .map((option) => ({ option, score: scorePaletteItem(trimmedQuery, option.label, [option.id]) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.option)

  const harnessResults = page !== "harness"
    ? []
    : !trimmedQuery
      ? providerList(app)
      : providerList(app)
        .map((provider) => ({ provider, score: scorePaletteItem(trimmedQuery, provider.label, [provider.id]) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.provider)

  // "Chats in <project>", empty query: the sidebar Chats tab's grouping.
  const projectChatSections = page !== "project-chats" || trimmedQuery ? null : computeSidebarThreadSections(projectChatsThreads, nowMs)
  // Typing on the sub-page collapses the groups into fuzzy search results.
  const projectChatResults = page !== "project-chats" || !trimmedQuery
    ? []
    : searchThreadsByTitle(projectChatsThreads, trimmedQuery, projectChatsThreads.length)

  const openInResults = (() => {
    if (page !== "open-in") return []
    const entries = getOpenAppItems({ editorPreset, isMac, installedEditors, installedTerminals }).filter((entry) => entry.installed)
    if (!trimmedQuery) return entries
    return entries
      .map((entry) => ({ entry, score: scorePaletteItem(trimmedQuery, entry.label) }))
      .filter((scored) => scored.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((scored) => scored.entry)
  })()

  // ADD PROJECT PAGES

  // Root: a full GitHub/GitLab URL (never `owner/repo` shorthand) surfaces a "Clone owner/repo" row.
  const rootCloneRepo = page === "root" && trimmedQuery ? parseRepoRefFromUrl(trimmedQuery) : null
  // Add Project page: URL or shorthand both work here.
  const addProjectRepo = page === "add-project" && trimmedQuery ? parseRepoRef(trimmedQuery) : null

  const addProjectActionRows = page !== "add-project"
    ? []
    : !trimmedQuery
      ? [...ADD_PROJECT_STATIC_ACTIONS]
      : ADD_PROJECT_STATIC_ACTIONS
        .map((action) => ({ action, score: scorePaletteItem(trimmedQuery, action.title, [...action.keywords]) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.action)

  const localProjectGroups = (() => {
    if (page !== "add-project" && page !== "new-thread" && page !== "hide-project") return []
    if (page === "new-thread") {
      return groupProjectsForNewChat({
        projects: app.localProjects?.projects ?? [],
        projectGroups: data.projectGroups,
        currentProjectId: currentChatGroup?.groupKey ?? projectId,
        search: trimmedQuery,
        pendingSendTimes: app.stores.pendingSend.sentAt,
        nowMs,
      })
    }
    return groupProjectsByRecency(filterProjects(app.localProjects?.projects ?? [], trimmedQuery), nowMs)
  })()

  const githubRepos = model.githubRepos
  const githubRepoResults = page !== "clone-github" || !githubRepos?.available
    ? []
    : !trimmedQuery
      ? githubRepos.repos
      : githubRepos.repos
        .map((repo) => ({ repo, score: scorePaletteItem(trimmedQuery, repo.nameWithOwner, repo.description ? [repo.description] : []) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.repo)

  // A typed repo ref that isn't in the listed repos gets its own result row.
  const cloneTypedRepo = (() => {
    if (page !== "clone-github" || !trimmedQuery) return null
    const repo = parseRepoRef(trimmedQuery)
    if (!repo) return null
    const key = `${repo.owner}/${repo.repo}`.toLocaleLowerCase()
    if (githubRepoResults.some((listed) => listed.nameWithOwner.toLocaleLowerCase() === key)) return null
    return repo
  })()

  const createName = page === "create-new" ? trimmedQuery : ""
  const createNameValid = isValidNewProjectName(createName)
  const createNames = model.createDirNames
  const createNameExists = createNameValid && createNames !== null && createNames.includes(createName.toLocaleLowerCase())

  // BROWSE

  const browser = model.browser
  const browseDir = page === "browse" ? browser.dir : null
  // In browse mode the input is a filter or a path jump.
  const browseInputMode = page === "browse" && classifyBrowserInput(query) === "path" ? "path" : "filter"
  const visibleBrowseEntries: FsDirEntry[] = browseDir ? filterDirEntries(browseDir.entries, browseInputMode === "filter" ? query : "") : []
  const browseHasExactDirMatch = visibleBrowseEntries.some(
    (entry) => entry.kind === "dir" && entry.name.toLocaleLowerCase() === trimmedQuery.toLocaleLowerCase(),
  )
  // No exact folder match for the filter → offer to create (and open) it.
  const browseCreateVisible = page === "browse"
    && browseInputMode === "filter"
    && trimmedQuery.length > 0
    && !browseHasExactDirMatch
    && browseDir !== null
    && !browser.error

  const browseOpenTargets = new Map<string, BrowseTarget>()
  if (page === "browse" && browseDir) {
    browseOpenTargets.set("browse-open-current", { path: browseDir.path, name: pathBasename(browseDir.path) || browseDir.path })
    for (const entry of visibleBrowseEntries) {
      if (entry.kind !== "dir") continue
      browseOpenTargets.set(`browse-dir-${entry.name}`, { path: joinDirPath(browseDir.path, entry.name), name: entry.name })
    }
    if (browseCreateVisible) {
      browseOpenTargets.set("browse-create", { path: joinDirPath(browseDir.path, trimmedQuery), name: trimmedQuery, create: true })
    }
  }

  const runBrowseTarget = (target: BrowseTarget): Return => runProjectAction(model, `browse-open:${target.path}`, {
    mode: target.create ? "create" : "existing",
    localPath: target.path,
    title: pathBasename(target.path) || target.name,
  })

  // FIRST RESULT

  const projectChatSectionThreads = projectChatSections
    ? [
      ...projectChatSections.pinned,
      ...projectChatSections.delegators,
      ...projectChatSections.inProgress,
      ...projectChatSections.review,
      ...projectChatSections.relevant,
      ...projectChatSections.buckets.flatMap((bucket) => bucket.threads),
      ...projectChatSections.archived,
    ]
    : []

  const firstResultValue = ((): string => {
    switch (page) {
      case "models":
        return modelResults[0] ? `model-${modelResults[0].id}` : ""
      case "harness":
        return harnessResults[0] ? `harness-${harnessResults[0].id}` : ""
      case "settings":
        return settingsResults[0] ? `setting-${settingsResults[0].id}` : ""
      case "open-in":
        return openInResults[0] ? `open-${openInResults[0].value}` : ""
      case "new-thread":
      case "hide-project":
        if (localProjectGroups[0]?.projects[0]) return `local-project-${localProjectGroups[0].projects[0].localPath}`
        if (page === "hide-project") return ""
        return !trimmedQuery || scorePaletteItem(trimmedQuery, "Add Project…", ["create", "add", "new"]) > 0 ? "project-new" : ""
      case "project-chats": {
        if (trimmedQuery) return projectChatResults[0] ? `thread-${projectChatResults[0].chatId}` : ""
        if (model.projectChatsTargetId !== null) return "project-chats-new"
        const firstThread = projectChatSectionThreads[0]
        return firstThread ? `thread-${firstThread.chatId}` : ""
      }
      case "usage":
        return ""
      case "add-project": {
        if (addProjectRepo) return "clone-inline"
        if (addProjectActionRows[0]) return `add-action-${addProjectActionRows[0].id}`
        const firstProject = localProjectGroups[0]?.projects[0]
        return firstProject ? `local-project-${firstProject.localPath}` : ""
      }
      case "clone-github":
        if (model.cloneRun && model.cloneRun.status !== "error") return ""
        if (cloneTypedRepo) return "clone-typed"
        return githubRepoResults[0] ? `gh-repo-${githubRepoResults[0].nameWithOwner}` : ""
      case "create-new":
        return createNameValid ? "create-new-row" : ""
      case "browse": {
        if (browseInputMode === "path") return "browse-jump"
        // Filter typing highlights the first folder match (Enter drills); the
        // create row when nothing matches; the pinned "Open <dir>" row only
        // when the directory has no folders at all.
        const firstDir = visibleBrowseEntries.find((entry) => entry.kind === "dir")
        if (trimmedQuery) {
          if (firstDir) return `browse-dir-${firstDir.name}`
          return browseCreateVisible ? "browse-create" : "browse-open-current"
        }
        return firstDir ? `browse-dir-${firstDir.name}` : "browse-open-current"
      }
    }
    if (trimmedQuery) {
      return [
        { value: rootCloneRepo ? "root-clone" : null, score: rootCloneRepo ? Infinity : -Infinity },
        { value: rankedActions[0] ? `action-${rankedActions[0].action.id}` : null, score: rankedActions[0]?.score ?? -Infinity },
        { value: projectSearchResults[0] ? `palette-project-${projectSearchResults[0].localPath}` : null, score: projectSearchResults[0]?.score ?? -Infinity },
        { value: threadResults[0] ? `thread-${threadResults[0].chatId}` : null, score: threadResults[0]?.score ?? -Infinity },
        { value: allProjectSearchResults[0] ? `all-project-${allProjectSearchResults[0].localPath}` : null, score: allProjectSearchResults[0]?.score ?? -Infinity },
        { value: rootSettingsResults[0] ? `setting-${rootSettingsResults[0].id}` : null, score: rootSettingsResults[0] ? rootSettingsResults[0].score * ROOT_SETTINGS_RANK : -Infinity },
      ]
        .filter((candidate) => candidate.value !== null)
        .sort((left, right) => right.score - left.score)[0]?.value ?? ""
    }
    const firstThread = reviewResults[0] ?? inProgressResults[0] ?? threadResults[0]
    if (firstThread) return `thread-${firstThread.chatId}`
    if (rankedActions[0]) return `action-${rankedActions[0].action.id}`
    return ""
  })()

  // COPY PATH

  const copyPathByValue = new Map<string, string>()
  for (const thread of [...reviewResults, ...inProgressResults, ...threadResults, ...projectChatSectionThreads, ...projectChatResults]) {
    copyPathByValue.set(`thread-${thread.chatId}`, thread.row.localPath)
  }
  for (const project of projectSearchResults) copyPathByValue.set(`palette-project-${project.localPath}`, project.localPath)
  for (const project of allProjectSearchResults) copyPathByValue.set(`all-project-${project.localPath}`, project.localPath)
  if (page === "project-chats" && model.projectChatsTargetId !== null && projectChatsGroup) {
    copyPathByValue.set("project-chats-new", projectChatsGroup.localPath)
    copyPathByValue.set("project-chats-copy-path", projectChatsGroup.localPath)
  }
  if (page === "new-thread" || page === "hide-project") {
    for (const projectGroup of localProjectGroups) {
      for (const project of projectGroup.projects) copyPathByValue.set(`local-project-${project.localPath}`, project.localPath)
    }
  }

  // ROWS

  const pendingActionValue = model.pendingActionValue
  const startingLocalPath = app.actions.startingLocalPath

  const threadItem = (thread: SidebarThread, showStatus: boolean, scope: ThreadDetailScope, delegatorMark = true): Item =>
    item<Message, Run>(`thread-${thread.chatId}`, (h) => threadRowContent(thread, {
      showStatus,
      hasDraft: ChatInput.chatHasDraft(app.stores.chatInput, thread.chatId),
      delegatorMark,
      scope,
      nowMs,
    }, h), openThread(thread))

  const settingsItem = (entry: { id: string; title: string; sectionLabel: string; path: string }): Item =>
    item<Message, Run>(`setting-${entry.id}`, (h) => [
      Settings2({ class: ICON_CLASS }, h),
      titleSpan([entry.title], h),
      trailingHint(entry.sectionLabel, h),
    ], () => close(navigate(entry.path)))

  const errorBlock = (key: string, message: string) => block<Message>(key, (h) => paletteErrorRow(message, h))

  const localProjectRow = (project: { localPath: string; title: string; sidebarTitle?: string }, run: Run): Item => {
    const value = `local-project-${project.localPath}`
    const busy = pendingActionValue === value || startingLocalPath === project.localPath
    return item<Message, Run>(value, (h) => [
      Folder({ class: ICON_CLASS }, h),
      titleSpan([getLocalProjectTitle(project as Parameters<typeof getLocalProjectTitle>[0])], h),
      busy ? rowSpinner(h) : trailingPath(formatPathWithTilde(project.localPath), h),
    ], run)
  }

  const nodes: Node[] = []

  if (page === "root") {
    const reviewGroup = reviewResults.length > 0
      ? group<Message, Run>("review", "Review", reviewResults.map((thread) => threadItem(thread, true, "cross-project")))
      : null
    const inProgressGroup = inProgressResults.length > 0
      ? group<Message, Run>("in-progress", "In Progress", inProgressResults.map((thread) => threadItem(thread, true, "cross-project")))
      : null
    const threadsGroup = threadResults.length > 0
      ? group<Message, Run>("threads", trimmedQuery ? "Chats" : "Recents", threadResults.map((thread) => threadItem(thread, !trimmedQuery, "cross-project")))
      : null
    const actionsGroup = rankedActions.length > 0
      ? group<Message, Run>("actions", "Actions", rankedActions.map(({ action }) => item<Message, Run>(`action-${action.id}`, (h) => [
        action.icon(h),
        titleSpan([action.title], h),
        ...(action.shortcut ? [shortcutHint(action.shortcut, h)] : action.hint ? [trailingHint(action.hint, h)] : []),
      ], action.run)))
      : null
    // One row per matched project: starts a new chat in it.
    const projectsGroup = projectSearchResults.length > 0
      ? group<Message, Run>("projects", "Projects", projectSearchResults.map((project) => item<Message, Run>(`palette-project-${project.localPath}`, (h) => [
        Folder({ class: ICON_CLASS }, h),
        titleSpan([project.title], h),
        trailingPath(formatPathWithTilde(project.localPath), h),
      ], () => close(AppAction.CreateChat({ projectId: project.projectId })))))
      : null
    // Every other project on the machine: opens it and starts a chat.
    const allProjectsGroup = allProjectSearchResults.length > 0
      ? group<Message, Run>("all-projects", "All Projects", allProjectSearchResults.map((project) => {
        const value = `all-project-${project.localPath}`
        const busy = pendingActionValue === value || startingLocalPath === project.localPath
        return item<Message, Run>(value, (h) => [
          Folder({ class: ICON_CLASS }, h),
          titleSpan([project.title], h),
          busy ? rowSpinner(h) : trailingPath(formatPathWithTilde(project.localPath), h),
        ], () => close(AppAction.OpenLocalProject({ localPath: project.localPath })))
      }))
      : null
    const settingsGroup = rootSettingsResults.length > 0
      ? group<Message, Run>("settings", "Settings", rootSettingsResults.map(settingsItem))
      : null
    // A pasted repo URL gets a pinned "Clone owner/repo" row.
    const cloneGroup = rootCloneRepo
      ? group<Message, Run>("clone", undefined, [item<Message, Run>("root-clone", (h) => [
        GitBranch({ class: ICON_CLASS }, h),
        titleSpan([`Clone ${rootCloneRepo.owner}/${rootCloneRepo.repo}`], h),
        trailingPath(formatPathWithTilde(joinDirPath(newDir, rootCloneRepo.repo)), h),
      ], () => startClone(model, app, rootCloneRepo))])
      : null

    if (!trimmedQuery) {
      // Empty query = quick switcher: Review, In Progress, Recents, Actions.
      for (const node of [reviewGroup, inProgressGroup, threadsGroup, actionsGroup]) if (node) nodes.push(node)
    } else {
      // Typing = groups ordered by their best match; ties keep the declared
      // order (actions, projects, threads) via stable sort.
      if (cloneGroup) nodes.push(cloneGroup)
      const ranked = [
        { node: actionsGroup, topScore: rankedActions[0]?.score ?? 0 },
        { node: projectsGroup, topScore: projectSearchResults[0]?.score ?? 0 },
        { node: threadsGroup, topScore: threadResults[0]?.score ?? 0 },
        { node: allProjectsGroup, topScore: allProjectSearchResults[0]?.score ?? 0 },
        { node: settingsGroup, topScore: (rootSettingsResults[0]?.score ?? 0) * ROOT_SETTINGS_RANK },
      ]
        .filter((entry) => entry.node !== null)
        .sort((left, right) => right.topScore - left.topScore)
      for (const entry of ranked) nodes.push(entry.node!)
      if (model.actionError) nodes.push(errorBlock("root-error", model.actionError))
    }
  }

  if (page === "settings") {
    nodes.push(group<Message, Run>("settings-page", "Settings", settingsResults.map(settingsItem)))
  }

  if (page === "models") {
    nodes.push(group<Message, Run>("models", `${composer.providerConfig?.label ?? "Provider"} Models`, modelResults.map((option) => item<Message, Run>(`model-${option.id}`, (h) => [
      Box({ class: ICON_CLASS }, h),
      titleSpan([option.label], h),
      ...(composer.effectiveState.model === option.id ? [Check({ class: "ml-auto h-4 w-4 text-muted-foreground" }, h)] : []),
    ], composerRun(composer.selectModel(option.id))))))
  }

  if (page === "harness") {
    nodes.push(group<Message, Run>("harness", "Harness", harnessResults.map((provider) => item<Message, Run>(`harness-${provider.id}`, (h) => [
      providerIcon(provider.id, ICON_CLASS, h),
      titleSpan([provider.label], h),
      ...(composer.selectedProvider === provider.id ? [Check({ class: "ml-auto h-4 w-4 text-muted-foreground" }, h)] : []),
    ], composerRun(composer.selectProvider(provider.id))))))
  }

  if (page === "new-thread" || page === "hide-project") {
    for (const projectGroup of localProjectGroups) {
      nodes.push(group<Message, Run>(`local:${projectGroup.key}`, projectGroup.title, projectGroup.projects.map((project) => localProjectRow(project, () => {
        if (page === "hide-project") return close(AppAction.HideProject({ target: { localPath: project.localPath } }))
        // Closes at once rather than spinning on the row: the new chat opens
        // as soon as the server makes it. A project already in the sidebar
        // skips `project.open`.
        const knownProjectId = data.projectGroups.find((projectGroupEntry) => projectGroupEntry.localPath === project.localPath)?.groupKey
        return close(knownProjectId ? AppAction.CreateChat({ projectId: knownProjectId }) : AppAction.OpenLocalProject({ localPath: project.localPath }))
      }))))
    }
    if (page === "new-thread" && (!trimmedQuery || scorePaletteItem(trimmedQuery, "Add Project…", ["create", "add", "new"]) > 0)) {
      nodes.push(group<Message, Run>("project-new", undefined, [item<Message, Run>("project-new", (h) => [
        Plus({ class: ICON_CLASS }, h),
        h.span([], ["Add Project…"]),
      ], () => push("add-project"))]))
    }
    if (model.actionError) nodes.push(errorBlock("local-error", model.actionError))
  }

  if (page === "project-chats") {
    // "New Chat" leads only when the sub-page was entered by picking a project.
    if (model.projectChatsTargetId !== null) {
      const rows: Item[] = [item<Message, Run>("project-chats-new", (h) => [
        SquarePen({ class: ICON_CLASS }, h),
        h.span([], ["New Chat"]),
        ...(projectChatsGroup ? [trailingPath(formatPathWithTilde(projectChatsGroup.localPath), h)] : []),
      ], () => close(projectChatsProjectId ? AppAction.CreateChat({ projectId: projectChatsProjectId }) : null))]
      if (projectChatsGroup) {
        rows.push(item<Message, Run>("project-chats-copy-path", (h) => [
          Copy({ class: ICON_CLASS }, h),
          h.span([], ["Copy Path"]),
          trailingPath(formatPathWithTilde(projectChatsGroup.localPath), h),
        ], () => close(AppAction.CopyPath({ localPath: projectChatsGroup.localPath }))))
      }
      nodes.push(group<Message, Run>("project-chats-head", undefined, rows))
    }
    if (projectChatSections) {
      // Browsing: the sidebar Chats tab's grouping, as flat headed groups.
      for (const chatGroup of getProjectChatGroups(projectChatsThreads, nowMs)) {
        nodes.push(group<Message, Run>(`chats:${chatGroup.key}`, chatGroup.label, chatGroup.threads.map((thread) =>
          threadItem(thread, true, "project-scoped", chatGroup.key !== DELEGATORS_GROUP_KEY))))
      }
    } else {
      nodes.push(group<Message, Run>("project-chat-results", projectChatsTitle ? `Chats in ${projectChatsTitle}` : "Project Chats",
        projectChatResults.map((thread) => threadItem(thread, true, "project-scoped"))))
    }
  }

  if (page === "open-in") {
    nodes.push(group<Message, Run>("open-in", "Open Project In", openInResults.map((entry) => item<Message, Run>(`open-${entry.value}`, (h) => [
      openAppIcon(entry.value, isMac, "h-4 w-4", h),
      h.span([], [entry.label]),
    ], () => close(openAppAction(entry.value, editorCommandTemplate))))))
  }

  if (page === "add-project") {
    if (addProjectRepo) {
      nodes.push(group<Message, Run>("add-clone", undefined, [item<Message, Run>("clone-inline", (h) => [
        GitBranch({ class: ICON_CLASS }, h),
        titleSpan([`Clone ${addProjectRepo.owner}/${addProjectRepo.repo}`], h),
        trailingPath(formatPathWithTilde(joinDirPath(newDir, addProjectRepo.repo)), h),
      ], () => startClone(model, app, addProjectRepo))]))
    }
    if (addProjectActionRows.length > 0) {
      nodes.push(group<Message, Run>("add-actions", "Add Project", addProjectActionRows.map((action) => item<Message, Run>(`add-action-${action.id}`, (h) => [
        (action.id === "clone-github" ? GitBranch : action.id === "create-new" ? Plus : Folder)({ class: ICON_CLASS }, h),
        h.span([], [action.title]),
      ], () => push(action.id === "clone-github" ? "clone-github" : action.id === "create-new" ? "create-new" : "browse")))))
    }
    for (const projectGroup of localProjectGroups) {
      nodes.push(group<Message, Run>(`local:${projectGroup.key}`, projectGroup.title, projectGroup.projects.map((project) =>
        localProjectRow(project, () => runProjectAction(model, `local-project-${project.localPath}`, {
          mode: "existing",
          localPath: project.localPath,
          title: getPathBasename(project.localPath),
        })))))
    }
    if (model.actionError) nodes.push(errorBlock("add-error", model.actionError))
  }

  if (page === "clone-github") {
    const cloneRun = model.cloneRun
    if (cloneRun && cloneRun.status !== "error") {
      const status = cloneRun.status
      nodes.push(block<Message>("clone-progress", (h) => cloneProgressBlock({ repo: cloneRun.repo, status, destinationLabel: cloneRun.destinationLabel }, h)))
    } else {
      if (cloneTypedRepo) {
        const meta = model.repoMetadata
        nodes.push(group<Message, Run>("clone-typed-group", undefined, [item<Message, Run>("clone-typed", (h) => [repoResultContent({
          repo: cloneTypedRepo,
          meta: meta.meta,
          metaLoading: meta.loading,
          metaError: meta.error,
          destinationLabel: formatPathWithTilde(joinDirPath(newDir, cloneTypedRepo.repo)),
        }, h)], () => startClone(model, app, cloneTypedRepo))]))
      }
      if (model.githubReposLoading && !githubRepos) {
        nodes.push(block<Message>("gh-loading", (h) => h.div([h.Class("flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground")], [
          Loader2({ class: "h-4 w-4 animate-spin" }, h),
          " Loading your repositories…",
        ])))
      }
      if (githubRepos && !githubRepos.available) {
        nodes.push(block<Message>("gh-signin", (h) => h.div([h.Class("px-4 py-3 text-sm text-muted-foreground")], [
          "Run ",
          h.code([h.Class("rounded border border-border bg-muted px-1 py-0.5 font-mono text-xs")], ["gh auth login"]),
          " to see your repositories here — or paste any repository URL to clone it.",
        ])))
      }
      if (githubRepoResults.length > 0) {
        nodes.push(group<Message, Run>("gh-repos", "Recent Repositories", githubRepoResults.map((repo) => {
          const repoName = repo.nameWithOwner.split("/")[1] ?? repo.nameWithOwner
          return item<Message, Run>(`gh-repo-${repo.nameWithOwner}`, (h) => [
            (repo.isPrivate ? Lock : GitBranch)({ class: ICON_CLASS }, h),
            h.span([h.Class("shrink-0")], [repo.nameWithOwner]),
            ...(repo.description ? [h.span([h.Class("min-w-0 truncate text-xs text-muted-foreground")], [repo.description])] : []),
            h.span([h.Class("ml-auto shrink-0 pl-3 text-xs text-muted-foreground")], [
              repo.pushedAt ? formatSidebarAgeLabel(Date.parse(repo.pushedAt), nowMs) ?? "" : "",
            ]),
          ], () => startClone(model, app, {
            host: "github.com",
            owner: repo.owner,
            repo: repoName,
            cloneUrl: `https://github.com/${repo.nameWithOwner}.git`,
          }))
        })))
      }
      if (cloneRun?.status === "error" && cloneRun.error) nodes.push(errorBlock("clone-error", cloneRun.error))
    }
  }

  if (page === "create-new") {
    if (!createName) {
      nodes.push(block<Message>("create-hint", (h) => h.div([h.Class("px-4 py-3 text-sm text-muted-foreground")], [
        "Type a name — the project is created in ",
        h.span([h.Class("font-mono text-xs")], [formatPathWithTilde(newDir)]),
        " with git initialized.",
      ])))
    } else if (!createNameValid) {
      nodes.push(block<Message>("create-invalid", (h) => h.div([h.Class("px-4 py-3 text-sm text-muted-foreground")], ["Project names can't contain slashes."])))
    } else {
      nodes.push(group<Message, Run>("create-new", undefined, [item<Message, Run>("create-new-row", (h) => [
        (createNameExists ? Folder : Plus)({ class: ICON_CLASS }, h),
        titleSpan([createNameExists ? `Open ${createName}` : `Create ${createName}`], h),
        pendingActionValue === "create-new-row"
          ? rowSpinner(h)
          : trailingPath(createNameExists ? "already exists" : formatPathWithTilde(joinDirPath(newDir, createName)), h, "max-w-[240px]"),
      ], () => runProjectAction(model, "create-new-row", {
        mode: createNameExists ? "existing" : "create",
        localPath: joinDirPath(newDir, createName),
        title: createName,
      }))]))
    }
    if (model.actionError) nodes.push(errorBlock("create-error", model.actionError))
  }

  if (page === "browse") {
    const dir = browseDir
    const dirName = dir ? (pathBasename(dir.path) || dir.path) : ""
    if (browser.error) nodes.push(errorBlock("browse-error", browser.error))
    if (browseInputMode === "path" && !browser.error) {
      nodes.push(group<Message, Run>("browse-jump-group", undefined, [item<Message, Run>("browse-jump", (h) => [
        CornerDownRight({ class: ICON_CLASS }, h),
        h.span([h.Class("min-w-0 truncate")], ["Go to ", h.span([h.Class("font-mono")], [trimmedQuery])]),
        ...(browser.loading ? [rowSpinner(h)] : []),
      ], () => jumpToTypedPath(model))]))
    }
    if (dir && !browser.error) {
      // The current directory: one "+ <name>" row that adds it as a project.
      nodes.push(group<Message, Run>(`dir:${dir.path}`, undefined, [item<Message, Run>("browse-open-current", (h) => [
        Plus({ class: ICON_CLASS }, h),
        titleSpan([dirName], h),
        ...(dir.isGitRepo
          ? [h.span([h.Class("inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1 py-px text-[10px] font-medium text-primary")], [
            GitBranch({ class: "h-2.5 w-2.5" }, h),
            "git",
          ])]
          : []),
        pendingActionValue === `browse-open:${dir.path}` || browser.loading
          ? rowSpinner(h)
          : trailingPath(abbreviateHomePath(dir.path, dir.homePath), h, "max-w-[260px]", "font-mono"),
      ], () => runBrowseTarget({ path: dir.path, name: dirName }))]))
      if (visibleBrowseEntries.length > 0 || browseCreateVisible || dir.truncated) {
        const children: Array<Item | ReturnType<typeof block<Message>>> = visibleBrowseEntries.map((entry) => entry.kind === "dir"
          ? item<Message, Run>(`browse-dir-${entry.name}`, (h) => [
            Folder({ class: ICON_CLASS }, h),
            titleSpan([entry.name], h),
          ], () => ({ model: pushPage(model, "browse", joinDirPath(dir.path, entry.name)) }))
          : item<Message, Run>(`browse-file-${entry.name}`, (h) => [
            File({ class: ICON_CLASS }, h),
            titleSpan([entry.name], h),
          ], undefined, { disabled: true, className: "text-muted-foreground/60" }))
        if (browseCreateVisible) {
          const createPath = joinDirPath(dir.path, trimmedQuery)
          children.push(item<Message, Run>("browse-create", (h) => [
            Plus({ class: ICON_CLASS }, h),
            titleSpan([`Create "${trimmedQuery}"`], h),
            pendingActionValue === `browse-open:${createPath}`
              ? rowSpinner(h)
              : trailingPath(abbreviateHomePath(dir.path, dir.homePath), h, "max-w-[240px]"),
          ], () => runBrowseTarget({ path: createPath, name: trimmedQuery, create: true })))
        }
        if (dir.truncated) {
          children.push(block<Message>("browse-truncated", (h) => h.div([h.Class("px-2 py-1.5 text-xs text-muted-foreground")], [
            `Showing the first ${dir.entries.length.toLocaleString()} entries`,
          ])))
        }
        nodes.push(group<Message, Run>(`${dir.path}:entries`, "In this folder", children))
      }
    } else if (!browser.error) {
      nodes.push(block<Message>("browse-loading", (h) => h.div([h.Class("flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground")], [
        Loader2({ class: "h-4 w-4 animate-spin" }, h),
        " Loading…",
      ])))
    }
    if (model.actionError) nodes.push(errorBlock("browse-action-error", model.actionError))
  }

  // Pages that render non-item content (progress, hints, loading) suppress
  // cmdk's empty state so it doesn't show alongside them.
  const showEmpty = page !== "usage"
    && page !== "create-new"
    && !(page === "clone-github" && (model.cloneRun !== null || model.githubReposLoading || githubRepos?.available !== true))
    && !(page === "browse" && (browser.loading || browser.error !== null || !browseDir))

  const selected = effectiveSelection(nodes, model.selectedValue)
  const footerCopyPath = selected ? copyPathByValue.get(selected) : undefined
  // Browse pages swap the copy-path footer for the "⌘↵ Open <highlighted>" button.
  const footerBrowseTarget = page === "browse" && selected ? browseOpenTargets.get(selected) : undefined

  const placeholder = page === "models"
    ? `Search ${composer.providerConfig?.label ?? "provider"} models…`
    : page === "harness"
      ? "Choose a harness…"
      : page === "new-thread"
        ? "Choose a project…"
        : page === "hide-project"
          ? "Choose project to hide"
          : page === "open-in"
            ? "Open project in…"
            : page === "project-chats"
              ? `Search chats in ${projectChatsTitle ?? "project"}…`
              : page === "settings"
                ? "Search settings…"
                : page === "usage"
                  ? "Harness usage"
                  : page === "add-project"
                    ? "Add a project, or paste a repo to clone…"
                    : page === "clone-github"
                      ? "Search your repos or paste a URL…"
                      : page === "create-new"
                        ? "Project name"
                        : page === "browse"
                          ? "Filter folders, or type a path…"
                          : "Type a command or search threads…"

  return {
    page,
    trimmedQuery,
    nodes,
    empty: showEmpty ? "No results found." : null,
    placeholder,
    firstResultValue,
    selected,
    footerCopyPath,
    footerBrowseTarget,
    isMac,
    locked,
    canPop: model.pages.length > 0 && !locked,
    runBrowseTarget,
    effects: {
      pageKey: pageKey(model),
      browseDirPath: browseDir?.path ?? null,
      typedRepo: cloneTypedRepo,
      typedRepoEnabled: page === "clone-github" && model.cloneRun === null,
      // The hook's effect re-ran whenever the memoized repo did: on the
      // query, the page and the listed repos.
      typedRepoInputs: `${page}\u0000${trimmedQuery}\u0000${githubRepos ? githubRepos.repos.length : -1}\u0000${model.cloneRun === null}`,
      createDir: newDir,
    },
  }
}

/** `state.availableProviders`. */
function providerList(app: AppModel) {
  return availableProviders(app)
}

function availableProviderCount(app: AppModel, _composer: ComposerController) {
  return availableProviders(app).length
}

/** Enter on a typed path: jump (nearest-ancestor); update pushes the page when the listing lands. */
function jumpToTypedPath(model: Model): Return {
  const input = model.query.trim()
  if (!input) return { model }
  const seq = model.browser.seq + 1
  return {
    model: { ...model, browser: { ...model.browser, seq, error: null, loading: true } },
    commands: [Commands.JumpToPath({ seq, input })],
  }
}
