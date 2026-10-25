import type { Html, HtmlBuilder } from "foldkit/html"
import { publicAssetUrl } from "../../client/lib/publicAsset"
import { EDITOR_PRESETS, getEditorPresetLabel } from "../../shared/editor-presets"
import type { EditorPreset } from "../../shared/protocol"

// The editor app icons from src/client/components/editor-icons.tsx (the
// Default Editor picker), with the same <img> markup. Brand marks are
// ui/provider-icons.ts. Other slices draw these too; the integrator may
// hoist this file into ui/.

// EDITORS (editor-icons.tsx)

export const EDITOR_OPTIONS: Array<{ value: EditorPreset; label: string }> = EDITOR_PRESETS.map((value) => ({
  value,
  label: getEditorPresetLabel(value),
}))

const EDITOR_ICON_SRC: Record<EditorPreset, string> = {
  cursor: publicAssetUrl("/editor-icons/cursor.png"),
  vscode: publicAssetUrl("/editor-icons/vscode.png"),
  zed: publicAssetUrl("/editor-icons/zed.png"),
  xcode: publicAssetUrl("/editor-icons/xcode.png"),
  windsurf: publicAssetUrl("/editor-icons/windsurf.png"),
  custom: publicAssetUrl("/editor-icons/custom.png"),
}

export function editorIcon<Message>(preset: EditorPreset, options: { class?: string }, h: HtmlBuilder<Message>): Html {
  return h.img([
    h.Src(EDITOR_ICON_SRC[preset] ?? EDITOR_ICON_SRC.cursor),
    h.Alt(""),
    h.AriaHidden(true),
    h.Draggable(false),
    ...(options.class !== undefined ? [h.Class(options.class)] : []),
  ])
}
