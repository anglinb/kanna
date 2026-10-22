import { afterEach, describe, expect, test } from "bun:test"
import { makeFakeKeybindings } from "./keybindings.fake"
import { makeFakeAppSettings } from "./app-settings.fake"
import { makeFakeTerminals } from "./terminal-manager.fake"
import { makeFakeWorktreeProbe } from "./worktree-probe.fake"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { NoopAnalytics } from "./analytics"
import { AsyncQueue } from "./async-queue"
import { createChatCommands } from "./chat-commands"
import { openEventStore } from "./event-store-bridge"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { KannaToolRuntime } from "./kanna-tools"
import { ChatOrchestrator } from "./orchestrator"
import { TicketStore } from "./ticket-store"
import { TestPlatform } from "./effect/testing"
import { Layer, ManagedRuntime, Option } from "effect"
import { runKannaSync } from "./effect/bridge"
import type { TicketBoard } from "./ticket-board"
import { createWsRouter } from "./ws-router"
import { timestamped } from "./transcript"
import { stripSystemMessages } from "../shared/message-preview"
import { PROVIDERS } from "../shared/types"
import type { UserPromptEntry } from "../shared/types"

/**
 * The ticket board end to end: the real coordinator, store and orchestrator,
 * against a provider whose turns the test ends by hand (as in
 * `orchestrator.test.ts`), with the delegator calling its tools through the
 * same runtime a harness uses.
 */

interface FakeTurn {
  chatId: string
  content: string
  model?: string
  planMode?: boolean
  events: AsyncQueue<HarnessEvent>
  open: boolean
}

class FakeCodex {
  readonly turns: FakeTurn[] = []
  async startSession() {}
  stopSession() {}
  stopAll() {}
  getResourceCounts() { return {} }
  // A prompt that starts with "/name" asks the harness for its skills; this one has none.
  async listSkills() { return [] }

  async startTurn(args: { chatId: string; content: string; model?: string; planMode?: boolean }): Promise<HarnessTurn> {
    const turn: FakeTurn = { chatId: args.chatId, content: args.content, model: args.model, planMode: args.planMode, events: new AsyncQueue(), open: true }
    this.turns.push(turn)
    const end = () => {
      turn.open = false
      turn.events.finish()
    }
    return { provider: "codex", stream: turn.events, interrupt: async () => end(), close: end }
  }

  turn(chatId: string) {
    const found = [...this.turns].reverse().find((turn) => turn.chatId === chatId && turn.open)
    if (!found) throw new Error(`No open turn for ${chatId}`)
    return found
  }

  turnsFor(chatId: string) {
    return this.turns.filter((turn) => turn.chatId === chatId)
  }

  finish(chatId: string, text: string) {
    const turn = this.turn(chatId)
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) })
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" }) })
    turn.open = false
    turn.events.finish()
  }

  fail(chatId: string, message: string) {
    const turn = this.turn(chatId)
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }) })
    turn.open = false
    turn.events.finish()
  }
}

