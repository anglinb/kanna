import { getProjectIdForChat, projectActivity } from "../../client/app/kannaStateHelpers"
import { getVisibleSidebarChats, type VisibleSidebarChat } from "../../client/app/sidebarNumberJump"
import { editorPresetFromOpenAppValue, resolveEffectiveEditorPreset } from "../../client/lib/effective-editor"
import { getResolvedKeybindings } from "../../client/lib/keybindings"
import { flattenSidebarThreads, listedThreads, stabilizeSidebarThreads, type SidebarThread } from "../../client/lib/thread-sections"
import { normalizeChatId } from "../../client/lib/utils"
import { getEditorPresetLabel } from "../../shared/editor-presets"
import type { AppSettingsSnapshot, KeybindingsSnapshot, SidebarData, SidebarProjectGroup } from "../../shared/types"
import type { AppModel } from "../app/slice"
import * as ChatSession from "../core/chatSession"
import * as ChatInput from "../core/stores/chatInput"
import { focusSidebarData, resolveFocusedProjectGroup } from "../core/stores/focusMode"
import * as PendingSend from "../core/stores/pendingSend"
import type { Model } from "./model"

// What KannaSidebar worked out from its props and stores on every render,
// as functions of the root Model and the slice's own.

/** The page's chat id, as `useParams` had it (app/route's `routeChatId`). */
export function activeChatId(app: AppModel): string | null {
  return app.route._tag === "Chat" ? app.route.chatId : null
}

/**
 * useKannaState's activeProjectId: the open chat's project, else the
 * project picked last. Copied from app/update.ts rather than imported, so
 * the slice doesn't import the root's update (which imports the slice).
 */
export function currentProjectId(app: AppModel): string | null {
  const chatId = activeChatId(app)
  const snapshot = app.chat && app.chat.chatId === chatId ? ChatSession.snapshotOf(app.chat) : null
  return snapshot?.runtime.projectId
    ?? (chatId ? getProjectIdForChat(app.stores.sidebar.data.projectGroups, chatId) : null)
    ?? app.selectedProjectId
}

/** `/project/:id`: that project's own page, which is the project focused. */
export function routeProjectId(app: AppModel): string | null {
  if (app.route._tag !== "Project") return null
  try {
    return decodeURIComponent(app.route.projectId)
  } catch {
    return app.route.projectId
  }
}

export function appSettings(app: AppModel): AppSettingsSnapshot | null {
  return app.stores.appSettings.settings
}

export function newSidebarEnabled(app: AppModel) {
  return appSettings(app)?.newSidebarEnabled !== false
}

export function resolvedKeybindings(app: AppModel): KeybindingsSnapshot {
  return resolvedKeybindingsOf(app.keybindings)
}

let lastKeybindings: { snapshot: KeybindingsSnapshot | null; resolved: KeybindingsSnapshot } | null = null

function resolvedKeybindingsOf(snapshot: KeybindingsSnapshot | null) {
  if (lastKeybindings?.snapshot === snapshot) return lastKeybindings.resolved
  lastKeybindings = { snapshot, resolved: getResolvedKeybindings(snapshot) }
  return lastKeybindings.resolved
}

/**
 * The editor every plain "Open in X" names: the one the navbar's button
 * would open (useKannaState's `editorLabel`).
 */
export function editorLabel(app: AppModel): string {
  return getEditorPresetLabel(resolveEffectiveEditorPreset({
    preferred: app.stores.terminalPreferences.editorPreset,
    remembered: editorPresetFromOpenAppValue(app.stores.openDestination.value),
    installedEditors: appSettings(app)?.installedEditors ?? null,
  }))
}

export function focusedProjectGroup(app: AppModel): SidebarProjectGroup | null {
  const routeProject = routeProjectId(app)
  return resolveFocusedProjectGroup(
    app.stores.sidebar.data.projectGroups,
    app.stores.focusMode.enabled || routeProject !== null,
    routeProject ?? currentProjectId(app),
  )
}

/** The snapshot the sidebar renders: everything, or the focused project. */
export function sidebarData(app: AppModel): SidebarData {
  return focusSidebarData(app.stores.sidebar.data, focusedProjectGroup(app))
}

