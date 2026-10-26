import { Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { mergeAppSettingsPatch } from "../../../shared/app-settings-merge"
import type { AppSettingsPatch, AppSettingsSnapshot } from "../../../shared/types"
import { opaque } from "../schema"

// Port of src/client/stores/appSettingsStore.ts: the `app-settings` snapshot,
// with a patch applied ahead of the server's ack. Not persisted.

export { mergeAppSettingsPatch }

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
