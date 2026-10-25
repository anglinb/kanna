import type { Html, HtmlBuilder } from "foldkit/html"
import { getTranscriptPaddingBottom } from "../../client/app/kannaStateHelpers"
import { paneDurationMs } from "../../client/app/paneAnimation"
import { EMPTY_STATE_TEXT } from "../../client/app/ChatPage/utils"
import { cn } from "../../client/lib/utils"
import type { AppModel } from "../app/slice"
import * as Composer from "../composer"
import * as Terminal from "../terminal"
import * as Transcript from "../transcript"
import * as Viewer from "../viewer"
import * as Widgets from "../widgets"
import { card, cardContent } from "../ui/card"
import { AnimateTerminalSplit, HoldArrivalFocus, KeepChatFocus, PageFileDrop, HoldColumnDragCursor, HoldMobileSheet, HoldPagePresence, KeepDiffsFresh, ListenForShortcuts, ObserveDock, ObserveLayout, ObservePage, pageRootAttribute, TypeEmptyState } from "./effects"
import { Message, type Watch } from "./message"
import type { Model } from "./model"
import { delegatedListButtonView, editableTitleView, navbarTitleView, navbarView, washView } from "./navbar"
import { chatTabsView } from "./chatTabs"
import { pageFacts, getTerminalPanelDefaultSizes, CHAT_MIN_SIZE_PERCENT, type PageFacts } from "./page"
import type { ChatPageContext, ChatPageSliceInputs } from "./pageInputs"
import { panel, panelGroup, separator } from "./resizable"
import { getWidgetsColumnWidthPx, widgetsColumnView } from "./widgetsColumn"
import { emptyStateView } from "./emptyState"
import { newChatDelegate } from "./newChatDelegate"

// ChatPage (src/client/app/ChatPage/index.tsx): the navbar over the chat,
// the viewer's pane and the widget column, the terminal under all of them,
// and the composer docked over the transcript's foot.

type H = HtmlBuilder<Message>

export function watchOf(facts: PageFacts): Watch {
  return {
    chatId: facts.chatId,
    projectId: facts.projectId,
    showRightSidebar: facts.showRightSidebar,
    isProcessing: facts.isProcessing,
    showEmptyState: facts.showEmptyState,
    viewerOpen: facts.viewerOpen,
    viewerExpanded: facts.viewerExpanded,
    showTerminalPane: facts.showTerminalPane,
    isMobile: facts.isMobile,
    sidebarReady: facts.sidebarReady,
    isDelegator: facts.isDelegator,
    bindings: JSON.stringify(facts.keybindings.bindings),
    terminalSwitchKey: facts.terminalChatKey ?? facts.projectId,
    shouldRenderTerminalLayout: facts.shouldRenderTerminalLayout,
    terminalMainSizes: JSON.stringify(facts.terminalLayout.mainSizes),
    chatTabsEnabled: facts.chatTabsEnabled,
    tabsCount: facts.tabsCount,
    pruneTabs: facts.pruneTabs,
  }
}

/** The typed hero line, and whether it is done, for the empty state now on screen. */
export function emptyStateTyping(model: Model, facts: PageFacts) {
  // Reset in the render the empty state appears, not after: the viewport
  // decides on its entrance animation from the first frame, and a stale
  // "typing complete" there would skip it.
  const typing = facts.showEmptyState && model.emptyStateTyping.started ? model.emptyStateTyping : { count: 0, complete: false }
  return { text: EMPTY_STATE_TEXT.slice(0, typing.count), complete: typing.complete }
}

