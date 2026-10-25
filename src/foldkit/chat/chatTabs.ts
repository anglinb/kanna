import { Effect, Option, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { getAdjacentChatTab, getChatTabAfterClose, type ChatTab } from "../../client/lib/chat-tabs"
import { flattenSidebarThreads, type SidebarThread } from "../../client/lib/thread-sections"
import { cn, normalizeChatId } from "../../client/lib/utils"
import type { AppModel } from "../app/slice"
import * as ChatInput from "../core/stores/chatInput"
import * as ContextMenu from "../ui/context-menu"
import { PencilLine, X } from "../ui/icons"
import { projectIcon } from "../ui/project-icon"
import { domStream } from "../ui/overlay/stream"
import { chatRowMenuEntries, DelegatorIcon, renderChatRowMenuItem, type ChatRowMenuContext } from "./chatRowMenu"
import { chatStatusDot } from "./emptyStateProject"
import { Message, type TabDrag } from "./message"
import { HOVER_CARD_OPEN_ATTRIBUTE, openTabCardKey, tabHoverCardView, trackTabCard } from "./tabHoverCard"
import type { Model } from "./model"

// ChatTabs (components/chat-ui/ChatTabs.tsx): with the Chat Tabs setting on,
// the navbar's left end holds every chat you have open, as tabs, in place of
// the one chat's title. One bar across every project; opening a chat gives
// it a tab or brings its tab forward (`lib/chat-tabs`, the chatTabs store).
//
// Switching is instant, by click (on the press) or by key. What moves is what
// you move: a dragged tab follows the pointer while the others slide aside
// (dnd-kit's horizontal sorting, restated in `TabDrag`). The sidebar's chat
// hover card beneath a tab is the sidebar's to port (see the slice report).

type H = HtmlBuilder<Message>

/** The strong ease-out the app uses for UI that answers a pointer (`--ease-snappy`). */
const TAB_MOVE_TRANSITION = "transform 200ms cubic-bezier(0.23, 1, 0.32, 1)"

/** A few pixels of travel before it is a drag, so a click is still a click. */
const DRAG_DISTANCE_PX = 4

/** lib/macApp's isMacApp (that module pulls zustand). */
function isMacApp() {
  if (typeof window === "undefined") return false
  const webkit = (window as { webkit?: { messageHandlers?: { kanna?: unknown } } }).webkit
  return Boolean(webkit?.messageHandlers?.kanna)
}

/** The menu of the tab for a chat, made on first use. */
export function tabMenu(model: Model, chatId: string): ContextMenu.Model {
  return model.tabMenus[chatId] ?? ContextMenu.init({ id: `chat-tab-${normalizeChatId(chatId)}` })
}

/** Only the projects that hold a tab's chat are flattened: most of the snapshot is not in the bar. */
export function threadsByChatId(app: AppModel, tabs: ReadonlyArray<ChatTab>): Map<string, SidebarThread> {
  const wanted = new Set(tabs.map((tab) => tab.chatId))
  const found = new Map<string, SidebarThread>()
  for (const group of app.stores.sidebar.data.projectGroups) {
    const holdsTab = group.chats.some((chat) => wanted.has(chat.chatId))
      || (group.archivedChats ?? []).some((chat) => wanted.has(chat.chatId))
    if (!holdsTab) continue
    for (const thread of flattenSidebarThreads({ projectGroups: [group] })) {
      if (wanted.has(thread.chatId)) found.set(thread.chatId, thread)
    }
  }
  return found
}

/**
 * The tabs to keep, when some should go: a tab outlives neither its chat nor
 * its chat being put away. The open chat is spared either way (one just
 * created is not in the snapshot yet; an archived one you are reading is
 * still on screen). Null when nothing goes, or the sidebar hasn't spoken.
 */
export function tabsToKeep(app: AppModel, activeChatId: string | null): ReadonlyArray<string> | null {
  if (!app.stores.sidebar.ready) return null
  const tabs = app.stores.chatTabs.tabs
  const threads = threadsByChatId(app, tabs)
  const keep = tabs.filter((tab) => {
    if (tab.chatId === activeChatId) return true
    const thread = threads.get(tab.chatId)
    return thread !== undefined && !thread.archived
  }).map((tab) => tab.chatId)
  return keep.length === tabs.length ? null : keep
}

/**
 * Closing the open tab goes back to the one you were on before it, as a
 * browser's does, and only falls to its neighbour when there is no such tab
 * left. `undefined`: stay. `null`: there is no chat left to show.
 */
export function chatAfterClose(app: AppModel, activeChatId: string | null, chatId: string): string | null | undefined {
  const { tabs, recentChatIds } = app.stores.chatTabs
  const lastSeen = recentChatIds.find((recent) => recent !== chatId && tabs.some((tab) => tab.chatId === recent))
  return chatId === activeChatId ? lastSeen ?? getChatTabAfterClose(tabs, chatId) : undefined
}

export function adjacentTab(app: AppModel, activeChatId: string | null, direction: 1 | -1) {
  return getAdjacentChatTab(app.stores.chatTabs.tabs, activeChatId, direction)
}

// MOUNTS

/**
 * The bar's pointer and keys: a press selects a tab (on the press, not the
 * release, as a browser's does) and may become a drag; the middle button
 * closes one; the bar's shortcuts work from anywhere, the composer included.
 */
type TabListMessage =
  | typeof Message.PressedTab.Type
  | typeof Message.StartedTabDrag.Type
  | typeof Message.MovedTabDrag.Type
  | typeof Message.DroppedTab.Type
  | typeof Message.MiddleClickedTab.Type
  | typeof Message.PressedTabShortcut.Type
  | typeof Message.ChangedTabCardRow.Type

export const TabListMount = Mount.defineStream("ChatTabList", {
  messages: [Message.PressedTab, Message.StartedTabDrag, Message.MovedTabDrag, Message.DroppedTab, Message.MiddleClickedTab, Message.PressedTabShortcut, Message.ChangedTabCardRow],
  execute: ({ element }) => domStream<TabListMessage>((emit) => {
    const list = element as HTMLElement
    let press: { chatId: string; pointerId: number; x: number; rects: DOMRect[]; index: number; dragging: boolean } | null = null

    const tabOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-chat-tab]") : null)
    const tabs = () => [...list.querySelectorAll<HTMLElement>("[data-chat-tab]")]

    const down = (event: PointerEvent) => {
      const tab = tabOf(event.target)
      if (!tab || !list.contains(tab)) return
      // The close button, the open tab's menu button and the title's field
      // keep their presses to themselves: past the bar too, as React's
      // stopPropagation did, so a card or menu over the page doesn't take
      // them for a press outside.
      if (event.target instanceof Element && event.target.closest("[data-tab-own-press]")) {
        event.stopPropagation()
        return
      }
      const chatId = tab.dataset.chatTab!
      if (event.button === 0) {
        const all = tabs()
        press = { chatId, pointerId: event.pointerId, x: event.clientX, rects: all.map((node) => node.getBoundingClientRect()), index: all.indexOf(tab), dragging: false }
        if (tab.getAttribute("aria-selected") !== "true") emit(Message.PressedTab({ chatId }))
      }
    }
    const move = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return
      const dx = event.clientX - press.x
      if (!press.dragging) {
        if (Math.abs(dx) < DRAG_DISTANCE_PX) return
        press.dragging = true
        emit(Message.StartedTabDrag({ chatId: press.chatId, fromIndex: press.index, width: press.rects[press.index]?.width ?? 0 }))
      }
      // closestCenter: the tab whose centre is nearest the dragged one's.
      const own = press.rects[press.index]
      const center = own ? own.left + own.width / 2 + dx : event.clientX
      let overIndex = press.index
      let best = Number.POSITIVE_INFINITY
      press.rects.forEach((rect, index) => {
        const distance = Math.abs(rect.left + rect.width / 2 - center)
        if (distance < best) {
          best = distance
          overIndex = index
        }
      })
      emit(Message.MovedTabDrag({ dx, overIndex }))
    }
    const end = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return
      const dragged = press.dragging
      press = null
      if (dragged) emit(Message.DroppedTab())
    }
    const aux = (event: MouseEvent) => {
      const tab = tabOf(event.target)
      if (!tab || event.button !== 1) return
      event.preventDefault()
      emit(Message.MiddleClickedTab({ chatId: tab.dataset.chatTab! }))
    }

    // Next and previous tab: in the Mac app Cmd+Option with an arrow, which a
    // browser's tabs answer to; on the web Option+[ and Option+], beside
    // Option+W for closing one (by the keys' positions: with Option held they
    // type curly quotes). Cmd+T in the Mac app is a new tab, a new chat.
    const inMacApp = isMacApp()
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.shiftKey) return
      const direction = inMacApp
        ? event.metaKey && event.altKey
          ? event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : null
          : null
        : event.altKey && !event.metaKey
          ? event.code === "BracketRight" ? 1 : event.code === "BracketLeft" ? -1 : null
          : null
      if (direction !== null) {
        event.preventDefault()
        emit(Message.PressedTabShortcut({ shortcut: direction === 1 ? "next" : "previous" }))
        return
      }
      if (inMacApp && event.code === "KeyT" && event.metaKey && !event.altKey) {
        event.preventDefault()
        emit(Message.PressedTabShortcut({ shortcut: "new" }))
        return
      }
      if (event.code !== "KeyW") return
      const chord = inMacApp ? event.metaKey && !event.altKey : event.altKey && !event.metaKey
      if (!chord || list.querySelector("[aria-selected=true]") === null) return
      event.preventDefault()
      emit(Message.PressedTabShortcut({ shortcut: "close" }))
    }

    list.addEventListener("pointerdown", down)
    // The chat card beneath the tab under the pointer (tabHoverCard.ts).
    const stopTrackingCard = trackTabCard(list, emit)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
    list.addEventListener("auxclick", aux)
    window.addEventListener("keydown", key, true)
    return () => {
      stopTrackingCard()
      list.removeEventListener("pointerdown", down)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      list.removeEventListener("auxclick", aux)
      window.removeEventListener("keydown", key, true)
    }
  }),
})

