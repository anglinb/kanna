import type { Html, HtmlBuilder } from "foldkit/html"
import { getEditorPresetLabel } from "../../shared/editor-presets"
import { editorPresetFromOpenAppValue, resolveEffectiveEditorPreset } from "../../client/lib/effective-editor"
import type { ChatDiffSnapshot } from "../../shared/types"
import type { AppModel } from "../app/slice"
import type { ChatPageContext, ChatPageRequests } from "../chat/pageInputs"
import type { ProjectDiffCommitSelection } from "../core/stores/diffCommit"
import type { WidgetDisclosureId } from "../core/stores/rightSidebar"
import * as ViewerStore from "../core/stores/viewer"
import * as ContextMenu from "../ui/context-menu"
import * as Tooltip from "../ui/tooltip"
import { EMPTY_DIFF_SNAPSHOT } from "./gitLogic"
import { Message } from "./message"
import type { MenuTarget, Model } from "./model"
import { defaultWidgetExpanded, type PartsMessage, type WidgetRowMenu } from "./parts"
import { Option } from "effect"

export type H = HtmlBuilder<Message>

/** The parts' own Mounts (a slot's entrance, a stopped click), lifted into the column's Message. */
export const toParts = (message: PartsMessage) => Message.GotPartsMessage({ message })

/** What every widget view reads, worked out once per render of the column. */
export interface ColumnContext {
  model: Model
  app: AppModel
  page: ChatPageContext
  requests: ChatPageRequests
  projectId: string
  chatId: string | null
  diffs: ChatDiffSnapshot
  editorLabel: string
  /** The file the viewer's diff list is on (useReviewedPath). */
  reviewedPath: string | null
  selection: ProjectDiffCommitSelection | undefined
  summary: string
  description: string
  /** useWidgetExpanded: the stored state, else its default for this many rows. */
  expanded: (id: WidgetDisclosureId, rowCount: number, defaultOpen?: boolean) => boolean
  now: number
}

/** The editor the "Open in …" items name (useKannaState's editorLabel). */
export function editorLabel(app: AppModel): string {
  const preferences = app.stores.terminalPreferences
  const preset = resolveEffectiveEditorPreset({
    preferred: preferences.editorPreset,
    remembered: editorPresetFromOpenAppValue(app.stores.openDestination.value),
    installedEditors: app.stores.appSettings.settings?.installedEditors ?? null,
  })
  return getEditorPresetLabel(preset)
}

export function columnContext(model: Model, app: AppModel, page: ChatPageContext, requests: ChatPageRequests): ColumnContext | null {
  const projectId = page.projectId
  if (!projectId) return null
  const ui = app.stores.rightSidebar.projectUi[projectId]
  return {
    model,
    app,
    page,
    requests,
    projectId,
    chatId: page.chatId,
    diffs: app.projectDiffs[projectId] ?? EMPTY_DIFF_SNAPSHOT,
    editorLabel: editorLabel(app),
    reviewedPath: ViewerStore.reviewedPath({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar }, projectId),
    selection: app.stores.diffCommit.selectionsByProjectId[projectId],
    summary: ui?.summary ?? "",
    description: ui?.description ?? "",
    expanded: (id, rowCount, defaultOpen) => {
      const stored = ui?.expanded?.[id]
      if (stored !== undefined) return stored
      return rowCount > 0 ? defaultOpen ?? defaultWidgetExpanded(rowCount) : false
    },
    now: model.now,
  }
}

// THE ROW MENU

export const sameTarget = (left: MenuTarget | null, right: MenuTarget) =>
  left !== null && JSON.stringify(left) === JSON.stringify(right)

/** The menu is up on this row (Radix's `data-state="open"` on the trigger). */
export function menuOpenOn(model: Model, target: MenuTarget) {
  return ContextMenu.isOpen(model.menu) && sameTarget(model.menuTarget, target)
}

/** A row's menu: right click or long press, and the kebab. */
export function rowMenu(model: Model, target: MenuTarget, label: string, h: H): WidgetRowMenu<Message> {
  return {
    label,
    onKebab: ({ x, y }) => Message.PressedRowKebab({ target, x, y }),
    trigger: [
      h.DataAttribute("state", menuOpenOn(model, target) ? "open" : "closed"),
      h.OnContextMenu(Message.RequestedMenu({ target })),
      h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX, clientY) =>
        Option.some(Message.PressedMenuTrigger({
          target,
          pointerType,
          button,
          // Radix positions from the contextmenu event, whose coordinates
          // Chromium truncates to whole pixels.
          x: pointerType === "mouse" ? Math.trunc(clientX) : clientX,
          y: pointerType === "mouse" ? Math.trunc(clientY) : clientY,
        }))),
      h.OnPointerMove((_x, _y, pointerType) => (pointerType !== "mouse" ? Option.some(Message.MovedOnMenuTrigger()) : Option.none())),
      h.OnPointerUp((_x, _y, pointerType) => (pointerType !== "mouse" ? Option.some(Message.MovedOnMenuTrigger()) : Option.none())),
    ],
  }
}

// TOOLTIPS

export function tooltipModel(model: Model, id: string): Tooltip.Model {
  return model.tooltips[id] ?? Tooltip.init({ id: `widgets-${id}`, delayDuration: 0 })
}

/**
 * `<Tooltip delayDuration={0}>` around a trigger. Inside a card it is still
 * (WidgetGroup's StillTooltips: the right sidebar is scanned like the left
 * one); in a dialog it moves.
 */
export function tooltip(model: Model, id: string, inputs: Omit<Tooltip.ViewInputs, "still">, h: H, still = true): Html {
  return h.submodel({
    slotId: `widgets-tooltip-${id}`,
    model: tooltipModel(model, id),
    view: Tooltip.view,
    viewInputs: { ...inputs, still },
    toParentMessage: (message) => Message.GotTooltipMessage({ id, message }),
  })
}
