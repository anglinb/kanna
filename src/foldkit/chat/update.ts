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
import * as ChatInput from "../core/stores/chatInput"
import * as ChatTabs from "../core/stores/chatTabs"
import * as Delegate from "../core/stores/delegate"
import { adjacentTab, chatAfterClose, movedTabIds, ScrollTabIntoView, tabMenu, threadsByChatId } from "./chatTabs"
import * as OpenDestination from "../core/stores/openDestination"
import * as PendingSend from "../core/stores/pendingSend"
import * as ProviderAuth from "../core/stores/providerAuth"
import { delegatorIsBusy, newChatDelegate, SendToDelegator, StampDelegatedSend } from "./newChatDelegate"
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
  MeasureTabMenuButton,
  OpenCommandPalette,
  OpenWindow,
  ReadQuickActions,
  RefreshDiffs,
  RefreshUsage,
  RenameChat,
} from "./effects"
import { Message, type MenuId, type ShortcutAction, type TerminalPurpose, type TooltipId, type WashId, type Watch } from "./message"
import { initialTerminalPane, type Model } from "./model"
import { resolveTerminalAnimationState, shouldRequestTerminalFocus } from "./terminalPane"
import { shownTitle, titleMenuContext } from "./navbar"
import { openAppValueOfMenuValue, openAppValueRequest, type OpenAppValue } from "./openExternal"
import { getTerminalPanelDefaultSizes, pageFacts, type PageFacts } from "./page"
import { CHAT_MIN_WORKSPACE_SIZE_PERCENT, getWidgetsColumnWidthPx, widthForHandleKey } from "./widgetsColumn"
import { DEFAULT_RIGHT_SIDEBAR_SIZE } from "../core/stores/rightSidebar"

