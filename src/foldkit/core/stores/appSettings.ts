import { Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { mergeProviderDefaultsPatch } from "../../../shared/provider-preferences"
import type { AppSettingsPatch, AppSettingsSnapshot } from "../../../shared/types"
import { opaque } from "../schema"

// Port of src/client/stores/appSettingsStore.ts: the `app-settings` snapshot,
// with a patch applied ahead of the server's ack. Not persisted.

/**
 * Copied from appSettingsStore.ts, which imports zustand, and kept identical:
 * src/demo/backend.ts uses the React copy, and the server's ack must match
 * what either client showed optimistically.
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
    // Same deep-merge the server applies in app-settings.ts applyPatch, so the
    // optimistic snapshot matches what the ack will confirm.
    providerDefaults: mergeProviderDefaultsPatch(settings.providerDefaults, patch.providerDefaults),
  }
}

const AppSettings = opaque<AppSettingsSnapshot>("AppSettingsSnapshot")

export const Model = Schema.Struct({
  /** Null until the first `app-settings` snapshot. */
  settings: Schema.NullOr(AppSettings),
})
export type Model = typeof Model.Type

export const initialModel: Model = { settings: null }

export const Message = defineMessageUnion({
  ReceivedAppSettings: { settings: AppSettings },
  /** A patch the client is sending: shown now, confirmed by the next snapshot. */
  AppliedOptimisticPatch: { patch: opaque<AppSettingsPatch>("AppSettingsPatch") },
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ReceivedAppSettings: ({ settings }) => ({ model: { settings } }),
    AppliedOptimisticPatch: ({ patch }) => ({
      model: model.settings ? { settings: mergeAppSettingsPatch(model.settings, patch) } : model,
    }),
  })

export function appSettings(model: Model): AppSettingsSnapshot | null {
  return model.settings
}
