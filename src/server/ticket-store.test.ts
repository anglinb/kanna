import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Layer, Option, Result } from "effect"
import { runTest } from "./effect/testing"
import { TicketStore } from "./ticket-store"

let dataDir: string
beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), "kanna-tickets-")) })
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }) })

/** A store over the test's data dir, as a restart would build it. Lives until the test's scope closes. */
const reopen = (compactionThresholdBytes?: number) =>
  Layer.build(TicketStore.layer({ dataDir, compactionThresholdBytes })).pipe(
    Effect.map((context) => Context.get(context, TicketStore)),
  )

const ticket = (store: TicketStore["Service"], ticketId: string, delegatorChatId = "delegator") =>
  store.get(delegatorChatId, ticketId).pipe(Effect.map(Option.getOrUndefined))

/** A ticket with a hand-off, a reply, a history line, flags and a read mark. */
const fill = Effect.fnUntraced(function* (store: TicketStore["Service"]) {
  yield* store.append("delegator", [{ type: "ticket_created", at: 100, ticket: { id: "tk_aaaaaa", number: 1, title: "Escape hold", body: "500ms" } }])
  yield* store.append("delegator", [
    { type: "handoff_added", at: 200, handoff: { delegationId: "dl_1", ticketId: "tk_aaaaaa", childChatId: "child", createdAt: 200, outstanding: true } },
    { type: "history_added", at: 200, event: { id: "th_1", ticketId: "tk_aaaaaa", createdAt: 200, kind: "sent_to", chatId: "child" } },
  ])
  yield* store.append("delegator", [
    { type: "reply_added", at: 300, reply: { id: "rp_1", ticketId: "tk_aaaaaa", author: "delegator", text: "Which platform?", asksUser: true, createdAt: 300 } },
    { type: "flags_set", at: 300, ticketId: "tk_aaaaaa", asksUser: true, closed: { status: "done", by: "user", at: 300 } },
    { type: "read_set", at: 310, ticketId: "tk_aaaaaa", readAt: 310 },
    { type: "ticket_edited", at: 320, ticketId: "tk_aaaaaa", title: "Escape hold: 500ms", body: "Half a second." },
  ])
  yield* store.flush
})