export function pageContext(model: Model, app: AppModel, facts: PageFacts): ChatPageContext {
  const typing = emptyStateTyping(model, facts)
  return {
    chatId: facts.chatId,
    projectId: facts.projectId,
    isMobile: facts.isMobile,
    showEmptyState: facts.showEmptyState,
    delegate: newChatDelegate(app, facts),
    typedEmptyStateText: typing.text,
    isEmptyStateTypingComplete: typing.complete,
    transcriptPaddingBottom: getTranscriptPaddingBottom(model.dockHeight),
    isPageFileDragActive: model.pageFileDragActive,
    projectPath: facts.navbarLocalPath,
    widgetsActive: facts.showRightSidebar,
    isNewChat: facts.showEmptyState,
    widgetsData: {
      quickActions: facts.projectId ? model.quickActions[facts.projectId] ?? null : null,
      quickActionsError: model.quickActionsError,
      usageLimits: model.usageLimits,
      usageRefreshing: model.usageRefreshing,
    },
    viewer: {
      paneAvailable: facts.viewerPaneAvailable,
      expanded: facts.viewerExpanded,
      // On desktop the navbar stays over the viewer, docked or expanded, so
      // the card starts below it, level with the widget column's top card
      // (navbar + 1px); on a phone the viewer covers the navbar too.
      className: facts.isMobile ? undefined : cn("pt-[calc(var(--chat-navbar-h,53px)+1px)]", facts.showRightSidebar && "pr-0"),
    },
    terminal: {
      layout: facts.terminalLayout,
      fixedHeight: fixedTerminalHeight(model, facts),
      focusRequestVersion: model.terminalPane.focusRequest.key === (facts.terminalChatKey ?? facts.projectId) ? model.terminalPane.focusRequest.version : 0,
      pendingCommandsByTerminalId: model.pendingTerminalCommands,
      chatKey: facts.terminalChatKey,
    },
  }
}

function fixedTerminalHeight(model: Model, facts: PageFacts) {
  if (!facts.shouldRenderTerminalLayout || model.layoutHeight <= 0) return 0
  const height = model.layoutHeight * (facts.terminalLayout.mainSizes[1] / 100)
  return height > 0 ? height : 0
}

/** Present while the empty state is: types its line out, once per appearance. */
const emptyStateTypist = (h: H) => h.keyed("span")("chat-empty-state-typist", [h.Hidden(true), h.OnMount(TypeEmptyState())], [])

