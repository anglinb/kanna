import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { editorPresetFromOpenAppValue, isEditorInstalled as isPresetInstalled, resolveEffectiveEditorPreset } from "../../client/lib/effective-editor"
import { getRepoUrlLabel } from "../../shared/git-url"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction, TerminalPreset } from "../../shared/protocol"
import { TERMINAL_PRESETS, TERMINAL_SPECS } from "../../shared/terminal-presets"
import { getDefaultEditorCommandTemplate } from "../../shared/editor-presets"
import { AppAction } from "../app/action"
import type { Child } from "../ui/attributes"
import * as ContextMenu from "../ui/context-menu"
import { defaultAppIcon, EDITOR_OPTIONS, editorIcon, finderIcon, folderFallbackIcon, githubIcon, previewIcon, terminalIcon } from "./editorIcons"

// Port of the React-free half of src/client/components/open-external-menu.tsx:
// the "Open in…" destinations, what each opens, and their rows. The navbar's
// split button (OpenExternalSelect) is drawn by navbar.ts from these.

/**
 * `"repo"` is the odd one out: every other destination is an app on the machine
 * the project lives on, opened by the server. The repo's forge is a web page,
 * opened by *this* browser — which is the right end of the wire, since on a
 * remote machine the server has no browser you're looking at.
 */
export type OpenAppValue =
  | "finder"
  /** The machine's default terminal, and the only terminal entry until detection reports. */
  | "terminal"
  | "preview"
  | "default"
  | "repo"
  | `editor:${EditorPreset}`
  | `terminal:${TerminalPreset}`

/**
 * A menu entry. `installed: false` marks an editor this machine doesn't have:
 * still listed (so you can see Kanna supports it) but not clickable, since the
 * open would only fail in the server with an error nobody is looking at.
 */
export interface OpenAppItem {
  value: OpenAppValue
  label: string
  installed: boolean
}

function terminalPresetFromValue(value: OpenAppValue) {
  return value.startsWith("terminal:") ? value.slice("terminal:".length) as TerminalPreset : null
}

/**
 * One entry per installed emulator, in TERMINAL_PRESETS order, plus the
 * generic entry that goes to whatever the machine opens by default.
 *
 * That generic entry is what the menu had before any of this, and it stays
 * wherever the named list can't stand in for it: before detection reports (and
 * on servers too old to send it), when nothing was detected at all, and always
 * off macOS — the server opens GNOME Terminal, Konsole, Windows Terminal or
 * cmd there through paths that have no preset to detect.
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

/** `getEffectiveEditorPreset`: the editor a plain "Open in …" entry names and opens. */
export function effectiveEditorPreset(preferred: EditorPreset, remembered: string | null, installedEditors: EditorPreset[] | null) {
  return resolveEffectiveEditorPreset({
    preferred,
    remembered: editorPresetFromOpenAppValue(remembered),
    installedEditors,
  })
}

export function getEditorSettings(preset: EditorPreset, customTemplate?: string): EditorOpenSettings {
  return {
    preset,
    commandTemplate: preset === "custom"
      ? customTemplate?.trim() || getDefaultEditorCommandTemplate(preset)
      : getDefaultEditorCommandTemplate(preset),
  }
}

export function getOpenAppLabel(value: OpenAppValue, isMac: boolean, repoUrl?: string) {
  if (value === "finder") return isMac ? "Finder" : "Folder"
  if (value === "terminal") return "Terminal"
  const terminalPreset = terminalPresetFromValue(value)
  if (terminalPreset) return TERMINAL_SPECS[terminalPreset].label
  if (value === "preview") return "Preview"
  if (value === "default") return "Default App"
  if (value === "repo") return getRepoUrlLabel(repoUrl)
  const preset = value.replace("editor:", "") as EditorPreset
  return EDITOR_OPTIONS.find((option) => option.value === preset)?.label ?? "Editor"
}

export function openAppIcon<Message>(value: OpenAppValue, isMac: boolean, className: string | undefined, h: HtmlBuilder<Message>): Html {
  if (value === "repo") return githubIcon(className, h)
  if (value === "finder") return isMac ? finderIcon(className, h) : folderFallbackIcon(className, h)
  if (value === "terminal" || value.startsWith("terminal:")) {
    return terminalIcon(terminalPresetFromValue(value) ?? undefined, className, h)
  }
  if (value === "preview") return previewIcon(className, h)
  if (value === "default") return defaultAppIcon(className, h)
  return editorIcon(value.replace("editor:", "") as EditorPreset, className, h)
}

