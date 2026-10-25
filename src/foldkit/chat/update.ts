import { Effect, Option, Schema } from "effect"
import { Command, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { getNextMeasuredInputHeight } from "../../client/app/kannaStateHelpers"
import { paneDurationMs } from "../../client/app/paneAnimation"
import { EMPTY_STATE_TEXT } from "../../client/app/ChatPage/utils"
import { dockedViewerPaneWidthPx } from "../../client/lib/viewer-split"
import { AppAction } from "../app/action"
import { SliceOutMessage, type AppModel, type SliceReturn } from "../app/slice"
import * as Stores from "../app/stores"
import * as Composer from "../composer"
import * as Delegate from "../core/stores/delegate"
import * as OpenDestination from "../core/stores/openDestination"
import * as RightSidebar from "../core/stores/rightSidebar"
import * as TerminalLayout from "../core/stores/terminalLayout"
import * as ViewerStore from "../core/stores/viewer"
import * as Terminal from "../terminal"
import * as Transcript from "../transcript"
import * as Viewer from "../viewer"
import * as Widgets from "../widgets"
import * as ContextMenu from "../ui/context-menu"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import { chooseChatRowMenuItem } from "./chatRowMenu"
import {
  ElapseColumnSlide,
  FocusChatInput,
  MakeTerminalId,
  MeasureMenuButton,
  OpenCommandPalette,
  OpenWindow,
  RefreshDiffs,
  RenameChat,
} from "./effects"
import { Message, type MenuId, type ShortcutAction, type TerminalPurpose, type TooltipId, type WashId, type Watch } from "./message"
import type { Model } from "./model"
import { shownTitle, titleMenuContext } from "./navbar"
import { openAppValueOfMenuValue, openAppValueRequest, type OpenAppValue } from "./openExternal"
import { pageFacts, type PageFacts } from "./page"
import { CHAT_MIN_WORKSPACE_SIZE_PERCENT, getWidgetsColumnWidthPx, widthForHandleKey } from "./widgetsColumn"
import { DEFAULT_RIGHT_SIDEBAR_SIZE } from "../core/stores/rightSidebar"

type Return = SliceReturn<Model, Message>
type AppCommand = Command.Command<Message, never, never>

// ASKING THE ROOT

/**
 * A slice's update hands the root one request; the rest are queued as
 * Messages of its own, each handed up in turn (`ForwardedAppAction`).
 */
function withActions(result: { model: Model; commands?: ReadonlyArray<Command.Command<Message, never, unknown>> }, actions: ReadonlyArray<AppAction>): Return {
  const [first, ...rest] = actions
  const queued = rest.map((action) => DispatchAppAction({ action }))
  return {
    model: result.model,
    commands: [...(result.commands ?? []), ...queued] as Return["commands"],
    ...(first ? { outMessage: SliceOutMessage.RequestedAppAction({ action: first }) } : {}),
  }
}

/** One of several requests from one update, handed up on its own turn. */
const DispatchAppAction = Command.define("DispatchChatPageAppAction", {
  args: { action: AppAction },
  messages: [Message.ForwardedAppAction],
  execute: ({ action }) => Effect.succeed(Message.ForwardedAppAction({ action })),
})

const store = (message: Stores.Message) => AppAction.Store({ message })
const rightSidebar = (message: RightSidebar.Message) => store(Stores.Message.GotRightSidebarMessage({ message }))
const terminalLayout = (message: TerminalLayout.Message) => store(Stores.Message.GotTerminalLayoutMessage({ message }))
const viewerStore = (message: ViewerStore.Message) => store(Stores.Message.GotViewerMessage({ message }))
const delegate = (message: Delegate.Message) => store(Stores.Message.GotDelegateMessage({ message }))
const openDestination = (message: OpenDestination.Message) => store(Stores.Message.GotOpenDestinationMessage({ message }))

// SUB-SLICES (their requests to the root pass through unchanged)

const passOutMessage = (outMessage: SliceOutMessage) => outMessage

function child<ChildModel, ChildMessage, Key extends keyof Model>(
  key: Key,
  childUpdate: (model: ChildModel, message: ChildMessage, app: AppModel) => SliceReturn<ChildModel, ChildMessage>,
  wrap: (message: ChildMessage) => Message,
) {
  return Update.foldChild({
    update: (childModel: ChildModel, input: { message: ChildMessage; app: AppModel }) => childUpdate(childModel, input.message, input.app),
    read: (model: Model) => Option.some(model[key] as unknown as ChildModel),
    write: (model: Model, next: ChildModel) => modifyFields(model, { [key]: () => next } as never) as Model,
    toParentMessage: wrap,
    toParentOutMessage: passOutMessage,
  })
}

const foldTranscript = child("transcript", Transcript.update, (message) => Message.GotTranscriptMessage({ message }))
const foldComposer = child("composer", Composer.update, (message) => Message.GotComposerMessage({ message }))
const foldWidgets = child("widgets", Widgets.update, (message) => Message.GotWidgetsMessage({ message }))
const foldViewer = child("viewer", Viewer.update, (message) => Message.GotViewerMessage({ message }))
const foldTerminal = child("terminal", Terminal.update, (message) => Message.GotTerminalMessage({ message }))

// PRIMITIVES

function tooltipStep(model: Model, id: TooltipId, message: Tooltip.Message): Return {
  const result = Tooltip.update(model.tooltips[id], message)
  return {
    model: modifyFields(model, { tooltips: (tooltips) => ({ ...tooltips, [id]: result.model }) }),
    commands: Command.mapMessages(result.commands, (inner: Tooltip.Message) => Message.GotTooltipMessage({ id, message: inner })) as Return["commands"],
  }
}

function menuStep(model: Model, id: MenuId, message: ContextMenu.Message): { result: Return; selected: string | null } {
  const result = ContextMenu.update(model.menus[id], message)
  const selected = result.outMessage && result.outMessage._tag === "Selected" ? result.outMessage.value : null
  return {
    result: {
      model: modifyFields(model, { menus: (menus) => ({ ...menus, [id]: result.model }) }),
      commands: Command.mapMessages(result.commands, (inner: ContextMenu.Message) => Message.GotMenuMessage({ id, message: inner })) as Return["commands"],
    },
    selected,
  }
}

function then(first: Return, next: (model: Model) => Return): Return {
  const second = next(first.model)
  return {
    model: second.model,
    commands: [...(first.commands ?? []), ...(second.commands ?? [])],
    ...(second.outMessage ? { outMessage: second.outMessage } : first.outMessage ? { outMessage: first.outMessage } : {}),
  }
}

// PANES

/** handleToggleEmbeddedTerminal: shows or hides the pane, or opens the first terminal. */
function toggleTerminal(model: Model, facts: PageFacts): Return {
  if (!facts.projectId) return { model }
  if (facts.hasTerminals) {
    return withActions({ model }, [terminalLayout(TerminalLayout.Message.ToggledVisibility({ projectId: facts.projectId, chatKey: facts.terminalChatKey }))])
  }
  return addTerminal(model, facts, { _tag: "Toggle" })
}

function addTerminal(model: Model, facts: PageFacts, purpose: TerminalPurpose): Return {
  if (!facts.projectId) return { model }
  return {
    model,
    commands: [MakeTerminalId({ purpose, projectId: facts.projectId, chatKey: facts.terminalChatKey, nextTerminalIndex: facts.terminalLayout.nextTerminalIndex })],
  }
}

/** Opening or closing the column in place slides it; going elsewhere snaps (WidgetsColumn's useColumnSlide). */
function followColumn(model: Model, open: boolean, switchKey: string | null): Return {
  const current = model.widgetsColumn
  if (current.open === open && current.switchKey === switchKey) return { model }
  const sliding = current.switchKey === switchKey
  const token = current.slideToken + 1
  return {
    model: modifyFields(model, { widgetsColumn: (column) => ({ ...column, open, switchKey, sliding, slideToken: token }) }),
    commands: sliding ? [ElapseColumnSlide({ token, ms: paneDurationMs(open) + 50 })] : [],
  }
}

function toggleWidgets(model: Model, facts: PageFacts): Return {
  if (!facts.projectId) return { model }
  const followed = followColumn(model, !facts.showRightSidebar, facts.widgetsChatKey ?? facts.projectId)
  return withActions(followed, [rightSidebar(RightSidebar.Message.ToggledWidgets({ projectId: facts.projectId, chatKey: facts.widgetsChatKey }))])
}

function hideWidgets(model: Model, facts: PageFacts): Return {
  if (!facts.projectId) return { model }
  const followed = followColumn(model, false, facts.widgetsChatKey ?? facts.projectId)
  return withActions(followed, [rightSidebar(RightSidebar.Message.HidWidgets({ projectId: facts.projectId, chatKey: facts.widgetsChatKey }))])
}

/** The split a docked pane takes for what's open (`dockedViewerPaneWidthPx`). */
function viewerSplitFor(model: Model, app: AppModel, facts: PageFacts): [number, number] {
  if (!facts.viewerPaneAvailable || !facts.viewerOpen || facts.viewerExpanded) {
    // Expanded over the chat, the split is left alone.
    return facts.viewerOpen && facts.viewerExpanded ? model.viewerSplit as [number, number] : [100, 0]
  }
  const columnWidth = facts.showRightSidebar ? getWidgetsColumnWidthPx(app.stores.rightSidebar.size, model.layoutWidth) : 0
  const splitWidth = model.layoutWidth - columnWidth
  if (splitWidth <= 0) return [100, 0]
  const chatMinPx = model.layoutWidth * (CHAT_MIN_WORKSPACE_SIZE_PERCENT / 100)
  const viewer = ViewerStore.chatViewer({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar })
  const panePercent = (dockedViewerPaneWidthPx({
    splitWidthPx: splitWidth,
    chatMinPx,
    draggedWidthPx: app.stores.rightSidebar.viewerWidthPx,
    widthClass: viewer ? ViewerStore.viewerWidthClass(viewer.item) : null,
  }) / splitWidth) * 100
  return [100 - panePercent, panePercent]
}

// OPEN IN…

function openValue(model: Model, facts: PageFacts, value: OpenAppValue, remember: boolean): Return {
  const actions: AppAction[] = []
  // The forge isn't remembered as the split button's default: switching
  // projects would leave the button pointing at a repo the project lacks.
  if (remember && value !== "repo") actions.push(openDestination(OpenDestination.Message.ChoseDestination({ value })))
  const request = openAppValueRequest({ value, editorCommandTemplate: facts.editorCommandTemplate, repoUrl: facts.repoUrl })
  if (request._tag === "Action") actions.push(request.action)
  const commands = request._tag === "Repo" ? [OpenWindow({ url: request.url })] : []
  return withActions({ model, commands }, actions)
}

// TITLE

function commitTitle(model: Model, facts: PageFacts): Return {
  const draft = model.title.draft
  if (draft === null) return { model }
  const serverTitle = facts.runtime?.title ?? ""
  const shown = shownTitle(model, serverTitle)
  const next = draft.trim()
  const cleared = modifyFields(model, { title: (title) => ({ ...title, draft: null }) })
  if (!next || next === shown || !facts.chatId) return { model: cleared }
  return {
    model: modifyFields(cleared, { title: () => ({ draft: null, submitted: next, submittedOver: serverTitle }) }),
    commands: [RenameChat({ chatId: facts.chatId, title: next })],
  }
}

// THE PAGE'S EFFECTS

/**
 * What ChatPage's effects did when a fact they ran on changed. `fresh` is a
 * page mounted anew: what React held in refs starts over.
 */
function observePage(model: Model, app: AppModel, watch: Watch, fresh: boolean): Return {
  const previous = fresh ? null : model.watch
  const facts = pageFacts(app, model.viewportWidth, model.settledShowEmptyState)
  const commands: AppCommand[] = []
  const actions: AppAction[] = []
  let next: Model = modifyFields(model, {
    watch: () => watch,
    settledShowEmptyState: () => watch.showEmptyState,
    lastGitRefreshProjectId: (last) => (fresh ? null : last),
  })

  // The viewer is the chat's: this chat's opens here, and another chat's
  // waits in the store for you to go back to it.
  if (!previous || previous.chatId !== watch.chatId) {
    actions.push(viewerStore(ViewerStore.Message.ChangedChat({ chatId: watch.chatId })))
  }
  // On a delegator the list of the chats under it is the floor of the pane,
  // the first time its page is opened in this browser; not before the
  // sidebar has said what the chat is.
  if (watch.sidebarReady && (!previous || previous.chatId !== watch.chatId || previous.isDelegator !== watch.isDelegator
    || previous.isMobile !== watch.isMobile || !previous.sidebarReady)) {
    const floorChatId = watch.isDelegator && !watch.isMobile ? watch.chatId : null
    if (!floorChatId) {
      actions.push(viewerStore(ViewerStore.Message.ChangedFloor({ floor: null, openByDefault: false })))
    } else {
      const firstTime = !app.stores.delegate.paneShown[floorChatId]
      actions.push(viewerStore(ViewerStore.Message.ChangedFloor({ floor: { kind: "delegated", chatId: floorChatId }, openByDefault: firstTime })))
      if (firstTime) actions.push(delegate(Delegate.Message.ShowedPane({ chatId: floorChatId })))
    }
  }
  // Which of a project's delegators a click on the project opens.
  if (watch.isDelegator && watch.chatId && (!previous || previous.chatId !== watch.chatId || !previous.isDelegator)) {
    commands.push(ViewDelegatorNow({ chatId: watch.chatId }))
  }

  // useChatPageSidebarActions: diffs refresh when the column opens, and the
  // project's git snapshot once per project.
  if (watch.projectId && watch.showRightSidebar && watch.chatId
    && (!previous || !previous.showRightSidebar || previous.projectId !== watch.projectId)) {
    commands.push(RefreshDiffs({ chatId: watch.chatId }))
  }
  if (watch.projectId && watch.chatId && next.lastGitRefreshProjectId !== watch.projectId) {
    next = modifyFields(next, { lastGitRefreshProjectId: () => watch.projectId })
    commands.push(RefreshDiffs({ chatId: watch.chatId }))
  }
  if (watch.showRightSidebar && watch.chatId && previous?.isProcessing && !watch.isProcessing) {
    commands.push(RefreshDiffs({ chatId: watch.chatId }))
  }

  // The empty state types its line each time it appears.
  if (watch.showEmptyState && !previous?.showEmptyState) {
    next = modifyFields(next, { emptyStateTyping: () => ({ started: true, count: 0, complete: false }) })
  } else if (!watch.showEmptyState && next.emptyStateTyping.started) {
    next = modifyFields(next, { emptyStateTyping: () => ({ started: false, count: 0, complete: false }) })
  }

  // Focus goes back to the composer when the viewer closes, and when the
  // terminal hides in the same project.
  if (previous?.viewerOpen && !watch.viewerOpen) commands.push(FocusChatInput())
  if (previous && previous.projectId !== null && previous.projectId === watch.projectId && previous.showTerminalPane && !watch.showTerminalPane) {
    commands.push(FocusChatInput())
  }

  // The widget column follows the store: a switch snaps it.
  const followed = followColumn(next, facts.showRightSidebar, facts.widgetsChatKey ?? facts.projectId)
  next = followed.model
  commands.push(...((followed.commands ?? []) as AppCommand[]))

  // On a phone the widget column is a sheet over the chat, and the viewer
  // opens over the chat: close the sheet so what you opened is what you see.
  if (watch.viewerOpen && watch.isMobile && watch.projectId && watch.showRightSidebar) {
    actions.push(rightSidebar(RightSidebar.Message.HidWidgets({ projectId: watch.projectId, chatKey: facts.widgetsChatKey })))
  }

  next = modifyFields(next, { viewerSplit: () => viewerSplitFor(next, app, facts) })
  return withActions({ model: next, commands }, actions)
}

/** `useDelegateStore.markViewed`: stamped with now, which update can't read. */
const ViewDelegatorNow = Command.define("ViewDelegatorNow", {
  args: { chatId: Schema.String },
  messages: [Message.ForwardedAppAction],
  execute: ({ chatId }) => Effect.sync(() =>
    Message.ForwardedAppAction({ action: delegate(Delegate.Message.ViewedDelegator({ chatId, at: Date.now() })) })),
})

function washStep(model: Model, wash: WashId, change: (state: Model["washes"][WashId]) => Model["washes"][WashId]): Return {
  return { model: modifyFields(model, { washes: (washes) => ({ ...washes, [wash]: change(washes[wash]) }) }) }
}

function shortcut(model: Model, facts: PageFacts, action: ShortcutAction): Return {
  if (!facts.projectId) return { model }
  switch (action) {
    case "toggleEmbeddedTerminal": return toggleTerminal(model, facts)
    case "toggleRightSidebar": return toggleWidgets(model, facts)
    case "openInFinder": return withActions({ model }, [AppAction.OpenExternal({ action: "open_finder", editor: null, terminal: null })])
    case "openInEditor": return withActions({ model }, [AppAction.OpenExternal({ action: "open_editor", editor: null, terminal: null })])
    case "addSplitTerminal": return addTerminal(model, facts, { _tag: "Split" })
  }
}

function commitColumnWidth(model: Model, app: AppModel, widthPx: number): Return {
  return withActions({ model }, [rightSidebar(RightSidebar.Message.ChangedSize({ size: Math.round(getWidgetsColumnWidthPx(widthPx, model.layoutWidth)) }))])
}

// UPDATE

export function update(model: Model, message: Message, app: AppModel): Return {
  const facts = () => pageFacts(app, model.viewportWidth, model.settledShowEmptyState)
  return Message.match<Return>(message, {
    GotTranscriptMessage: ({ message: inner }) => foldTranscript(model, { message: inner, app }) as Return,
    GotComposerMessage: ({ message: inner }) => foldComposer(model, { message: inner, app }) as Return,
    GotWidgetsMessage: ({ message: inner }) => foldWidgets(model, { message: inner, app }) as Return,
    GotViewerMessage: ({ message: inner }) => foldViewer(model, { message: inner, app }) as Return,
    GotTerminalMessage: ({ message: inner }) => foldTerminal(model, { message: inner, app }) as Return,

    GotTooltipMessage: ({ id, message: inner }) => tooltipStep(model, id, inner),
    GotMenuMessage: ({ id, message: inner }) => {
      const { result, selected } = menuStep(model, id, inner)
      if (selected === null) return result
      return then(result, (next) => chooseMenuItem(next, app, facts(), id, selected))
    },
    GotOpenSelectMessage: ({ message: inner }) => {
      const result = Select.update(model.openSelect, inner)
      const stepped: Return = {
        model: modifyFields(model, { openSelect: () => result.model }),
        commands: Command.mapMessages(result.commands, (m: Select.Message) => Message.GotOpenSelectMessage({ message: m })) as Return["commands"],
      }
      if (!result.outMessage) return stepped
      return then(stepped, (next) => openValue(next, facts(), result.outMessage!.value as OpenAppValue, true))
    },

    ObservedPage: ({ watch, fresh }) => observePage(model, app, watch, fresh),
    ResizedWindow: ({ width }) => (width === model.viewportWidth ? { model } : { model: modifyFields(model, { viewportWidth: () => width }) }),
    MeasuredLayout: ({ width, height }) => {
      const nextWidth = Math.abs(model.layoutWidth - width) < 1 ? model.layoutWidth : width
      const nextHeight = Math.abs(model.layoutHeight - height) < 1 ? model.layoutHeight : height
      if (nextWidth === model.layoutWidth && nextHeight === model.layoutHeight) return { model }
      const next = modifyFields(model, { layoutWidth: () => nextWidth, layoutHeight: () => nextHeight })
      return { model: modifyFields(next, { viewerSplit: () => viewerSplitFor(next, app, facts()) }) }
    },
    MeasuredNavbar: ({ height }) => (height === model.navbarHeight ? { model } : { model: modifyFields(model, { navbarHeight: () => height }) }),
    MeasuredDock: ({ height }) => {
      const next = getNextMeasuredInputHeight(model.dockHeight, height)
      return next === model.dockHeight ? { model } : { model: modifyFields(model, { dockHeight: () => next }) }
    },
    ChangedWashScroll: ({ wash, scrolled }) => washStep(model, wash, (state) => (state.scrolled === scrolled ? state : { ...state, scrolled })),
    StartedWash: ({ wash, token }) => washStep(model, wash, (state) => ({ ...state, settling: true, token })),
    SettledWash: ({ wash, token }) => washStep(model, wash, (state) => (state.token === token ? { ...state, settling: false } : state)),
    TypedEmptyStateCharacter: ({ count }) => model.emptyStateTyping.started
      ? { model: modifyFields(model, { emptyStateTyping: (typing) => ({ ...typing, count, complete: count >= EMPTY_STATE_TEXT.length }) }) }
      : { model },

    ClickedBack: () => withActions({ model }, [AppAction.OpenSidebar()]),
    ClickedExpandSidebar: () => withActions({ model }, [AppAction.ExpandSidebar()]),
    ClickedSearch: () => ({ model, commands: [OpenCommandPalette({ page: null })] }),
    ClickedToggleTerminal: () => toggleTerminal(model, facts()),
    ClickedToggleWidgets: () => toggleWidgets(model, facts()),
    ClickedShareChat: () => {
      const current = facts()
      if (!current.chatId || current.isExportingStandalone) return { model }
      return withActions({ model }, [AppAction.ShareChat({ chatId: current.chatId })])
    },
    ClickedOpenPrimary: ({ value }) => openValue(model, facts(), value as OpenAppValue, true),
    ClickedMenuButton: ({ id, selector }) => ({ model, commands: [MeasureMenuButton({ id, selector })] }),
    MeasuredMenuButton: ({ id, x, y }) => {
      const pressed = menuStep(model, id, ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x, y })).result
      return then(pressed, (next) => menuStep(next, id, ContextMenu.Message.RequestedContextMenu()).result)
    },

    ClickedTitle: () => beginTitleEdit(model, facts()),
    PressedTitleKey: () => beginTitleEdit(model, facts()),
    ChangedTitleDraft: ({ value }) => (model.title.draft === null ? { model } : { model: modifyFields(model, { title: (title) => ({ ...title, draft: value }) }) }),
    BlurredTitle: () => commitTitle(model, facts()),
    PressedTitleInputKey: ({ key }) => key === "Enter"
      ? commitTitle(model, facts())
      : { model: modifyFields(model, { title: (title) => ({ ...title, draft: null }) }) },
    ClickedProjectName: () => withActions({ model }, [AppAction.OpenExternal({ action: "open_finder", editor: null, terminal: null })]),
    ClickedBranch: ({ url }) => ({ model, commands: [OpenWindow({ url })] }),

    ClickedProjectPicker: () => ({ model, commands: [OpenCommandPalette({ page: "new-thread" })] }),

    PressedShortcut: ({ action }) => shortcut(model, facts(), action),
    PressedEscapeOnSheet: () => hideWidgets(model, facts()),
    ClickedCloseWidgets: () => hideWidgets(model, facts()),

    PressedColumnHandle: ({ x }) => {
      const current = facts()
      if (!current.showRightSidebar) return { model }
      const widthPx = getWidgetsColumnWidthPx(app.stores.rightSidebar.size, model.layoutWidth)
      return { model: modifyFields(model, { widgetsColumn: (column) => ({ ...column, dragStart: { pointerX: x, widthPx }, dragWidthPx: widthPx }) }) }
    },
    MovedColumnHandle: ({ x }) => {
      const start = model.widgetsColumn.dragStart
      if (!start) return { model }
      // The column is on the right, so dragging left widens it.
      return { model: modifyFields(model, { widgetsColumn: (column) => ({ ...column, dragWidthPx: start.widthPx - (x - start.pointerX) }) }) }
    },
    ReleasedColumnHandle: () => {
      const dragged = model.widgetsColumn.dragWidthPx
      const cleared = modifyFields(model, { widgetsColumn: (column) => ({ ...column, dragStart: null, dragWidthPx: null }) })
      return dragged === null ? { model: cleared } : commitColumnWidth(cleared, app, dragged)
    },
    DoubleClickedColumnHandle: () => commitColumnWidth(model, app, DEFAULT_RIGHT_SIDEBAR_SIZE),
    PressedColumnHandleKey: ({ key }) => {
      const widthPx = getWidgetsColumnWidthPx(app.stores.rightSidebar.size, model.layoutWidth)
      return Option.match(widthForHandleKey(key, widthPx), {
        onNone: () => ({ model }),
        onSome: (next) => commitColumnWidth(model, app, next),
      })
    },
    ElapsedColumnSlide: ({ token }) => model.widgetsColumn.slideToken === token && model.widgetsColumn.sliding
      ? { model: modifyFields(model, { widgetsColumn: (column) => ({ ...column, sliding: false }) }) }
      : { model },

    MadeTerminalId: ({ purpose, projectId, chatKey, terminalId }) => {
      const next = purpose._tag === "QuickAction"
        ? modifyFields(model, { pendingTerminalCommands: (pending) => ({ ...pending, [terminalId]: purpose.command }) })
        : model
      return withActions({ model: next }, [terminalLayout(TerminalLayout.Message.AddedTerminal({ projectId, terminalId, afterTerminalId: null, chatKey }))])
    },
    TickedDiffRefresh: () => {
      const current = facts()
      return current.chatId && current.showRightSidebar ? { model, commands: [RefreshDiffs({ chatId: current.chatId })] } : { model }
    },

    ForwardedAppAction: ({ action }) => withActions({ model }, [action]),
    CompletedSideEffect: () => ({ model }),
  })
}

function beginTitleEdit(model: Model, facts: PageFacts): Return {
  const title = facts.runtime?.title
  if (title === undefined || model.title.draft !== null) return { model }
  return { model: modifyFields(model, { title: (state) => ({ ...state, draft: shownTitle(model, title) }) }) }
}

function chooseMenuItem(model: Model, app: AppModel, facts: PageFacts, id: MenuId, value: string): Return {
  if (id === "overflow") {
    const openApp = openAppValueOfMenuValue(value)
    if (openApp) return openValue(model, facts, openApp, false)
    if (value === "toggle-terminal") return toggleTerminal(model, facts)
    if (value === "share") {
      if (!facts.chatId || facts.isExportingStandalone) return { model }
      return withActions({ model }, [AppAction.ShareChat({ chatId: facts.chatId })])
    }
    return { model }
  }
  const context = titleMenuContext(app, facts)
  if (!context) return { model }
  const choice = chooseChatRowMenuItem(value, context)
  if (!choice || choice._tag === "None") return { model }
  if (choice._tag === "OpenUrl") return { model, commands: [OpenWindow({ url: choice.url })] }
  return withActions({ model }, [choice.action])
}

