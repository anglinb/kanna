import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarProjectGroup } from "../../../shared/types"
import { initialModel, Message, pendingSendTimes, update } from "./pendingSend"
import { run } from "./testing"

function row(chatId: string, lastMessageAt?: number): SidebarChatRow {
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
    ...(lastMessageAt == null ? {} : { lastMessageAt }),
  }
}

function groups(chats: SidebarChatRow[]): SidebarProjectGroup[] {
  return [{
    groupKey: "p1",
    title: "P",
    realTitle: "P",
    localPath: "/repo",
    chats,
    previewChats: chats,
    olderChats: [],
    defaultCollapsed: false,
  }]
}

describe("pending sends", () => {
  test("records and clears an in-flight send", () => {
    const sending = run(update, initialModel, Message.StartedSending({ chatId: "a", sentAt: 100 }))
    expect(sending.sentAt).toEqual({ a: 100 })

    expect(run(update, sending, Message.ClearedSending({ chatId: "a" })).sentAt).toEqual({})
  })

  test("clearing an unknown chat leaves the model alone", () => {
    expect(run(update, initialModel, Message.ClearedSending({ chatId: "missing" }))).toBe(initialModel)
  })

  test("pruning drops sends the snapshot has caught up with", () => {
    const sending = run(
      update,
      initialModel,
      Message.StartedSending({ chatId: "landed", sentAt: 100 }),
      Message.StartedSending({ chatId: "still-flying", sentAt: 100 }),
    )

    const pruned = run(update, sending, Message.ReceivedSidebarSnapshot({ projectGroups: groups([row("landed", 150), row("still-flying", 50)]) }))

    expect(pruned.sentAt).toEqual({ "still-flying": 100 })
  })

  test("pruning drops sends for chats the snapshot no longer carries", () => {
    const sending = run(update, initialModel, Message.StartedSending({ chatId: "deleted", sentAt: 100 }))

    const pruned = run(update, sending, Message.ReceivedSidebarSnapshot({ projectGroups: groups([row("other", 150)]) }))

    expect(pruned.sentAt).toEqual({})
  })

  test("pruning with nothing pending does no work", () => {
    expect(run(update, initialModel, Message.ReceivedSidebarSnapshot({ projectGroups: groups([row("a", 1)]) }))).toBe(initialModel)
  })

  test("the times keep their identity until a send starts or lands", () => {
    const sending = run(update, initialModel, Message.StartedSending({ chatId: "a", sentAt: 100 }))
    const times = pendingSendTimes(sending)
    expect([...times]).toEqual([["a", 100]])
    expect(pendingSendTimes(run(update, sending, Message.ReceivedSidebarSnapshot({ projectGroups: groups([row("a", 50)]) })))).toBe(times)
  })
})
