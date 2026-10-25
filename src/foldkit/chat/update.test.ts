import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { fromString } from "foldkit/url"
import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as ChatSession from "../core/chatSession"
import { memoryStorage } from "../core/stores/testing"
import { Message, type Watch } from "./message"
import { init } from "./model"
import { routeDelegatedSend, routeLocalLink, update } from "./update"
import { pageFacts } from "./page"
import { watchOf } from "./view"

// The chat page's update: what it asks of the root and the socket as the
// page opens, as the navbar is used, as tabs close, and as the new chat page
// hands a message to a delegator.

function row(chatId: string, title: string, extra: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title,
    status: "idle",
    unread: false,
    localPath: "/work/tidepool",
    provider: "claude",
    lastMessageAt: 1_000,
    canFork: true,
    ...extra,
  } as SidebarChatRow
}

function group(chats: SidebarChatRow[]): SidebarProjectGroup {
  return { groupKey: "p1", title: "tidepool", realTitle: "tidepool", localPath: "/work/tidepool", chats, archivedChats: [] } as unknown as SidebarProjectGroup
}

function boot(path: string, chats: SidebarChatRow[] = [row("c1", "Fix the tide chart"), row("c2", "Deploys")]): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  const app = initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
  const data: SidebarData = { projectGroups: [group(chats)] }
  return { ...app, stores: { ...app.stores, sidebar: { ...app.stores.sidebar, data, ready: true } } }
}

function watch(app: AppModel, viewportWidth = 1440): Watch {
  return watchOf(pageFacts(app, viewportWidth, false))
}

const names = (result: { commands?: ReadonlyArray<{ name: string }> }) => (result.commands ?? []).map((command) => command.name)

describe("chat page: opening", () => {
  test("a fresh page reads the project's quick actions, then refreshes its diffs, and hands the viewer the chat", () => {
    const app = boot("/chat/c1")
    const opened = update({ ...init(), viewportWidth: 1440 }, Message.ObservedPage({ watch: watch(app), fresh: true }), app)
    expect(names(opened)).toEqual(["ReadProjectQuickActions", "RefreshChatDiffs", "DispatchChatPageAppAction"])
    expect(opened.outMessage?.action._tag).toBe("Store")
  })

  test("another chat of the same project reads nothing again", () => {
    const app = boot("/chat/c1")
    const first = update({ ...init(), viewportWidth: 1440 }, Message.ObservedPage({ watch: watch(app), fresh: true }), app).model
    const next = boot("/chat/c2")
    const second = update(first, Message.ObservedPage({ watch: watch(next), fresh: false }), next)
    expect(names(second)).not.toContain("ReadProjectQuickActions")
    expect(names(second)).not.toContain("RefreshChatDiffs")
  })

  test("the page's presence follows its view, by the token of each showing", () => {
    const app = boot("/chat/c1")
    const entered = update(init(), Message.EnteredPage({ token: 3 }), app).model
    expect(entered.presence).toBe(3)
    // A late leave from an earlier showing changes nothing.
    expect(update(entered, Message.LeftPage({ token: 2 }), app).model.presence).toBe(3)
    expect(update(entered, Message.LeftPage({ token: 3 }), app).model.presence).toBeNull()
  })
})

