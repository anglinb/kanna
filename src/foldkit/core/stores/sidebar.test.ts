import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import type { SidebarPatch } from "../../../shared/sidebar-patch"
import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../../shared/types"
import {
  chatExists,
  findSidebarChat,
  initialModel,
  Message,
  OutMessage,
  parentChatIdOf,
  projectIdForChat,
  sidebarChatIsNew,
  sidebarProjectGroups,
  update,
  WarnPatchFailed,
  type Model,
} from "./sidebar"
import { run } from "./testing"

function row(chatId: string, overrides: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: "Chat",
    status: "idle",
    unread: false,
    localPath: "/repo",
    provider: "claude",
    hasAutomation: false,
    ...overrides,
  }
}

function group(groupKey: string, chats: SidebarChatRow[] = [row(`${groupKey}-a`)]): SidebarProjectGroup {
  return {
    groupKey,
    title: groupKey,
    realTitle: groupKey,
    localPath: `/repo/${groupKey}`,
    chats,
    previewChats: chats,
    olderChats: [],
    defaultCollapsed: false,
  }
}

function data(groups: SidebarProjectGroup[]): SidebarData {
  return { projectGroups: groups }
}

const setSnapshot = (snapshot: SidebarData) => Message.ReceivedSidebarSnapshot({ snapshot })
const setOrder = (projectIds: string[] | null) => Message.ChangedOptimisticProjectOrder({ projectIds })
const keys = (model: Model) => sidebarProjectGroups(model).map((item) => item.groupKey)

