import { editorPresetFromOpenAppValue, isEditorInstalled as isPresetInstalled } from "../../client/lib/effective-editor"
import { EDITOR_PRESETS, getDefaultEditorCommandTemplate, getEditorPresetLabel } from "../../shared/editor-presets"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction } from "../../shared/protocol"
import { TERMINAL_PRESETS, TERMINAL_SPECS, type TerminalPreset } from "../../shared/terminal-presets"
import { AppAction } from "../app/action"
import type { OpenAppValue } from "./icons"

// The parts of components/open-external-menu.tsx the palette uses
// (getOpenAppItems, openAppValue), copied: that file is React components
// around them. `openAppAction` is openAppValue with its callback turned into
// the AppAction the palette asks the root for.

export const EDITOR_OPTIONS: Array<{ value: EditorPreset; label: string }> = EDITOR_PRESETS.map((value) => ({
  value,
  label: getEditorPresetLabel(value),
}))

/**
 * A menu entry. `installed: false` marks an editor this machine doesn't have:
 * still listed (so you can see Kanna supports it) but not clickable.
 */
export interface OpenAppItem {
  value: OpenAppValue
  label: string
  installed: boolean
}

/**
 * One entry per installed emulator, in TERMINAL_PRESETS order, plus the
 * generic entry that goes to whatever the machine opens by default (before
 * detection reports, when nothing was detected, and always off macOS).
 */
function getTerminalItems(installedTerminals: TerminalPreset[] | null, isMac: boolean): OpenAppItem[] {
  const systemItem: OpenAppItem = { value: "terminal", label: "Terminal", installed: true }
  if (!installedTerminals) return [systemItem]
  const namedItems = TERMINAL_PRESETS
    .filter((preset) => installedTerminals.includes(preset))
    .map((preset) => ({
      value: `terminal:${preset}` as OpenAppValue,
      label: TERMINAL_SPECS[preset].label,
      installed: true,
    }))
  // On macOS, Terminal.app is itself a preset and is always present, so the
  // named list already covers the default.
  if (isMac && namedItems.length > 0) return namedItems
  return [systemItem, ...namedItems]
}

function isEditorInstalled(value: OpenAppValue, installedEditors: EditorPreset[] | null) {
  const preset = editorPresetFromOpenAppValue(value)
  return preset === null || isPresetInstalled(preset, installedEditors)
}

export function getEditorSettings(preset: EditorPreset, customTemplate?: string): EditorOpenSettings {
  return {
    preset,
    commandTemplate: preset === "custom"
      ? customTemplate?.trim() || getDefaultEditorCommandTemplate(preset)
      : getDefaultEditorCommandTemplate(preset),
  }
}

/** getOpenAppItems with the palette's options (context-menu order, Finder and terminals, no repo). */
export function getOpenAppItems({
  editorPreset,
  isMac,
  installedEditors,
  installedTerminals,
}: {
  editorPreset: EditorPreset
  isMac: boolean
  installedEditors: EditorPreset[] | null
  installedTerminals: TerminalPreset[] | null
}): OpenAppItem[] {
  const editorItems: OpenAppItem[] = EDITOR_OPTIONS
    // Xcode can't exist off macOS, and "Custom" is a destination only once the
    // user has written a command for it — neither is a missing app.
    .filter((option) => (option.value !== "xcode" || isMac) && (option.value !== "custom" || editorPreset === "custom"))
    .map((option) => ({
      value: `editor:${option.value}` as OpenAppValue,
      label: option.label,
      installed: isEditorInstalled(`editor:${option.value}`, installedEditors),
    }))
  const defaultEditorValue = `editor:${editorPreset}` as OpenAppValue
  // The head of the list is whatever the navbar button itself opens.
  const headValue = editorItems.some((item) => item.value === defaultEditorValue && item.installed)
    ? defaultEditorValue
    : editorItems.find((item) => item.installed)?.value ?? defaultEditorValue
  const sortedEditorItems = [
    ...editorItems.filter((item) => item.value === headValue),
    ...editorItems.filter((item) => item.value !== headValue && item.installed),
    ...editorItems.filter((item) => item.value !== headValue && !item.installed),
  ]
  const app = (value: OpenAppValue, label: string): OpenAppItem => ({ value, label, installed: true })
  return [
    ...sortedEditorItems,
    app("finder", isMac ? "Finder" : "Folder"),
    ...getTerminalItems(installedTerminals, isMac),
  ]
}

/** openAppValue's `onOpenExternal` call, as the AppAction (`state.handleOpenExternal`). */
export function openAppAction(value: OpenAppValue, editorCommandTemplate: string): AppAction | null {
  const open = (action: OpenExternalAction, editor: EditorOpenSettings | null = null, terminal: TerminalPreset | null = null) =>
    AppAction.OpenExternal({ action, editor, terminal })
  // The palette never offers the repo's forge page.
  if (value === "repo") return null
  if (value === "finder") return open("open_finder")
  if (value === "terminal") return open("open_terminal")
  if (value.startsWith("terminal:")) return open("open_terminal", null, value.slice("terminal:".length) as TerminalPreset)
  if (value === "preview") return open("open_preview")
  if (value === "default") return open("open_default")
  const preset = value.replace("editor:", "") as EditorPreset
  return open("open_editor", getEditorSettings(preset, editorCommandTemplate))
}