type Return = SliceReturn<Model, Message>
type AppCommand = NonNullable<Return["commands"]>[number]

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
const chatTabs = (message: ChatTabs.Message) => store(Stores.Message.GotChatTabsMessage({ message }))
const delegate = (message: Delegate.Message) => store(Stores.Message.GotDelegateMessage({ message }))
const openDestination = (message: OpenDestination.Message) => store(Stores.Message.GotOpenDestinationMessage({ message }))
const pendingSend = (message: PendingSend.Message) => store(Stores.Message.GotPendingSendMessage({ message }))

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
  const serverTitle = facts.activeTitle ?? ""
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

  // QuickActionsWidget reads the project's quick actions as it mounts, and
  // again for each project (its effect ran before the page's own, below).
  if (watch.projectId && (!previous || previous.projectId !== watch.projectId)) {
    commands.push(ReadQuickActions({ projectId: watch.projectId }))
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

  // ChatTabs' effects, while the bar is up: the open chat has a tab (opened
  // right of the chat you came from, read before this visit joins the
  // history), a tab outlives neither its chat nor its archiving, and the open
  // tab is scrolled into view.
  if (watch.chatTabsEnabled) {
    if (next.tabsInitial === null) next = modifyFields(next, { tabsInitial: () => app.stores.chatTabs.tabs.map((tab) => tab.chatId) })
    if (watch.chatId && (!previous || !previous.chatTabsEnabled || previous.chatId !== watch.chatId)) {
      actions.push(chatTabs(ChatTabs.Message.OpenedTab({ chatId: watch.chatId, afterChatId: app.stores.chatTabs.recentChatIds[0] ?? null })))
    }
    if (watch.pruneTabs && watch.pruneTabs !== previous?.pruneTabs) {
      actions.push(chatTabs(ChatTabs.Message.PrunedTabs({ keepChatIds: JSON.parse(watch.pruneTabs) as string[] })))
    }
    if (watch.chatId && (!previous || !previous.chatTabsEnabled || previous.chatId !== watch.chatId || previous.tabsCount !== watch.tabsCount)) {
      commands.push(ScrollTabIntoView({ chatId: watch.chatId }))
    }
    if (watch.chatId && (!previous || !previous.chatTabsEnabled || previous.chatId !== watch.chatId)) {
      actions.push(chatTabs(ChatTabs.Message.VisitedChat({ chatId: watch.chatId })))
    }
  } else if (next.tabsInitial !== null) {
    next = modifyFields(next, { tabsInitial: () => null, tabDrag: () => null })
  }

  // The empty state types its line each time it appears, and animates in
  // when it does: on a new chat's viewport while it is up, as it then is.
  if (watch.showEmptyState && !previous?.showEmptyState) {
    next = modifyFields(next, {
      emptyStateTyping: () => ({ started: true, count: 0, complete: false }),
      emptyStateEntrance: () => ({ chatId: watch.chatId, animatesIn: true }),
    })
  } else if (!watch.showEmptyState && next.emptyStateTyping.started) {
    next = modifyFields(next, { emptyStateTyping: () => ({ started: false, count: 0, complete: false }) })
  }
  if (!watch.showEmptyState) {
    next = modifyFields(next, { emptyStateEntrance: () => null })
  } else if (next.emptyStateEntrance?.chatId !== watch.chatId) {
    next = modifyFields(next, { emptyStateEntrance: () => ({ chatId: watch.chatId, animatesIn: !next.emptyStateTyping.complete }) })
  }

  // Focus goes back to the composer when the viewer closes, and when the
  // terminal hides in the same project.
  if (previous?.viewerOpen && !watch.viewerOpen) commands.push(FocusChatInput())
  next = followTerminalPane(next, previous, watch, fresh)
  if (previous && previous.terminalSwitchKey !== null && previous.terminalSwitchKey === watch.terminalSwitchKey && previous.showTerminalPane && !watch.showTerminalPane) {
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

/**
 * useTerminalToggleAnimation: the terminal's split slides to its new layout
 * when the pane is toggled in place, and snaps on a switch (another chat or
 * project), on the first render, or when there is nothing to move. A pane
 * opened by a toggle asks the terminal for focus.
 */
function followTerminalPane(model: Model, previous: Watch | null, watch: Watch, fresh: boolean): Model {
  let pane = fresh ? initialTerminalPane : model.terminalPane
  // A new project is a new split (React keyed the group by project): what
  // the hook wrote on the old one's elements is gone with them.
  if (previous && previous.projectId !== watch.projectId) {
    pane = { ...pane, split: null, panelOpen: null, animated: false, animation: null }
  }
  const previousKey = previous?.terminalSwitchKey ?? null

  if (shouldRequestTerminalFocus({
    previousProjectId: previousKey,
    projectId: watch.terminalSwitchKey,
    showTerminalPane: watch.showTerminalPane,
    wasTerminalVisible: previous?.showTerminalPane ?? false,
  })) {
    const current = pane.focusRequest
    pane = { ...pane, focusRequest: { key: watch.terminalSwitchKey, version: (current.key === watch.terminalSwitchKey ? current.version : 0) + 1 } }
  }

  const changed = !previous
    || previous.terminalSwitchKey !== watch.terminalSwitchKey
    || previous.shouldRenderTerminalLayout !== watch.shouldRenderTerminalLayout
    || previous.showTerminalPane !== watch.showTerminalPane
    || previous.terminalMainSizes !== watch.terminalMainSizes
  if (!changed) return modifyFields(model, { terminalPane: () => pane })

  if (!watch.shouldRenderTerminalLayout) {
    // The split stays mounted without terminals; the terminal's share goes
    // back to what's above it.
    return modifyFields(model, { terminalPane: () => ({ ...pane, split: [100, 0] as const, animation: null, previousShouldRender: false, previousShow: false }) })
  }

  const mainSizes = JSON.parse(watch.terminalMainSizes) as [number, number]
  const live = (pane.split ?? getTerminalPanelDefaultSizes(watch.showTerminalPane, mainSizes)) as [number, number]
  const { currentLayout, shouldSkipAnimation, targetLayout } = resolveTerminalAnimationState({
    previousProjectId: previousKey,
    projectId: watch.terminalSwitchKey,
    previousShouldRenderTerminalLayout: pane.previousShouldRender,
    previousShowTerminalPane: pane.previousShow,
    showTerminalPane: watch.showTerminalPane,
    mainSizes,
    liveLayout: live,
  })
  const panelOpen = watch.showTerminalPane ? "true" as const : "false" as const
  const settled = { ...pane, panelOpen, previousShouldRender: true, previousShow: watch.showTerminalPane }
  const still = Math.abs(currentLayout[0] - targetLayout[0]) < 0.1 && Math.abs(currentLayout[1] - targetLayout[1]) < 0.1
  if (shouldSkipAnimation || still) {
    return modifyFields(model, { terminalPane: () => ({ ...settled, split: targetLayout, animated: false, animation: null }) })
  }
  const token = pane.tokens + 1
  return modifyFields(model, {
    terminalPane: () => ({
      ...settled,
      split: currentLayout,
      animated: true,
      tokens: token,
      animation: { token, from: currentLayout, to: targetLayout, durationMs: paneDurationMs(watch.showTerminalPane) },
    }),
  })
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
    GotComposerMessage: ({ message: inner }) => routeDelegatedSend(foldComposer(model, { message: inner, app }) as Return, app, facts()),
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

    EnteredPage: ({ token }) => ({ model: modifyFields(model, { presence: () => token }) }),
    LeftPage: ({ token }) => (model.presence === token ? { model: modifyFields(model, { presence: () => null }) } : { model }),
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
    ChangedPageFileDrag: ({ active }) => (model.pageFileDragActive === active ? { model } : { model: modifyFields(model, { pageFileDragActive: () => active }) }),
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
    // toggleDelegatedPane / openViewer.
    ClickedDelegatedList: ({ chatId, overlay }) => withActions({ model }, [
      !overlay && Boolean(app.stores.rightSidebar.chatViewers[chatId])
        ? viewerStore(ViewerStore.Message.ShutViewer({ byKey: false }))
        : viewerStore(ViewerStore.Message.OpenedItem({ item: { kind: "delegated", chatId }, expanded: false, byKey: false })),
    ]),
    ClickedOpenPrimary: ({ value }) => openValue(model, facts(), value as OpenAppValue, true),
    ClickedMenuButton: ({ id, selector }) => ({ model, commands: [MeasureMenuButton({ id, selector })] }),
    MeasuredMenuButton: ({ id, x, y }) => {
      const pressed = menuStep(model, id, ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x, y })).result
      return then(pressed, (next) => menuStep(next, id, ContextMenu.Message.RequestedContextMenu()).result)
    },

    // Selected on the press, not the release: the tab answers the moment it
    // is touched, as a browser's does.
    PressedTab: ({ chatId }) => withActions({ model }, [navigateTo(chatId)]),
    ClickedCloseTab: ({ chatId }) => closeTab(model, app, facts(), chatId),
    MiddleClickedTab: ({ chatId }) => closeTab(model, app, facts(), chatId),
    ClickedTabMenuButton: ({ chatId }) => ({ model, commands: [MeasureTabMenuButton({ chatId })] }),
    MeasuredTabMenuButton: ({ chatId, x, y }) => {
      const pressed = tabMenuStep(model, chatId, ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x, y })).result
      return then(pressed, (next) => tabMenuStep(next, chatId, ContextMenu.Message.RequestedContextMenu()).result)
    },
    GotTabMenuMessage: ({ chatId, message: inner }) => {
      const { result, selected } = tabMenuStep(model, chatId, inner)
      if (selected === null) return result
      return then(result, (next) => chooseTabMenuItem(next, app, facts(), chatId, selected))
    },
    PressedTabShortcut: ({ shortcut }) => {
      const current = facts()
      if (shortcut === "new") return withActions({ model }, [AppAction.Compose()])
      if (shortcut === "close") return current.chatId ? closeTab(model, app, current, current.chatId) : { model }
      const next = adjacentTab(app, current.chatId, shortcut === "next" ? 1 : -1)
      return next ? withActions({ model }, [navigateTo(next)]) : { model }
    },
    StartedTabDrag: ({ chatId, fromIndex, width }) => ({ model: modifyFields(model, { tabDrag: () => ({ chatId, dx: 0, fromIndex, overIndex: fromIndex, width }) }) }),
    MovedTabDrag: ({ dx, overIndex }) => (model.tabDrag ? { model: modifyFields(model, { tabDrag: (drag) => (drag ? { ...drag, dx, overIndex } : drag) }) } : { model }),
    DroppedTab: () => {
      const drag = model.tabDrag
      const cleared = modifyFields(model, { tabDrag: () => null })
      if (!drag || drag.overIndex === drag.fromIndex) return { model: cleared }
      return withActions({ model: cleared }, [chatTabs(ChatTabs.Message.ReorderedTabs({ orderedChatIds: movedTabIds(app.stores.chatTabs.tabs, drag.fromIndex, drag.overIndex) }))])
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
    ClickedSetup: () => withActions({ model }, [store(Stores.Message.GotProviderAuthMessage({ message: ProviderAuth.Message.OpenedSetupWizard() }))]),
    StartedProjectChats: ({ nowMs }) => ({ model: modifyFields(model, { projectChats: () => ({ query: "", cascadeDone: false, nowMs, stuck: false }) }) }),
    ElapsedProjectChatsCascade: () => ({ model: modifyFields(model, { projectChats: (state) => ({ ...state, cascadeDone: true }) }) }),
    ChangedProjectChatsStuck: ({ stuck }) => (model.projectChats.stuck === stuck ? { model } : { model: modifyFields(model, { projectChats: (state) => ({ ...state, stuck }) }) }),
    // Typing a search ends the cascade early: results should land at once.
    ChangedProjectChatsQuery: ({ value }) => ({ model: modifyFields(model, { projectChats: (state) => ({ ...state, query: value, cascadeDone: true }) }) }),
    ClickedProjectChat: ({ chatId }) => withActions({ model }, [AppAction.Navigate({ path: `/chat/${chatId}`, replace: false })]),

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
    ChangedWidgetsPeek: ({ peeking }) => (model.widgetsColumn.peekRequested === peeking
      ? { model }
      : { model: modifyFields(model, { widgetsColumn: (column) => ({ ...column, peekRequested: peeking }) }) }),
    ElapsedColumnSlide: ({ token }) => model.widgetsColumn.slideToken === token && model.widgetsColumn.sliding
      ? { model: modifyFields(model, { widgetsColumn: (column) => ({ ...column, sliding: false }) }) }
      : { model },

    MadeTerminalId: ({ purpose, projectId, chatKey, terminalId }) => {
      const next = purpose._tag === "QuickAction"
        ? modifyFields(model, { pendingTerminalCommands: (pending) => ({ ...pending, [terminalId]: purpose.command }) })
        : model
      return withActions({ model: next }, [terminalLayout(TerminalLayout.Message.AddedTerminal({ projectId, terminalId, afterTerminalId: null, chatKey }))])
    },
    SteppedTerminalSplit: ({ token, chat, terminal, done }) => model.terminalPane.animation?.token === token
      ? { model: modifyFields(model, { terminalPane: (pane) => ({ ...pane, split: [chat, terminal] as const, animation: done ? null : pane.animation }) }) }
      : { model },
    TickedDiffRefresh: () => {
      const current = facts()
      return current.chatId && current.showRightSidebar ? { model, commands: [RefreshDiffs({ chatId: current.chatId })] } : { model }
    },

    // Holds the delegator's place in the sidebar until the server says it is
    // running (`usePendingSendStore`).
    StampedDelegatedSend: ({ chatId, content, options, sentAt }) => withActions(
      { model, commands: [SendToDelegator({ chatId, content, options, queued: false })] },
      [pendingSend(PendingSend.Message.StartedSending({ chatId, sentAt }))],
    ),
    SucceededDelegatedSend: ({ chatId }) => {
      const projectId = facts().projectId
      return withActions({ model }, [
        ...(projectId ? [delegate(Delegate.Message.ChangedPreference({ projectId, preference: { on: true, chatId } }))] : []),
        AppAction.Navigate({ path: `/chat/${chatId}`, replace: false }),
      ])
    },
    // The page has nowhere of its own to say so: its error line is the
    // transcript's, and this message was never in this chat's. React put up
    // an alert ("Could not send to the delegator"); the root has no action
    // for one yet (see the slice's report).
    FailedDelegatedSend: ({ chatId }) => withActions({ model }, [pendingSend(PendingSend.Message.ClearedSending({ chatId }))]),

    SucceededReadQuickActions: ({ projectId, actions }) => ({
      model: modifyFields(model, { quickActions: (all) => ({ ...all, [projectId]: actions }), quickActionsError: () => null }),
    }),
    FailedReadQuickActions: ({ error }) => ({ model: modifyFields(model, { quickActionsError: () => error }) }),
    ReceivedUsageLimits: ({ snapshot }) => ({ model: modifyFields(model, { usageLimits: () => snapshot }) }),
    TickedUsageRefresh: () => ({ model: modifyFields(model, { usageRefreshing: () => true }), commands: [RefreshUsage({ force: false })] }),
    CompletedRefreshUsage: ({ snapshot }) => ({
      model: modifyFields(model, { usageRefreshing: () => false, usageLimits: (current) => snapshot ?? current }),
    }),

    ForwardedAppAction: ({ action }) => withActions({ model }, [action]),
    CompletedSideEffect: () => ({ model }),
  })
}