describe("sidebar", () => {
  test("marks itself ready on the first snapshot, and tells the root", () => {
    const snapshot = data([group("p1")])
    expect(initialModel.ready).toBe(false)
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(setSnapshot(snapshot)),
      Story.expectOutMessage(OutMessage.AppliedSidebarSnapshot({ projectGroups: snapshot.projectGroups })),
      Story.model((model) => expect(model.ready).toBe(true)),
    )
  })

  test("keeps the held snapshot when a push changes nothing", () => {
    const first = run(update, initialModel, setSnapshot(data([group("p1"), group("p2")])))

    const next = run(update, first, setSnapshot(data([group("p1"), group("p2")])))

    // Identity is what lets every row below skip its work.
    expect(next.data).toBe(first.data)
  })

  test("keeps untouched groups when one chat moves", () => {
    const first = run(update, initialModel, setSnapshot(data([group("p1", [row("a")]), group("p2")])))

    const next = run(update, first, setSnapshot(data([
      group("p1", [row("a", { turnCount: 3 })]),
      group("p2"),
    ])))

    expect(next.data).not.toBe(first.data)
    expect(next.data.projectGroups[1]).toBe(first.data.projectGroups[1])
  })

  test("applies an optimistic reorder immediately", () => {
    const model = run(update, initialModel, setSnapshot(data([group("p1"), group("p2")])), setOrder(["p2", "p1"]))
    expect(keys(model)).toEqual(["p2", "p1"])
  })

  test("holds the optimistic order across a push that has not caught up", () => {
    const model = run(
      update,
      initialModel,
      setSnapshot(data([group("p1"), group("p2")])),
      setOrder(["p2", "p1"]),
      setSnapshot(data([group("p1"), group("p2")])),
    )

    expect(keys(model)).toEqual(["p2", "p1"])
    expect(model.optimisticProjectOrder).toEqual(["p2", "p1"])
  })

  test("drops the optimistic order once the server echoes it", () => {
    const model = run(
      update,
      initialModel,
      setSnapshot(data([group("p1"), group("p2")])),
      setOrder(["p2", "p1"]),
      setSnapshot(data([group("p2"), group("p1")])),
    )

    expect(model.optimisticProjectOrder).toBeNull()
    expect(keys(model)).toEqual(["p2", "p1"])
  })

  test("finds a chat row for handlers", () => {
    const model = run(update, initialModel, setSnapshot(data([group("p1", [row("a", { unread: true })])])))

    expect(findSidebarChat(model, "a")?.unread).toBe(true)
    expect(findSidebarChat(model, "missing")).toBeNull()
  })

  test("reads a chat's parent from its row, archived or not", () => {
    const snapshot = data([
      group("p1", [row("parent"), row("child", { parentChatId: "parent" })]),
      { ...group("p2", [row("other")]), archivedChats: [row("put-away", { parentChatId: "other" })] },
    ])

    expect(parentChatIdOf(snapshot, "child")).toBe("parent")
    expect(parentChatIdOf(snapshot, "put-away")).toBe("other")
    // A chat of the user's own, a chat the snapshot does not hold, and no chat at all.
    expect(parentChatIdOf(snapshot, "parent")).toBeNull()
    expect(parentChatIdOf(snapshot, "missing")).toBeNull()
    expect(parentChatIdOf(snapshot, null)).toBeNull()
  })

  test("answers the per-chat questions, archived chats included where they were", () => {
    const model = run(update, initialModel, setSnapshot(data([
      { ...group("p1", [row("a"), row("fresh", { title: "New Chat" })]), archivedChats: [row("old")] },
    ])))
    expect(projectIdForChat(model, "old")).toBe("p1")
    expect(chatExists(model, "old")).toBe(true)
    expect(chatExists(model, "gone")).toBe(false)
    expect(sidebarChatIsNew(model, "fresh")).toBe(true)
    expect(sidebarChatIsNew(model, "a")).toBe(false)
  })

  describe("pushes on the topic", () => {
    const reset: SidebarPatch = {
      from: null,
      to: 1,
      order: ["p1"],
      headers: [(({ chats: _c, previewChats: _p, olderChats: _o, ...header }) => header)(group("p1", [row("a")]))],
      lists: [{ groupKey: "p1", chats: ["a"], previewChats: ["a"], olderChats: [] }],
      rows: [row("a")],
    }

    test("a full snapshot is applied and held", () => {
      const snapshot = data([group("p1")])
      const model = run(update, initialModel, Message.ReceivedSidebarPush({ push: snapshot }))
      expect(model.data).toBe(snapshot)
      expect(model.held).toEqual({ revision: null, data: snapshot })
    })

    test("patches apply to what the server last sent", () => {
      const afterReset = run(update, initialModel, Message.ReceivedSidebarPush({ push: reset }))
      expect(keys(afterReset)).toEqual(["p1"])
      expect(afterReset.held?.revision).toBe(1)

      const next = run(update, afterReset, Message.ReceivedSidebarPush({
        push: { from: 1, to: 2, order: ["p1"], rows: [row("a", { unread: true })] },
      }))
      expect(findSidebarChat(next, "a")?.unread).toBe(true)
      expect(next.held?.revision).toBe(2)
      expect(next.subscriptionGeneration).toBe(0)
    })

    test("a patch from another revision resubscribes", () => {
      const afterReset = run(update, initialModel, Message.ReceivedSidebarPush({ push: reset }))
      Story.story(
        update,
        Story.given(afterReset),
        Story.message(Message.ReceivedSidebarPush({ push: { from: 7, to: 8, order: ["p1"] } })),
        Story.Command.expectNone(),
        Story.model((model) => {
          expect(model.subscriptionGeneration).toBe(1)
          expect(model.held).toBeNull()
          // What is shown stays until the fresh subscription's reset.
          expect(model.data).toBe(afterReset.data)
        }),
      )
    })

    test("a patch that doesn't apply warns and resubscribes", () => {
      const afterReset = run(update, initialModel, Message.ReceivedSidebarPush({ push: reset }))
      Story.story(
        update,
        Story.given(afterReset),
        Story.message(Message.ReceivedSidebarPush({ push: { from: 1, to: 2, order: ["p1", "nowhere"] } })),
        Story.Command.expectHas(WarnPatchFailed),
        Story.Command.resolve(WarnPatchFailed, Message.CompletedWarn()),
        Story.model((model) => expect(model.subscriptionGeneration).toBe(1)),
      )
    })
  })
})