describe("chat page: navbar", () => {
  test("the widgets toggle and its shortcut ask the right sidebar store to toggle", () => {
    const app = boot("/chat/c1")
    const clicked = update(init(), Message.ClickedToggleWidgets(), app)
    const action = clicked.outMessage?.action
    expect(action?._tag).toBe("Store")
    const byKey = update(init(), Message.PressedShortcut({ action: "toggleRightSidebar" }), app)
    expect(byKey.outMessage?.action).toEqual(action!)
  })

  test("Share chat asks the root to share the open chat", () => {
    const app = boot("/chat/c1")
    const shared = update(init(), Message.ClickedShareChat(), app)
    expect(shared.outMessage?.action).toEqual(AppAction.ShareChat({ chatId: "c1" }))
  })

  test("renaming in place: Enter renames once, Escape drops the draft", () => {
    const base = boot("/chat/c1")
    const session = ChatSession.init("c1", { windowSize: 50, starting: false }).model
    const snapshot = { runtime: { chatId: "c1", projectId: "p1", title: "Fix the tide chart", status: "idle", localPath: "/work/tidepool" }, messages: [], queuedMessages: [] }
    const app: AppModel = { ...base, chat: { ...session, snapshot: snapshot as never } }
    const editing = update(init(), Message.ClickedTitle(), app).model
    expect(editing.title.draft).toBe("Fix the tide chart")
    const typed = update(editing, Message.ChangedTitleDraft({ value: "  Tide chart in Safari " }), app).model
    const saved = update(typed, Message.PressedTitleInputKey({ key: "Enter" }), app)
    expect(names(saved)).toEqual(["RenameChatInPlace"])
    expect(saved.model.title).toEqual({ draft: null, submitted: "Tide chart in Safari", submittedOver: "Fix the tide chart" })
    // The blur that follows the field's removal saves nothing more.
    expect(names(update(saved.model, Message.BlurredTitle(), app))).toEqual([])

    const escaped = update(typed, Message.PressedTitleInputKey({ key: "Escape" }), app)
    expect(names(escaped)).toEqual([])
    expect(escaped.model.title.draft).toBeNull()
  })

  test("a delegator's list button opens its pane, and shuts it when open", () => {
    const app = boot("/chat/c1")
    const opened = update(init(), Message.ClickedDelegatedList({ chatId: "c1", overlay: false }), app)
    const message = opened.outMessage?.action._tag === "Store" ? opened.outMessage.action.message : null
    expect(message?._tag).toBe("GotViewerMessage")
  })
})

describe("chat page: tabs", () => {
  function withTabs(app: AppModel, tabs: string[], recent: string[]): AppModel {
    return { ...app, stores: { ...app.stores, chatTabs: { tabs: tabs.map((chatId) => ({ chatId })), recentChatIds: recent } } }
  }

  test("closing the open tab goes back to the one you were on before it", () => {
    const app = withTabs(boot("/chat/c1"), ["c1", "c2", "c3"], ["c1", "c3"])
    const closed = update(init(), Message.ClickedCloseTab({ chatId: "c1" }), app)
    expect(closed.outMessage?.action._tag).toBe("Store")
    expect(names(closed)).toEqual(["DispatchChatPageAppAction"])
    const queued = closed.commands?.[0] as unknown as { args: { action: AppAction } }
    expect(queued.args.action).toEqual(AppAction.Navigate({ path: "/chat/c3", replace: false }))
  })

  test("closing another tab stays on the open chat", () => {
    const app = withTabs(boot("/chat/c1"), ["c1", "c2"], ["c1"])
    const closed = update(init(), Message.ClickedCloseTab({ chatId: "c2" }), app)
    expect(names(closed)).toEqual([])
  })

  test("the next-tab shortcut wraps along the bar", () => {
    const app = withTabs(boot("/chat/c2"), ["c1", "c2"], ["c2"])
    const next = update(init(), Message.PressedTabShortcut({ shortcut: "next" }), app)
    expect(next.outMessage?.action).toEqual(AppAction.Navigate({ path: "/chat/c1", replace: false }))
  })

  test("a dropped drag reorders the tabs; one dropped in place changes nothing", () => {
    const app = withTabs(boot("/chat/c1"), ["c1", "c2", "c3"], ["c1"])
    const dragging = update(init(), Message.StartedTabDrag({ chatId: "c1", fromIndex: 0, width: 120 }), app).model
    const moved = update(dragging, Message.MovedTabDrag({ dx: 260, overIndex: 2 }), app).model
    const dropped = update(moved, Message.DroppedTab(), app)
    expect(dropped.model.tabDrag).toBeNull()
    const action = dropped.outMessage?.action
    expect(action?._tag === "Store" && action.message._tag === "GotChatTabsMessage" ? action.message.message : null)
      .toEqual({ _tag: "ReorderedTabs", orderedChatIds: ["c2", "c3", "c1"] })
    const inPlace = update(dragging, Message.DroppedTab(), app)
    expect(inPlace.outMessage).toBeUndefined()
  })
})

