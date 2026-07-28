import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react"
import { ChevronDown, Github } from "lucide-react"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction } from "../../shared/protocol"
import { getRepoUrlLabel } from "../../shared/git-url"
import { getDefaultEditorCommandTemplate } from "../stores/terminalPreferencesStore"
import { DefaultAppIcon, EDITOR_OPTIONS, EditorIcon, FinderIcon, FolderFallbackIcon, PreviewIcon, TerminalIcon } from "./editor-icons"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger } from "./ui/tooltip"
import { Button } from "./ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from "./ui/select"
import { ContextMenuContent, ContextMenuItem } from "./ui/context-menu"
import { OPEN_EXTERNAL_SELECT_STORAGE_KEY as OPEN_SELECT_STORAGE_KEY } from "../lib/storageKeys"

/**
 * `"repo"` is the odd one out: every other destination is an app on the machine
 * the project lives on, opened by the server. The repo's forge is a web page,
 * opened by *this* browser — which is the right end of the wire, since on a
 * remote machine the server has no browser you're looking at.
 */
export type OpenAppValue = "finder" | "terminal" | "preview" | "default" | "repo" | `editor:${EditorPreset}`

const OPEN_APP_MENU_ITEM_CLASS_NAME = "py-2 pl-2 pr-8"
const OPEN_APP_CONTEXT_MENU_ITEM_CLASS_NAME = "rounded-md text-sm font-normal focus:bg-accent focus:text-accent-foreground hover:bg-accent hover:text-accent-foreground"
const OPEN_APP_MENU_ROW_CLASS_NAME = "flex items-center gap-3"
const OPEN_APP_MENU_ICON_CLASS_NAME = "h-5 w-5 shrink-0"

export function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
  event.preventDefault()
  event.stopPropagation()
  const rect = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.bottom,
    view: window,
  }))
}

function OpenAppMenuItemContent({
  value,
  label,
  isMac,
}: {
  value: OpenAppValue
  label: string
  isMac: boolean
}) {
  return (
    <span className={OPEN_APP_MENU_ROW_CLASS_NAME}>
      <OpenAppIcon value={value} isMac={isMac} className={OPEN_APP_MENU_ICON_CLASS_NAME} />
      <span>{label}</span>
    </span>
  )
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
  if (value === "preview") return "Preview"
  if (value === "default") return "Default App"
  if (value === "repo") return getRepoUrlLabel(repoUrl)
  const preset = value.replace("editor:", "") as EditorPreset
  if (preset === "vscode") return "VS Code"
  return EDITOR_OPTIONS.find((option) => option.value === preset)?.label ?? "Editor"
}

export function OpenAppIcon({ value, isMac, className }: { value: OpenAppValue; isMac: boolean; className?: string }) {
  if (value === "repo") {
    return <Github className={className} />
  }
  if (value === "finder") {
    return isMac ? <FinderIcon className={className} /> : <FolderFallbackIcon className={className} />
  }
  if (value === "terminal") {
    return <TerminalIcon className={className} />
  }
  if (value === "preview") {
    return <PreviewIcon className={className} />
  }
  if (value === "default") {
    return <DefaultAppIcon className={className} />
  }
  return <EditorIcon preset={value.replace("editor:", "") as EditorPreset} className={className} />
}

function normalizeOpenAppValue(value: string | null, fallback: OpenAppValue): OpenAppValue {
  if (value === "finder" || value === "terminal" || value === "preview" || value === "default") return value
  // Not `repo`: the last-used destination is remembered across projects, and a
  // project with no origin would offer a button that does nothing.
  if (value === "repo") return fallback
  if (value?.startsWith("editor:")) {
    const preset = value.slice("editor:".length)
    if (preset === "vscode" || EDITOR_OPTIONS.some((option) => option.value === preset)) {
      return value as OpenAppValue
    }
  }
  return fallback
}

