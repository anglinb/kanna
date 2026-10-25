import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { getMinimumTerminalWidth } from "../../client/components/chat-ui/TerminalWorkspaceLayout"
import { getResolvedKeybindings } from "../../client/lib/keybindings"
import type { AppModel, SliceViewInputs } from "../app/slice"
import { resolveTheme, themePreference } from "../app/theme"
import type { ProjectTerminalLayout } from "../core/stores/terminalLayout"
import { button } from "../ui/button"
import type { Icon } from "../ui/icon"
import { ChevronDown, Eraser, Plus, X } from "../ui/icons"
import * as Tooltip from "../ui/tooltip"
import { Message, type Surface } from "./message"
import { type Model, splitTooltipId } from "./model"
import { mountInputs } from "./mountInputs"
import { TerminalPane, TerminalWorkspaceScroller } from "./mounts"
import type { PaneInputs } from "./pane"
import { resizableHandle, resizablePanel, resizablePanelGroup, type GroupItem } from "./resizable"
import { HOME_TERMINAL_LAYOUT_KEY, projectLayout } from "./update"

type H = HtmlBuilder<Message>

/**
 * Where the workspace is embedded and what its host passes it: TerminalWorkspace's props.
 * The /terminal page leaves `workspace` out; the chat page passes one.
 */
export interface WorkspaceOptions {
  /** Layout-store key. */
  layoutKey: string
  /**
   * The project the shells run in, passed to terminal.create; null spawns
   * home-directory shells (the /terminal page, whose key is no project).
   */
  paneProjectId: string | null
  surface: Surface
  /**
   * What the X offers on the only remaining pane. Splits always close.
   * - `close`: kill it, same as a split.
   * - `hide`: collapse the panel and leave the shell attached (chat panel).
   * - `locked`: no X; the surface always needs one pane (/terminal page).
   */
  lastPaneClose: "close" | "hide" | "locked"
  /** The chat whose own visibility hiding the panel changes, when per chat. */
  chatKey: string | null
  focusRequestVersion: number
  pendingCommandsByTerminalId: Readonly<Record<string, string>>
  splitTerminalShortcut?: ReadonlyArray<string>
}

/**
 * What the chat page hands its sub-slices (chat/pageInputs.ts's
 * `ChatPageContext`), the part the terminal reads: TerminalWorkspaceShell's
 * props. Typed here structurally so this slice needn't import chat/.
 */
export interface ChatTerminalContext {
  projectId: string | null
  terminal: {
    focusRequestVersion: number
    pendingCommandsByTerminalId: Readonly<Record<string, string>>
    /** Per chat (`paneVisibility.terminal`), or null when the pane follows the project. */
    chatKey: string | null
  }
}

/**
 * The /terminal page passes neither; the chat page passes its `page`
 * context (or a ready `workspace`), and gets the panel's workspace.
 */
export interface ViewInputs extends SliceViewInputs {
  workspace?: WorkspaceOptions
  page?: ChatTerminalContext
}

/** TerminalWorkspaceShell's TerminalWorkspace props, from the chat page's context. */
export function chatWorkspaceOptions(app: AppModel, page: ChatTerminalContext): WorkspaceOptions | null {
  if (!page.projectId) return null
  return {
    layoutKey: page.projectId,
    paneProjectId: page.projectId,
    surface: "chat",
    lastPaneClose: "hide",
    chatKey: page.terminal.chatKey,
    focusRequestVersion: page.terminal.focusRequestVersion,
    pendingCommandsByTerminalId: page.terminal.pendingCommandsByTerminalId,
    splitTerminalShortcut: getResolvedKeybindings(app.keybindings).bindings.addSplitTerminal,
  }
}

interface PaneCloseAction {
  label: string
  icon: Icon
}

const CLOSE_PANE_ACTION: PaneCloseAction = { label: "Close terminal", icon: X }
const HIDE_PANE_ACTION: PaneCloseAction = { label: "Hide terminal", icon: ChevronDown }

