import type { Html, HtmlBuilder } from "foldkit/html"
import type { AppModel } from "../app/slice"
import { effectiveEditorPreset, getOpenAppItems, getOpenAppLabel, openAppIcon, openAppMenuItemContent, OPEN_APP_MENU_ITEM_CLASS_NAME, type OpenAppItem, type OpenAppValue } from "../chat/openExternal"
import { ChevronDown } from "../ui/icons"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import { Message } from "./message"
import type { Model } from "./model"
import { tooltipOf } from "./surface"

// OpenFileSelect (components/open-external-menu.tsx): "Open in…" for one
// file, in the viewer's header: the navbar's split button at a header
// control's size. The icon opens the file where it last went; the chevron
// lists the rest, the same list a file link's context menu has (editors,
// Preview, Finder, the default app). What it last opened is remembered apart
// from the navbar's; until there is something, it's the editor the navbar
// would use.

type H = HtmlBuilder<Message>

export interface OpenFileContext {
  isMac: boolean
  items: OpenAppItem[]
  lastValue: OpenAppValue
}

export function openFileContext(app: AppModel, isMac: boolean): OpenFileContext {
  const preferences = app.stores.terminalPreferences
  const installedEditors = app.stores.appSettings.settings?.installedEditors ?? null
  const items = getOpenAppItems({
    editorPreset: preferences.editorPreset,
    isMac,
    installedEditors,
    includeFinder: true,
    includePreview: true,
    includeDefault: true,
  })
  const remembered = app.stores.openDestination.fileValue
  // Only something this menu offers and can run: an editor since uninstalled falls back.
  const effective = effectiveEditorPreset(preferences.editorPreset, app.stores.openDestination.value, installedEditors)
  const lastValue = items.find((item) => item.value === remembered && item.installed)?.value ?? (`editor:${effective}` as OpenAppValue)
  return { isMac, items, lastValue }
}

export function selectOf(model: Model, id: string): Select.Model {
  return model.selects[id] ?? Select.init({ id: `viewer-select-${id}` })
}

export function openFileSelect(model: Model, context: OpenFileContext, options: { id: string; path: string; line: number | null }, h: H): Html {
  const { id, path, line } = options
  const label = `Open in ${getOpenAppLabel(context.lastValue, context.isMac)}`
  const tooltipId = `open-${id}`
  return h.div([h.Class("flex h-7 shrink-0 items-center rounded-md border border-border")], [
    h.submodel({
      slotId: `viewer-tooltip-${tooltipId}`,
      model: tooltipOf(model, tooltipId),
      view: Tooltip.view,
      viewInputs: {
        content: () => [label],
        toView: ({ trigger, portal }) => h.button([
          ...trigger,
          h.Type("button"),
          h.AriaLabel(label),
          h.OnClick(Message.ChoseOpenDestination({ path, line, value: context.lastValue })),
          h.Class("flex h-full items-center rounded-l-md pl-1.5 pr-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"),
        ], [openAppIcon(context.lastValue, context.isMac, "size-4.5", h), portal]),
      },
      toParentMessage: (message: Tooltip.Message) => Message.GotTooltipMessage({ id: tooltipId, message }),
    }),
    h.submodel({
      slotId: `viewer-open-${id}`,
      model: selectOf(model, id),
      view: Select.view,
      viewInputs: {
        value: undefined,
        items: context.items.map((item) => ({ value: item.value, disabled: !item.installed, className: OPEN_APP_MENU_ITEM_CLASS_NAME, textValue: item.label })),
        renderItem: (value: string) => {
          const item = context.items.find((candidate) => candidate.value === value)
          return item ? [openAppMenuItemContent(item, context.isMac, h)] : []
        },
        grouped: true,
        align: "end",
        toView: ({ trigger, portal }) => Select.selectTrigger({
          class: "!h-full !w-auto !py-0 !pl-0.5 !pr-1 rounded-l-none rounded-r-md border-0 bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:ring-0 focus:ring-offset-0 [&>svg]:hidden",
          attributes: [...trigger, h.AriaLabel("Choose where to open")],
        }, [
          // Wrapped: `[&>svg]:hidden` hides the trigger's built-in arrow, and would take a bare chevron with it.
          h.span([h.Class("flex items-center")], [ChevronDown({ class: "size-3.5" }, h)]),
        ], portal, h),
      },
      toParentMessage: (message: Select.Message) => Message.GotSelectMessage({ id, message }),
    }),
  ])
}

/** What a select's id says about the file it opens: `<card>:<path>:<line>`. */
export function selectTarget(id: string): { path: string; line: number | null } | null {
  const match = /^[^:]+:(.*):(\d*)$/u.exec(id)
  if (!match) return null
  return { path: match[1]!, line: match[2] ? Number(match[2]) : null }
}

export function selectId(card: string, path: string, line: number | null) {
  return `${card}:${path}:${line ?? ""}`
}
