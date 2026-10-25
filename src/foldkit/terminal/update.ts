import { Command } from "foldkit"
import { AppAction } from "../app/action"
import { type AppModel, requestAction, type SliceObserve, type SliceReturn } from "../app/slice"
import * as Stores from "../app/stores"
import * as TerminalLayout from "../core/stores/terminalLayout"
import * as Tooltip from "../ui/tooltip"
import { CloseTerminal, DisposeCachedTerminal, makeTerminalId } from "./commands"
import { Message } from "./message"
import { type Model, splitTooltipId } from "./model"

type Return = SliceReturn<Model, Message>

/**
 * The /terminal page's layout key: a reserved non-project key, so the page's
 * splits and sizes persist like any project's panel, and its pane ids stay
 * put, so coming back reattaches the same shells with their scrollback.
 */
export const HOME_TERMINAL_LAYOUT_KEY = "devbox:home"

function layoutStore(message: TerminalLayout.Message): AppAction {
  return AppAction.Store({ message: Stores.Message.GotTerminalLayoutMessage({ message }) })
}

export function projectLayout(app: AppModel, layoutKey: string) {
  return app.stores.terminalLayout.projects[layoutKey] ?? null
}

function setEntry<Value>(record: Readonly<Record<string, Value>>, key: string, value: Value): Readonly<Record<string, Value>> {
  return record[key] === value && key in record ? record : { ...record, [key]: value }
}

function addTerminal(model: Model, app: AppModel, layoutKey: string, afterTerminalId: string | null): Return {
  const nextTerminalIndex = projectLayout(app, layoutKey)?.nextTerminalIndex ?? 0
  return { model, commands: [makeTerminalId({ layoutKey, afterTerminalId, nextTerminalIndex })] }
}

export function update(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    // TerminalWorkspacePane's handleClearTerminal: clear, and forget the path.
    ClickedClearTerminal: ({ terminalId }) => ({
      model: {
        ...model,
        clearVersionsByTerminalId: { ...model.clearVersionsByTerminalId, [terminalId]: (model.clearVersionsByTerminalId[terminalId] ?? 0) + 1 },
        pathsByTerminalId: setEntry<string | null>(model.pathsByTerminalId, terminalId, null),
      },
    }),
    ClickedAddTerminal: ({ layoutKey, afterTerminalId }) => addTerminal(model, app, layoutKey, afterTerminalId),
    MadeTerminalId: ({ layoutKey, terminalId, afterTerminalId }) => requestAction(
      model.seeding && layoutKey === HOME_TERMINAL_LAYOUT_KEY ? { ...model, seeding: false } : model,
      layoutStore(TerminalLayout.Message.AddedTerminal({ projectId: layoutKey, terminalId, afterTerminalId, chatKey: null })),
    ),
    ClickedRemoveTerminal: ({ layoutKey, terminalId, surface, chatKey }) => {
      if (surface === "chat") {
        const paneCount = projectLayout(app, layoutKey)?.terminals.length ?? 0
        if (paneCount <= 1) {
          // Closing the only pane hides the panel instead of killing the
          // shell: the pane stays mounted, so reopening returns to the same
          // session and scrollback with whatever was running still running.
          return requestAction(model, layoutStore(TerminalLayout.Message.HidTerminals({ projectId: layoutKey, chatKey })))
        }
      }
      // A split is unreachable once removed, so closing it kills its shell.
      return {
        ...requestAction(model, layoutStore(TerminalLayout.Message.RemovedTerminal({ projectId: layoutKey, terminalId }))),
        commands: surface === "chat"
          ? [CloseTerminal({ terminalId }), DisposeCachedTerminal({ terminalId })]
          : [CloseTerminal({ terminalId })],
      }
    },
    GotTooltipMessage: ({ terminalId, message: child }) => {
      const current = model.tooltips[terminalId] ?? Tooltip.init({ id: splitTooltipId(terminalId) })
      const next = Tooltip.update(current, child)
      return {
        model: { ...model, tooltips: { ...model.tooltips, [terminalId]: next.model } },
        commands: Command.mapMessages(next.commands, (message: Tooltip.Message) => Message.GotTooltipMessage({ terminalId, message })),
      }
    },
    // handleLayoutChanged: the panes' sizes in layout order, keeping a size
    // the group didn't report.
    GotGroupMessage: ({ layoutKey, message: { layout } }) => {
      const terminals = projectLayout(app, layoutKey)?.terminals ?? []
      return requestAction(model, layoutStore(TerminalLayout.Message.ChangedTerminalSizes({
        projectId: layoutKey,
        sizes: terminals.map((terminal) => layout[terminal.id] ?? terminal.size),
      })))
    },
    ChangedPanePath: ({ terminalId, path }) => {
      const pathsByTerminalId = setEntry(model.pathsByTerminalId, terminalId, path)
      return { model: pathsByTerminalId === model.pathsByTerminalId ? model : { ...model, pathsByTerminalId } }
    },
    ChangedPaneError: ({ terminalId, error }) => {
      const errorsByTerminalId = setEntry(model.errorsByTerminalId, terminalId, error)
      return { model: errorsByTerminalId === model.errorsByTerminalId ? model : { ...model, errorsByTerminalId } }
    },
    SentPaneCommand: () => ({ model }),
    SentInitialCommand: () => ({ model }),
    MeasuredWorkspace: ({ width }) => ({ model: width === model.viewportWidth ? model : { ...model, viewportWidth: width } }),
    CompletedSideEffect: () => ({ model }),
  })
}

/** Whether `app` is on /terminal with settings saying this is no dev box. */
function shouldLeavePage(app: AppModel) {
  const settings = app.stores.appSettings.settings
  return app.route._tag === "Terminal" && settings !== null && settings.devbox !== true
}

/**
 * TerminalPage's effect and its redirect, for the root's /terminal page:
 * - not a dev box (once settings are known): `<Navigate to="/" replace />`,
 *   once per arrival, as Navigate's effect ran once per mount;
 * - a dev box with no shell: seed one, on the first visit and whenever the
 *   persisted layout comes back empty.
 * The chat page's embedding doesn't lift this.
 */
export const observe: SliceObserve<Model, Message> = (model, _previousApp, app) => {
  if (app.route._tag !== "Terminal") {
    return { model: model.seeding || model.leaving ? { ...model, seeding: false, leaving: false } : model }
  }
  if (shouldLeavePage(app)) {
    if (model.leaving) return { model }
    return requestAction({ ...model, leaving: true }, AppAction.Navigate({ path: "/", replace: true }))
  }
  const isDevbox = app.stores.appSettings.settings?.devbox === true
  const hasTerminals = (projectLayout(app, HOME_TERMINAL_LAYOUT_KEY)?.terminals.length ?? 0) > 0
  if (isDevbox && !hasTerminals && !model.seeding) {
    return addTerminal({ ...model, seeding: true }, app, HOME_TERMINAL_LAYOUT_KEY, null)
  }
  return { model }
}
