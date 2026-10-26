import { Effect, Schedule, Schema } from "effect"
import { Command } from "foldkit"
import {
  CHANNEL_PINS_STORAGE_KEY,
  LEGACY_SETUP_COMPLETED_STORAGE_KEY,
  LEGACY_SETUP_DISMISSED_STORAGE_KEY,
  LEGACY_SETUP_SHOWN_STORAGE_KEY,
  UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY,
  UI_UPDATE_RESTART_STORAGE_KEY,
} from "../../client/lib/storageKeys"
import type { AppSettingsPatch, AppSettingsSnapshot, SidebarProjectGroup } from "../../shared/types"
import { opaque } from "../core/schema"
import { sendCommand } from "../core/socket"
import { Message } from "./message"

// The app's housekeeping, from hooks that kept browser state in step with
// the server: useUpdateRestart's reload/restart handshake and its update
// checks, useAppSettingsSync's one-time legacy settings migrations, and
// useMigrateChannelPins. Each is a Command; the root decides when.
//
// UPDATE RESTART (useUpdateRestart's helpers, copied: its module is a hook)

function getUiUpdateRestartReconnectAction(phase: string | null, connectionStatus: string): "none" | "awaiting_server_ready" {
  return phase === "awaiting_disconnect" && connectionStatus === "disconnected" ? "awaiting_server_ready" : "none"
}

function shouldHandleUiUpdateReloadRequest(reloadRequestedAt: number | null | undefined, lastHandledReloadRequest: string | null) {
  if (!reloadRequestedAt) return false
  return String(reloadRequestedAt) !== lastHandledReloadRequest
}

function getUiUpdateReadinessPath() {
  return "/auth/status"
}

/**
 * The server asked open clients to reload (an update installed elsewhere):
 * handled once per request, by entering the restart handshake.
 */
export const HandleReloadRequest = Command.define("HandleReloadRequest", {
  args: { reloadRequestedAt: Schema.Number },
  messages: [Message.CompletedSideEffect],
  execute: ({ reloadRequestedAt }) => Effect.sync(() => {
    const lastHandled = window.sessionStorage.getItem(UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY)
    if (shouldHandleUiUpdateReloadRequest(reloadRequestedAt, lastHandled)) {
      window.sessionStorage.setItem(UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY, String(reloadRequestedAt))
      window.sessionStorage.setItem(UI_UPDATE_RESTART_STORAGE_KEY, "awaiting_disconnect")
    }
    return Message.CompletedSideEffect()
  }),
})

/**
 * On every connection change: a restart that has seen its disconnect waits
 * for the server to be ready, polling every 500 ms, then reloads into the
 * new version.
 */
export const FollowRestart = Command.define("FollowRestart", {
  args: { connectionStatus: Schema.Literals(["connecting", "connected", "disconnected"]) },
  messages: [Message.CompletedSideEffect],
  execute: ({ connectionStatus }) => Effect.gen(function* () {
    const phase = window.sessionStorage.getItem(UI_UPDATE_RESTART_STORAGE_KEY)
    if (getUiUpdateRestartReconnectAction(phase, connectionStatus) === "awaiting_server_ready") {
      window.sessionStorage.setItem(UI_UPDATE_RESTART_STORAGE_KEY, "awaiting_server_ready")
    }
    if (window.sessionStorage.getItem(UI_UPDATE_RESTART_STORAGE_KEY) !== "awaiting_server_ready") {
      return Message.CompletedSideEffect()
    }
    // Keep polling while the process restarts.
    yield* Effect.tryPromise(async () => {
      const response = await fetch(getUiUpdateReadinessPath(), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error("not ready")
    }).pipe(Effect.retry(Schedule.spaced("500 millis")), Effect.orDie)
    window.sessionStorage.removeItem(UI_UPDATE_RESTART_STORAGE_KEY)
    window.location.reload()
    return Message.CompletedSideEffect()
  }),
})

/** How often an idle client re-checks for updates: nightlies every 5 min, releases hourly. */
export function updateCheckInterval(onNightly: boolean) {
  return (onNightly ? 5 : 60) * 60 * 1000
}

// LEGACY SETTINGS (useAppSettingsSync)

const LEGACY_THEME_STORAGE_KEY = "lever-theme"
const LEGACY_CHAT_SOUND_STORAGE_KEY = "chat-sound-preferences"
const LEGACY_TERMINAL_STORAGE_KEY = "terminal-preferences"
const LEGACY_CHAT_PREFERENCES_STORAGE_KEY = "chat-preferences"

function readPersistedZustandState(key: string): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: unknown }
    return parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state)
      ? parsed.state as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function readLegacyBrowserSettingsPatch(): AppSettingsPatch | null {
  const patch: AppSettingsPatch = {}
  const theme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
  if (theme === "light" || theme === "dark" || theme === "system") patch.theme = theme

  const chatSoundState = readPersistedZustandState(LEGACY_CHAT_SOUND_STORAGE_KEY)
  const soundPreference = chatSoundState?.chatSoundPreference
  if (soundPreference === "never" || soundPreference === "unfocused" || soundPreference === "always") {
    patch.chatSoundPreference = soundPreference
  }
  const soundId = chatSoundState?.chatSoundId
  if (["blow", "bottle", "frog", "funk", "glass", "ping", "pop", "purr", "tink"].includes(soundId as string)) {
    patch.chatSoundId = soundId as AppSettingsPatch["chatSoundId"]
  }

  const terminalState = readPersistedZustandState(LEGACY_TERMINAL_STORAGE_KEY)
  if (terminalState) {
    patch.terminal = {}
    if (typeof terminalState.scrollbackLines === "number") patch.terminal.scrollbackLines = terminalState.scrollbackLines
    if (typeof terminalState.minColumnWidth === "number") patch.terminal.minColumnWidth = terminalState.minColumnWidth
    const editorPatch: NonNullable<AppSettingsPatch["editor"]> = {}
    if (["cursor", "vscode", "xcode", "windsurf", "custom"].includes(terminalState.editorPreset as string)) {
      editorPatch.preset = terminalState.editorPreset as NonNullable<AppSettingsPatch["editor"]>["preset"]
    }
    if (typeof terminalState.editorCommandTemplate === "string") editorPatch.commandTemplate = terminalState.editorCommandTemplate
    if (Object.keys(editorPatch).length > 0) patch.editor = editorPatch
  }

  const chatPreferencesState = readPersistedZustandState(LEGACY_CHAT_PREFERENCES_STORAGE_KEY)
  const defaultProvider = chatPreferencesState?.defaultProvider
  if (defaultProvider === "last_used" || defaultProvider === "claude" || defaultProvider === "codex") patch.defaultProvider = defaultProvider
  if (chatPreferencesState?.providerDefaults && typeof chatPreferencesState.providerDefaults === "object") {
    patch.providerDefaults = chatPreferencesState.providerDefaults as AppSettingsPatch["providerDefaults"]
  }

  patch.browserSettingsMigrated = true
  return Object.keys(patch).length > 1 ? patch : null
}

