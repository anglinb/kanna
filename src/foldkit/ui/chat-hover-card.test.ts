import { describe, expect, test } from "bun:test"
import { Scene } from "foldkit/test"
import { flattenSidebarThreads, type SidebarThread } from "../../client/lib/thread-sections"
import type { ChatPreview, ChatTouchedFilesResult, SidebarChatRow, SidebarProjectGroup } from "../../shared/types"
import {
  CardBody,
  CardMessage,
  ChatCardLoader,
  closedCard,
  getPreviewCacheKey,
  getTouchedFilesCacheKey,
  initCardData,
  updateCard,
  type CardData,
} from "./chat-hover-card"

// The chat hover card every surface shares: its fetches (any surface's cache
// first), what it holds while a newer answer loads, its actions as intents,
// and its body.

const NOW = Date.parse("2026-06-01T12:00:00Z")

function row(overrides: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: "c1",
    _creationTime: NOW - 600_000,
    chatId: "c1",
    title: "Fix the tide chart",
    status: "idle",
    unread: false,
    localPath: "/Users/you/Projects/tidepool",
    provider: "claude",
    hasAutomation: false,
    lastMessageAt: NOW - 120_000,
    lastAgentMessageAt: NOW - 60_000,
    lastTurnEndedAt: NOW - 60_000,
    turnCount: 3,
    canFork: true,
    ...overrides,
  } as SidebarChatRow
}

function threadOf(chat: SidebarChatRow, extra: Partial<SidebarProjectGroup> = {}): SidebarThread {
  const group = { groupKey: "p1", title: "tidepool", realTitle: "tidepool", localPath: "/Users/you/Projects/tidepool", chats: [chat], previewChats: [chat], olderChats: [], defaultCollapsed: false, ...extra } as SidebarProjectGroup
  return flattenSidebarThreads({ projectGroups: [group] })[0]!
}

const PREVIEW = { lastUserMessagePreview: "Why is the chart blank?", lastAgentMessagePreview: "Safari parses the date differently.", lastAgentMessagePreviewAt: NOW - 60_000 } as ChatPreview
const FILES: ChatTouchedFilesResult = { files: [{ path: "src/chart.ts", additions: 4, deletions: 1 }], totalCount: 1 } as ChatTouchedFilesResult
const names = (step: { commands: ReadonlyArray<{ name: string }> }) => step.commands.map((command) => command.name)

describe("chat hover card: fetches", () => {
  test("asks for what no cache has, and holds the answer for the key it waited on", () => {
    const asked = updateCard(initCardData(), CardMessage.RequestedCardLoad({ chatId: "c1", kind: "files", cacheKey: "k1" }), [])
    expect(names(asked)).toEqual(["ChatCardLoadTouchedFiles"])
    expect(asked.data.cardFilesKey).toBe("k1")
    const landed = updateCard(asked.data, CardMessage.SucceededLoadTouchedFiles({ chatId: "c1", cacheKey: "k1", result: FILES }), [])
    expect(landed.data.touchedFilesCache["k1"]).toBe(FILES)
    expect(landed.data.heldTouchedFiles).toEqual({ chatId: "c1", result: FILES })
  })

  test("another surface's cache serves it: nothing is asked for", () => {
    const other: CardData = { ...initCardData(), previewCache: { p1: PREVIEW } }
    const served = updateCard(initCardData(), CardMessage.RequestedCardLoad({ chatId: "c1", kind: "preview", cacheKey: "p1" }), [other])
    expect(served.commands).toEqual([])
    expect(served.data.heldPreview).toEqual({ chatId: "c1", preview: PREVIEW })
  })

  test("a card that closed takes a late answer into its cache only", () => {
    const asked = updateCard(initCardData(), CardMessage.RequestedCardLoad({ chatId: "c1", kind: "preview", cacheKey: "p1" }), []).data
    const late = updateCard(closedCard(asked), CardMessage.SucceededLoadPreview({ chatId: "c1", cacheKey: "p1", preview: PREVIEW }), []).data
    expect(late.previewCache["p1"]).toBe(PREVIEW)
    expect(late.heldPreview).toBeNull()
  })

  test("a newer key for the same chat keeps what it held; another chat's is dropped", () => {
    const held: CardData = { ...initCardData(), heldPreview: { chatId: "c1", preview: PREVIEW } }
    expect(updateCard(held, CardMessage.RequestedCardLoad({ chatId: "c1", kind: "preview", cacheKey: "p2" }), []).data.heldPreview?.chatId).toBe("c1")
    expect(updateCard(held, CardMessage.RequestedCardLoad({ chatId: "c2", kind: "preview", cacheKey: "p3" }), []).data.heldPreview).toBeNull()
  })
})