describe("chat page: the viewer's split", () => {
  function withViewer(app: AppModel, open: boolean): AppModel {
    const viewers = open ? { c1: { item: { kind: "file", projectId: "p1", path: "src/units.ts" }, expanded: false } } : {}
    return {
      ...app,
      stores: {
        ...app.stores,
        viewer: { ...app.stores.viewer, chatKey: "c1" },
        rightSidebar: { ...app.stores.rightSidebar, chatViewers: viewers as never },
      },
    }
  }

  test("opening the pane slides it to its docked width; closing slides it shut; another chat snaps", () => {
    const closed = withViewer(boot("/chat/c1"), false)
    const measured = { ...init(), viewportWidth: 1440, layoutWidth: 1157, layoutHeight: 900 }
    const start = update(measured, Message.ObservedPage({ watch: watch(closed), fresh: true }), closed).model
    expect(start.viewerSplit).toEqual([100, 0])

    const opened = withViewer(boot("/chat/c1"), true)
    const opening = update(start, Message.ObservedPage({ watch: watch(opened), fresh: false }), opened).model
    const slide = opening.viewerPane.animation!
    expect(slide.from).toEqual([100, 0])
    expect(slide.to[1]).toBeGreaterThan(0)
    const landed = update(opening, Message.SteppedViewerSplit({ token: slide.token, chat: slide.to[0], viewer: slide.to[1], done: true }), opened).model
    expect(landed.viewerPane.animation).toBeNull()

    const closing = update(landed, Message.ObservedPage({ watch: watch(closed), fresh: false }), closed).model
    expect(closing.viewerPane.animation?.to).toEqual([100, 0])

    // A fresh page (another chat's arrival) takes its layout in one step.
    const elsewhere = update(measured, Message.ObservedPage({ watch: watch(opened), fresh: true }), opened).model
    expect(elsewhere.viewerPane.animation).toBeNull()
    expect(elsewhere.viewerSplit[1]).toBeGreaterThan(0)
  })
})

describe("chat page: file links", () => {
  const openLink = (path: string, trigger: "click" | "contextmenu" = "click") => ({
    model: init(),
    outMessage: { _tag: "RequestedAppAction" as const, action: AppAction.OpenLocalLink({ target: { path, trigger }, action: "open_editor", editor: null }) },
  })

  test("a file in this project opens in the viewer instead of the editor", () => {
    const app = boot("/chat/c1")
    const facts = pageFacts(app, 1440, false)
    const routed = routeLocalLink(openLink("/work/tidepool/src/units.ts") as never, facts)
    const action = routed.outMessage?.action
    const message = action?._tag === "Store" && action.message._tag === "GotViewerMessage" ? action.message.message : null
    expect(message?._tag).toBe("OpenedItem")
  })

  test("a file elsewhere, or a choice from the link's menu, goes where it always did", () => {
    const app = boot("/chat/c1")
    const facts = pageFacts(app, 1440, false)
    expect(routeLocalLink(openLink("/etc/hosts") as never, facts).outMessage?.action._tag).toBe("OpenLocalLink")
    expect(routeLocalLink(openLink("/work/tidepool/a.ts", "contextmenu") as never, facts).outMessage?.action._tag).toBe("OpenLocalLink")
  })
})

describe("chat page: delegating from the new chat page", () => {
  const delegator = row("d1", "Release manager", { delegator: true } as Partial<SidebarChatRow>)
  const fresh = row("c9", "New Chat", { lastMessageAt: undefined } as Partial<SidebarChatRow>)

  function newChatPage(): AppModel {
    const base = boot("/chat/c9", [fresh, delegator])
    const session = ChatSession.init("c9", { windowSize: 50, starting: false }).model
    const snapshot = { runtime: { chatId: "c9", projectId: "p1", title: "New Chat", status: "idle", localPath: "/work/tidepool" }, messages: [], queuedMessages: [] }
    return { ...base, chat: { ...session, snapshot: snapshot as never } }
  }

  test("the composer's send goes to the delegator instead of the page's chat", () => {
    const app = newChatPage()
    const facts = pageFacts(app, 1440, false)
    expect(facts.showEmptyState).toBe(true)
    const submitted = { model: init(), outMessage: { _tag: "RequestedAppAction" as const, action: AppAction.Chat({ message: ChatSession.Message.SubmittedMessage({ content: "ship it", options: {} }) }) } }
    const routed = routeDelegatedSend(submitted as never, app, facts)
    expect(routed.outMessage).toBeUndefined()
    expect(names(routed)).toEqual(["StampDelegatedSend"])
  })

  test("sent, the page follows the message to the delegator and remembers it", () => {
    const app = newChatPage()
    const sent = update(init(), Message.SucceededDelegatedSend({ chatId: "d1" }), app)
    expect(sent.outMessage?.action._tag).toBe("Store")
    const queued = sent.commands?.[0] as unknown as { args: { action: AppAction } }
    expect(queued.args.action).toEqual(AppAction.Navigate({ path: "/chat/d1", replace: false }))
  })
})
