import { Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { getDefaultEditorCommandTemplate, getEditorPresetLabel, isEditorPreset } from "../../../shared/editor-presets"
import type { EditorPreset } from "../../../shared/protocol"
import { opaque } from "../schema"

// Port of src/client/stores/terminalPreferencesStore.ts. Not persisted: the
// values come from the app settings.

export const DEFAULT_TERMINAL_SCROLLBACK = 1_000
export const MIN_TERMINAL_SCROLLBACK = 500
export const MAX_TERMINAL_SCROLLBACK = 5_000
export const DEFAULT_TERMINAL_WEBGL_RENDERER = false
export const DEFAULT_TERMINAL_MIN_COLUMN_WIDTH = 450
export const MIN_TERMINAL_MIN_COLUMN_WIDTH = 250
export const MAX_TERMINAL_MIN_COLUMN_WIDTH = 900
export const DEFAULT_EDITOR_PRESET: EditorPreset = "cursor"

export { getDefaultEditorCommandTemplate, getEditorPresetLabel }

function clampScrollback(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_SCROLLBACK
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.round(value)))
}

function clampMinColumnWidth(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_MIN_COLUMN_WIDTH
  return Math.min(MAX_TERMINAL_MIN_COLUMN_WIDTH, Math.max(MIN_TERMINAL_MIN_COLUMN_WIDTH, Math.round(value)))
}

function normalizeEditorPreset(value?: string): EditorPreset {
  return isEditorPreset(value) ? value : DEFAULT_EDITOR_PRESET
}

function normalizeEditorCommandTemplate(value: string | undefined, preset: EditorPreset) {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : getDefaultEditorCommandTemplate(preset)
}

const EditorPresetSchema = opaque<EditorPreset>("EditorPreset")

export const Model = Schema.Struct({
  scrollbackLines: Schema.Number,
  minColumnWidth: Schema.Number,
  webglRenderer: Schema.Boolean,
  editorPreset: EditorPresetSchema,
  editorCommandTemplate: Schema.String,
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK,
  minColumnWidth: DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
  webglRenderer: DEFAULT_TERMINAL_WEBGL_RENDERER,
  editorPreset: DEFAULT_EDITOR_PRESET,
  editorCommandTemplate: getDefaultEditorCommandTemplate(DEFAULT_EDITOR_PRESET),
}

export const Message = defineMessageUnion({
  ChangedScrollbackLines: { scrollbackLines: Schema.Number },
  ChangedMinColumnWidth: { minColumnWidth: Schema.Number },
  ChangedWebglRenderer: { webglRenderer: Schema.Boolean },
  ChangedEditorPreset: { editorPreset: EditorPresetSchema },
  ChangedEditorCommandTemplate: { editorCommandTemplate: Schema.String },
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedScrollbackLines: ({ scrollbackLines }) => ({
      model: modifyFields(model, { scrollbackLines: () => clampScrollback(scrollbackLines) }),
    }),
    ChangedMinColumnWidth: ({ minColumnWidth }) => ({
      model: modifyFields(model, { minColumnWidth: () => clampMinColumnWidth(minColumnWidth) }),
    }),
    ChangedWebglRenderer: ({ webglRenderer }) => ({
      model: modifyFields(model, { webglRenderer: () => webglRenderer === true }),
    }),
    ChangedEditorPreset: ({ editorPreset }) => {
      const normalizedPreset = normalizeEditorPreset(editorPreset)
      return {
        model: modifyFields(model, {
          editorPreset: () => normalizedPreset,
          editorCommandTemplate: () => normalizedPreset === "custom"
            ? normalizeEditorCommandTemplate(model.editorCommandTemplate, normalizedPreset)
            : getDefaultEditorCommandTemplate(normalizedPreset),
        }),
      }
    },
    ChangedEditorCommandTemplate: ({ editorCommandTemplate }) => ({
      model: modifyFields(model, {
        editorCommandTemplate: () => normalizeEditorCommandTemplate(editorCommandTemplate, model.editorPreset),
      }),
    }),
  })