describe("chat hover card: actions", () => {
  test("each click is an intent for the surface; the repo opens here", () => {
    const data = initCardData()
    expect(updateCard(data, CardMessage.ClickedCardMessage({ chatId: "c1", role: "prompt" }), []).intent).toEqual({ kind: "openAt", chatId: "c1", role: "prompt" })
    expect(updateCard(data, CardMessage.ClickedCardChat({ chatId: "c1", archived: true }), []).intent).toEqual({ kind: "open", chatId: "c1", archived: true })
    expect(updateCard(data, CardMessage.ClickedCardSetupGit({ chatId: "c1" }), []).intent).toEqual({ kind: "setupGit", chatId: "c1" })
    // Repo-relative, as the server records them: the project path goes back on.
    expect(updateCard(data, CardMessage.ClickedCardFile({ localPath: "/Users/you/Projects/tidepool", filePath: "src/chart.ts" }), []).intent)
      .toEqual({ kind: "openFile", localPath: "/Users/you/Projects/tidepool/src/chart.ts" })
    const repo = updateCard(data, CardMessage.ClickedCardRepo({ url: "https://github.com/you/tidepool" }), [])
    expect(repo.intent).toEqual({ kind: "dismiss" })
    expect(names(repo)).toEqual(["ChatCardOpenRepo"])
  })
})

describe("chat hover card: the body (Scene)", () => {
  const chat = row()
  const thread = threadOf(chat, { repoUrl: "https://github.com/you/tidepool" } as Partial<SidebarProjectGroup>)
  const data: CardData = {
    ...initCardData(),
    previewCache: { [getPreviewCacheKey(chat)]: PREVIEW },
    touchedFilesCache: { [getTouchedFilesCacheKey(chat)]: FILES },
  }
  const body = (inputs: Partial<Parameters<typeof CardBody>[1]> = {}) =>
    Scene.withViewInputs(CardBody, { thread, draft: null, nowMs: NOW, shared: [], ...inputs })()
  const update = (model: CardData, message: CardMessage) => ({ model: updateCard(model, message, []).data })
  const loaded = [
    Scene.Mount.resolve(ChatCardLoader, CardMessage.RequestedCardLoad({ chatId: "c1", kind: "files", cacheKey: getTouchedFilesCacheKey(chat) })),
  ] as const

  test("the prompt and its reply jump; the files open; the turn count and the harness show", () => {
    Scene.scene(
      { update, view: body() },
      Scene.given(data),
      ...loaded,
      Scene.expect(Scene.role("button", { name: "Jump to this prompt" })).toHaveText("Why is the chart blank?"),
      Scene.expect(Scene.role("button", { name: "Jump to this reply" })).toHaveText("Safari parses the date differently."),
      Scene.expect(Scene.role("button", { name: "Open src/chart.ts" })).toExist(),
      Scene.expect(Scene.text("3 turns")).toExist(),
      Scene.expect(Scene.text("Claude", { exact: false })).toExist(),
    )
  })

  test("a draft takes the prompt's place and opens the chat", () => {
    Scene.scene(
      { update, view: body({ draft: "Also check Firefox" }) },
      Scene.given(data),
      ...loaded,
      Scene.expect(Scene.role("button", { name: "Jump to this prompt" })).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Open this chat" })).toHaveText("Also check Firefox"),
    )
  })

  test("an archived chat's previews read, but don't jump", () => {
    const archived = { ...thread, archived: true }
    Scene.scene(
      { update, view: body({ thread: archived }) },
      Scene.given(data),
      ...loaded,
      Scene.expect(Scene.role("button", { name: "Jump to this prompt" })).toBeAbsent(),
      Scene.expect(Scene.text("Why is the chart blank?")).toExist(),
    )
  })
})