async function until(condition: () => boolean, label = "condition") {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-tickets-data-"))
  const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-tickets-project-"))
  const store = await openEventStore(dataDir)
  const ticketsRuntime = ManagedRuntime.make(TicketStore.layer({ dataDir }).pipe(Layer.provide(TestPlatform)))
  const tickets = await ticketsRuntime.runPromise(TicketStore)
  const project = await store.openProject(projectDir)
  const codex = new FakeCodex()
  const agent = new AgentCoordinator({
    store,
    onStateChange: () => {},
    codexManager: codex as never,
    generateTitle: async () => ({ title: null, usedFallback: true, failureMessage: null }),
  })
  const orchestrator = new ChatOrchestrator({
    store,
    agent,
    commands: createChatCommands({ store, agent, analytics: NoopAnalytics }),
    push: () => {},
    tickets,
  })
  agent.orchestration = orchestrator
  agent.onChatSettled = (chatId) => orchestrator.handleChatSettled(chatId)
  agent.onChatStopped = (chatId) => orchestrator.handleChatStopped(chatId)
  store.onTurnStarted = (chatId) => orchestrator.handleTurnStarted(chatId)
  store.onQueuedMessageRemoved = (chatId, queuedMessageId, taken) => orchestrator.handleQueuedMessageRemoved(chatId, queuedMessageId, taken)
  cleanups.push(async () => {
    orchestrator.dispose()
    agent.dispose()
    await ticketsRuntime.runPromise(tickets.flush)
    await ticketsRuntime.dispose()
    await rm(dataDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  })

  /** A chat with a turn open in it: a delegator unless told otherwise. */
  async function startChat(options?: { delegator?: boolean; content?: string }) {
    const chat = await store.createChat(project.id, undefined, { delegator: options?.delegator ?? true })
    await agent.send({ type: "chat.send", chatId: chat.id, provider: "codex", content: options?.content ?? "ship the release" })
    await until(() => codex.turnsFor(chat.id).length === 1, "the first turn")
    return chat.id
  }

  /** The chat's Kanna tools, as its harness calls them. */
  function toolsFor(chatId: string) {
    const runtime = new KannaToolRuntime({
      chatId,
      cwd: projectDir,
      dataDir,
      emit: async () => {},
      requestInput: async () => ({}),
      orchestration: orchestrator,
    })
    return async (name: string, input: Record<string, unknown>) => {
      const result = await runtime.execute(name, input)
      const text = result.content.map((part) => ("text" in part ? part.text : "")).join("")
      if (result.isError) return { error: text } as Record<string, any>
      try {
        return JSON.parse(text) as Record<string, any>
      } catch {
        return { text } as Record<string, any>
      }
    }
  }

  const prompts = (chatId: string) => store.getMessages(chatId).filter((entry): entry is UserPromptEntry & typeof entry => entry.kind === "user_prompt")

  return { store, tickets, project, codex, agent, orchestrator, startChat, toolsFor, prompts, board: boardReads(orchestrator.tickets!) }
}

/** The board's reads, run at once, as the assertions below make them. */
function boardReads(board: TicketBoard["Service"]) {
  return {
    get: (delegatorChatId: string, ticketId: string) => Option.getOrUndefined(runKannaSync(board.get(delegatorChatId, ticketId))),
    require: (delegatorChatId: string, ticketId: string) => runKannaSync(board.require(delegatorChatId, ticketId)),
    list: (delegatorChatId: string) => runKannaSync(board.list(delegatorChatId)),
    summary: board.summary,
    stateOf: board.stateOf,
  }
}

describe("hand-offs from a delegator", () => {
  test("need a ticket, and say how to name one", async () => {
    const { startChat, toolsFor, store } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const before = store.listChatsByProject(store.getChat(delegator)!.projectId).length

    const refused = await call("create_chat", { message: "fix the flicker" })
    expect(refused.error).toContain("ticketId")
    expect(refused.error).toContain("ticket: { title, body }")
    expect(await call("create_chat", { message: "x", ticketId: "tk_nope00" })).toMatchObject({ error: expect.stringContaining("not found") })
    expect(await call("create_chat", { message: "x", ticketId: "tk_nope00", ticket: { title: "Both" } })).toMatchObject({ error: expect.stringContaining("not both") })
    // Nothing was created by the refusals.
    expect(store.listChatsByProject(store.getChat(delegator)!.projectId).length).toBe(before)
  })

  test("create a ticket in the same call, and record the hand-off on it", async () => {
    const { startChat, toolsFor, board } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)

    const child = await call("create_chat", { message: "fix the flicker", title: "Flicker fix", ticket: { title: "Flicker", body: "No flicker on open." } })
    expect(child.ticket).toEqual({ id: expect.stringMatching(/^tk_[0-9a-f]{6}$/), number: 1, link: `/chat/${delegator}?ticket=${child.ticket.id}` })
    const ticket = board.get(delegator, child.ticket.id)!
    expect(ticket).toMatchObject({ title: "Flicker", body: "No flicker on open.", number: 1 })
    expect(ticket.handoffs).toMatchObject([{ childChatId: child.chatId, outstanding: true }])
    expect(ticket.history).toMatchObject([{ kind: "sent_to", chatId: child.chatId }])
    expect(board.summary(ticket)).toMatchObject({ state: "in_progress", statusLine: "Flicker fix is working" })
  })

  test("hand on follow-ups for an existing ticket with send_message and fork_chat", async () => {
    const { startChat, toolsFor, board, codex, orchestrator } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const { ticketId, number } = await call("create_ticket", { title: "Release", body: "Tag and publish." })
    expect(number).toBe(1)

    const first = await call("create_chat", { message: "tag it", ticketId })
    // A session to fork from.
    codex.turn(first.chatId).events.push({ type: "session_token", sessionToken: "thread-1" })
    codex.finish(first.chatId, "Tagged.")
    await until(() => !orchestrator["agent"].isBusy(first.chatId), "the first chat at rest")
    await until(() => board.summary(board.get(delegator, ticketId)!).state === "done", "the ticket done")
    const fork = await call("fork_chat", { chatId: first.chatId, ticketId })
    expect(fork.error).toBeUndefined()
    const link = `/chat/${delegator}?ticket=${ticketId}`
    // Handing work on a Done ticket reopens it, and the result says so.
    const reopened = { id: ticketId, number: 1, link, reopened: true, note: "Reopened #1, which was Done. A new ask needs a new ticket." }
    expect(fork.ticket).toEqual(reopened)
    const sent = await call("send_message", { chatId: first.chatId, message: "now publish", ticketId })
    // A copy with no message owes nothing, so the ticket was Done again.
    expect(sent.ticket).toEqual(reopened)
    // An open ticket is not reopened, and the result says nothing of it.
    expect((await call("send_message", { chatId: first.chatId, message: "and the notes", ticketId })).ticket).toEqual({ id: ticketId, number: 1, link })
    expect(board.get(delegator, ticketId)!.handoffs.map((handoff) => [handoff.childChatId, handoff.outstanding]))
      // The first was settled by the report of the turn it asked for.
      .toEqual([[first.chatId, false], [fork.chatId, false], [first.chatId, true], [first.chatId, true]])
  })

  test("an ordinary chat hands off as before, and has no board", async () => {
    const { startChat, toolsFor, board, orchestrator } = await setup()
    const plain = await startChat({ delegator: false })
    const call = toolsFor(plain)
    const child = await call("create_chat", { message: "go", ticket: { title: "Ignored" } })
    expect(child.error).toBeUndefined()
    expect(child.ticket).toBeUndefined()
    expect(board.list(plain)).toEqual([])
    expect(orchestrator.ticketBoard(plain)).toBeNull()
    expect(await call("create_ticket", { title: "Nope" })).toMatchObject({ error: expect.stringContaining("delegator") })
  })
})