/** The /terminal page's workspace (TerminalPage's props for TerminalWorkspace). */
const PAGE_WORKSPACE: WorkspaceOptions = {
  layoutKey: HOME_TERMINAL_LAYOUT_KEY,
  paneProjectId: null,
  surface: "page",
  lastPaneClose: "locked",
  chatKey: null,
  focusRequestVersion: 0,
  pendingCommandsByTerminalId: {},
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { app, workspace, page }, h) => {
  if (workspace) return workspaceView(model, app, workspace, h)
  if (page) {
    const options = chatWorkspaceOptions(app, page)
    return options ? workspaceView(model, app, options, h) : null
  }
  return pageView(model, app, h)
})

/**
 * TerminalPage (`/terminal`): the dev box's full-screen terminal, the same
 * workspace as the chat page's panel but page-sized, with shells at $HOME.
 * Not a dev box: nothing, while `observe` sends the page to `/`.
 */
function pageView(model: Model, app: AppModel, h: H): Html {
  const settings = app.stores.appSettings.settings
  if (settings !== null && settings.devbox !== true) return null
  const layout = projectLayout(app, HOME_TERMINAL_LAYOUT_KEY)
  const hasTerminals = (layout?.terminals.length ?? 0) > 0
  return h.div([h.Class("flex-1 flex min-h-0 min-w-0 flex-col pt-14 md:pt-0")], [
    layout && hasTerminals ? workspaceView(model, app, PAGE_WORKSPACE, h) : null,
  ])
}

/** TerminalWorkspace: the panes side by side in a resizable group, scrolling sideways past the minimum widths. */
export function workspaceView(model: Model, app: AppModel, options: WorkspaceOptions, h: H): Html {
  const layout = projectLayout(app, options.layoutKey)
  if (!layout) return null
  const preferences = app.stores.terminalPreferences
  const viewportWidth = model.viewportWidth
  const paneCount = layout.terminals.length
  const closeAction = paneCount > 1
    ? CLOSE_PANE_ACTION
    : options.lastPaneClose === "locked" ? null
    : options.lastPaneClose === "hide" ? HIDE_PANE_ACTION
    : CLOSE_PANE_ACTION
  const minTerminalWidth = getMinimumTerminalWidth(preferences.minColumnWidth)
  const effectiveMinTerminalWidth = viewportWidth > 0 ? Math.min(minTerminalWidth, viewportWidth) : minTerminalWidth
  const requiredWidth = Math.max(1, paneCount) * effectiveMinTerminalWidth
  const innerWidth = Math.max(viewportWidth, requiredWidth)
  const terminalIds = layout.terminals.map((terminal) => terminal.id)
  const panelGroupKey = terminalIds.join(":")
  const shared: PaneShared = {
    options,
    app,
    model,
    closeAction,
    minTerminalWidth: effectiveMinTerminalWidth,
    theme: resolveTheme(themePreference(app.stores.appSettings.settings), app.systemTheme),
  }

  return h.div([h.Class("flex h-full min-h-0 flex-col")], [
    h.div([
      h.Class("min-h-0 flex-1 overflow-x-auto overflow-y-hidden"),
      mountInputs({ terminalIds }, h),
      h.OnMount(TerminalWorkspaceScroller()),
    ], [
      h.div([h.Class("h-full min-h-0"), h.Style({ width: innerWidth ? `${innerWidth}px` : "100%" })], [
        resizablePanelGroup<Message>({
          id: `terminal-workspace-${options.layoutKey}`,
          key: panelGroupKey,
          orientation: "horizontal",
          className: "h-full min-h-0",
          toMessage: (message) => Message.GotGroupMessage({ layoutKey: options.layoutKey, message }),
          items: layout.terminals.flatMap((terminal, index) =>
            paneItems(terminal, index, index === layout.terminals.length - 1, shared, h)),
        }, h),
      ]),
    ]),
  ])
}

interface PaneShared {
  options: WorkspaceOptions
  app: AppModel
  model: Model
  closeAction: PaneCloseAction | null
  minTerminalWidth: number
  theme: "light" | "dark"
}

