import { describe, test } from "bun:test"
import { Option } from "effect"
import { Scene } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import { memoryStorage } from "../core/stores/testing"
import { ListHoverTracker } from "./hoverCard"
import { Message } from "./message"
import { init, type Model } from "./model"
import { FocusMotion } from "./motion"
import { SidebarCard } from "./mounts"
import { update } from "./update"
import { view } from "./view"

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
    lastMessageAt: Date.now() - 60_000,
    canFork: true,
    ...overrides,
  }
}

function group(groupKey: string, chats: SidebarChatRow[]): SidebarProjectGroup {
  return { groupKey, title: groupKey, realTitle: groupKey, localPath: `/repo/${groupKey}`, chats, previewChats: chats, olderChats: [], defaultCollapsed: false }
}

const DATA: SidebarData = { projectGroups: [group("p1", [row("c1"), row("c2", { status: "running" })])] }

function appAt(path: string): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  const app = initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
  return { ...app, connectionStatus: "connected", stores: { ...app.stores, sidebar: { ...app.stores.sidebar, data: DATA, ready: true } } }
}

// The card's own Mounts report nothing until something happens; settled here.
const mounted = [
  Scene.Mount.resolve(SidebarCard, Message.ChangedPeek({ peeking: false })),
  Scene.Mount.resolve(FocusMotion, Message.CompletedSideEffect()),
  Scene.Mount.resolve(ListHoverTracker, Message.ChangedHoveredRow({ list: "chats", key: null })),
]

const asks = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })

function scene(app: AppModel) {
  return {
    update: (model: Model, message: Message) => update(model, message, app),
    view: Scene.withViewInputs(view, { app })(),
  }
}

describe("sidebar view", () => {
  test("the Chats view lists the chats; a click opens one", () => {
    const app = appAt("/settings/general")
    Scene.scene(
      scene(app),
      Scene.given(init(memoryStorage())),
      ...mounted,
      Scene.expect(Scene.role("button", { name: "New Chat" })).toExist(),
      Scene.expect(Scene.text("In Progress")).toExist(),
      Scene.expect(Scene.text("Chat c1")).toExist(),
      Scene.click(Scene.text("Chat c1")),
      Scene.expectOutMessage(asks(AppAction.Navigate({ path: "/chat/c1", replace: false }))),
    )
  })

  test("the footer says where the connection stands and opens Settings", () => {
    const app = appAt("/home")
    Scene.scene(
      scene(app),
      Scene.given(init(memoryStorage())),
      ...mounted,
      Scene.expect(Scene.text("Connected")).toExist(),
      Scene.click(Scene.text("Settings")),
      Scene.expectOutMessage(asks(AppAction.Navigate({ path: "/settings/general", replace: false }))),
    )
  })

  test("collapsing asks the root", () => {
    Scene.scene(
      scene(appAt("/home")),
      Scene.given(init(memoryStorage())),
      ...mounted,
      Scene.click(Scene.title("Collapse sidebar")),
      Scene.expectOutMessage(asks(AppAction.CollapseSidebar())),
    )
  })
})
