import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Story } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { AppSettingsSnapshot, SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as ChatTabs from "../core/stores/chatTabs"
import * as FocusMode from "../core/stores/focusMode"
import * as SidebarSection from "../core/stores/sidebarSection"
import * as SidebarView from "../core/stores/sidebarView"
import { memoryStorage } from "../core/stores/testing"
import * as ContextMenu from "../ui/context-menu"
import { Message } from "./message"
import { init, type Model } from "./model"
import { LoadTouchedFiles, SaveSidebarWidth, update } from "./update"

function row(chatId: string, overrides: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: `Chat ${chatId}`,
    status: "idle",
    unread: false,
    localPath: "/repo/p1",
    provider: "claude",
    hasAutomation: false,
    lastMessageAt: 1_000,
    canFork: true,
    ...overrides,
  }
}

function group(groupKey: string, chats: SidebarChatRow[], overrides: Partial<SidebarProjectGroup> = {}): SidebarProjectGroup {
  return {
    groupKey,
    title: groupKey,
    realTitle: groupKey,
    localPath: `/repo/${groupKey}`,
    chats,
    previewChats: chats,
    olderChats: [],
    defaultCollapsed: false,
    ...overrides,
  }
}

const DATA: SidebarData = {
  projectGroups: [
    group("p1", [row("c1"), row("c2", { pinnedAt: 5 })]),
    group("p2", [row("c3", { localPath: "/repo/p2" })], { defaultCollapsed: true }),
  ],
}

function appAt(path: string, options: { settings?: Partial<AppSettingsSnapshot> } = {}): AppModel {
  const flags: Flags = {
    sidebarCollapsed: false,
    systemTheme: "dark",
    initialAppSettings: null,
    stores: Stores.load(memoryStorage()),
  }
  const app = initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
  return {
    ...app,
    stores: {
      ...app.stores,
      sidebar: { ...app.stores.sidebar, data: DATA, ready: true },
      appSettings: { ...app.stores.appSettings, settings: (options.settings ?? null) as AppSettingsSnapshot | null },
    },
  }
}

const sidebar = init(memoryStorage())
const asks = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })
const store = (message: Stores.Message) => asks(AppAction.Store({ message }))
const updateFor = (app: AppModel) => (model: Model, message: Message) => update(model, message, app)

describe("sidebar: chats", () => {
  test("a click on a chat opens it", () => {
    Story.story(
      updateFor(appAt("/settings/general")),
      Story.given(sidebar),
      Story.message(Message.ClickedChat({ chatId: "c1", archived: false })),
      Story.expectOutMessage(asks(AppAction.Navigate({ path: "/chat/c1", replace: false }))),
    )
  })

  test("with chat tabs on, a Cmd-click opens a tab and stays put", () => {
    Story.story(
      updateFor(appAt("/chat/c2", { settings: { chatTabsEnabled: true } })),
      Story.given(sidebar),
      Story.message(Message.PressedChatInBackground({ chatId: "c1" })),
      Story.message(Message.ClickedChat({ chatId: "c1", archived: false })),
      Story.expectOutMessage(store(Stores.Message.GotChatTabsMessage({ message: ChatTabs.Message.OpenedTab({ chatId: "c1", afterChatId: "c2" }) }))),
      Story.model((model) => expect(model.backgroundClickChatId).toBeNull()),
    )
  })

  test("an archived chat opens read-only", () => {
    Story.story(
      updateFor(appAt("/home")),
      Story.given(sidebar),
      Story.message(Message.ClickedChat({ chatId: "c1", archived: true })),
      Story.expectOutMessage(asks(AppAction.OpenArchivedChat({ chatId: "c1" }))),
    )
  })

  test("restoring leaves the Archived view first, then restores", () => {
    const app = appAt("/home")
    const first = update(sidebar, Message.ClickedRestoreChat({ chatId: "c1" }), app)
    expect(first.outMessage).toEqual(store(Stores.Message.GotSidebarViewMessage({ message: SidebarView.Message.LeftArchived() })))
    expect(first.commands?.map((command) => command.name)).toEqual(["SidebarContinueActions"])
    const second = update(first.model, Message.ContinuedActions({ actions: [AppAction.RestoreChat({ chatId: "c1" })] }), app)
    expect(second.outMessage).toEqual(asks(AppAction.RestoreChat({ chatId: "c1" })))
    expect(second.commands ?? []).toEqual([])
  })

  test("a section's toggle flips it against its current state", () => {
    Story.story(
      updateFor(appAt("/home")),
      Story.given(sidebar),
      Story.message(Message.ToggledSection({ scope: "chats", sectionKey: "relevant", expanded: false })),
      Story.expectOutMessage(store(Stores.Message.GotSidebarSectionMessage({
        message: SidebarSection.Message.ChangedSectionExpanded({ scope: "chats", sectionKey: "relevant", expanded: false }),
      }))),
    )
  })
})