/**
 * ChatPage's handleChatSubmit: from the new chat page with delegating on,
 * the composer's message is not for this chat at all. It goes to the
 * delegator, and the app goes with it.
 */
export function routeDelegatedSend(result: Return, app: AppModel, facts: PageFacts): Return {
  const out = result.outMessage
  if (!out || out.action._tag !== "Chat" || out.action.message._tag !== "SubmittedMessage") return result
  const target = newChatDelegate(app, facts)?.target
  if (!target) return result
  const { content, options } = out.action.message
  const send = delegatorIsBusy(app, target.chatId)
    ? SendToDelegator({ chatId: target.chatId, content, options, queued: true })
    : StampDelegatedSend({ chatId: target.chatId, content, options })
  return { model: result.model, commands: [...(result.commands ?? []), send] }
}

// TABS

const navigateTo = (chatId: string) => AppAction.Navigate({ path: `/chat/${chatId}`, replace: false })

function tabMenuStep(model: Model, chatId: string, message: ContextMenu.Message): { result: Return; selected: string | null } {
  const result = ContextMenu.update(tabMenu(model, chatId), message)
  const selected = result.outMessage && result.outMessage._tag === "Selected" ? result.outMessage.value : null
  return {
    result: {
      model: modifyFields(model, { tabMenus: (menus) => ({ ...menus, [chatId]: result.model }) }),
      commands: Command.mapMessages(result.commands, (inner: ContextMenu.Message) => Message.GotTabMenuMessage({ chatId, message: inner })) as Return["commands"],
    },
    selected,
  }
}

