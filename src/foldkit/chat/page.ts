import { getProjectIdForChat } from "../../client/app/kannaStateHelpers"
import { getResolvedKeybindings } from "../../client/lib/keybindings"
import type { PaneVisibilityScope } from "../../shared/types"
import { getEditorPresetLabel } from "../../shared/editor-presets"
import type { ChatDiffSnapshot, ChatSnapshot, KeybindingsSnapshot, SidebarData } from "../../shared/types"
import type { AppModel } from "../app/slice"
import { routeChatId } from "../app/route"
import * as ChatSession from "../core/chatSession"
import * as RightSidebar from "../core/stores/rightSidebar"
import * as Sidebar from "../core/stores/sidebar"
import * as TerminalLayout from "../core/stores/terminalLayout"
import * as Viewer from "../core/stores/viewer"
import { effectiveEditorPreset } from "./openExternal"
import { tabsToKeep, threadsByChatId } from "./chatTabs"

// What the chat page reads off the root Model, worked out once per render:
// useKannaState's chat-page fields and ChatPage's own derivations. The
// root's selectors (app/update.ts) are restated here rather than imported:
// app/update imports this slice, and the cycle would reach app/message
// before this module's exports exist.

const MOBILE_BREAKPOINT_PX = 768

/** The chat pane never shrinks past this, so it also fixes the terminal's ceiling. */
export const CHAT_MIN_SIZE_PERCENT = 25
export const MAX_TERMINAL_MAIN_SIZES: [number, number] = [CHAT_MIN_SIZE_PERCENT, 100 - CHAT_MIN_SIZE_PERCENT]

/** lib/paneVisibility's paneChatKey (that module pulls a React store): the chat, when the pane is per chat. */
export function paneChatKey(scope: PaneVisibilityScope, chatId: string | null | undefined) {
  return scope === "chat" ? chatId ?? null : null
}

export function shouldUseMobileRightSidebarOverlay(viewportWidth: number) {
  return viewportWidth > 0 && viewportWidth < MOBILE_BREAKPOINT_PX
}

/**
 * Mobile pins the terminal to its ceiling: a 32%-tall pane on a phone is a few
 * usable rows, and the drag handle is too fine a target to fix that with. The
 * clamp is derived rather than written back to the store so the project keeps
 * whatever split it was given on a desktop.
 */
export function getEffectiveTerminalMainSizes(mainSizes: [number, number], clampToMax: boolean): [number, number] {
  return clampToMax ? MAX_TERMINAL_MAIN_SIZES : mainSizes
}

export function getTerminalPanelDefaultSizes(showTerminalPane: boolean, mainSizes: [number, number]): [number, number] {
  return showTerminalPane ? mainSizes : [100, 0]
}

// THE ROOT'S SELECTORS (app/update.ts)

export function sidebarData(app: AppModel): SidebarData {
  return app.stores.sidebar.data
}

export function activeChatId(app: AppModel): string | null {
  return routeChatId(app.route)
}

export function activeChatSnapshot(app: AppModel): ChatSnapshot | null {
  return app.chat && app.chat.chatId === activeChatId(app) ? ChatSession.snapshotOf(app.chat) : null
}

export function activeProjectId(app: AppModel): string | null {
  const chatId = activeChatId(app)
  return activeChatSnapshot(app)?.runtime.projectId
    ?? (chatId ? getProjectIdForChat(sidebarData(app).projectGroups, chatId) : null)
    ?? app.selectedProjectId
}

export function navbarLocalPath(app: AppModel): string | null {
  const projectId = activeProjectId(app)
  const fromSidebar = activeChatId(app) && projectId
    ? sidebarData(app).projectGroups.find((group) => group.groupKey === projectId)?.localPath ?? null
    : null
  return activeChatSnapshot(app)?.runtime.localPath
    ?? fromSidebar
    ?? app.localProjects?.projects[0]?.localPath
    ?? sidebarData(app).projectGroups[0]?.localPath
    ?? null
}

export function activeChatStarted(app: AppModel): boolean {
  const chatId = activeChatId(app)
  return Boolean(chatId && app.actions.startedChat?.chatId === chatId && !activeChatSnapshot(app))
}

// THE PAGE