export function pageView(model: Model, app: AppModel, h: H): Html {
  const facts = pageFacts(app, model.viewportWidth, model.settledShowEmptyState)
  const page = pageContext(model, app, facts)
  const inputs: ChatPageSliceInputs = { app, page }
  const transcriptInputs: ChatPageSliceInputs = { app, page, emptyState: () => emptyStateView(model, app, facts, page, h) }

  // CHAT CARD

  const chatCard = card({
    class: "bg-background h-full flex flex-col overflow-hidden border-0 rounded-none relative",
    attributes: [h.DataAttribute("chat-card", ""), h.OnMount(PageFileDrop({ enabled: facts.hasSelectedProject }))],
  }, [
    cardContent({ class: "flex flex-1 min-h-0 flex-col overflow-hidden p-0 relative" }, [
      washView(model, { wash: "transcript", resetKey: facts.chatId, stopAtTranscriptScrollbar: true, opaqueBar: facts.chatTabsEnabled }, h),
      h.submodel({ slotId: "transcript", model: model.transcript, view: Transcript.view, viewInputs: transcriptInputs, toParentMessage: (message) => Message.GotTranscriptMessage({ message }) }),
    ], h),
    // ChatInputDock
    h.div([h.Class("absolute bottom-0 left-0 right-0 z-20 pointer-events-none")], [
      h.div([h.Class("relative pointer-events-auto"), h.OnMount(ObserveDock())], [
        // The wash is its own layer, ending at the transcript's scrollbar
        // gutter so it stops dimming the scrollbar. In `surface`, not the
        // page's background: the dock also sits in the viewer's card.
        h.div([h.Class("absolute inset-y-0 left-0 right-[var(--transcript-scrollbar-w,0px)] bg-gradient-to-t from-surface via-surface to-surface/10 md:to-surface/0 pointer-events-none")], []),
        h.div([h.Class("relative")], [
          h.submodel({ slotId: "composer", model: model.composer, view: Composer.view, viewInputs: inputs, toParentMessage: (message) => Message.GotComposerMessage({ message }) }),
        ]),
      ]),
    ]),
  ], h)

  // The chat, with the viewer beside it or over it. Over it, the chat stays
  // mounted underneath but goes inert.
  const chatColumn = h.div([
    ...((facts.viewerOpen && !facts.viewerDocked) ? [h.Inert(true)] : []),
    h.Class("flex h-full min-h-0 flex-1 flex-col"),
  ], [chatCard])

  const viewerLayer = h.submodel({ slotId: "viewer", model: model.viewer, view: Viewer.view, viewInputs: inputs, toParentMessage: (message) => Message.GotViewerMessage({ message }) })

  const workspace = facts.viewerPaneAvailable
    // The split is always there, the pane at nothing while the viewer's
    // closed, so opening one never moves the chat to a new parent.
    ? h.div([h.Class("relative flex h-full min-h-0 flex-1 flex-col")], [
      panelGroup({ id: "chat-viewer-split", orientation: "horizontal", class: "flex-1 min-h-0" }, [
        panel({ id: "chatColumn", orientation: "horizontal", size: model.viewerSplit[0], class: "flex min-h-0 min-w-0 flex-col" }, [chatColumn], h),
        separator({
          id: "chat-viewer-separator",
          orientation: "horizontal",
          withHandle: false,
          disabled: !facts.viewerDocked,
          // The card sits 8px into its pane, so this reaches from 4px into
          // the chat to 4px past the border (still no width of its own).
          class: cn("z-40 w-4 -ml-1 -mr-3", !facts.viewerDocked && "pointer-events-none opacity-0"),
        }, h),
        panel({ id: "viewerPane", orientation: "horizontal", size: model.viewerSplit[1], class: cn("min-h-0 min-w-0", !facts.viewerExpanded && "relative") }, [viewerLayer], h),
      ], h),
    ])
    : h.div([h.Class("relative flex h-full min-h-0 flex-1 flex-col")], [chatColumn, viewerLayer])

  const widgets = facts.projectId
    ? h.submodel({ slotId: "widgets", model: model.widgets, view: Widgets.view, viewInputs: inputs, toParentMessage: (message) => Message.GotWidgetsMessage({ message }) })
    : null

  // The chat and the viewer, then the widget column, side by side: all that
  // sits above the terminal.
  const panes = h.div([h.Class("flex min-h-0 flex-1 overflow-hidden")], [
    h.div([h.Class("flex min-h-0 min-w-0 flex-1 flex-col")], [workspace]),
    ...(facts.projectId && !facts.isMobile
      ? widgetsColumnView(model, {
        open: facts.showRightSidebar,
        widthPx: getWidgetsColumnWidthPx(model.widgetsColumn.dragWidthPx ?? app.stores.rightSidebar.size, model.layoutWidth),
        content: widgets,
        wash: washView(model, { wash: "widgets", resetKey: null, stopAtTranscriptScrollbar: false, opaqueBar: false }, h),
      }, h)
      : []),
  ])

  // The navbar spans the chat, the viewer's pane and the widget column, over
  // the top of all three.
  // The navbar's left end names the open chat, or with the Chat Tabs
  // setting on holds every chat you have open, as tabs.
  const titleSlot = facts.chatTabsEnabled
    ? chatTabsView(model, app, facts.chatId, facts.editorLabel, (title) => editableTitleView(model, title, h), h)
    : facts.chatId && facts.runtime?.title
      ? navbarTitleView(model, app, facts, facts.runtime.title, facts.diffs?.branchName, h)
      : null
  // On a phone a delegator has no pane to keep its list in, so the list is a
  // button in the navbar instead, always there.
  const actionsSlot = facts.isDelegator && facts.chatId ? delegatedListButtonView(model, app, facts.chatId, facts.isMobile, h) : null
  const navbar = navbarView(model, app, facts, { title: titleSlot, actions: actionsSlot }, h)
  const panesWithNavbar = h.div([
    h.Class("relative flex h-full min-h-0 flex-1 flex-col"),
    ...(model.navbarHeight !== null ? [h.Style({ "--chat-navbar-h": `${model.navbarHeight}px` })] : []),
  ], [panes, navbar])

  const chatWorkspace = facts.projectId ? terminalWorkspaceView(model, facts, panesWithNavbar, page, inputs, h) : panesWithNavbar

  return h.div([
    h.Class("flex-1 flex flex-col min-w-0 relative"),
    h.Attribute(pageRootAttribute, ""),
    h.OnMount(ObserveLayout()),
  ], [
    chatWorkspace,
    facts.isMobile ? mobileSidebarPaneView(facts, widgets, h) : null,
    // What ChatPage's effects ran on, reported each time it changes.
    h.div([h.Hidden(true), h.OnMount(HoldPagePresence())], [
      h.keyed("span")(JSON.stringify(watchOf(facts)), [h.OnMount(ObservePage({ watch: watchOf(facts) }))], []),
      facts.showEmptyState ? emptyStateTypist(h) : null,
      // useStickyChatFocus, while there is a project to type into.
      facts.hasSelectedProject ? h.keyed("span")(`arrival-focus-${facts.chatId ?? ""}`, [h.OnMount(HoldArrivalFocus())], []) : null,
      facts.hasSelectedProject ? h.keyed("span")("sticky-focus", [h.OnMount(KeepChatFocus({ canCancel: facts.canCancel }))], []) : null,
      facts.projectId
        ? h.keyed("span")(`shortcuts-${JSON.stringify(facts.keybindings.bindings)}`, [h.OnMount(ListenForShortcuts({ bindings: JSON.stringify(facts.keybindings.bindings) }))], [])
        : null,
      facts.isMobile && facts.showRightSidebar ? h.keyed("span")("mobile-sheet", [h.OnMount(HoldMobileSheet())], []) : null,
      facts.projectId && facts.showRightSidebar ? h.keyed("span")(`diff-refresh-${facts.projectId}`, [h.OnMount(KeepDiffsFresh())], []) : null,
      model.widgetsColumn.dragWidthPx !== null ? h.keyed("span")("column-drag", [h.OnMount(HoldColumnDragCursor())], []) : null,
    ]),
  ])
}