describe("reports to a delegator", () => {
  test("name the ticket in the header and add the outcome to its history", async () => {
    const { startChat, toolsFor, board, codex, prompts } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const child = await call("create_chat", { message: "fix it", title: "Flicker fix", ticket: { title: "Escape hold" } })
    const ticketId = child.ticket.id as string
    codex.finish(delegator, "Handed off.")

    codex.finish(child.chatId, "Fixed in App.tsx.")
    await until(() => prompts(delegator).length === 2, "the report")
    const report = prompts(delegator)[1]!.content
    expect(report).toContain(`Sub-chat completed: [Flicker fix]`)
    expect(report).toContain(`For ticket #1 "Escape hold" (${ticketId})`)
    // The status line stays first in the header, for the clients that read it.
    expect(report.indexOf("Sub-chat completed")).toBeLessThan(report.indexOf("For ticket"))
    expect(stripSystemMessages(report)).toBe("Fixed in App.tsx.")
    // The same, as data, so a client need not read the header.
    expect(prompts(delegator)[1]!.source).toEqual({ kind: "report", chatIds: [child.chatId], tickets: { [child.chatId]: [ticketId] } })

    const ticket = board.get(delegator, ticketId)!
    expect(ticket.history.map((event) => event.kind)).toEqual(["sent_to", "chat_finished"])
    expect(ticket.handoffs[0]!.outstanding).toBe(false)
    expect(board.summary(ticket)).toMatchObject({ state: "done", unread: true, statusLine: "Flicker fix finished" })
  })

  test("a chat given two tickets in a row reports each with the turn that did it, and a failure only on its own", async () => {
    const { startChat, toolsFor, board, codex, prompts } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const first = await call("create_chat", { message: "web", ticket: { title: "Web" } })
    const second = await call("send_message", { chatId: first.chatId, message: "and iOS", ticket: { title: "iOS" }, delivery: "queue" })
    codex.finish(delegator, "Both handed off.")
    expect(board.summary(board.get(delegator, first.ticket.id)!).state).toBe("in_progress")
    expect(board.summary(board.get(delegator, second.ticket.id)!).state).toBe("in_progress")

    // The queued follow-up starts as the first turn ends. That turn's reply
    // is its whole answer on Web, so Web settles with it and iOS does not.
    codex.finish(first.chatId, "Web done.")
    await until(() => codex.turnsFor(delegator).length === 2, "the first turn's report")
    const firstReport = prompts(delegator)[1]!
    expect(firstReport.content).toContain("went straight on into another turn")
    expect(firstReport.content).toContain(`For ticket #1 "Web" (${first.ticket.id})`)
    expect(firstReport.content).not.toContain(second.ticket.id)
    expect(firstReport.source).toEqual({ kind: "report", chatIds: [first.chatId], tickets: { [first.chatId]: [first.ticket.id] } })
    expect(board.get(delegator, first.ticket.id)!.history.map((event) => event.kind)).toEqual(["sent_to", "chat_finished"])
    expect(board.summary(board.get(delegator, first.ticket.id)!).state).toBe("done")
    expect(board.get(delegator, second.ticket.id)!.history.map((event) => event.kind)).toEqual(["sent_to"])
    expect(board.summary(board.get(delegator, second.ticket.id)!)).toMatchObject({ state: "in_progress", chats: [{ state: "working", outstanding: true }] })
    codex.finish(delegator, "Web is done; iOS is next.")

    codex.fail(first.chatId, "Simulator would not boot.")
    await until(() => codex.turnsFor(delegator).length === 3, "the failure report")
    const failure = prompts(delegator)[2]!
    expect(failure.content).toContain("Sub-chat failed")
    expect(failure.content).toContain(`For ticket #2 "iOS" (${second.ticket.id})`)
    expect(failure.source).toMatchObject({ kind: "report", tickets: { [first.chatId]: [second.ticket.id] } })
    expect(board.get(delegator, second.ticket.id)!.history.map((event) => event.kind)).toEqual(["sent_to", "chat_failed"])
    expect(board.get(delegator, first.ticket.id)!.history.map((event) => event.kind)).toEqual(["sent_to", "chat_finished"])
  })

  test("three hand-offs queued to one chat settle one per turn, and the delegator posting on each is not nudged", async () => {
    const { startChat, toolsFor, board, codex, prompts } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const a = await call("create_chat", { message: "do A", ticket: { title: "A" } })
    const b = await call("send_message", { chatId: a.chatId, message: "do B", ticket: { title: "B" } })
    const c = await call("send_message", { chatId: a.chatId, message: "do C", ticket: { title: "C" } })
    expect([b.started, c.started]).toEqual([false, false])
    codex.finish(delegator, "Handed off three.")
    const child = a.chatId as string
    const ids = [a.ticket.id, b.ticket.id, c.ticket.id] as string[]
    const kinds = (ticketId: string) => board.get(delegator, ticketId)!.history.map((event) => event.kind)

    for (const [index, ticketId] of ids.entries()) {
      codex.finish(child, `Did ${"ABC"[index]}.`)
      await until(() => codex.turnsFor(delegator).length === index + 2, `the report on ${"ABC"[index]}`)
      const report = prompts(delegator)[index + 1]!
      // Each report names, and settles, only the ticket its turn worked on.
      expect(report.source).toMatchObject({ kind: "report", tickets: { [child]: [ticketId] } })
      for (const [other, otherId] of ids.entries()) {
        expect(kinds(otherId)).toEqual(other <= index ? ["sent_to", "chat_finished"] : ["sent_to"])
        expect(board.summary(board.get(delegator, otherId)!).state).toBe(other <= index ? "done" : "in_progress")
      }
      // The delegator posts on the ticket as its report arrives.
      await call("reply_to_ticket", { ticketId, text: `${"ABC"[index]} is done.` })
      codex.finish(delegator, "Posted.")
      await until(() => !codex.turns.some((turn) => turn.chatId === delegator && turn.open), "the delegator at rest")
    }

    // The last report was a final one and added "finished" to C alone.
    expect(prompts(delegator)[3]!.content).not.toContain("went straight on")
    for (const ticketId of ids) expect(kinds(ticketId).filter((kind) => kind === "chat_finished")).toHaveLength(1)
    // Each was posted on after its own report, so there is nothing to nudge about.
    await Bun.sleep(100)
    expect(codex.turnsFor(delegator)).toHaveLength(4)
    expect(prompts(delegator).some((prompt) => prompt.source?.kind === "ticket_nudge")).toBe(false)
  })

  test("a queued hand-off taken out of the queue is withdrawn: no row, no finished line, no nudge", async () => {
    // Ticket #24: the delegator removed a ticket's queued message to move a
    // commit ahead of it and sent the work again. The commit's turn took the
    // orphaned hand-off, and its report said the ticket had finished.
    const { startChat, toolsFor, board, codex, prompts } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const a = await call("create_chat", { message: "do A", title: "Worker", ticket: { title: "A" } })
    const child = a.chatId as string
    const b = await call("send_message", { chatId: child, message: "do B", ticket: { title: "B" } })
    const c = await call("send_message", { chatId: child, message: "do C", ticket: { title: "C" } })
    const ticket = (id: string) => board.get(delegator, id)!
    // Behind A, B and C wait in the queue: queued, not working.
    expect(board.summary(ticket(b.ticket.id))).toMatchObject({ state: "in_progress", statusLine: "Queued in Worker", chats: [{ chatId: child, state: "working", queued: true }] })

    expect((await call("update_queued_message", { chatId: child, queuedMessageId: b.queuedMessageId, action: "remove" })).error).toBeUndefined()
    // No chat ever had B's work, so the ticket has no row for it.
    expect(ticket(b.ticket.id)).toMatchObject({ handoffs: [], history: [] })
    expect(board.summary(ticket(b.ticket.id))).toMatchObject({ statusLine: "Not started", chats: [] })
    codex.finish(delegator, "Moved C ahead.")

    // A ends, and C's turn starts with C's message. It does not take B's hand-off.
    codex.finish(child, "Did A.")
    await until(() => codex.turnsFor(delegator).length === 2, "the report on A")
    // Not toMatchObject with expect.any: Bun writes the matcher into the live record.
    expect(typeof ticket(c.ticket.id).handoffs[0]!.turn).toBe("number")
    expect(board.summary(ticket(c.ticket.id)).chats[0]!.queued).toBeUndefined()
    await call("reply_to_ticket", { ticketId: a.ticket.id, text: "A is done." })
    codex.finish(delegator, "Posted.")
    await until(() => !codex.turns.some((turn) => turn.chatId === delegator && turn.open), "the delegator at rest")

    codex.finish(child, "Did C.")
    await until(() => codex.turnsFor(delegator).length === 3, "the report on C")
    expect(prompts(delegator)[2]!.source).toMatchObject({ kind: "report", tickets: { [child]: [c.ticket.id] } })
    await call("reply_to_ticket", { ticketId: c.ticket.id, text: "C is done." })
    codex.finish(delegator, "Posted.")
    await Bun.sleep(100)
    expect(ticket(b.ticket.id).history).toEqual([])
    expect(prompts(delegator).some((prompt) => prompt.source?.kind === "ticket_nudge")).toBe(false)
  })

  test("a queued hand-off the user takes out of the queue is withdrawn too", async () => {
    const { startChat, toolsFor, board, agent } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const a = await call("create_chat", { message: "do A", ticket: { title: "A" } })
    const b = await call("send_message", { chatId: a.chatId, message: "do B", ticket: { title: "B" } })
    // The composer's remove button sends this; the store's hook does the rest.
    await agent.dequeue({ type: "message.dequeue", chatId: a.chatId, queuedMessageId: b.queuedMessageId })
    await until(() => board.get(delegator, b.ticket.id)!.handoffs.length === 0, "the withdrawal")
    expect(board.get(delegator, b.ticket.id)!.history).toEqual([])
    expect(board.get(delegator, a.ticket.id)!.handoffs).toHaveLength(1)
  })

  test("a hand-off steered into a running turn settles with that turn", async () => {
    const { startChat, toolsFor, board, codex, prompts } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const a = await call("create_chat", { message: "do A", ticket: { title: "A" } })
    const b = await call("send_message", { chatId: a.chatId, message: "and B, now", ticket: { title: "B" }, delivery: "steer" })
    expect(b.started).toBe(true)
    await until(() => codex.turnsFor(a.chatId).length === 2, "the steered turn")
    codex.finish(delegator, "Handed off.")
    // The turn A was in was stopped for the steer and is never reported; the
    // steered turn carries A on, so its report covers both.
    expect(board.get(delegator, a.ticket.id)!.handoffs[0]!.outstanding).toBe(true)

    codex.finish(a.chatId, "Did A and B.")
    await until(() => codex.turnsFor(delegator).length === 2, "the report")
    expect(prompts(delegator)[1]!.source).toMatchObject({ tickets: { [a.chatId]: [a.ticket.id, b.ticket.id] } })
    for (const ticketId of [a.ticket.id, b.ticket.id]) {
      expect(board.get(delegator, ticketId)!.history.map((event) => event.kind)).toEqual(["sent_to", "chat_finished"])
      expect(board.get(delegator, ticketId)!.handoffs.every((handoff) => !handoff.outstanding)).toBe(true)
    }
  })

  test("an interim report names the ticket but does not settle it", async () => {
    const { startChat, toolsFor, board, codex, prompts } = await setup()
    const delegator = await startChat()
    const worker = await toolsFor(delegator)("create_chat", { message: "audit it", ticket: { title: "Audit" } })
    codex.finish(delegator, "Handed off.")
    // The worker hands part of it to a sub-chat of its own, then ends its turn.
    const helper = await toolsFor(worker.chatId)("create_chat", { message: "check the parser" })
    codex.finish(worker.chatId, "Waiting on the parser check.")
    await until(() => codex.turnsFor(delegator).length === 2, "the interim report")
    const interim = prompts(delegator)[1]!.content
    expect(interim).toContain("Not its last word")
    expect(interim).toContain(`For ticket #1 "Audit" (${worker.ticket.id})`)
    expect(board.get(delegator, worker.ticket.id)!.handoffs[0]!.outstanding).toBe(true)
    expect(board.get(delegator, worker.ticket.id)!.history.map((event) => event.kind)).toEqual(["sent_to"])
    codex.finish(delegator, "Noted.")

    // The helper's report wakes the worker; the turn that ends it is its last word.
    codex.finish(helper.chatId, "Parser is fine.")
    await until(() => codex.turnsFor(worker.chatId).length === 2, "the worker's next turn")
    codex.finish(worker.chatId, "Audit done.")
    await until(() => board.get(delegator, worker.ticket.id)!.handoffs[0]!.outstanding === false, "the final report")
    expect(board.get(delegator, worker.ticket.id)!.history.map((event) => event.kind)).toEqual(["sent_to", "chat_finished"])
  })

  test("a chat stopping to ask the user is recorded on its tickets", async () => {
    const { startChat, toolsFor, board, orchestrator } = await setup()
    const delegator = await startChat()
    const child = await toolsFor(delegator)("create_chat", { message: "plan it", ticket: { title: "Plan" } })
    orchestrator.handleWaitingForUser(child.chatId)
    await until(() => board.get(delegator, child.ticket.id)!.history.length === 2, "the asking line")
    expect(board.get(delegator, child.ticket.id)!.history.at(-1)).toMatchObject({ kind: "chat_asking", chatId: child.chatId })
  })
})

