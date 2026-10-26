import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { fromString } from "foldkit/url"
import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import * as ChatPage from "../chat"
import { pageFacts } from "../chat/page"
import { watchOf } from "../chat/view"
import { memoryStorage } from "../core/stores/testing"
import { Message } from "./message"
import type { Flags, Model } from "./model"
import * as Stores from "./stores"
import { init, update } from "./update"

// useKannaState marked the chat you left read in the commit that showed the
// next page, after that page's own effects: for another chat, once its page
// has been observed.

function row(chatId: string, unread: boolean): SidebarChatRow {
  return { _id: chatId, _creationTime: 1, chatId, title: chatId, status: "idle", unread, localPath: "/work/tidepool", provider: "claude", lastMessageAt: 1_000, canFork: true } as SidebarChatRow
}

function boot(path: string): Model {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  const app = init(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
  const group = { groupKey: "p1", title: "tidepool", realTitle: "tidepool", localPath: "/work/tidepool", chats: [row("a", true), row("b", false)], archivedChats: [] } as unknown as SidebarProjectGroup
  const data: SidebarData = { projectGroups: [group] }
  return { ...app, stores: { ...app.stores, sidebar: { ...app.stores.sidebar, data, ready: true } } }
}

const go = (model: Model, path: string) => update(model, Message.ChangedUrl({ url: Option.getOrThrow(fromString(`http://localhost${path}`)) }))
const names = (result: { commands?: ReadonlyArray<{ name: string }> }) => (result.commands ?? []).map((command) => command.name)

describe("marking a chat read as you leave it", () => {
  test("for another chat, after the next chat's page is observed", () => {
    const left = go(boot("/chat/a"), "/chat/b")
    expect(left.model.pendingMarkRead).toBe("a")
    const observed = update(left.model, Message.GotChatPageMessage({
      message: ChatPage.Message.ObservedPage({ watch: watchOf(pageFacts(left.model, 1440, false)), fresh: true }),
    }))
    expect(observed.model.pendingMarkRead).toBeNull()
    expect(names(observed).at(-1)).toBe("SendCommand")
  })

  test("for any other page, at once", () => {
    const left = go(boot("/chat/a"), "/settings/general")
    expect(left.model.pendingMarkRead).toBeNull()
    expect(names(left)).toContain("SendCommand")
  })

  test("a mark still waiting goes with the next route change", () => {
    const left = go(boot("/chat/a"), "/chat/b")
    const away = go(left.model, "/home")
    expect(away.model.pendingMarkRead).toBeNull()
    expect(names(away)).toContain("SendCommand")
  })
})
