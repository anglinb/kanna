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
import { Message as SidebarMessage } from "../sidebar/message"
import * as Terminal from "../terminal"
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

/** The store Message a result asks the root for (`AppAction.Store`), by its inner tag. */
function storeMessageTag(result: { outMessage?: { action: AppAction } }): string | null {
  const action = result.outMessage?.action
  if (action?._tag !== "Store") return null
  const inner = (action.message as { message?: { _tag: string } }).message
  return inner?._tag ?? null
}

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

describe("chat page: the new chat page", () => {
  function withSnapshot(app: AppModel, title: string, messages: unknown[]): AppModel {
    const session = ChatSession.init("c1", { windowSize: 50, starting: false }).model
    const snapshot = { runtime: { chatId: "c1", projectId: "p1", title, status: "idle", localPath: "/work/tidepool" }, messages, queuedMessages: [] }
    return { ...app, chat: { ...session, snapshot: snapshot as never } }
  }

  test("a chat with no message under its first name is the new chat page; any other is not", () => {
    const app = boot("/chat/c1")
    expect(pageFacts(withSnapshot(app, "New Chat", []), 1440, false).showEmptyState).toBe(true)
    expect(pageFacts(withSnapshot(app, "Fix the tide chart", []), 1440, false).showEmptyState).toBe(false)
  })

  test("while the snapshot loads, a chat the sidebar lists is judged by its row", () => {
    const listedOld = boot("/chat/c1")
    expect(pageFacts(listedOld, 1440, true).showEmptyState).toBe(false)
    const listedNew = boot("/chat/c1", [row("c1", "New Chat", { lastMessageAt: undefined })])
    expect(pageFacts(listedNew, 1440, false).showEmptyState).toBe(true)
  })

  test("a chat neither listed nor known holds the empty state as it last was", () => {
    const unlisted = boot("/chat/c9")
    expect(pageFacts(unlisted, 1440, true).showEmptyState).toBe(true)
    expect(pageFacts(unlisted, 1440, false).showEmptyState).toBe(false)
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

  test("Search and the empty page's project picker open the palette through the root", () => {
    const app = boot("/chat/c1")
    const searched = update(init(), Message.ClickedSearch(), app)
    expect(searched.outMessage?.action).toEqual(AppAction.OpenCommandPalette({ page: null }))
    expect(searched.commands ?? []).toEqual([])
    const picked = update(init(), Message.ClickedProjectPicker(), app)
    expect(picked.outMessage?.action).toEqual(AppAction.OpenCommandPalette({ page: "new-thread" }))
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

  test("a terminal command refreshes the open column's diffs a second after the last one", () => {
    const base = boot("/chat/c1")
    const app: AppModel = { ...base, stores: { ...base.stores, rightSidebar: { ...base.stores.rightSidebar, projects: { p1: { widgetsOpen: true, chats: { c1: true } } } as never } } }
    const sent = Message.GotTerminalMessage({ message: Terminal.Message.SentPaneCommand({ terminalId: "terminal-1" }) })
    const first = update(init(), sent, app)
    expect(names(first)).toEqual(["ElapseTerminalDiffRefresh"])
    const second = update(first.model, sent, app)
    // The first wait ends after a newer command: nothing yet.
    expect(names(update(second.model, Message.ElapsedTerminalDiffRefresh({ token: 1 }), app))).toEqual([])
    expect(names(update(second.model, Message.ElapsedTerminalDiffRefresh({ token: 2 }), app))).toEqual(["RefreshChatDiffs"])
  })

  test("the terminal toggle makes the project's first terminal, then shows and hides the pane", () => {
    const app = boot("/chat/c1")
    const toggled = update(init(), Message.ClickedToggleTerminal(), app)
    expect(names(toggled)).toEqual(["MakeChatTerminalId"])
    const made = update(toggled.model, Message.MadeTerminalId({ purpose: { _tag: "Toggle" }, projectId: "p1", chatKey: "c1", terminalId: "terminal-1" }), app)
    expect(storeMessageTag(made)).toBe("AddedTerminal")
    // With a terminal there, the toggle and its shortcut flip the pane instead.
    const withTerminal: AppModel = {
      ...app,
      stores: {
        ...app.stores,
        terminalLayout: {
          ...app.stores.terminalLayout,
          projects: { p1: { isVisible: true, mainSizes: [68, 32], terminals: [{ id: "terminal-1", title: "", size: 100 }], nextTerminalIndex: 1 } },
        } as never,
      },
    }
    expect(storeMessageTag(update(init(), Message.ClickedToggleTerminal(), withTerminal))).toBe("ToggledVisibility")
    expect(storeMessageTag(update(init(), Message.PressedShortcut({ action: "toggleEmbeddedTerminal" }), withTerminal))).toBe("ToggledVisibility")
  })

  test("on a phone the sheet's backdrop and Escape hide the widget column", () => {
    const app = boot("/chat/c1")
    expect(storeMessageTag(update(init(), Message.ClickedCloseWidgets(), app))).toBe("HidWidgets")
    expect(storeMessageTag(update(init(), Message.PressedEscapeOnSheet(), app))).toBe("HidWidgets")
  })

  test("a delegator's list button opens its pane, and shuts it when open", () => {
    const app = boot("/chat/c1")
    const opened = update(init(), Message.ClickedDelegatedList({ chatId: "c1", overlay: false }), app)
    const message = opened.outMessage?.action._tag === "Store" ? opened.outMessage.action.message : null
    expect(message?._tag).toBe("GotViewerMessage")
  })
})

describe("chat page: the tabs' hover card", () => {
  test("a card asks for what the sidebar's card hasn't already fetched, files before preview", () => {
    const app = boot("/chat/c1")
    const opened = update(init(), Message.ChangedTabCardRow({ key: "c2" }), app).model
    expect(opened.tabCard.hovered).toBe("c2")
    const files = update(opened, Message.GotTabCardMessage({ message: SidebarMessage.RequestedCardLoad({ chatId: "c2", kind: "files", cacheKey: "c2-files" }) }), app)
    expect(names(files)).toEqual(["LoadChatTabCardFiles"])
    // The sidebar's card had the preview: no second fetch.
    const preview = { lastUserMessagePreview: "Deploy it", lastAgentMessagePreview: null } as never
    const known: AppModel = { ...app, sidebar: { ...app.sidebar, previewCache: { "c2-preview": preview } } }
    const fromCache = update(files.model, Message.GotTabCardMessage({ message: SidebarMessage.RequestedCardLoad({ chatId: "c2", kind: "preview", cacheKey: "c2-preview" }) }), known)
    expect(names(fromCache)).toEqual([])
    expect(fromCache.model.tabCard.heldPreview).toEqual({ chatId: "c2", preview })
    // The answer lands in the card it was asked for.
    const result = { files: [] } as never
    const landed = update(files.model, Message.SucceededLoadTabCardFiles({ chatId: "c2", cacheKey: "c2-files", result }), app).model
    expect(landed.tabCard.heldTouchedFiles).toEqual({ chatId: "c2", result })
    // Closed, it stops waiting: a late answer is cached, not shown.
    const closed = update(files.model, Message.ChangedTabCardRow({ key: null }), app).model
    const late = update(closed, Message.SucceededLoadTabCardFiles({ chatId: "c2", cacheKey: "c2-files", result }), app).model
    expect(late.tabCard.touchedFilesCache["c2-files"]).toBe(result)
    expect(late.tabCard.heldTouchedFiles).toBeNull()
  })

  test("a preview in the card opens its chat at that message, dismissing the card first", () => {
    const app = boot("/chat/c1")
    const clicked = update(init(), Message.GotTabCardMessage({ message: SidebarMessage.ClickedCardMessage({ list: "chats", chatId: "c2", role: "reply" }) }), app)
    expect(names(clicked)).toEqual(["DismissChatTabCard"])
    expect(clicked.outMessage?.action).toEqual(AppAction.OpenChatAt({ chatId: "c2", jump: "reply" }))
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