describe("the nudge", () => {
  test("after a final report the delegator did not post on, once", async () => {
    const { startChat, toolsFor, codex, prompts } = await setup()
    const delegator = await startChat()
    const child = await toolsFor(delegator)("create_chat", { message: "fix it", ticket: { title: "Escape hold" } })
    codex.finish(delegator, "Handed off.")
    codex.finish(child.chatId, "Fixed.")
    await until(() => codex.turnsFor(delegator).length === 2, "the report's turn")

    codex.finish(delegator, "The fix is in.")
    await until(() => codex.turnsFor(delegator).length === 3, "the nudge's turn")
    const nudge = prompts(delegator)[2]!
    expect(nudge.source).toEqual({ kind: "ticket_nudge", ticketIds: [child.ticket.id] })
    expect(nudge.content).toContain(`#1 "Escape hold" (${child.ticket.id})`)
    expect(nudge.content).toContain("reply_to_ticket")
    // Nothing to say is allowed: the nudge once drew "Nothing new" posts.
    expect(nudge.content).toContain("If you already posted it, or you handed the work on, post nothing.")
    expect(nudge.content).not.toContain("one line saying so")
    expect(stripSystemMessages(nudge.content)).toBe("")

    // Its own turn ending without a post earns no second one.
    codex.finish(delegator, "Still not posting.")
    await Bun.sleep(100)
    expect(codex.turnsFor(delegator)).toHaveLength(3)
  })

  test("not when the delegator replied on the ticket", async () => {
    const { startChat, toolsFor, codex } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const child = await call("create_chat", { message: "fix it", ticket: { title: "Escape hold" } })
    codex.finish(delegator, "Handed off.")
    codex.finish(child.chatId, "Fixed.")
    await until(() => codex.turnsFor(delegator).length === 2, "the report's turn")

    expect(await call("reply_to_ticket", { ticketId: child.ticket.id, text: "Fixed in App.tsx." })).toEqual({ replyId: expect.stringMatching(/^rp_/) })
    codex.finish(delegator, "Posted.")
    await Bun.sleep(100)
    expect(codex.turnsFor(delegator)).toHaveLength(2)
  })

  test("after a user reply the delegator neither posted on nor handed work from", async () => {
    const { startChat, toolsFor, orchestrator, codex, prompts, board } = await setup()
    const delegator = await startChat()
    const { ticketId } = await toolsFor(delegator)("create_ticket", { title: "Escape hold" })
    codex.finish(delegator, "Made a ticket.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")

    await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "make it 500ms" })
    await until(() => codex.turnsFor(delegator).length === 2, "the reply's turn")
    codex.finish(delegator, "Will do.")
    await until(() => codex.turnsFor(delegator).length === 3, "the nudge's turn")
    expect(prompts(delegator)[2]!.source).toEqual({ kind: "ticket_nudge", ticketIds: [ticketId] })
    expect(prompts(delegator)[2]!.content).toContain("the user replied")
    expect(board.get(delegator, ticketId)!.awaitingDelegator).toBe(true)
  })

  test("not after a user reply the delegator handed work on from", async () => {
    const { startChat, toolsFor, orchestrator, codex, board } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const { ticketId } = await call("create_ticket", { title: "Escape hold" })
    codex.finish(delegator, "Made a ticket.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")

    await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "make it 500ms" })
    await until(() => codex.turnsFor(delegator).length === 2, "the reply's turn")
    await call("create_chat", { message: "set the hold to 500ms", ticketId })
    // A hand-off answers the user's reply.
    expect(board.get(delegator, ticketId)!.awaitingDelegator).toBe(false)
    codex.finish(delegator, "Sent it on.")
    await Bun.sleep(100)
    expect(codex.turnsFor(delegator)).toHaveLength(2)
  })
})

