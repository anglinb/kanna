import { mergeProviderDefaultsPatch } from "./provider-preferences"
import type { AppSettingsPatch, AppSettingsSnapshot } from "./types"

/**
 * A settings patch applied ahead of the server's ack: the client's optimistic
 * snapshot, and the demo backend's own answer. Same deep-merge the server
 * applies in app-settings.ts applyPatch, so the optimistic snapshot matches
 * what the ack will confirm.
 */
export function mergeAppSettingsPatch(
  settings: AppSettingsSnapshot,
  patch: AppSettingsPatch
): AppSettingsSnapshot {
  return {
    ...settings,
    ...patch,
    terminal: {
      ...settings.terminal,
      ...patch.terminal,
    },
    editor: {
      ...settings.editor,
      ...patch.editor,
    },
    transcript: {
      ...settings.transcript,
      ...patch.transcript,
    },
    paneVisibility: {
      ...settings.paneVisibility,
      ...patch.paneVisibility,
    },
    providerDefaults: mergeProviderDefaultsPatch(settings.providerDefaults, patch.providerDefaults),
  }
}