export interface PageFacts {
  chatId: string | null
  projectId: string | null
  snapshot: ChatSnapshot | null
  runtime: ChatSnapshot["runtime"] | null
  messageCount: number
  isChatLoading: boolean
  isKnownNewChat: boolean
  sidebarListsChat: boolean
  showEmptyState: boolean
  isMobile: boolean
  chatTabsEnabled: boolean
  /** The widget column's peek setting (General). */
  widgetsPeekEnabled: boolean
  /** The open chat's name where the navbar shows it: its tab's (the sidebar's) with tabs on, the snapshot's without. */
  activeTitle: string | undefined
  tabsCount: number
  /** With tabs on: the tabs to keep, as JSON, when some should go. */
  pruneTabs: string | null
  widgetsChatKey: string | null
  terminalChatKey: string | null
  showRightSidebar: boolean
  terminalLayout: TerminalLayout.ProjectTerminalLayout
  hasTerminals: boolean
  showTerminalPane: boolean
  shouldRenderTerminalLayout: boolean
  viewerOpen: boolean
  viewerExpanded: boolean
  viewerPaneAvailable: boolean
  viewerDocked: boolean
  isDelegator: boolean
  diffs: ChatDiffSnapshot | null
  keybindings: KeybindingsSnapshot
  isMac: boolean
  platform: string | undefined
  navbarLocalPath: string | null
  repoUrl: string | undefined
  editorPreset: TerminalLayoutEditorPreset
  editorCommandTemplate: string | undefined
  editorLabel: string
  hasSelectedProject: boolean
  isProcessing: boolean
  canCancel: boolean
  sidebarReady: boolean
  sidebarCollapsed: boolean
  installedEditors: NonNullable<AppModel["stores"]["appSettings"]["settings"]>["installedEditors"] | null
  installedTerminals: NonNullable<AppModel["stores"]["appSettings"]["settings"]>["installedTerminals"] | null
  rememberedDestination: string | null
  isExportingStandalone: boolean
  standaloneShareComplete: boolean
}

type TerminalLayoutEditorPreset = AppModel["stores"]["terminalPreferences"]["editorPreset"]

/** A chat's title as the sidebar has it (its tab's), archived ones included. */
function threadTitle(app: AppModel, chatId: string): string | undefined {
  const group = app.stores.sidebar.data.projectGroups.find((item) => (
    item.chats.some((chat) => chat.chatId === chatId)
    || (item.archivedChats ?? []).some((chat) => chat.chatId === chatId)
  ))
  return group ? threadsByChatId(app, [{ chatId }]).get(chatId)?.title : undefined
}

function keepJson(keep: ReadonlyArray<string> | null) {
  return keep ? JSON.stringify(keep) : null
}

/** Where a viewer item shows: a diff or file only on its own project's page. */
function showsOn(item: Viewer.ViewerItem | null, projectId: string | null) {
  if (!item) return false
  if (item.kind === "diff" || item.kind === "file") return Boolean(projectId) && item.projectId === projectId
  return true
}

/**
 * `settledShowEmptyState` is the empty state as the page last showed it,
 * which a chat neither known nor listed (the sidebar still loading) holds.
 */
