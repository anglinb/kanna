import { describe, expect, test } from "bun:test"
import { makeFakeDiffStore } from "./diff-store.fake"
import { makeFakeKeybindings } from "./keybindings.fake"
import { makeFakeAppSettings } from "./app-settings.fake"
import { makeFakeTerminals } from "./terminal-manager.fake"
import { PROTOCOL_VERSION } from "../shared/types"
import type { TicketDetail } from "../shared/tickets"
import { createEmptyState } from "./events"
import { createWsRouter } from "./ws-router"

/**
 * The `ticket` topic and the `ticket.*` commands, against a stand-in for the
 * orchestrator's ticket methods. The rules behind them are tested in
 * `tickets.test.ts`; this is the wire.
 */

class FakeWebSocket {
  readonly sent: Array<Record<string, any>> = []
  readonly data = { subscriptions: new Map(), protectedDraftChatIds: new Set<string>() }
  send(message: string) {
    this.sent.push(JSON.parse(message))
  }
}

function detail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: "tk_aaaaaa",
    delegatorChatId: "delegator",
    number: 1,
    title: "Escape hold",
    state: "in_progress",
    statusLine: "Not started",
    chats: [],
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    replyCount: 0,
    body: "",
    asksUser: false,
    awaitingDelegator: false,
    replies: [],
    history: [],
    ...overrides,
  }
}

function setup() {
  let current = detail()
  const calls: Array<[string, unknown]> = []
  const tickets = {
    ticketBoard: () => null,
    ticketDetail: (chatId: string, ticketId: string) => (chatId === "delegator" && ticketId === current.id ? current : null),
    ticketAttentionByChat: () => new Map<string, number>(),
    replyToTicketAsUser: async (input: unknown) => {
      calls.push(["reply", input])
      current = { ...current, replyCount: 1, awaitingDelegator: true }
      return { replyId: "rp_1" }
    },
    setTicketStatusAsUser: async (input: unknown) => { calls.push(["status", input]) },
    setTicketReadAsUser: async (input: unknown) => { calls.push(["read", input]) },
  }
  const router = createWsRouter({
    store: { state: createEmptyState(), getSidebarProjectOrder: () => [], pruneStaleEmptyChats: async () => [] } as never,
    diffStore: makeFakeDiffStore(),
    worktreeProbe: { getStates: () => new Map(), getRepoLabels: () => new Map(), getProjectsWithoutRepo: () => new Set() },
    agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
    terminals: makeFakeTerminals(),
    keybindings: makeFakeKeybindings({ bindings: {}, warning: null } as never),
    appSettings: makeFakeAppSettings(),
    llmProvider: { read: async () => ({}), write: async () => ({}), validate: async () => ({ ok: true, error: null }) } as never,
    refreshDiscovery: async () => [],
    getDiscoveredProjects: () => [],
    machineDisplayName: "Local Machine",
    updateManager: null,
    tickets: tickets as never,
  })
  const ws = new FakeWebSocket()
  router.handleOpen(ws as never)
  const message = (body: Record<string, unknown>) => router.handleMessage(ws as never, JSON.stringify({ v: PROTOCOL_VERSION, ...body }))
  return { ws, message, calls, setDetail: (next: TicketDetail) => { current = next } }
}

const ticketPushes = (ws: FakeWebSocket, id: string) => ws.sent.filter((envelope) => envelope.type === "snapshot" && envelope.id === id)

describe("the ticket topic", () => {
  test("pushes the ticket whole, and null for one that does not exist", async () => {
    const { ws, message } = setup()
    await message({ type: "subscribe", id: "t1", topic: { type: "ticket", chatId: "delegator", ticketId: "tk_aaaaaa" } })
    await message({ type: "subscribe", id: "t2", topic: { type: "ticket", chatId: "delegator", ticketId: "tk_nope00" } })
    expect(ticketPushes(ws, "t1")).toEqual([{ v: PROTOCOL_VERSION, type: "snapshot", id: "t1", snapshot: { type: "ticket", data: detail() } }])
    expect(ticketPushes(ws, "t2")[0]?.snapshot).toEqual({ type: "ticket", data: null })
  })

  test("a reply is acked with its id, then the changed ticket is pushed once", async () => {
    const { ws, message, calls } = setup()
    await message({ type: "subscribe", id: "t1", topic: { type: "ticket", chatId: "delegator", ticketId: "tk_aaaaaa" } })
    await message({ type: "command", id: "c1", command: { type: "ticket.reply", chatId: "delegator", ticketId: "tk_aaaaaa", text: "faster" } })

    expect(calls).toEqual([["reply", { type: "ticket.reply", chatId: "delegator", ticketId: "tk_aaaaaa", text: "faster" }]])
    const ack = ws.sent.findIndex((envelope) => envelope.id === "c1")
    expect(ws.sent[ack]).toEqual({ v: PROTOCOL_VERSION, type: "ack", id: "c1", result: { replyId: "rp_1" } })
    const pushes = ticketPushes(ws, "t1")
    expect(pushes).toHaveLength(2)
    expect(pushes[1]!.snapshot.data).toMatchObject({ replyCount: 1, awaitingDelegator: true })
    // The ack goes before the push it caused.
    expect(ws.sent.indexOf(pushes[1]!)).toBeGreaterThan(ack)

    // Nothing changed, so the next command pushes nothing on the topic.
    await message({ type: "command", id: "c2", command: { type: "ticket.markRead", chatId: "delegator", ticketId: "tk_aaaaaa" } })
    expect(ticketPushes(ws, "t1")).toHaveLength(2)
  })

  test("status and read marks reach the service", async () => {
    const { message, calls } = setup()
    await message({ type: "command", id: "c1", command: { type: "ticket.setStatus", chatId: "delegator", ticketId: "tk_aaaaaa", status: "done" } })
    await message({ type: "command", id: "c2", command: { type: "ticket.markUnread", chatId: "delegator", ticketId: "tk_aaaaaa" } })
    expect(calls).toEqual([
      ["status", { type: "ticket.setStatus", chatId: "delegator", ticketId: "tk_aaaaaa", status: "done" }],
      ["read", { chatId: "delegator", ticketId: "tk_aaaaaa", read: false }],
    ])
  })
})