/** ChatTabs' handleClose: back to the tab you were on before, else its neighbour, else home. */
function closeTab(model: Model, app: AppModel, facts: PageFacts, chatId: string): Return {
  const next = chatAfterClose(app, facts.chatId, chatId)
  const actions: AppAction[] = [chatTabs(ChatTabs.Message.ClosedTab({ chatId }))]
  if (next !== undefined) actions.push(next ? navigateTo(next) : AppAction.Navigate({ path: "/", replace: false }))
  return withActions({ model }, actions)
}

function chooseTabMenuItem(model: Model, app: AppModel, facts: PageFacts, chatId: string, value: string): Return {
  if (value === "tab:close") return closeTab(model, app, facts, chatId)
  // Closing several from a tab's menu: if the open tab is among those
  // closed, the tab the menu was opened on is what's left to show.
  if (value === "tab:close-others") {
    return withActions({ model }, [
      chatTabs(ChatTabs.Message.ClosedOtherTabs({ chatId })),
      ...(facts.chatId !== chatId ? [navigateTo(chatId)] : []),
    ])
  }
  if (value === "tab:close-right") {
    const tabs = app.stores.chatTabs.tabs
    const index = tabs.findIndex((tab) => tab.chatId === chatId)
    const activeIndex = tabs.findIndex((tab) => tab.chatId === facts.chatId)
    return withActions({ model }, [
      chatTabs(ChatTabs.Message.ClosedTabsToRight({ chatId })),
      ...(activeIndex > index ? [navigateTo(chatId)] : []),
    ])
  }
  const thread = threadsByChatId(app, [{ chatId }]).get(chatId)
  if (!thread) return { model }
  const choice = chooseChatRowMenuItem(value, {
    thread,
    archived: thread.archived,
    editorLabel: facts.editorLabel,
    hasDraft: ChatInput.chatHasDraft(app.stores.chatInput, chatId),
  })
  if (!choice || choice._tag === "None") return { model }
  if (choice._tag === "OpenUrl") return { model, commands: [OpenWindow({ url: choice.url })] }
  return withActions({ model }, [choice.action])
}

function beginTitleEdit(model: Model, facts: PageFacts): Return {
  const title = facts.activeTitle
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