export function pageFacts(app: AppModel, viewportWidth: number, settledShowEmptyState: boolean): PageFacts {
  const chatId = activeChatId(app)
  const snapshot = activeChatSnapshot(app)
  const runtime = snapshot?.runtime ?? null
  const projectId = activeProjectId(app)
  const settings = app.stores.appSettings.settings
  const sidebarStore = app.stores.sidebar
  const chat = app.chat && app.chat.chatId === chatId ? app.chat : null
  const messageCount = chat?.messages.length ?? 0
  const sidebarStatus = Sidebar.sidebarChatStatus(sidebarStore, chat?.chatId ?? null)

  // While the next chat's snapshot loads there's no runtime to judge by. A
  // chat the sidebar lists is judged by the sidebar instead, which puts it to
  // the same test the snapshot will: a new chat (no message, its first name)
  // is the new chat page from the first frame, and any other chat is not.
  // A chat started from this window a moment ago is not listed yet, and is
  // known to be new all the same.
  //
  // A chat neither known nor listed (the sidebar still loading) holds the
  // empty state as it last was: dropping it for that gap is what made one
  // new chat to another fade out and back in.
  //
  // In every case a prompt sent before the snapshot comes ends the empty state.
  const isChatLoading = Boolean(chatId && !runtime)
  const sidebarListsChat = Sidebar.chatExists(sidebarStore, chatId)
  const isKnownNewChat = Sidebar.sidebarChatIsNew(sidebarStore, chatId) || activeChatStarted(app)
  const showEmptyState = isChatLoading
    ? isKnownNewChat
      ? messageCount === 0
      : !sidebarListsChat && settledShowEmptyState && messageCount === 0
    : messageCount === 0 && runtime?.title === "New Chat"

  const isMobile = shouldUseMobileRightSidebarOverlay(viewportWidth)
  const widgetsScope = settings?.paneVisibility?.widgets ?? "chat"
  const terminalScope = settings?.paneVisibility?.terminal ?? "chat"
  const widgetsChatKey = paneChatKey(widgetsScope, chatId)
  const terminalChatKey = paneChatKey(terminalScope, chatId)
  const widgetsOpen = RightSidebar.widgetsOpen(app.stores.rightSidebar, projectId, widgetsChatKey)

  const storedTerminalLayout = (projectId ? app.stores.terminalLayout.projects[projectId] : undefined) ?? TerminalLayout.DEFAULT_PROJECT_TERMINAL_LAYOUT
  const mainSizes = getEffectiveTerminalMainSizes(storedTerminalLayout.mainSizes as [number, number], isMobile)
  const terminalLayout = (mainSizes === storedTerminalLayout.mainSizes
    ? storedTerminalLayout
    : { ...storedTerminalLayout, mainSizes }) as TerminalLayout.ProjectTerminalLayout
  const hasTerminals = terminalLayout.terminals.length > 0
  const showTerminalPane = Boolean(projectId && TerminalLayout.isTerminalVisible(terminalLayout, terminalChatKey) && hasTerminals)

  const viewerState = { viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar }
  const chatViewer = Viewer.chatViewer(viewerState)
  const viewerOpen = showsOn(chatViewer?.item ?? null, projectId)
  const viewerExpanded = chatViewer?.expanded ?? false
  const viewerPaneAvailable = !isMobile

  const keybindings = getResolvedKeybindings(app.keybindings)
  const platform = app.localProjects?.machine.platform
  const preferences = app.stores.terminalPreferences
  const remembered = app.stores.openDestination.value
  const installedEditors = settings?.installedEditors ?? null
  const firstGroup = Sidebar.firstProjectGroup(sidebarStore)
  const localPath = navbarLocalPath(app)
  const chatTabsEnabled = settings?.chatTabsEnabled === true

  return {
    chatId,
    projectId,
    snapshot,
    runtime,
    messageCount,
    isChatLoading,
    isKnownNewChat,
    sidebarListsChat,
    showEmptyState,
    isMobile,
    chatTabsEnabled,
    widgetsPeekEnabled: settings?.widgetsPeekEnabled === true,
    activeTitle: chatTabsEnabled ? (chatId ? threadTitle(app, chatId) ?? "New Chat" : undefined) : runtime?.title,
    tabsCount: app.stores.chatTabs.tabs.length,
    pruneTabs: chatTabsEnabled ? keepJson(tabsToKeep(app, chatId)) : null,
    widgetsChatKey,
    terminalChatKey,
    showRightSidebar: Boolean(projectId && widgetsOpen),
    terminalLayout,
    hasTerminals,
    showTerminalPane,
    shouldRenderTerminalLayout: Boolean(projectId && hasTerminals),
    viewerOpen,
    viewerExpanded,
    viewerPaneAvailable,
    viewerDocked: viewerPaneAvailable && viewerOpen && !viewerExpanded,
    isDelegator: Sidebar.chatIsDelegator(sidebarStore, chatId),
    diffs: projectId ? app.projectDiffs[projectId] ?? null : null,
    keybindings,
    isMac: (platform ?? "darwin") === "darwin",
    platform,
    navbarLocalPath: localPath,
    // Read off the sidebar snapshot rather than the git one: the sidebar carries
    // a resolved forge URL for every project, while `project-git` only knows a
    // GitHub slug and only for the project currently subscribed.
    repoUrl: Sidebar.projectRepoUrl(sidebarStore, projectId),
    editorPreset: preferences.editorPreset,
    editorCommandTemplate: preferences.editorCommandTemplate,
    editorLabel: getEditorPresetLabel(effectiveEditorPreset(preferences.editorPreset, remembered, installedEditors)),
    hasSelectedProject: Boolean(app.selectedProjectId ?? runtime?.projectId ?? firstGroup.groupKey ?? app.localProjects?.projects[0]?.localPath),
    isProcessing: chat ? ChatSession.isProcessing(chat, sidebarStatus) : false,
    canCancel: chat ? ChatSession.canCancel(chat, sidebarStatus) : false,
    sidebarReady: sidebarStore.ready,
    sidebarCollapsed: app.sidebarCollapsed,
    installedEditors,
    installedTerminals: settings?.installedTerminals ?? null,
    rememberedDestination: remembered,
    isExportingStandalone: app.actions.isExportingStandalone,
    standaloneShareComplete: app.actions.standaloneShareComplete,
  }
}
