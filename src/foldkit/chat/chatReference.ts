import type { HtmlBuilder } from "foldkit/html"
import { resolveChatOpen } from "../../client/lib/chat-open"
import { flattenSidebarThreads, type SidebarThread } from "../../client/lib/thread-sections"
import type { ChatSchedule } from "../../shared/types"
import { AppAction } from "../app/action"
import { routeChatId } from "../app/route"
import type { AppModel } from "../app/slice"
import * as Stores from "../app/stores"
import * as ChatTabs from "../core/stores/chatTabs"
import * as ViewerStore from "../core/stores/viewer"
import type { Child } from "../ui/attributes"
import * as ContextMenu from "../ui/context-menu"
import { PanelRight, SquareArrowOutUpRight } from "../ui/icons"

// What the chat page gave everything inside it that shows another chat
// (chat-reference.tsx's ChatReferenceProvider and ChatSchedulesProvider,
// ChatOpenMenuItems, useOpenChat), as functions of the root Model: a chat
// shown inside this one (a card in the transcript, a Tasks row) is the same
// chat the sidebar lists, with the same menu and the same ways to open it.
// The transcript and the widget column import these; a choice comes back as
// AppActions for their OutMessage.

/** useSidebarThread: one chat as the sidebar knows it, or null while it hasn't heard of it. */
export function sidebarThread(app: AppModel, chatId: string | null | undefined): SidebarThread | null {
  if (!chatId) return null
  const group = app.stores.sidebar.data.projectGroups.find((candidate) => (
    candidate.chats.some((chat) => chat.chatId === chatId)
    || (candidate.archivedChats ?? []).some((chat) => chat.chatId === chatId)
  ))
  return group ? flattenSidebarThreads({ projectGroups: [group] }).find((thread) => thread.chatId === chatId) ?? null : null
}

/** ChatSchedulesValue, less its Edit (the composer's prefill, the composer's to offer). */
export function chatSchedules(app: AppModel): { chatId: string | null; schedules: readonly ChatSchedule[] } {
  const chatId = routeChatId(app.route)
  const snapshot = app.chat && app.chat.chatId === chatId ? app.chat.snapshot : null
  return { chatId, schedules: snapshot?.runtime.schedules ?? [] }
}

/** The chat the main view shows as a transcript: the page is on it, and its route is its. */
export function isChatInMainView(app: AppModel, chatId: string): boolean {
  return app.stores.viewer.chatKey === chatId && routeChatId(app.route) === chatId
}

const viewer = (message: ViewerStore.Message) => AppAction.Store({ message: Stores.Message.GotViewerMessage({ message }) })
const navigate = (chatId: string) => AppAction.Navigate({ path: `/chat/${chatId}`, replace: false })

/**
 * useOpenChat: a chat opened from inside this one goes to the previewer
 * beside it, whatever it is to it; `target: "tab"` skips the previewer;
 * `newTab` (Cmd/Ctrl or the middle button) gives it a tab instead. A jump to
 * a message is the router's (see the slice report): not carried here.
 */
export function openChatActions(app: AppModel, chatId: string, options: { from?: "page" | "preview"; target?: "tab"; newTab?: boolean } = {}): AppAction[] {
  const store = app.stores.viewer
  const pageChatId = store.chatKey || null
  const current = ViewerStore.chatViewer({ viewer: store, rightSidebar: app.stores.rightSidebar })
  const item = current?.item
  const preview = item?.kind === "chat" ? { chatId: item.chatId, back: item.back ?? [] } : null

  if (options.target === "tab") {
    return [
      ...(preview?.chatId === chatId ? [viewer(ViewerStore.Message.ClosedViewer({ byKey: false }))] : []),
      ...(!isChatInMainView(app, chatId) ? [navigate(chatId)] : []),
    ]
  }

  const action = resolveChatOpen({
    chatId,
    pageChatId,
    pageShowsTranscript: pageChatId !== null && isChatInMainView(app, pageChatId),
    preview,
    from: options.from ?? "page",
    newTab: options.newTab ?? false,
    tabsEnabled: app.stores.appSettings.settings?.chatTabsEnabled === true,
    canPreview: store.chatPreviewHosts > 0,
  })
  switch (action.kind) {
    case "background-tab":
      return [AppAction.Store({ message: Stores.Message.GotChatTabsMessage({ message: ChatTabs.Message.OpenedTab({ chatId, afterChatId: pageChatId }) }) })]
    case "close-preview":
      return [viewer(ViewerStore.Message.ClosedViewer({ byKey: false }))]
    case "stay":
      return []
    case "preview": {
      const inPane = options.from === "preview"
      const delegated = !inPane ? undefined : item?.kind === "delegated" ? item.chatId : item?.kind === "chat" ? item.delegated : undefined
      return [viewer(ViewerStore.Message.OpenedItem({
        item: { kind: "chat", chatId, ...(action.back.length > 0 ? { back: action.back } : {}), ...(delegated ? { delegated } : {}) },
        expanded: false,
        byKey: false,
      }))]
    }
    case "navigate":
      return [navigate(chatId)]
  }
}

// THE TWO WAYS TO OPEN A CHAT (ChatOpenMenuItems)

export const OPEN_IN_PREVIEW = "chat-open:preview"
export const OPEN_IN_TAB = "chat-open:tab"

/**
 * At the head of a chat's right-click menu wherever it is shown inside
 * another chat: in the previewer, and in the main view. None for the chat
 * the main view already shows, which neither can open further; none in the
 * previewer for the page's own chat.
 */
export function chatOpenMenuEntries(app: AppModel, chatId: string): ContextMenu.MenuEntry[] {
  if (isChatInMainView(app, chatId)) return []
  const isPageChat = app.stores.viewer.chatKey === chatId
  return [
    ...(isPageChat ? [] : [ContextMenu.item({ value: OPEN_IN_PREVIEW })]),
    ContextMenu.item({ value: OPEN_IN_TAB }),
  ]
}

export function renderChatOpenMenuItem<Message>(value: string, app: AppModel, h: HtmlBuilder<Message>): ReadonlyArray<Child> | null {
  if (value === OPEN_IN_PREVIEW) {
    return [PanelRight({ class: "size-3.5" }, h), h.span([h.Class("text-xs font-medium")], ["Open in Preview"])]
  }
  if (value === OPEN_IN_TAB) {
    const tabs = app.stores.appSettings.settings?.chatTabsEnabled === true
    return [SquareArrowOutUpRight({ class: "size-3.5" }, h), h.span([h.Class("text-xs font-medium")], [tabs ? "Open in Tab" : "Open Chat"])]
  }
  return null
}

/** What choosing one asks for, or null for a value that isn't one of them. */
export function chooseChatOpenMenuItem(value: string, app: AppModel, chatId: string): AppAction[] | null {
  if (value === OPEN_IN_PREVIEW) return openChatActions(app, chatId)
  if (value === OPEN_IN_TAB) return openChatActions(app, chatId, { target: "tab" })
  return null
}