describe("sidebar: header and navigation", () => {
  test("New Chat composes; on a project's page it starts a chat there", () => {
    Story.story(
      updateFor(appAt("/home")),
      Story.given(sidebar),
      Story.message(Message.ClickedNewChat()),
      Story.expectOutMessage(asks(AppAction.Compose())),
    )
    Story.story(
      updateFor(appAt("/project/p2")),
      Story.given(sidebar),
      Story.message(Message.ClickedNewChat()),
      Story.expectOutMessage(asks(AppAction.CreateChat({ projectId: "p2" }))),
    )
  })

  test("leaving focus mode turns it off; on a project's page it goes back instead", () => {
    Story.story(
      updateFor(appAt("/chat/c1")),
      Story.given(sidebar),
      Story.message(Message.ClickedExitFocus()),
      Story.expectOutMessage(store(Stores.Message.GotFocusModeMessage({ message: FocusMode.Message.ChangedFocusMode({ enabled: false }) }))),
    )
    const onProject = update(sidebar, Message.ClickedExitFocus(), appAt("/project/p1"))
    expect(onProject.commands?.map((command) => command.name)).toEqual(["SidebarLeaveProjectPage"])
    const noHistory = update(sidebar, Message.FoundNoHistoryToLeave(), appAt("/project/p1"))
    expect(noHistory.outMessage).toEqual(asks(AppAction.Navigate({ path: "/", replace: true })))
  })

  test("the number jump opens the chat it names; the create shortcut needs a current project", () => {
    Story.story(
      updateFor(appAt("/home")),
      Story.given(sidebar),
      Story.message(Message.PressedJumpShortcut({ chatId: "c3" })),
      Story.expectOutMessage(asks(AppAction.Navigate({ path: "/chat/c3", replace: false }))),
    )
    expect(update(sidebar, Message.PressedCreateChatShortcut(), appAt("/settings/general")).outMessage).toBeUndefined()
    expect(update(sidebar, Message.PressedCreateChatShortcut(), appAt("/chat/c3")).outMessage)
      .toEqual(asks(AppAction.CreateChat({ projectId: "p2" })))
  })
})

describe("sidebar: resizing", () => {
  test("follows the pointer within its bounds, and saves on release", () => {
    Story.story(
      updateFor(appAt("/home")),
      Story.given({ ...sidebar, sidebarWidth: 275 }),
      Story.message(Message.PressedResizeHandle({ pointerX: 300 })),
      Story.message(Message.MovedResize({ pointerX: 340 })),
      Story.model((model) => expect(model.sidebarWidth).toBe(315)),
      Story.message(Message.MovedResize({ pointerX: 0 })),
      Story.model((model) => expect(model.sidebarWidth).toBe(220)),
      Story.message(Message.ReleasedResize()),
      Story.Command.expectHas(SaveSidebarWidth),
      Story.Command.resolve(SaveSidebarWidth, Message.CompletedSideEffect()),
      Story.model((model) => expect(model.resizeStart).toBeNull()),
    )
  })

  test("the keyboard steps 16px; Enter and a double click reset", () => {
    const app = appAt("/home")
    expect(update({ ...sidebar, sidebarWidth: 275 }, Message.PressedResizeKey({ key: "ArrowRight" }), app).model.sidebarWidth).toBe(291)
    expect(update({ ...sidebar, sidebarWidth: 300 }, Message.PressedResizeKey({ key: "Enter" }), app).model.sidebarWidth).toBe(275)
    expect(update({ ...sidebar, sidebarWidth: 300 }, Message.PressedResizeKey({ key: "Tab" }), app).commands ?? []).toEqual([])
    expect(update({ ...sidebar, sidebarWidth: 300 }, Message.DoubleClickedResizeHandle(), app).model.sidebarWidth).toBe(275)
  })
})

describe("sidebar: Projects view", () => {
  test("a header folds and unfolds its group, from its default", () => {
    const app = appAt("/home")
    const folded = update(sidebar, Message.ToggledProjectGroup({ projectId: "p1" }), app).model
    expect(folded.projectFolds).toEqual({ p1: true })
    // p2 starts folded (defaultCollapsed): the first click opens it.
    const opened = update(sidebar, Message.ToggledProjectGroup({ projectId: "p2" }), app).model
    expect(opened.projectFolds).toEqual({ p2: false })
  })

  test("dropping a dragged group on another reorders; a press without a drag doesn't", () => {
    const app = appAt("/home", { settings: { newSidebarEnabled: false } })
    const pressed = update(sidebar, Message.PressedProjectHeader({ projectId: "p2", pointerId: 1, y: 100 }), app).model
    const released = update(pressed, Message.ReleasedProjectDrag(), app)
    expect(released.outMessage).toBeUndefined()
    const active = update(pressed, Message.ActivatedProjectDrag({ activeHeight: 40 }), app).model
    const moved = update(active, Message.MovedProjectDrag({ deltaY: -60, overId: "p1" }), app).model
    const dropped = update(moved, Message.ReleasedProjectDrag(), app)
    expect(dropped.outMessage).toEqual(asks(AppAction.ReorderProjectGroups({ projectIds: ["p2", "p1"] })))
    expect(dropped.model.projectDrag).toBeNull()
  })
})