/**
 * The terminal under everything right of the left sidebar. The split is
 * there even with no terminals (the terminal at nothing), so adding the
 * first one doesn't move what's above to a new parent.
 */
function terminalWorkspaceView(model: Model, facts: PageFacts, content: Html, page: ChatPageContext, inputs: ChatPageSliceInputs, h: H): Html {
  const clampTerminalToMaxHeight = facts.isMobile
  const pane = model.terminalPane
  const sizes = pane.split ?? getTerminalPanelDefaultSizes(facts.showTerminalPane, facts.terminalLayout.mainSizes)
  const animation = pane.animation
  return h.keyed("div")(`terminal-split-${facts.projectId}`, [
    h.Class(cn("flex h-full w-full", "flex-1 min-h-0")),
    h.DataAttribute("group", "true"),
    h.DataAttribute("testid", "chat-terminal-split"),
    h.Id("chat-terminal-split"),
    h.Style({ height: "100%", width: "100%", overflow: "hidden", display: "flex", "flex-flow": "column", "touch-action": "pan-x" }),
  ], [
    panel({ id: "chat", orientation: "vertical", size: sizes[0], class: "flex min-h-0 flex-col" }, [content], h),
    separator({
      id: "chat-terminal-separator",
      orientation: "vertical",
      // Nothing to drag to when the terminal is pinned at its ceiling; the
      // pane's own close button is the way out on mobile.
      withHandle: !clampTerminalToMaxHeight,
      disabled: !facts.showTerminalPane || clampTerminalToMaxHeight,
      class: cn(!facts.showTerminalPane && "pointer-events-none opacity-0"),
      value: { controls: "chat", now: sizes[0], min: CHAT_MIN_SIZE_PERCENT, max: 100 },
    }, h),
    panel({
      id: "terminal",
      orientation: "vertical",
      size: sizes[1],
      class: "min-h-0",
      // What the toggle animation writes on the panel (`terminalPanelRef`).
      attributes: pane.panelOpen ? [h.DataAttribute("terminal-open", pane.panelOpen)] : [],
    }, [
      h.div([
        h.Class("h-full min-h-0 overflow-hidden relative"),
        h.DataAttribute("terminal-open", facts.showTerminalPane ? "true" : "false"),
        h.DataAttribute("terminal-animated", pane.animated ? "true" : "false"),
        h.DataAttribute("terminal-visual", "true"),
        h.Style({ "--pane-duration": `${paneDurationMs(facts.showTerminalPane)}ms` }),
      ], [
        animation
          ? h.keyed("span")(`terminal-split-${animation.token}`, [
            h.Hidden(true),
            h.OnMount(AnimateTerminalSplit({
              token: animation.token,
              fromChat: animation.from[0],
              fromTerminal: animation.from[1],
              toChat: animation.to[0],
              toTerminal: animation.to[1],
              durationMs: animation.durationMs,
            })),
          ], [])
          : null,
        facts.shouldRenderTerminalLayout
          // TerminalWorkspaceShell
          ? h.div(page.terminal.fixedHeight > 0 ? [h.Style({ height: `${page.terminal.fixedHeight}px` })] : [], [
            h.submodel({ slotId: "terminal", model: model.terminal, view: Terminal.view, viewInputs: inputs, toParentMessage: (message) => Message.GotTerminalMessage({ message }) }),
          ])
          : null,
      ]),
    ], h),
  ])
}