describe("the user's ticket replies", () => {
  test("reach the delegator with a hidden header, as the user's words, with the ticket as source", async () => {
    const { startChat, toolsFor, orchestrator, codex, prompts } = await setup()
    const delegator = await startChat()
    const child = await toolsFor(delegator)("create_chat", { message: "fix it", title: "Flicker fix", ticket: { title: "Escape hold" } })
    const ticketId = child.ticket.id as string
    codex.finish(delegator, "Handed off.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")

    const { replyId } = await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "and on iOS too" })
    await until(() => codex.turnsFor(delegator).length === 2, "the reply's turn")
    const prompt = prompts(delegator)[1]!
    expect(prompt.source).toEqual({ kind: "ticket", ticketId, number: 1, title: "Escape hold", replyId })
    // Stored as the user's words alone, as any message they send.
    expect(prompt.content).toBe("and on iOS too")
    // The header is the turn's, on the wire, after those words.
    const wire = codex.turnsFor(delegator)[1]!.content
    expect(wire.startsWith("and on iOS too")).toBe(true)
    expect(wire).toContain(`The user replied on ticket #1 "Escape hold" (${ticketId})`)
    expect(wire).toContain("It is In progress.")
    expect(wire).toContain(`"Flicker fix" (chat id ${child.chatId}) working`)
    expect(wire).toContain("reply_to_ticket")
    // Either answers it; a hand-off is not announced.
    expect(wire).toContain(`hand the work on with ticketId "${ticketId}"; a hand-off needs no post.`)
  })

  test("answering the delegator's question tells it the ticket is In progress, not still waiting", async () => {
    const { startChat, toolsFor, orchestrator, codex, board } = await setup()
    const delegator = await startChat()
    const { ticketId } = await toolsFor(delegator)("create_ticket", { title: "Escape hold" })
    await toolsFor(delegator)("reply_to_ticket", { ticketId, text: "Once per install, or per session?", asksUser: true })
    expect(board.stateOf(board.require(delegator, ticketId))).toBe("waiting_on_you")
    codex.finish(delegator, "Asked.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")

    await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "once per install" })
    await until(() => codex.turnsFor(delegator).length === 2, "the reply's turn")
    const content = codex.turnsFor(delegator)[1]!.content
    expect(content).toContain("It is In progress.")
    expect(content).not.toContain("Waiting on the user")
    expect(board.require(delegator, ticketId).asksUser).toBe(false)
  })

  test("through ticket.reply, an answer to the delegator's question on a finished ticket reads In progress at the turn's start", async () => {
    // Ticket #8: its one chat finished, then the delegator asked the user
    // something (asksUser), and the user answered on the ticket. The server
    // that produced "It is Waiting on the user" was a build from before the
    // header described the state after the reply; this is that sequence.
    const { startChat, toolsFor, orchestrator, codex, board, store, agent, prompts } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const child = await call("create_chat", { message: "build it", title: "Live rows", ticket: { title: "One live row per hand-off" } })
    const ticketId = child.ticket.id as string
    codex.finish(delegator, "Handed off.")
    codex.finish(child.chatId, "Built, uncommitted.")
    await until(() => codex.turnsFor(delegator).length === 2, "the report")
    await call("reply_to_ticket", { ticketId, text: "Built. Keep the chat list below the body?", asksUser: true })
    codex.finish(delegator, "Posted.")
    await until(() => !agent.isBusy(delegator), "the delegator at rest")
    expect(board.summary(board.require(delegator, ticketId))).toMatchObject({ state: "waiting_on_you", statusLine: "Asks you" })

    const router = createWsRouter({
      store,
      diffStore: { getProjectSnapshot: () => null, getSnapshotVersion: () => 0 } as never,
      worktreeProbe: makeFakeWorktreeProbe(),
      agent,
      terminals: makeFakeTerminals(),
      keybindings: makeFakeKeybindings({ bindings: {}, warning: null } as never),
      appSettings: makeFakeAppSettings({ transcript: { windowAssistantMessages: 50 } }),
      llmProvider: { read: async () => ({}), write: async () => ({}), validate: async () => ({ ok: true, error: null }) } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      tickets: orchestrator,
    })
    const ws = { sent: [] as Array<Record<string, any>>, data: { subscriptions: new Map(), protectedDraftChatIds: new Set<string>() }, send(message: string) { this.sent.push(JSON.parse(message)) } }
    router.handleOpen(ws as never)
    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "command", id: "reply", command: { type: "ticket.reply", chatId: delegator, ticketId, text: "whats the question?" },
    }))
    expect(ws.sent.find((envelope) => envelope.id === "reply")).toMatchObject({ type: "ack", result: { replyId: expect.stringMatching(/^rp_/) } })

    // The reply cleared the question in the same write that stored it.
    const ticket = board.require(delegator, ticketId)
    expect(ticket).toMatchObject({ asksUser: false, awaitingDelegator: true })
    expect(board.summary(ticket)).toMatchObject({ state: "in_progress", statusLine: "Waiting on the delegator" })

    // The turn the reply starts carries the notice, written as the ticket stands after it.
    await until(() => codex.turnsFor(delegator).length === 3, "the reply's turn")
    const wire = codex.turnsFor(delegator)[2]!.content
    expect(wire).toContain(`The user replied on ticket #1 "One live row per hand-off" (${ticketId})`)
    expect(wire).toContain("It is In progress.")
    expect(wire).not.toContain("Waiting on the user")
    expect(wire).toContain(`"Live rows" (chat id ${child.chatId}) finished`)
    expect(prompts(delegator)[2]!.content).toBe("whats the question?")
  })

  test("keep their attachments, on the ticket and on the delegator's prompt", async () => {
    const { startChat, toolsFor, orchestrator, codex, prompts } = await setup()
    const delegator = await startChat()
    const { ticketId } = await toolsFor(delegator)("create_ticket", { title: "Escape hold" })
    codex.finish(delegator, "Made it.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")

    // The shape the composer's upload returns (`persistProjectUpload`).
    const attachment = {
      id: "up_1",
      kind: "image" as const,
      displayName: "shot.png",
      absolutePath: "/tmp/project/.kanna/uploads/shot.png",
      relativePath: "./.kanna/uploads/shot.png",
      contentUrl: "/api/projects/p1/uploads/shot.png/content",
      mimeType: "image/png",
      size: 12,
    }
    const { replyId } = await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "", attachments: [attachment] })
    const reply = orchestrator.ticketDetail(delegator, ticketId)?.replies.find((candidate) => candidate.id === replyId)
    expect(reply?.attachments).toEqual([attachment])
    await until(() => codex.turnsFor(delegator).length === 2, "the reply's turn")
    expect(prompts(delegator)[1]!.attachments).toEqual([attachment])
  })

  test("that start with a slash command reach the harness starting with it, as a chat message does", async () => {
    const { startChat, toolsFor, orchestrator, codex, prompts } = await setup()
    const delegator = await startChat()
    const { ticketId } = await toolsFor(delegator)("create_ticket", { title: "Escape hold" })
    codex.finish(delegator, "Made it.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")

    await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "/emil-design-eng tighten the hold animation" })
    await until(() => codex.turnsFor(delegator).length === 2, "the reply's turn")
    expect(prompts(delegator)[1]!.content).toBe("/emil-design-eng tighten the hold animation")
    const wire = codex.turnsFor(delegator)[1]!.content
    expect(wire.startsWith("/emil-design-eng tighten the hold animation")).toBe(true)
    expect(wire).toContain("The user replied on ticket #1")
  })

  test("that start with a slash command keep it first when steered into a busy delegator", async () => {
    const { startChat, toolsFor, orchestrator, codex } = await setup()
    const delegator = await startChat()
    const { ticketId } = await toolsFor(delegator)("create_ticket", { title: "Escape hold" })

    await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "/emil-design-eng and the ring" })
    await until(() => codex.turnsFor(delegator).length === 2, "the steered turn")
    expect(codex.turnsFor(delegator)[1]!.content.startsWith("/emil-design-eng and the ring")).toBe(true)
  })

  test("run the delegator's turn with the settings the ticket's composer chose", async () => {
    const { startChat, toolsFor, orchestrator, codex } = await setup()
    const delegator = await startChat()
    const { ticketId } = await toolsFor(delegator)("create_ticket", { title: "Escape hold" })
    codex.finish(delegator, "Made it.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")
    const before = codex.turnsFor(delegator)[0]!.model
    const chosen = PROVIDERS.find((provider) => provider.id === "codex")!.models.find((model) => model.id !== before)!.id

    await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "try it", provider: "codex", model: chosen, planMode: true })
    await until(() => codex.turnsFor(delegator).length === 2, "the reply's turn")
    expect(codex.turnsFor(delegator)[1]).toMatchObject({ model: chosen, planMode: true })
  })

  test("steer into a delegator that is busy", async () => {
    const { startChat, toolsFor, orchestrator, codex, prompts } = await setup()
    const delegator = await startChat()
    const { ticketId } = await toolsFor(delegator)("create_ticket", { title: "Escape hold" })

    await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "faster please" })
    await until(() => codex.turnsFor(delegator).length === 2, "the steered turn")
    expect(prompts(delegator)[1]).toMatchObject({ steered: true, source: { kind: "ticket", ticketId } })
  })

  test("reopen a Done ticket, and mark it read", async () => {
    const { startChat, toolsFor, orchestrator, codex, board } = await setup()
    const delegator = await startChat()
    const child = await toolsFor(delegator)("create_chat", { message: "fix it", ticket: { title: "Escape hold" } })
    const ticketId = child.ticket.id as string
    codex.finish(child.chatId, "Fixed.")
    await until(() => board.summary(board.get(delegator, ticketId)!).state === "done", "the ticket done")
    codex.finish(delegator, "Handed off.")
    await until(() => codex.turnsFor(delegator).length === 2, "the report's turn")
    codex.finish(delegator, "Done.")
    await until(() => codex.turnsFor(delegator).length === 3, "the nudge's turn")
    codex.finish(delegator, "Ok.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")

    await orchestrator.replyToTicketAsUser({ chatId: delegator, ticketId, text: "it flickers again" })
    const ticket = board.get(delegator, ticketId)!
    expect(ticket.history.at(-1)).toMatchObject({ kind: "reopened", cause: "user_reply" })
    expect(board.summary(ticket)).toMatchObject({ state: "in_progress", unread: false })
    expect(ticket.readAt).toBeDefined()
    await until(() => codex.turnsFor(delegator).length === 4, "the reply's turn")
    expect(codex.turnsFor(delegator)[3]!.content).toContain("It was Done, and this reply reopened it.")
  })
})