describe("TicketStore", () => {
  test("folds events into tickets and reads them back after a restart", async () => {
    await runTest(Effect.gen(function* () {
      const store = yield* reopen()
      yield* fill(store)
      const live = (yield* ticket(store, "tk_aaaaaa"))!
      expect(live).toMatchObject({
        number: 1,
        title: "Escape hold: 500ms",
        body: "Half a second.",
        bodyEditedAt: 320,
        createdAt: 100,
        updatedAt: 300,
        asksUser: true,
        readAt: 310,
        closed: { status: "done", by: "user", at: 300 },
      })
      expect(live.handoffs).toEqual([{ delegationId: "dl_1", ticketId: "tk_aaaaaa", childChatId: "child", createdAt: 200, outstanding: true }])
      expect(yield* store.nextNumber("delegator")).toBe(2)
      expect(yield* store.list("other")).toEqual([])
      expect(yield* store.version).toBe(3)

      const reloaded = yield* reopen()
      expect(yield* ticket(reloaded, "tk_aaaaaa")).toEqual(live)
    }))
  })

  test("settling, a dropped close and a dropped read mark survive a restart", async () => {
    await runTest(Effect.gen(function* () {
      const store = yield* reopen()
      yield* fill(store)
      yield* store.append("delegator", [
        { type: "handoffs_settled", at: 400, childChatId: "child" },
        { type: "flags_set", at: 400, ticketId: "tk_aaaaaa", closed: null },
        { type: "read_set", at: 400, ticketId: "tk_aaaaaa", readAt: null },
      ])
      yield* store.flush
      const reloaded = (yield* ticket(yield* reopen(), "tk_aaaaaa"))!
      expect(reloaded.handoffs[0]!.outstanding).toBe(false)
      expect(reloaded).not.toHaveProperty("closed")
      expect(reloaded).not.toHaveProperty("readAt")
    }))
  })

  test("a withdrawn hand-off goes with its sent-to line, and stays gone after a restart", async () => {
    await runTest(Effect.gen(function* () {
      const store = yield* reopen()
      yield* fill(store)
      yield* store.append("delegator", [
        { type: "handoff_added", at: 400, handoff: { delegationId: "dl_2", ticketId: "tk_aaaaaa", childChatId: "child", createdAt: 400, outstanding: true, turn: null } },
        { type: "history_added", at: 400, event: { id: "th_2", ticketId: "tk_aaaaaa", createdAt: 400, kind: "sent_to", chatId: "child" } },
      ])
      yield* store.append("delegator", [{ type: "handoff_withdrawn", at: 450, ticketId: "tk_aaaaaa", delegationId: "dl_2" }])
      yield* store.flush
      for (const read of [store, yield* reopen()]) {
        const withdrawn = (yield* ticket(read, "tk_aaaaaa"))!
        // The earlier hand-off to the same chat, and its line, are untouched.
        expect(withdrawn.handoffs.map((handoff) => handoff.delegationId)).toEqual(["dl_1"])
        expect(withdrawn.history.map((event) => event.id)).toEqual(["th_1"])
      }
    }))
  })

  test("settling can be kept to some tickets", async () => {
    await runTest(Effect.gen(function* () {
      const store = yield* reopen()
      yield* fill(store)
      yield* store.append("delegator", [
        { type: "ticket_created", at: 500, ticket: { id: "tk_bbbbbb", number: 2, title: "Second", body: "" } },
        { type: "handoff_added", at: 500, handoff: { delegationId: "dl_2", ticketId: "tk_bbbbbb", childChatId: "child", createdAt: 500, outstanding: true } },
        { type: "handoffs_settled", at: 600, childChatId: "child", ticketIds: ["tk_bbbbbb"] },
      ])
      expect((yield* ticket(store, "tk_aaaaaa"))!.handoffs[0]!.outstanding).toBe(true)
      expect((yield* ticket(store, "tk_bbbbbb"))!.handoffs[0]!.outstanding).toBe(false)
    }))
  })

  test("compaction rewrites the file as one snapshot, and appends carry on after it", async () => {
    await runTest(Effect.gen(function* () {
      const store = yield* reopen(1)
      yield* fill(store)
      const file = path.join(dataDir, "tickets", "delegator.jsonl")
      const lines = (yield* Effect.promise(() => readFile(file, "utf8"))).trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toMatchObject({ type: "board_snapshot", tickets: [{ id: "tk_aaaaaa" }] })
      const before = yield* ticket(store, "tk_aaaaaa")

      const reloaded = yield* reopen()
      expect(yield* ticket(reloaded, "tk_aaaaaa")).toEqual(before)
      yield* reloaded.append("delegator", [{ type: "read_set", at: 700, ticketId: "tk_aaaaaa", readAt: 700 }])
      yield* reloaded.flush
      expect((yield* ticket(yield* reopen(), "tk_aaaaaa"))?.readAt).toBe(700)
    }))
  })

  test("a file over the threshold is compacted when it loads", async () => {
    await runTest(Effect.gen(function* () {
      yield* fill(yield* reopen())
      const file = path.join(dataDir, "tickets", "delegator.jsonl")
      expect((yield* Effect.promise(() => readFile(file, "utf8"))).trim().split("\n").length).toBeGreaterThan(1)
      const store = yield* reopen(1)
      yield* store.flush
      expect((yield* Effect.promise(() => readFile(file, "utf8"))).trim().split("\n")).toHaveLength(1)
      expect((yield* ticket(store, "tk_aaaaaa"))?.title).toBe("Escape hold: 500ms")
    }))
  })

  test("a line cut off by a crash is skipped", async () => {
    await runTest(Effect.gen(function* () {
      yield* fill(yield* reopen())
      yield* Effect.promise(() => appendFile(path.join(dataDir, "tickets", "delegator.jsonl"), '{"v":1,"type":"reply_added","at":9'))
      expect((yield* ticket(yield* reopen(), "tk_aaaaaa"))?.replies).toHaveLength(1)
    }))
  })

  test("loads a board as an earlier build wrote it, skipping other versions and lines that do not fold", async () => {
    // Written by hand the way the store has always written: one event per
    // line, `v` first. A line from a future log version, garbage in the
    // middle, and an event whose shape no longer folds are all skipped.
    await writeFile(path.join(await mkdirTickets(), "delegator.jsonl"), [
      '{"v":1,"at":100,"type":"ticket_created","ticket":{"id":"tk_aaaaaa","number":1,"title":"Escape hold","body":"500ms"}}',
      '{"v":2,"at":150,"type":"ticket_edited","ticketId":"tk_aaaaaa","title":"From the future"}',
      "not json at all",
      '{"v":1,"at":160,"type":"reply_added"}',
      '{"v":1,"at":200,"type":"reply_added","reply":{"id":"rp_1","ticketId":"tk_aaaaaa","author":"user","text":"Mac only","createdAt":200}}',
      '{"v":1,"at":210,"type":"flags_set","ticketId":"tk_aaaaaa","awaitingDelegator":true}',
      "",
    ].join("\n"))

    const loaded = await runTest(Effect.gen(function* () {
      return yield* ticket(yield* reopen(), "tk_aaaaaa")
    }))

    expect(loaded).toMatchObject({ title: "Escape hold", awaitingDelegator: true, updatedAt: 200 })
    expect(loaded?.replies.map((reply) => reply.text)).toEqual(["Mac only"])
  })

  test("each delegator has its own file", async () => {
    await runTest(Effect.gen(function* () {
      const store = yield* reopen()
      yield* store.append("one", [{ type: "ticket_created", at: 1, ticket: { id: "tk_111111", number: 1, title: "One", body: "" } }])
      yield* store.append("two", [{ type: "ticket_created", at: 1, ticket: { id: "tk_222222", number: 1, title: "Two", body: "" } }])
      yield* store.flush
      const reloaded = yield* reopen()
      expect((yield* reloaded.delegatorChatIds).sort()).toEqual(["one", "two"])
      expect((yield* reloaded.list("one")).map((entry) => entry.title)).toEqual(["One"])
      expect((yield* ticket(reloaded, "tk_222222", "two"))?.delegatorChatId).toBe("two")
    }))
  })

  test("appends reach the file in the order they ran, and a read straight after sees them", async () => {
    await runTest(Effect.gen(function* () {
      const store = yield* reopen()
      const appends = Array.from({ length: 20 }, (_, index) =>
        store.append("delegator", [{ type: "ticket_created", at: index, ticket: { id: `tk_${index}`, number: index + 1, title: `T${index}`, body: "" } }]))
      // Started together, as concurrent callers would.
      yield* Effect.all(appends, { concurrency: "unbounded", discard: true })
      expect(yield* store.nextNumber("delegator")).toBe(21)
      const lines = (yield* Effect.promise(() => readFile(path.join(dataDir, "tickets", "delegator.jsonl"), "utf8"))).trim().split("\n")
      expect(lines.map((line) => JSON.parse(line).ticket.id)).toEqual(Array.from({ length: 20 }, (_, index) => `tk_${index}`))
    }))
  })

  test("a failed write fails its append with the delegator and path, and later writes still run", async () => {
    await runTest(Effect.gen(function* () {
      const store = yield* reopen()
      const file = path.join(dataDir, "tickets", "blocked.jsonl")
      // A directory where the board's file should be: appending to it fails.
      yield* Effect.promise(() => mkdir(file, { recursive: true }))
      const result = yield* Effect.result(store.append("blocked", [{ type: "ticket_created", at: 1, ticket: { id: "tk_x", number: 1, title: "X", body: "" } }]))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("@kanna/server/ticket-store/TicketStoreError")
        expect(result.failure.operation).toBe("append")
        expect(result.failure.delegatorChatId).toBe("blocked")
        expect(result.failure.filePath).toBe(file)
      }
      // Applied in memory all the same, as before.
      expect(yield* ticket(store, "tk_x", "blocked")).toBeDefined()

      yield* store.append("fine", [{ type: "ticket_created", at: 1, ticket: { id: "tk_y", number: 1, title: "Y", body: "" } }])
      yield* store.flush
      expect(yield* Effect.promise(() => readFile(path.join(dataDir, "tickets", "fine.jsonl"), "utf8"))).toContain("tk_y")
    }))
  })
})

async function mkdirTickets() {
  const dir = path.join(dataDir, "tickets")
  await mkdir(dir, { recursive: true })
  return dir
}