/** The open tab is in view: a bar past its width scrolls, and a tab reached by key may be off its end. */
export const ScrollTabIntoView = Command.define("ScrollChatTabIntoView", {
  args: { chatId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId }) => Effect.sync(() => {
    document.querySelector(`[data-chat-tab="${CSS.escape(chatId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" })
    return Message.CompletedSideEffect()
  }),
})

// VIEW

/** horizontalListSortingStrategy: where a tab sits while one is dragged past it. */
function tabTransform(drag: TabDrag | null, index: number, chatId: string): { transform?: string; transition?: string } {
  if (!drag) return {}
  if (drag.chatId === chatId) return { transform: `translate3d(${drag.dx}px, 0px, 0)` }
  const shift = index > drag.fromIndex && index <= drag.overIndex
    ? -drag.width
    : index < drag.fromIndex && index >= drag.overIndex
      ? drag.width
      : 0
  return { transform: `translate3d(${shift}px, 0px, 0)`, transition: TAB_MOVE_TRANSITION }
}

function tabView(
  model: Model,
  app: AppModel,
  options: {
    tab: ChatTab
    index: number
    thread: SidebarThread | undefined
    active: boolean
    isNew: boolean
    editorLabel: string
    hasOthers: boolean
    hasTabsToRight: boolean
    /** The chat card is up beneath this tab (`HOVER_CARD_OPEN_ATTRIBUTE`). */
    cardOpen: boolean
    titleView: (title: string) => Html
  },
  h: H,
): Html {
  const { tab, thread, active } = options
  const title = thread?.title ?? "New Chat"
  const statusMark = thread ? chatStatusDot(thread.row, h) : null
  // An unsent draft takes the icon's place, as on the chat's sidebar row.
  const hasDraft = ChatInput.chatHasDraft(app.stores.chatInput, tab.chatId)
  const mark = h.span([h.Class("relative flex size-4 shrink-0 items-center justify-center")], [
    statusMark ?? (hasDraft
      ? PencilLine({ class: "h-4 w-4 shrink-0 text-logo" }, h)
      // A delegator's own mark, as on its sidebar row.
      : thread?.row.delegator ? DelegatorIcon({ class: "h-4 w-4 shrink-0 text-muted-foreground" }, h)
      : thread ? projectIcon({ name: thread.projectTitle, iconUrl: thread.projectIconUrl }, h) : null),
  ])

  const body = (portal: Html | null) => h.div([
    h.Class(cn(
      // The tab's colour is a variable: the tab and the fade behind its close
      // button paint with it, and must match in every state.
      "group/tab relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-lg border bg-(--tab-bg) px-2 text-sm transition-colors",
      active
        ? "border-border text-foreground [--tab-bg:var(--color-muted)]"
        : "border-transparent text-muted-foreground [--tab-bg:var(--color-background)] hover:text-foreground hover:[--tab-bg:var(--color-muted)] group-data-[hover-card-open]/tabhost:text-foreground group-data-[hover-card-open]/tabhost:[--tab-bg:var(--color-muted)]",
    )),
  ], [
    active && thread
      ? h.button([
        h.Type("button"),
        h.Title("Chat actions"),
        h.AriaLabel("Chat actions"),
        h.DataAttribute("tab-own-press", ""),
        h.OnClick(Message.ClickedTabMenuButton({ chatId: tab.chatId })),
        h.Class("relative flex shrink-0 rounded-[4px] outline-none transition-transform duration-150 ease-snappy before:absolute before:-inset-1 before:rounded-md before:bg-foreground/10 before:opacity-0 before:transition-opacity before:duration-150 hover:before:opacity-100 focus-visible:before:opacity-100 active:scale-[0.94] motion-reduce:transition-none"),
      ], [mark])
      : active
        ? h.button([
          h.Type("button"),
          h.Title("Chat actions"),
          h.AriaLabel("Chat actions"),
          h.DataAttribute("tab-own-press", ""),
          h.Class("relative flex shrink-0 rounded-[4px] outline-none transition-transform duration-150 ease-snappy before:absolute before:-inset-1 before:rounded-md before:bg-foreground/10 before:opacity-0 before:transition-opacity before:duration-150 hover:before:opacity-100 focus-visible:before:opacity-100 active:scale-[0.94] motion-reduce:transition-none"),
        ], [mark])
        : mark,
    active ? options.titleView(title) : h.span([h.Class("min-w-0 truncate font-medium")], [title]),
    // Laid over the tab's end, not given room in it: the title gets the whole
    // tab, and the button appears over its tail on hover.
    h.span([h.Class("absolute inset-y-0 right-0 flex items-center rounded-r-[7px] bg-gradient-to-l from-(--tab-bg) via-(--tab-bg) to-transparent pl-6 pr-1.5 opacity-0 transition-opacity duration-150 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100")], [
      h.button([
        h.Type("button"),
        h.Title("Close tab"),
        h.AriaLabel(`Close ${title}`),
        h.DataAttribute("tab-own-press", ""),
        h.OnClick(Message.ClickedCloseTab({ chatId: tab.chatId })),
        h.Class("flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:text-foreground"),
      ], [X({ class: "size-3", strokeWidth: 2.5 }, h)]),
    ]),
    portal,
  ])

  const placed = tabTransform(model.tabDrag, options.index, tab.chatId)
  const host = (trigger: ReadonlyArray<ChildAttribute>, portal: Html | null) => h.keyed("div")(`tab-${tab.chatId}`, [
    ...(placed.transform ? [h.Style({ transform: placed.transform, ...(placed.transition ? { transition: placed.transition } : {}) })] : []),
    // dnd-kit's sortable attributes.
    h.Tabindex(0),
    h.AriaDisabled(false),
    h.Attribute("aria-roledescription", "sortable"),
    h.AriaDescribedBy("DndDescribedBy-0"),
    h.Role("tab"),
    h.AriaSelected(active),
    h.DataAttribute("chat-tab", tab.chatId),
    // What the chat hover card finds the tab under the pointer by.
    h.DataAttribute("chat-id", normalizeChatId(tab.chatId)),
    // The tab keeps its hover look while the pointer crosses to its card.
    ...(options.cardOpen ? [h.DataAttribute(HOVER_CARD_OPEN_ATTRIBUTE, "")] : []),
    // For a keyboard: a tab is focusable, and has no press to select on.
    h.OnKeyDownPreventDefault((key) => ((key === "Enter" || key === " ") && !active ? Option.some(Message.PressedTab({ chatId: tab.chatId })) : Option.none())),
    h.Class(cn(
      // As wide as its title, up to a cap, giving way evenly with the others
      // (down to a floor) once the bar is full. The 2px between tabs is 1px
      // of padding inside each one, so the pointer is never over none of them.
      "group/tabhost pointer-events-auto min-w-[74px] max-w-[242px] shrink cursor-default px-px outline-none",
      // A tab opened while the bar is up arrives with a short fade and grow.
      options.isNew && "transition-[opacity,scale] duration-200 ease-snappy starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
      model.tabDrag?.chatId === tab.chatId && "relative z-10",
    )),
    ...trigger,
  ], [body(portal)])

  if (!thread) return host([], null)
  const context: ChatRowMenuContext = {
    thread,
    archived: thread.archived,
    editorLabel: options.editorLabel,
    hasDraft,
    // A tab's own items, ahead of the chat's: what a browser's tab menu offers.
    leadingItems: [
      ContextMenu.item({ value: "tab:close" }),
      ContextMenu.item({ value: "tab:close-others", disabled: !options.hasOthers }),
      ContextMenu.item({ value: "tab:close-right", disabled: !options.hasTabsToRight }),
    ],
  }
  return h.submodel({
    slotId: `tab-menu-${tab.chatId}`,
    model: tabMenu(model, tab.chatId),
    view: ContextMenu.view,
    viewInputs: {
      items: chatRowMenuEntries(context),
      renderItem: (value: string) => tabMenuItem(value) ?? renderChatRowMenuItem(value, context, h) ?? [],
      toView: ({ trigger, portal }) => host(trigger, portal),
    },
    toParentMessage: (message) => Message.GotTabMenuMessage({ chatId: tab.chatId, message }),
  })

  function tabMenuItem(value: string) {
    const label = value === "tab:close" ? "Close" : value === "tab:close-others" ? "Close Others" : value === "tab:close-right" ? "Close to the Right" : null
    return label ? [h.span([h.Class("text-xs font-medium")], [label])] : null
  }
}

/**
 * The bar, rendered with no tabs too: it is the navbar's flexible middle,
 * and the buttons on the right are held there by it. 9px down on the web to
 * line up with the sidebar's bar; with the sidebar collapsed it goes back to
 * its own centre.
 */
export function chatTabsView(model: Model, app: AppModel, activeChatId: string | null, editorLabel: string, titleView: (title: string) => Html, h: H): Html {
  const tabs = app.stores.chatTabs.tabs
  const threads = threadsByChatId(app, tabs)
  const initial = new Set(model.tabsInitial ?? tabs.map((tab) => tab.chatId))
  const cardKey = openTabCardKey(model, app, threads)
  return h.div([h.Class("pointer-events-none hidden min-w-0 flex-1 translate-y-[9px] md:flex mac-app:md:translate-y-0 transition-[translate] duration-300 ease-glide motion-reduce:transition-none group-data-[sidebar-collapsed]/navbar:translate-y-0")], [
    h.div([
      h.Role("tablist"),
      h.AriaLabel("Open chats"),
      // No gap: the tabs space themselves. Pulled 1px left, so the first
      // tab's box still starts where the bar does.
      h.Class("-ml-px flex w-[calc(100%+1px)] min-w-0 items-center overflow-x-auto scrollbar-hide"),
      h.OnMount(TabListMount()),
    ], tabs.map((tab, index) => tabView(model, app, {
      tab,
      index,
      thread: threads.get(tab.chatId),
      active: tab.chatId === activeChatId,
      isNew: !initial.has(tab.chatId),
      editorLabel,
      hasOthers: tabs.length > 1,
      hasTabsToRight: index < tabs.length - 1,
      cardOpen: cardKey !== null && cardKey === normalizeChatId(tab.chatId),
      titleView,
    }, h))),
    // dnd-kit's screen reader instructions, which every tab is described by.
    h.div([h.Id("DndDescribedBy-0"), h.Style({ display: "none" })], [
      "To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel.",
    ]),
    // And its live region, where it announces a drag (empty: tabs drag by pointer only).
    h.div([
      h.Id("DndLiveRegion-0"),
      h.Role("status"),
      h.AriaLive("assertive"),
      h.AriaAtomic(true),
      h.Style({
        position: "fixed",
        top: "0px",
        left: "0px",
        width: "1px",
        height: "1px",
        margin: "-1px",
        border: "0px",
        padding: "0px",
        overflow: "hidden",
        clip: "rect(0px, 0px, 0px, 0px)",
        "clip-path": "inset(100%)",
        "white-space": "nowrap",
      }),
    ], []),
    // The chat rows' card, beneath the tab under the pointer. Pressing a tab
    // closes it, as any click outside a card does, so it is never up over a
    // tab being dragged.
    tabHoverCardView(model, app, threads, h),
  ])
}

/** For tabs reordered by a drop: `arrayMove`. */
export function movedTabIds(tabs: ReadonlyArray<ChatTab>, from: number, to: number): ReadonlyArray<string> {
  const ids = tabs.map((tab) => tab.chatId)
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) return ids
  const [moved] = ids.splice(from, 1)
  ids.splice(to, 0, moved!)
  return ids
}