// useStableSidebarThreads: flattened once per snapshot, and stabilized against
// the last list so an unchanged chat keeps its thread object.
let lastThreads: SidebarThread[] = []
const threadsByData = new WeakMap<SidebarData, SidebarThread[]>()

export function everyThread(data: SidebarData): SidebarThread[] {
  const cached = threadsByData.get(data)
  if (cached) return cached
  const stabilized = stabilizeSidebarThreads(lastThreads, flattenSidebarThreads(data))
  lastThreads = stabilized
  threadsByData.set(data, stabilized)
  return stabilized
}

export function threads(app: AppModel): SidebarThread[] {
  return listedThreads(everyThread(sidebarData(app)))
}

export function threadByChatId(app: AppModel): Map<string, SidebarThread> {
  return new Map(threads(app).map((thread) => [thread.chatId, thread]))
}

/** Every thread by its normalized id, archived and sub-chats included: what a hover card resolves. */
export function threadByRowId(app: AppModel): Map<string, SidebarThread> {
  return new Map(threads(app).map((thread) => [normalizeChatId(thread.chatId), thread]))
}

/** Whether a project group is folded in the Projects view. */
export function isProjectCollapsed(model: Model, group: SidebarProjectGroup): boolean {
  return model.projectFolds[group.groupKey] ?? Boolean(group.defaultCollapsed)
}

/** The chats the number jump counts, in order (`getVisibleSidebarChats`). */
export function visibleChats(app: AppModel, model: Model): VisibleSidebarChat[] {
  const groups = sidebarData(app).projectGroups
  return getVisibleSidebarChats(
    groups,
    new Set(groups.filter((group) => isProjectCollapsed(model, group)).map((group) => group.groupKey)),
    new Set(model.expandedGroups),
  )
}

export function draftStartTimes(app: AppModel) {
  return ChatInput.draftStartTimes(app.stores.chatInput)
}

export function pendingSendTimes(app: AppModel) {
  return PendingSend.pendingSendTimes(app.stores.pendingSend)
}

export function hasDraft(app: AppModel, chatId: string) {
  return ChatInput.chatHasDraft(app.stores.chatInput, chatId)
}

// New Sidebar's Projects view hides projects with no chats and sorts by
// recent activity, but a project seen non-empty during the current visit to
// the view sticks around at its last position even after its last chat is
// archived (activity would otherwise drop to 0 and yank it to the bottom).
// The memory resets when you leave the view. Kept at module level, as React
// kept it in a ref written during render: it is a memo of what was on screen.
let stickyProjectActivity = new Map<string, number>()

export function visibleProjectGroups(app: AppModel, projectsView: boolean): SidebarProjectGroup[] {
  const data = sidebarData(app)
  if (!projectsView) {
    stickyProjectActivity = new Map()
    return data.projectGroups
  }
  // Focus mode already picked the one project to show. Hiding it for being
  // empty would leave the view blank under a pill naming it.
  if (focusedProjectGroup(app)) return data.projectGroups
  const sticky = stickyProjectActivity
  const visible = data.projectGroups.filter((group) => {
    if (group.chats.length > 0) {
      sticky.set(group.groupKey, projectActivity(group))
      return true
    }
    return sticky.has(group.groupKey)
  })
  return visible.sort((left, right) =>
    (sticky.get(right.groupKey) ?? projectActivity(right)) - (sticky.get(left.groupKey) ?? projectActivity(left)))
}

export function isSettingsActive(app: AppModel) {
  return app.route._tag === "Settings" || app.route._tag === "SettingsIndex"
}

/** `/` is the sidebar itself on a phone, and so is a project's page. */
export function isRootActive(app: AppModel) {
  return app.route._tag === "Root" || routeProjectId(app) !== null
}

export function isLocalProjectsActive(app: AppModel) {
  return isRootActive(app) || app.route._tag === "Home"
}

export function isConnecting(app: AppModel) {
  return app.connectionStatus === "connecting" || !app.stores.sidebar.ready
}