describe("the user's other ticket commands", () => {
  test("closing is not forwarded; reopening a Done ticket is", async () => {
    const { startChat, toolsFor, orchestrator, codex, prompts, board } = await setup()
    const delegator = await startChat()
    const { ticketId } = await toolsFor(delegator)("create_ticket", { title: "Escape hold" })
    codex.finish(delegator, "Made a ticket.")
    await until(() => !orchestrator["agent"].isBusy(delegator), "the delegator at rest")

    await orchestrator.setTicketStatusAsUser({ chatId: delegator, ticketId, status: "done" })
    expect(board.get(delegator, ticketId)!.history.at(-1)).toMatchObject({ kind: "closed", by: "user" })
    expect(board.summary(board.get(delegator, ticketId)!).state).toBe("done")
    await Bun.sleep(50)
    expect(codex.turnsFor(delegator)).toHaveLength(1)

    await orchestrator.setTicketStatusAsUser({ chatId: delegator, ticketId, status: "open" })
    await until(() => codex.turnsFor(delegator).length === 2, "the reopen's turn")
    expect(prompts(delegator)[1]!.source).toEqual({ kind: "ticket", ticketId, number: 1, title: "Escape hold", reopened: true })
    expect(prompts(delegator)[1]!.content).toContain("The user reopened ticket #1")
    expect(board.summary(board.get(delegator, ticketId)!)).toMatchObject({ state: "in_progress" })
  })

  test("read marks are kept, and drive the attention count", async () => {
    const { startChat, toolsFor, orchestrator, codex, board } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const child = await call("create_chat", { message: "fix it", ticket: { title: "Escape hold" } })
    const ticketId = child.ticket.id as string
    await call("reply_to_ticket", { ticketId: (await call("create_ticket", { title: "Question" })).ticketId, text: "Which one?", asksUser: true })
    codex.finish(child.chatId, "Fixed.")
    await until(() => board.summary(board.get(delegator, ticketId)!).state === "done", "the ticket done")

    expect(orchestrator.ticketBoard(delegator)?.ticketAttention).toBe(2)
    expect(orchestrator.ticketAttentionByChat().get(delegator)).toBe(2)
    await orchestrator.setTicketReadAsUser({ chatId: delegator, ticketId, read: true })
    expect(orchestrator.ticketBoard(delegator)?.ticketAttention).toBe(1)
    await orchestrator.setTicketReadAsUser({ chatId: delegator, ticketId, read: false })
    expect(orchestrator.ticketBoard(delegator)?.ticketAttention).toBe(2)
  })
})