describe("sidebar: the right-click menu", () => {
  const openOn = (target: Parameters<typeof Message.RequestedMenu>[0]["target"], app: AppModel) => {
    const pressed = update(sidebar, Message.PressedMenuTrigger({ target, pointerType: "mouse", button: 2, x: 10, y: 20 }), app).model
    return update(pressed, Message.RequestedMenu({ target }), app).model
  }
  const choose = (model: Model, value: string, app: AppModel) =>
    update(model, Message.GotRowMenuMessage({ message: ContextMenu.Message.ChoseItem({ value }) }), app)

  test("opens at the pointer for what was right-clicked", () => {
    const app = appAt("/home")
    const open = openOn({ _tag: "Chat", chatId: "c1", archived: false, inCard: false }, app)
    expect(open.rowMenu.phase).toBe("Open")
    expect(open.rowMenu.point).toEqual({ x: 10, y: 20 })
    expect(open.menuTarget).toEqual({ _tag: "Chat", chatId: "c1", archived: false, inCard: false })
  })

  test("a chat's items ask the root for their action", () => {
    const app = appAt("/home")
    const open = openOn({ _tag: "Chat", chatId: "c2", archived: false, inCard: false }, app)
    expect(choose(open, "rename", app).outMessage).toEqual(asks(AppAction.RenameChat({ chatId: "c2", title: "Chat c2" })))
    expect(choose(open, "pin", app).outMessage).toEqual(asks(AppAction.TogglePinChat({ chatId: "c2", pinned: false })))
    expect(choose(open, "new-chat", app).outMessage).toEqual(asks(AppAction.CreateChat({ projectId: "p1" })))
    expect(choose(open, "delete", app).outMessage).toEqual(asks(AppAction.DeleteChat({ chatId: "c2", title: "Chat c2" })))
    expect(choose(open, "archive", app).model.rowMenu.phase).toBe("Closed")
  })

  test("a project's Show Archived opens its dialog", () => {
    const app = appAt("/home")
    const open = openOn({ _tag: "Project", projectId: "p2", channel: false }, app)
    const chosen = choose(open, "show-archived", app).model
    expect(chosen.archivedProjectId).toBe("p2")
    expect(chosen.archivedDialog.phase).toBe("Open")
  })

  test("Archive All archives each chat in turn", () => {
    const app = appAt("/home")
    const open = openOn({ _tag: "Section", chatIds: ["c1", "c2"] }, app)
    const first = choose(open, "archive-all", app)
    expect(first.outMessage).toEqual(asks(AppAction.ArchiveChat({ chatId: "c1" })))
    const second = update(first.model, Message.ContinuedActions({ actions: [AppAction.ArchiveChat({ chatId: "c2" })] }), app)
    expect(second.outMessage).toEqual(asks(AppAction.ArchiveChat({ chatId: "c2" })))
  })
})

describe("sidebar: hover cards", () => {
  test("a card asks for what the cache lacks, and keeps the answer", () => {
    Story.story(
      updateFor(appAt("/home")),
      Story.given(sidebar),
      Story.message(Message.RequestedCardLoad({ chatId: "c1", kind: "files", cacheKey: "k1" })),
      Story.Command.expectHas(LoadTouchedFiles),
      Story.Command.resolve(LoadTouchedFiles, Message.SucceededLoadTouchedFiles({ chatId: "c1", cacheKey: "k1", result: { files: [], totalCount: 0 } })),
      Story.model((model) => {
        expect(model.touchedFilesCache["k1"]).toEqual({ files: [], totalCount: 0 })
        expect(model.heldTouchedFiles?.chatId).toBe("c1")
      }),
      Story.message(Message.RequestedCardLoad({ chatId: "c1", kind: "files", cacheKey: "k1" })),
      Story.Command.expectNone(),
    )
  })

  test("a channel click opens its new chat with a mouse, and its page on touch", () => {
    const app = appAt("/home")
    expect(update({ ...sidebar, hasFinePointer: true }, Message.ClickedChannel({ projectId: "p1" }), app).outMessage)
      .toEqual(asks(AppAction.OpenProjectNewChat({ projectId: "p1" })))
    expect(update({ ...sidebar, hasFinePointer: false }, Message.ClickedChannel({ projectId: "p1" }), app).outMessage)
      .toEqual(asks(AppAction.Navigate({ path: "/project/p1", replace: false })))
  })

  test("Show more pins the channel's card; closing it unpins", () => {
    const app = appAt("/home")
    const pinned = update(sidebar, Message.ClickedPeekShowMore({ projectId: "p1" }), app).model
    expect(pinned.pinnedChannelId).toBe("p1")
    const closed = update(pinned, Message.DismissedChannelCard(), app)
    expect(closed.model.pinnedChannelId).toBeNull()
    expect(closed.commands?.map((command) => command.name)).toEqual(["SyncHoverTracker"])
  })
})