export function getOpenAppItems({
  editorPreset,
  isMac,
  includeFinder = true,
  includeTerminal = false,
  includePreview = false,
  includeDefault = false,
  repoUrl,
  menuKind = "context",
}: {
  editorPreset: EditorPreset
  isMac: boolean
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
}): Array<{ value: OpenAppValue; label: string }> {
  const editorItems: Array<{ value: OpenAppValue; label: string }> = [
    { value: "editor:cursor", label: "Cursor" },
    { value: "editor:xcode", label: "Xcode" },
    { value: "editor:windsurf", label: "Windsurf" },
    ...(editorPreset === "custom" ? [{ value: "editor:custom" as OpenAppValue, label: "Custom" }] : []),
  ]
  const defaultEditorValue = `editor:${editorPreset}` as OpenAppValue
  const sortedEditorItems = [
    ...editorItems.filter((item) => item.value === defaultEditorValue),
    ...editorItems.filter((item) => item.value !== defaultEditorValue),
  ]
  // Last in both orders. Every other entry opens the code on disk; the forge is
  // a different kind of destination, so it sits at the end rather than
  // interleaved with the apps.
  const repoItems = repoUrl ? [{ value: "repo" as OpenAppValue, label: getRepoUrlLabel(repoUrl) }] : []
  if (menuKind === "navbar") {
    return [
      ...sortedEditorItems.filter((item) => item.value === defaultEditorValue),
      ...(includeFinder ? [{ value: "finder" as OpenAppValue, label: isMac ? "Finder" : "Folder" }] : []),
      ...(includeTerminal ? [{ value: "terminal" as OpenAppValue, label: "Terminal" }] : []),
      ...sortedEditorItems.filter((item) => item.value !== defaultEditorValue),
      ...repoItems,
    ]
  }
  return [
    ...sortedEditorItems,
    ...(includePreview && isMac ? [{ value: "preview" as OpenAppValue, label: "Preview" }] : []),
    ...(includeFinder ? [{ value: "finder" as OpenAppValue, label: isMac ? "Finder" : "Folder" }] : []),
    ...(includeTerminal ? [{ value: "terminal" as OpenAppValue, label: "Terminal" }] : []),
    ...(includeDefault ? [{ value: "default" as OpenAppValue, label: "Default App" }] : []),
    ...repoItems,
  ]
}

export function openAppValue(args: {
  value: OpenAppValue
  editorCommandTemplate?: string
  /** Required for `"repo"`; the item is only offered when a URL exists. */
  repoUrl?: string
  onOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings) => void
}) {
  if (args.value === "repo") {
    // Straight to this browser rather than through `system.openExternal`: that
    // command opens things on the *machine running the agent*, which for a web
    // page is the wrong screen whenever that machine isn't this one.
    if (args.repoUrl) window.open(args.repoUrl, "_blank", "noopener,noreferrer")
    return
  }
  if (args.value === "finder") {
    args.onOpenExternal("open_finder")
    return
  }
  if (args.value === "terminal") {
    args.onOpenExternal("open_terminal")
    return
  }
  if (args.value === "preview") {
    args.onOpenExternal("open_preview")
    return
  }
  if (args.value === "default") {
    args.onOpenExternal("open_default")
    return
  }
  const preset = args.value.replace("editor:", "") as EditorPreset
  args.onOpenExternal("open_editor", getEditorSettings(preset, args.editorCommandTemplate))
}