/** The widget column as a sheet over the chat, on a phone. */
function mobileSidebarPaneView(facts: PageFacts, content: Html | null, h: H): Html | null {
  if (!facts.projectId) return null
  const show = facts.showRightSidebar
  return h.div([
    // The pane clock and curve (paneAnimation.ts), in classes. Under reduced
    // motion the sheet stops sliding; the backdrop still fades.
    h.Class(cn(
      "absolute inset-0 z-40 transition-opacity ease-glide",
      show ? "pointer-events-auto opacity-100 duration-300" : "pointer-events-none opacity-0 duration-[240ms]",
    )),
    ...(show ? [] : [h.AriaHidden(true)]),
    h.DataAttribute("mobile-right-sidebar-overlay", "true"),
  ], [
    h.button([
      h.Type("button"),
      h.Class("absolute inset-0 bg-black/45 backdrop-blur-[1px]"),
      h.AriaLabel("Close widgets"),
      h.OnClick(Message.ClickedCloseWidgets()),
    ], []),
    h.div([
      h.Class(cn(
        "group/widgets absolute inset-y-0 right-0 flex w-[min(92vw,30rem)] max-w-full min-h-0 flex-col overflow-hidden transition-transform ease-glide motion-reduce:transition-none",
        "pt-[max(env(safe-area-inset-top),0px)] pb-[max(env(safe-area-inset-bottom),0px)]",
        show ? "translate-x-0 duration-300" : "translate-x-full duration-[240ms]",
      )),
      h.DataAttribute("right-sidebar-open", show ? "true" : "false"),
      h.DataAttribute("right-sidebar-animated", "false"),
      h.DataAttribute("right-sidebar-visual", "true"),
      h.DataAttribute("slideover", "true"),
    ], [content]),
  ])
}