export function normalizeOpenAppValue(
  value: string | null,
  fallback: OpenAppValue,
  installedEditors: EditorPreset[] | null,
  installedTerminals: TerminalPreset[] | null,
): OpenAppValue {
  if (value === "finder" || value === "terminal" || value === "preview" || value === "default") return value
  if (value?.startsWith("terminal:")) {
    // An emulator that has since been uninstalled falls back like an editor does.
    const preset = value.slice("terminal:".length) as TerminalPreset
    return installedTerminals && !installedTerminals.includes(preset) ? fallback : value as OpenAppValue
  }
  // Not `repo`: the last-used destination is remembered across projects, and a
  // project with no origin would offer a button that does nothing.
  if (value === "repo") return fallback
  if (value?.startsWith("editor:")) {
    const preset = value.slice("editor:".length)
    // An editor that has since been uninstalled falls back too, rather than
    // leaving the split button's primary click on something that can't run.
    if (EDITOR_OPTIONS.some((option) => option.value === preset) && isEditorInstalled(value as OpenAppValue, installedEditors)) {
      return value as OpenAppValue
    }
  }
  return fallback
}

export function getOpenAppItems({
  editorPreset,
  isMac,
  installedEditors = null,
  installedTerminals = null,
  includeFinder = true,
  includeTerminal = false,
  includePreview = false,
  includeDefault = false,
  repoUrl,
  menuKind = "context",
}: {
  editorPreset: EditorPreset
  isMac: boolean
  /** `null` leaves every editor enabled. */
  installedEditors?: EditorPreset[] | null
  /** `null` keeps the single system-default entry. */
  installedTerminals?: TerminalPreset[] | null
  includeFinder?: boolean
  includeTerminal?: boolean
  includePreview?: boolean
  includeDefault?: boolean
  /**
   * The project's forge page. Its presence *is* the include flag — there is no
   * "show it disabled" state worth having, and a project with no origin simply
   * has nowhere to go.
   */
  repoUrl?: string
  menuKind?: "context" | "navbar"
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
  // The head of the list is whatever the navbar button itself opens, so when
  // the preferred editor isn't installed the head passes to one that is and
  // the preferred one sinks in with the rest of the greyed-out entries.
  const headValue = editorItems.some((item) => item.value === defaultEditorValue && item.installed)
    ? defaultEditorValue
    : editorItems.find((item) => item.installed)?.value ?? defaultEditorValue
  // Head first, then the rest, then the ones that aren't installed — the
  // entries you can act on stay at the top of the list.
  const sortedEditorItems = [
    ...editorItems.filter((item) => item.value === headValue),
    ...editorItems.filter((item) => item.value !== headValue && item.installed),
    ...editorItems.filter((item) => item.value !== headValue && !item.installed),
  ]
  const app = (value: OpenAppValue, label: string): OpenAppItem => ({ value, label, installed: true })
  const terminalItems = includeTerminal ? getTerminalItems(installedTerminals, isMac) : []
  // Last in both orders. Every other entry opens the code on disk; the forge is
  // a different kind of destination, so it sits at the end rather than
  // interleaved with the apps.
  const repoItems = repoUrl ? [app("repo", getRepoUrlLabel(repoUrl))] : []
  if (menuKind === "navbar") {
    return [
      ...sortedEditorItems.filter((item) => item.value === headValue),
      ...(includeFinder ? [app("finder", isMac ? "Finder" : "Folder")] : []),
      ...terminalItems,
      ...sortedEditorItems.filter((item) => item.value !== headValue),
      ...repoItems,
    ]
  }
  return [
    ...sortedEditorItems,
    ...(includePreview && isMac ? [app("preview", "Preview")] : []),
    ...(includeFinder ? [app("finder", isMac ? "Finder" : "Folder")] : []),
    ...terminalItems,
    ...(includeDefault ? [app("default", "Default App")] : []),
    ...repoItems,
  ]
}

/**
 * What the split button does when the remembered choice is unusable. The
 * preferred editor first; if that one isn't installed, whichever editor is;
 * and Finder if none is, since the button always has to do *something*.
 */
export function openSelectFallbackValue(editorPreset: EditorPreset, installedEditors: EditorPreset[] | null, items: OpenAppItem[]): OpenAppValue {
  const preferred = `editor:${editorPreset}` as OpenAppValue
  if (isEditorInstalled(preferred, installedEditors)) return preferred
  return items.find((item) => item.installed && item.value.startsWith("editor:"))?.value ?? "finder"
}

/** Opens the project's forge page in this browser (never through the machine). */
export const OpenRepoPage = Command.define("OpenRepoPage", {
  args: { url: Schema.String },
  messages: [],
  execute: ({ url }) => Effect.sync(() => {
    window.open(url, "_blank", "noopener,noreferrer")
  }).pipe(Effect.andThen(Effect.never)),
})

/**
 * `openAppValue`: what choosing a destination asks for. The forge goes
 * straight to this browser (a Command the caller runs), everything else to
 * the machine as `system.openExternal` through the root.
 */
export function openAppValueRequest(args: {
  value: OpenAppValue
  editorCommandTemplate?: string
  repoUrl?: string
}): { _tag: "Repo"; url: string } | { _tag: "Action"; action: AppAction } | { _tag: "None" } {
  const external = (action: OpenExternalAction, editor: EditorOpenSettings | null = null, terminal: TerminalPreset | null = null) =>
    ({ _tag: "Action" as const, action: AppAction.OpenExternal({ action, editor, terminal }) })
  if (args.value === "repo") {
    // Straight to this browser rather than through `system.openExternal`: that
    // command opens things on the *machine running the agent*, which for a web
    // page is the wrong screen whenever that machine isn't this one.
    return args.repoUrl ? { _tag: "Repo", url: args.repoUrl } : { _tag: "None" }
  }
  if (args.value === "finder") return external("open_finder")
  if (args.value === "terminal") return external("open_terminal")
  if (args.value.startsWith("terminal:")) return external("open_terminal", null, args.value.slice("terminal:".length) as TerminalPreset)
  if (args.value === "preview") return external("open_preview")
  if (args.value === "default") return external("open_default")
  const preset = args.value.replace("editor:", "") as EditorPreset
  return external("open_editor", getEditorSettings(preset, args.editorCommandTemplate))
}

// The `span:last-child` reach-in is Radix's ItemText wrapper: it shrinks to
// its content, which would leave each row's "Not installed" badge wherever its
// label happened to end instead of in a column down the right.
export const OPEN_APP_MENU_ITEM_CLASS_NAME = "py-2 pl-2 pr-8 [&>span:last-child]:w-full"
export const OPEN_APP_CONTEXT_MENU_ITEM_CLASS_NAME = "rounded-md text-sm font-normal focus:bg-accent focus:text-accent-foreground hover:bg-accent hover:text-accent-foreground"
const OPEN_APP_MENU_ROW_CLASS_NAME = "flex w-full items-center gap-3"
const OPEN_APP_MENU_ICON_CLASS_NAME = "h-5 w-5 shrink-0"

/** `OpenAppMenuItemContent`: a row's icon, label and "Not installed" badge. */
export function openAppMenuItemContent<Message>(item: OpenAppItem, isMac: boolean, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class(OPEN_APP_MENU_ROW_CLASS_NAME)], [
    openAppIcon(item.value, isMac, `${OPEN_APP_MENU_ICON_CLASS_NAME}${item.installed ? "" : " opacity-40 grayscale"}`, h),
    h.span(item.installed ? [] : [h.Class("text-muted-foreground")], [item.label]),
    item.installed
      ? null
      : h.span(
        [h.Class("ml-auto shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] leading-4 font-medium text-muted-foreground")],
        ["Not installed"],
      ),
  ])
}