export function OpenExternalSelect({
  isMac,
  editorPreset,
  editorCommandTemplate,
  finderShortcut,
  editorShortcut,
  repoUrl,
  onOpenExternal,
}: {
  isMac: boolean
  editorPreset: EditorPreset
  editorCommandTemplate?: string
  finderShortcut?: string[]
  editorShortcut?: string[]
  /** The project's forge page; omit and no repo item is offered. */
  repoUrl?: string
  onOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings) => void
}) {
  const fallbackValue = `editor:${editorPreset}` as OpenAppValue
  const [lastValue, setLastValue] = useState<OpenAppValue>(fallbackValue)

  useEffect(() => {
    setLastValue(normalizeOpenAppValue(window.localStorage.getItem(OPEN_SELECT_STORAGE_KEY), fallbackValue))
  }, [fallbackValue])

  const items = useMemo(() => getOpenAppItems({
    editorPreset,
    isMac,
    includeFinder: true,
    includeTerminal: true,
    repoUrl,
    menuKind: "navbar",
  }), [editorPreset, isMac, repoUrl])

  function handleOpenValue(value: OpenAppValue) {
    // The forge isn't remembered as the split button's default — see
    // `normalizeOpenAppValue`. Switching projects would leave the button
    // pointing at a repo the current project doesn't have.
    if (value !== "repo") {
      setLastValue(value)
      window.localStorage.setItem(OPEN_SELECT_STORAGE_KEY, value)
    }
    openAppValue({ value, editorCommandTemplate, repoUrl, onOpenExternal })
  }

  return (
    <div className="grid grid-cols-[1fr_auto]">
      <HotkeyTooltip>
        <HotkeyTooltipTrigger asChild>
          <Button
            variant="ghost"
            size="none"
            onClick={() => handleOpenValue(lastValue)}
            title={`Open in ${getOpenAppLabel(lastValue, isMac)}`}
            className="border-0 p-1 py-[3px] pr-0 hover:!border-border/0 hover:!bg-transparent"
          >
            <OpenAppIcon value={lastValue} isMac={isMac} className="size-5.5" />
          </Button>
        </HotkeyTooltipTrigger>
        <HotkeyTooltipContent
          side="bottom"
          shortcut={lastValue === "finder" ? finderShortcut : lastValue === `editor:${editorPreset}` ? editorShortcut : undefined}
        />
      </HotkeyTooltip>
      <Select value={undefined} onValueChange={(value) => handleOpenValue(value as OpenAppValue)}>
        <SelectTrigger
          aria-label="Choose open destination"
          className="!h-auto !py-0 !pl-0.5 !pr-1 border-0 bg-transparent hover:bg-transparent focus:ring-0 focus:ring-offset-0 [&>svg]:hidden"
        >
          <div className="flex items-center justify-center size-5">
            <ChevronDown className="h-4 w-4 opacity-60" />
          </div>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value} className={OPEN_APP_MENU_ITEM_CLASS_NAME}>
                <OpenAppMenuItemContent value={item.value} label={item.label} isMac={isMac} />
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

export function OpenExternalContextMenuContent({
  isMac,
  editorPreset,
  editorCommandTemplate,
  includeFinder = true,
  includeTerminal = false,
  includePreview = false,
  includeDefault = false,
  repoUrl,
  onOpenExternal,
}: {
  isMac: boolean
  editorPreset: EditorPreset
  editorCommandTemplate?: string
  includeFinder?: boolean
  includeTerminal?: boolean
  includePreview?: boolean
  includeDefault?: boolean
  /** The project's forge page; omit and no repo item is offered. */
  repoUrl?: string
  onOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings) => void
}) {
  const items = getOpenAppItems({
    editorPreset,
    isMac,
    includeFinder,
    includeTerminal,
    includePreview,
    includeDefault,
    repoUrl,
  })

  return (
    <ContextMenuContent className="rounded-lg p-1">
      {items.map((item) => (
        <ContextMenuItem
          key={item.value}
          className={`${OPEN_APP_MENU_ITEM_CLASS_NAME} ${OPEN_APP_CONTEXT_MENU_ITEM_CLASS_NAME}`}
          onSelect={(event) => {
            event.preventDefault()
            openAppValue({ value: item.value, editorCommandTemplate, repoUrl, onOpenExternal })
          }}
        >
          <OpenAppMenuItemContent value={item.value} label={item.label} isMac={isMac} />
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  )
}