/** TerminalWorkspacePane: the pane's panel and, unless it is last, the handle after it. */
function paneItems(terminal: ProjectTerminalLayout["terminals"][number], index: number, isLast: boolean, shared: PaneShared, h: H): GroupItem[] {
  const { options, model, closeAction, minTerminalWidth } = shared
  const terminalId = terminal.id
  const widthStyle = { "min-width": `${minTerminalWidth}px`, "max-width": "100%" }
  const panel = resizablePanel({
    id: terminalId,
    defaultSize: `${terminal.size}%`,
    minSize: `${minTerminalWidth}px`,
    className: "min-h-0 overflow-hidden",
    style: widthStyle,
    content: [
      h.div([
        h.Class("flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-transparent last:border-r-0"),
        h.Style(widthStyle),
      ], [
        h.div([h.Class("flex items-center gap-2 px-3 pr-2 pt-2 pb-1")], [
          h.div([h.Class("min-w-0 flex-1 text-left")], [
            h.div([h.Class("flex min-w-0 items-center gap-2")], [
              h.div([h.Class("shrink-0 text-sm font-medium")], ["Terminal"]),
              h.div([h.Class("min-w-0 truncate text-xs text-muted-foreground")], [model.pathsByTerminalId[terminalId] ?? ""]),
            ]),
          ]),
          h.div([h.Class("flex items-center gap-1")], [
            button({
              variant: "ghost",
              size: "icon-sm",
              attributes: [h.AriaLabel("Clear terminal"), h.OnClick(Message.ClickedClearTerminal({ terminalId }))],
            }, [Eraser({ class: "size-3.5" }, h)], h),
            splitButton(terminalId, shared, h),
            closeAction
              ? button({
                variant: "ghost",
                size: "icon-sm",
                attributes: [
                  h.AriaLabel(closeAction.label),
                  h.OnClick(Message.ClickedRemoveTerminal({ layoutKey: options.layoutKey, terminalId, surface: options.surface, chatKey: options.chatKey })),
                ],
              }, [closeAction.icon({ class: "size-3.5" }, h)], h)
              : null,
          ]),
        ]),
        paneView(terminalId, index, shared, h),
      ]),
    ],
  })
  return isLast ? [panel] : [panel, resizableHandle({ id: `${terminalId}-handle`, orientation: "horizontal", withHandle: true }, h)]
}

/** "Add terminal to the right", with its hotkey tooltip below it. */
function splitButton(terminalId: string, shared: PaneShared, h: H): Html {
  const { options, model } = shared
  return h.submodel({
    slotId: `split-tooltip-${terminalId}`,
    model: model.tooltips[terminalId] ?? Tooltip.init({ id: splitTooltipId(terminalId) }),
    view: Tooltip.view,
    viewInputs: {
      side: "bottom",
      variant: "hotkey",
      content: Tooltip.hotkeyContent({ shortcut: options.splitTerminalShortcut }, h),
      toView: ({ trigger, portal }) => button({
        variant: "ghost",
        size: "icon-sm",
        attributes: [
          ...trigger,
          h.AriaLabel("Add terminal to the right"),
          h.OnClick(Message.ClickedAddTerminal({ layoutKey: options.layoutKey, afterTerminalId: terminalId })),
        ],
      }, [Plus({ class: "size-3.5" }, h), portal], h),
    },
    toParentMessage: (message) => Message.GotTooltipMessage({ terminalId, message }),
  })
}

/** TerminalPane's markup: the xterm's element (its Mount) and the error line. */
function paneView(terminalId: string, index: number, shared: PaneShared, h: H): Html {
  const { options, app, model } = shared
  const preferences = app.stores.terminalPreferences
  const inputs: PaneInputs = {
    projectId: options.paneProjectId,
    scrollback: preferences.scrollbackLines,
    theme: shared.theme,
    webglRenderer: preferences.webglRenderer,
    connectionStatus: app.connectionStatus,
    initialCommand: options.pendingCommandsByTerminalId[terminalId] ?? null,
    clearVersion: model.clearVersionsByTerminalId[terminalId] ?? 0,
    focusRequestVersion: index === 0 ? options.focusRequestVersion : 0,
  }
  const error = model.errorsByTerminalId[terminalId] ?? null
  return h.div([h.Class("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-4")], [
    h.div([h.Class("flex min-h-0 min-w-0 flex-1 overflow-hidden px-3 py-1")], [
      h.div([
        h.Class("kanna-terminal min-h-0 min-w-0 flex-1 overflow-hidden w-full"),
        mountInputs(inputs, h),
        h.OnMount(TerminalPane({ terminalId })),
      ], []),
    ]),
    error ? h.div([h.Class("px-3 py-1 text-xs text-destructive")], ["Terminal error: ", error]) : null,
  ])
}
