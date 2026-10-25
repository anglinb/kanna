import { getProjectIdForChat } from "../../client/app/kannaStateHelpers"
import { withPiFaveModels, PROVIDERS, type AppSettingsSnapshot, type PaneVisibilityScope, type ProviderCatalogEntry, type SidebarData } from "../../shared/types"
import type { AppModel } from "../app/slice"
import { themePreference, type ThemePreference } from "../app/theme"
import * as ChatSession from "../core/chatSession"

// What CommandPalette read of useKannaState and the stores on each render,
// as functions of the root Model. A few are copied from app/update.ts
// rather than imported: the slice can't import the root's update (which
// imports the slice).

export function sidebarData(app: AppModel): SidebarData {
  return app.stores.sidebar.data
}

export function appSettings(app: AppModel): AppSettingsSnapshot | null {
  return app.stores.appSettings.settings
}

/** `state.activeChatId`: the page's chat, as `useParams` had it. */
export function activeChatId(app: AppModel): string | null {
  return app.route._tag === "Chat" ? app.route.chatId : null
}

/** The page's chat snapshot, if it is the open chat's. */
export function activeChatSnapshot(app: AppModel) {
  return app.chat && app.chat.chatId === activeChatId(app) ? ChatSession.snapshotOf(app.chat) : null
}

/** `state.activeProjectId`. */
export function activeProjectId(app: AppModel): string | null {
  const chatId = activeChatId(app)
  return activeChatSnapshot(app)?.runtime.projectId
    ?? (chatId ? getProjectIdForChat(sidebarData(app).projectGroups, chatId) : null)
    ?? app.selectedProjectId
}

/** `state.navbarLocalPath`: the snapshot's folder, else the sidebar's, else the first local project's. */
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

let lastProviders: { settings: unknown; faves: unknown; result: ProviderCatalogEntry[] } | null = null

/** `state.availableProviders`: the chat snapshot's catalog, else the app settings' with pi's fave models. */
export function availableProviders(app: AppModel): ProviderCatalogEntry[] {
  const settingsProviders = appSettings(app)?.availableProviders
  const faves = app.llmProvider?.faveModels
  if (!lastProviders || lastProviders.settings !== settingsProviders || lastProviders.faves !== faves) {
    lastProviders = { settings: settingsProviders, faves, result: withPiFaveModels(settingsProviders ?? PROVIDERS, faves ?? []) }
  }
  return activeChatSnapshot(app)?.availableProviders ?? lastProviders.result
}

/** The saved theme preference, not the resolved one: "Theme: System" is offered whenever System isn't the choice. */
export function theme(app: AppModel): ThemePreference {
  return themePreference(appSettings(app))
}

export function isMac(app: AppModel): boolean {
  return (app.localProjects?.machine.platform ?? "darwin") === "darwin"
}

// lib/paneVisibility (it reads the zustand settings store, so not imported).

export type PaneKind = keyof AppSettingsSnapshot["paneVisibility"]

function paneChatKeyFor(scope: PaneVisibilityScope, chatId: string | null | undefined) {
  return scope === "chat" ? chatId ?? null : null
}

/** `getPaneChatKey` / `usePaneChatKey`: per chat until the settings snapshot lands. */
export function paneChatKey(app: AppModel, pane: PaneKind, chatId: string | null | undefined) {
  return paneChatKeyFor(appSettings(app)?.paneVisibility?.[pane] ?? "chat", chatId)
}
