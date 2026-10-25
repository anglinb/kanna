import { describe, test } from "bun:test"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { Scene } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { AppAction } from "../app/action"
import { SliceOutMessage } from "../app/slice"
import * as ChatTabs from "../core/stores/chatTabs"
import type { Flags, Model as AppModel } from "../app/model"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as ChatSession from "../core/chatSession"
import { memoryStorage } from "../core/stores/testing"
import { chatTabsView, TabListMount } from "./chatTabs"
import { Message } from "./message"
import { init, type Model } from "./model"
import { editableTitleView, navbarTitleView, TitleInputMount } from "./navbar"
import { pageFacts } from "./page"
import { RenameChat } from "./effects"
import { update } from "./update"

// Scenes for the navbar's left end: the chat's title renamed in place, and
// the tabs that stand in for it with Chat Tabs on.

function row(chatId: string, title: string): SidebarChatRow {
  return { _id: chatId, _creationTime: 1, chatId, title, status: "idle", unread: false, localPath: "/work/tidepool", provider: "claude", lastMessageAt: 1_000, canFork: true } as SidebarChatRow
}

function app(path: string, tabs: string[] = []): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  const base = initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
  const group = { groupKey: "p1", title: "tidepool", realTitle: "tidepool", localPath: "/work/tidepool", chats: [row("c1", "Fix the tide chart"), row("c2", "Deploys")], archivedChats: [] } as unknown as SidebarProjectGroup
  const data: SidebarData = { projectGroups: [group] }
  const session = ChatSession.init("c1", { windowSize: 50, starting: false }).model
  const snapshot = { runtime: { chatId: "c1", projectId: "p1", title: "Fix the tide chart", status: "idle", localPath: "/work/tidepool" }, messages: [], queuedMessages: [] }
  return {
    ...base,
    chat: { ...session, snapshot: snapshot as never },
    stores: {
      ...base.stores,
      sidebar: { ...base.stores.sidebar, data, ready: true },
      chatTabs: { tabs: tabs.map((chatId) => ({ chatId })), recentChatIds: [] },
    },
  }
}

describe("navbar title", () => {
  const root = app("/chat/c1")
  const facts = pageFacts(root, 1440, false)
  const view = (model: Model, h: HtmlBuilder<Message>) => h.main([], [navbarTitleView(model, root, facts, "Fix the tide chart", "main", h)])

  test("Scene: renaming in place, Enter keeps the new name", () => {
    Scene.scene(
      { update: (model: Model, message: Message) => update(model, message, root), view },
      Scene.given(init()),
      Scene.expect(Scene.role("button", { name: "Chat actions" })).toExist(),
      Scene.expect(Scene.role("button", { name: "tidepool" })).toHaveAttr("title", "Show in Finder"),
      Scene.click(Scene.role("button", { name: "Fix the tide chart" })),
      Scene.expect(Scene.role("textbox", { name: "Chat title" })).toExist(),
      Scene.Mount.resolve(TitleInputMount, Message.CompletedSideEffect()),
      Scene.type(Scene.role("textbox", { name: "Chat title" }), "Tide chart in Safari"),
      Scene.keydown(Scene.role("textbox", { name: "Chat title" }), "Enter"),
      Scene.Command.resolve(RenameChat, Message.CompletedSideEffect()),
      Scene.expect(Scene.role("textbox", { name: "Chat title" })).toBeAbsent(),
      Scene.Mount.expectEnded(TitleInputMount),
      Scene.expect(Scene.role("button", { name: "Tide chart in Safari" })).toExist(),
    )
  })

  test("Scene: Escape drops what was typed", () => {
    Scene.scene(
      { update: (model: Model, message: Message) => update(model, message, root), view },
      Scene.given(init()),
      Scene.click(Scene.role("button", { name: "Fix the tide chart" })),
      Scene.Mount.resolve(TitleInputMount, Message.CompletedSideEffect()),
      Scene.type(Scene.role("textbox", { name: "Chat title" }), "Something else"),
      Scene.keydown(Scene.role("textbox", { name: "Chat title" }), "Escape"),
      Scene.expect(Scene.role("button", { name: "Fix the tide chart" })).toExist(),
      Scene.Mount.expectEnded(TitleInputMount),
      Scene.Command.expectNone(),
    )
  })
})

describe("chat tabs", () => {
  test("Scene: a tab per open chat; closing another stays, the open one's menu is there", () => {
    const root = app("/chat/c1", ["c2", "c1"])
    const view = (model: Model, h: HtmlBuilder<Message>) =>
      h.main([], [chatTabsView(model, root, "c1", "Cursor", (title) => editableTitleView(model, title, h), h)])
    Scene.scene(
      { update: (model: Model, message: Message) => update(model, message, root), view },
      Scene.given(init()),
      Scene.expect(Scene.role("tablist", { name: "Open chats" })).toExist(),
      Scene.expect(Scene.role("tab", { name: /Deploys/ })).toHaveAttr("aria-selected", "false"),
      Scene.expect(Scene.role("tab", { name: /Fix the tide chart/ })).toHaveAttr("aria-selected", "true"),
      Scene.Mount.resolve(TabListMount, Message.DroppedTab()),
      Scene.click(Scene.role("button", { name: "Close Deploys" })),
      Scene.expectOutMessage(SliceOutMessage.RequestedAppAction({
        action: AppAction.Store({ message: Stores.Message.GotChatTabsMessage({ message: ChatTabs.Message.ClosedTab({ chatId: "c2" }) }) }),
      })),
    )
  })
})