describe("the board on the snapshot", () => {
  test("an old delegator's sub-chats with no ticket are listed as untracked", async () => {
    const { startChat, toolsFor, orchestrator, store } = await setup()
    const parent = await startChat({ delegator: false })
    const old = await toolsFor(parent)("create_chat", { message: "older work" })
    await store.setChatDelegator(parent, true)

    expect(orchestrator.ticketBoard(parent)).toEqual({ tickets: [], ticketAttention: 0, untrackedChatIds: [old.chatId], readDoneTotal: 0 })
    const tracked = await toolsFor(parent)("create_chat", { message: "new work", ticket: { title: "New" } })
    const board = orchestrator.ticketBoard(parent)!
    expect(board.untrackedChatIds).toEqual([old.chatId])
    expect(board.tickets).toMatchObject([{ title: "New", chats: [{ chatId: tracked.chatId, outstanding: true }] }])
  })

  test("holds the latest 100 read Done tickets, and the rest stay readable", async () => {
    const { startChat, toolsFor, orchestrator } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const { ticketId: openId } = await call("create_ticket", { title: "Still open" })
    const ids: string[] = []
    for (let index = 0; index < 103; index += 1) {
      const { ticketId } = await call("create_ticket", { title: `Done ${index + 1}` })
      await call("update_ticket", { ticketId, status: "done" })
      ids.push(ticketId)
    }
    // The first two are never read: Ready for review, so never cut.
    for (const ticketId of ids.slice(2)) await orchestrator.setTicketReadAsUser({ chatId: delegator, ticketId, read: true })

    const board = orchestrator.ticketBoard(delegator)!
    const shown = new Set(board.tickets.map((ticket) => ticket.id))
    expect(board.readDoneTotal).toBe(101)
    expect(board.tickets.filter((ticket) => ticket.state === "done" && !ticket.unread)).toHaveLength(100)
    expect(shown.has(openId) && shown.has(ids[0]!) && shown.has(ids[1]!)).toBe(true)
    // The oldest read one is the one left out, and a link to it still opens it.
    expect(shown.has(ids[2]!)).toBe(false)
    expect(orchestrator.ticketDetail(delegator, ids[2]!)).toMatchObject({ id: ids[2], title: "Done 3" })
    expect(await call("read_ticket", { ticketId: ids[2] })).toMatchObject({ ticketId: ids[2], title: "Done 3" })
    const listed = await call("list_tickets", { status: "done", limit: 200 })
    expect(listed.total).toBe(103)
    expect(listed.tickets.map((ticket: { ticketId: string }) => ticket.ticketId)).toContain(ids[2])
  })

  test("a question can be withdrawn, and a post under one still open says so", async () => {
    const { startChat, toolsFor, board } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const { ticketId } = await call("create_ticket", { title: "Wording" })
    const asked = await call("reply_to_ticket", { ticketId, text: "Say “Closed by the delegator”?\nOr keep the chat's title.", asksUser: true })
    expect(asked).toEqual({ replyId: expect.stringMatching(/^rp_/) })

    // A status post leaves the question open, and the result says so.
    const later = await call("reply_to_ticket", { ticketId, text: "The merge fix is pushed." })
    expect(later.note).toBe(`#1 still waits on the user for your question (${asked.replyId}): "Say “Closed by the delegator”?". If that is settled, post again with asksUser: false.`)
    expect(board.stateOf(board.require(delegator, ticketId))).toBe("waiting_on_you")

    // Settled in the chat: withdrawn, and the ticket no longer waits.
    expect(await call("reply_to_ticket", { ticketId, text: "Settled in chat: keeping the title.", asksUser: false })).toEqual({ replyId: expect.stringMatching(/^rp_/) })
    expect(board.require(delegator, ticketId).asksUser).toBe(false)
    expect(board.stateOf(board.require(delegator, ticketId))).toBe("in_progress")
    expect((await call("reply_to_ticket", { ticketId, text: "Nothing asked." })).note).toBeUndefined()
  })

  test("read_ticket and list_tickets give the agent the ticket and its chats", async () => {
    const { startChat, toolsFor } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const child = await call("create_chat", { message: "fix it", title: "Flicker fix", ticket: { title: "Escape hold", body: "Hold 500ms." } })
    await call("reply_to_ticket", { ticketId: child.ticket.id, text: "Underway." })

    const read = await call("read_ticket", { ticketId: child.ticket.id })
    expect(read).toMatchObject({
      ticketId: child.ticket.id,
      number: 1,
      body: "Hold 500ms.",
      state: "in_progress",
      chats: [{ chatId: child.chatId, title: "Flicker fix", state: "working", outstanding: true }],
      replies: [{ author: "delegator", text: "Underway." }],
      history: [{ kind: "sent_to", chatId: child.chatId, chatTitle: "Flicker fix" }],
    })
    expect(await call("list_tickets", { status: "done" })).toEqual({ total: 0, tickets: [] })
    expect(await call("list_tickets", { status: "open" })).toMatchObject({ total: 1, tickets: [{ number: 1, status: "Flicker fix is working" }] })
    expect(await call("update_ticket", { ticketId: child.ticket.id, title: "Escape hold: 500ms" })).toMatchObject({ title: "Escape hold: 500ms" })
    expect((await call("read_ticket", { ticketId: child.ticket.id })).history.at(-1)).toMatchObject({ kind: "renamed", from: "Escape hold" })
  })

  test("every ticket a tool names carries its link, for the agent to copy", async () => {
    const { startChat, toolsFor } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const link = (ticketId: string) => `/chat/${delegator}?ticket=${ticketId}`

    const created = await call("create_ticket", { title: "Escape hold" })
    expect(created.link).toBe(link(created.ticketId))
    const child = await call("create_chat", { message: "fix it", title: "Flicker fix", ticket: { title: "Ring" } })
    expect(child.ticket).toMatchObject({ number: 2, link: link(child.ticket.id) })
    const sent = await call("send_message", { chatId: child.chatId, message: "and the hint", ticketId: created.ticketId })
    expect(sent.ticket.link).toBe(link(created.ticketId))
    // fork_chat's, which needs a chat at rest to copy, is checked with the follow-ups above.
    expect((await call("read_ticket", { ticketId: created.ticketId })).link).toBe(link(created.ticketId))
    const listed = await call("list_tickets", {})
    expect(listed.tickets.map((ticket: { ticketId: string; link: string }) => ticket.link)).toEqual(listed.tickets.map((ticket: { ticketId: string }) => link(ticket.ticketId)))
  })

  test("show_visualization with a ticketId posts the same media file on the ticket", async () => {
    const { startChat, toolsFor, board } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const { ticketId } = await call("create_ticket", { title: "Mockups" })
    const shown = await call("show_visualization", { title: "Board", html: "<p>Board</p>", ticketId })
    expect(shown.error).toBeUndefined()
    const reply = board.get(delegator, ticketId)!.replies[0]!
    expect(reply.artifacts).toMatchObject([{ type: "visualization", title: "Board", url: expect.stringContaining(`/${delegator}/media/visualization-`) }])
    expect(JSON.stringify(reply)).not.toContain("<p>Board</p>")
    expect(await call("show_visualization", { title: "Nope", html: "<p>x</p>", ticketId: "tk_nope00" })).toMatchObject({ error: expect.stringContaining("not found") })
  })

  test("show_visualization with text posts the mock and its words as one reply, and can ask", async () => {
    const { startChat, toolsFor, board } = await setup()
    const delegator = await startChat()
    const call = toolsFor(delegator)
    const { ticketId } = await call("create_ticket", { title: "Chat list" })
    const shown = await call("show_visualization", { title: "Three options", html: "<p>A B C</p>", ticketId, text: "A, B or C? **A** is my pick.", asksUser: true })
    expect(shown.error).toBeUndefined()
    const replies = board.get(delegator, ticketId)!.replies
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ text: "A, B or C? **A** is my pick.", asksUser: true, artifacts: [{ type: "visualization", title: "Three options" }] })
    expect(board.stateOf(board.require(delegator, ticketId))).toBe("waiting_on_you")
    // Words for a ticket reply need the ticket.
    expect(await call("show_visualization", { title: "Loose", html: "<p>x</p>", text: "hi" })).toMatchObject({ error: expect.stringContaining("ticketId") })
  })
})