/**
 * Settings that used to live in this browser go to the server once, then
 * the legacy keys go. The written snapshot comes back as the reply.
 */
export const MigrateLegacyBrowserSettings = Command.define("MigrateLegacyBrowserSettings", {
  messages: [Message.SucceededReadAppSettings, Message.CompletedSideEffect],
  execute: Effect.gen(function* () {
    const patch = readLegacyBrowserSettingsPatch()
    if (!patch) return Message.CompletedSideEffect()
    const snapshot = yield* sendCommand<AppSettingsSnapshot>({ type: "settings.writeAppSettingsPatch", patch })
    for (const key of [LEGACY_THEME_STORAGE_KEY, LEGACY_CHAT_SOUND_STORAGE_KEY, LEGACY_TERMINAL_STORAGE_KEY, LEGACY_CHAT_PREFERENCES_STORAGE_KEY]) {
      window.localStorage.removeItem(key)
    }
    return Message.SucceededReadAppSettings({ snapshot })
  }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedSideEffect()))),
})

/**
 * Onboarding markers used to live in this browser's localStorage. They are
 * machine-wide settings now; legacy local flags go up to the server once,
 * so the browser that completed setup isn't asked again.
 */
export const MigrateLegacySetupFlags = Command.define("MigrateLegacySetupFlags", {
  args: { snapshot: opaque<AppSettingsSnapshot>("AppSettingsSnapshot") },
  messages: [Message.SucceededReadAppSettings, Message.CompletedSideEffect],
  execute: ({ snapshot }) => Effect.gen(function* () {
    const has = (key: string) => {
      try {
        return window.localStorage.getItem(key) !== null
      } catch {
        return false
      }
    }
    const clear = () => {
      try {
        window.localStorage.removeItem(LEGACY_SETUP_SHOWN_STORAGE_KEY)
        window.localStorage.removeItem(LEGACY_SETUP_COMPLETED_STORAGE_KEY)
        window.localStorage.removeItem(LEGACY_SETUP_DISMISSED_STORAGE_KEY)
      } catch {
        // Private mode etc. — the server copy is authoritative either way.
      }
    }
    const patch: AppSettingsPatch = {}
    if (!snapshot.setupShown && has(LEGACY_SETUP_SHOWN_STORAGE_KEY)) patch.setupShown = true
    if (!snapshot.setupCompleted && has(LEGACY_SETUP_COMPLETED_STORAGE_KEY)) patch.setupCompleted = true
    if (!snapshot.setupDismissed && has(LEGACY_SETUP_DISMISSED_STORAGE_KEY)) patch.setupDismissed = true
    if (Object.keys(patch).length === 0) {
      clear()
      return Message.CompletedSideEffect()
    }
    const written = yield* sendCommand<AppSettingsSnapshot>({ type: "settings.writeAppSettingsPatch", patch })
    clear()
    return Message.SucceededReadAppSettings({ snapshot: written })
  }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedSideEffect()))),
})

// CHANNEL PINS (useMigrateChannelPins)

/**
 * Carries this browser's own pinned channels over to the server, once. A
 * pin for a project that is gone is dropped, one the server already has is
 * left alone, and the stored pins go only once every send has landed.
 */
export const MigrateChannelPins = Command.define("MigrateChannelPins", {
  args: { projectGroups: Schema.Array(opaque<SidebarProjectGroup>("SidebarProjectGroup")) },
  messages: [Message.CompletedSideEffect],
  execute: ({ projectGroups }) => Effect.gen(function* () {
    const stored = window.localStorage.getItem(CHANNEL_PINS_STORAGE_KEY)
    if (stored === null) return Message.CompletedSideEffect()
    let pins: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(stored)
      pins = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
    } catch {
      pins = {}
    }
    const groupsById = new Map(projectGroups.map((group) => [group.groupKey, group]))
    const sends = Object.entries(pins).flatMap(([projectId, pinnedAt]) => {
      const group = groupsById.get(projectId)
      if (!group || group.pinnedAt != null || typeof pinnedAt !== "number") return []
      return [sendCommand({ type: "project.setPinned", projectId, pinned: true, pinnedAt })]
    })
    yield* Effect.all(sends, { concurrency: "unbounded" })
    window.localStorage.removeItem(CHANNEL_PINS_STORAGE_KEY)
    return Message.CompletedSideEffect()
  }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedSideEffect()))),
})