/** Menu values for the destinations, kept apart from a menu's own items. */
export const OPEN_APP_MENU_PREFIX = "open-app:"

/**
 * `OpenAppMenuItems`: the destinations as bare context-menu items, so a menu
 * that already exists can carry them without nesting a second menu.
 */
export function openAppMenuEntries(items: OpenAppItem[], itemClassName?: string): ContextMenu.MenuEntry[] {
  return items.map((item) => ContextMenu.item({
    value: `${OPEN_APP_MENU_PREFIX}${item.value}`,
    disabled: !item.installed,
    className: `${OPEN_APP_MENU_ITEM_CLASS_NAME} ${OPEN_APP_CONTEXT_MENU_ITEM_CLASS_NAME}${itemClassName ? ` ${itemClassName}` : ""}`,
  }))
}

/** The row for a destination menu value, or null for a value that isn't one. */
export function renderOpenAppMenuValue<Message>(value: string, items: OpenAppItem[], isMac: boolean, h: HtmlBuilder<Message>): ReadonlyArray<Child> | null {
  if (!value.startsWith(OPEN_APP_MENU_PREFIX)) return null
  const item = items.find((candidate) => `${OPEN_APP_MENU_PREFIX}${candidate.value}` === value)
  return item ? [openAppMenuItemContent(item, isMac, h)] : []
}

export function openAppValueOfMenuValue(value: string): OpenAppValue | null {
  return value.startsWith(OPEN_APP_MENU_PREFIX) ? value.slice(OPEN_APP_MENU_PREFIX.length) as OpenAppValue : null
}
