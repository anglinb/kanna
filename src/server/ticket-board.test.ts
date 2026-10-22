import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, Option, Result } from "effect"
import type { TicketChatInfo } from "../shared/tickets"
import { runTest } from "./effect/testing"
import { TicketBoard } from "./ticket-board"
import { TicketStore } from "./ticket-store"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A board over a fresh store, with every chat it is asked about working. */
async function boardLayer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-ticket-board-"))
  tempDirs.push(dataDir)
  const chatInfo = (chatId: string): TicketChatInfo => ({ chatId, title: `Chat ${chatId}`, state: "working" })
  return TicketBoard.layer({ chatInfo, now: () => 1_000 }).pipe(Layer.provide(TicketStore.layer({ dataDir })))
}

describe("TicketBoard", () => {
  test("a ticket it does not have fails with the message the delegator reads", async () => {
    const result = await runTest(Effect.gen(function* () {
      const board = yield* TicketBoard
      return yield* Effect.result(board.require("delegator-1", "tk_nope00"))
    }).pipe(Effect.provide(await boardLayer())))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/ticket-board/TicketNotFoundError")
      expect(result.failure.message).toBe("Ticket tk_nope00 not found on this delegator's board. list_tickets shows its tickets.")
    }
  })

  test("refuses a ticket with no title and a reply with nothing in it", async () => {
    const [untitled, empty] = await runTest(Effect.gen(function* () {
      const board = yield* TicketBoard
      const ticket = yield* board.create("delegator-1", { title: "Fix the flicker" })
      return [
        yield* Effect.result(board.create("delegator-1", { title: "   " })),
        yield* Effect.result(board.reply("delegator-1", ticket.id, { author: "user", text: "  " })),
      ] as const
    }).pipe(Effect.provide(await boardLayer())))

    expect(Result.isFailure(untitled) && untitled.failure.message).toBe("A ticket needs a title.")
    expect(Result.isFailure(empty) && empty.failure.message).toBe("A reply needs text or a file.")
  })

  test("a write is read straight back, and a user's reply is news until the delegator answers it", async () => {
    const { summary, nudged, answered } = await runTest(Effect.gen(function* () {
      const board = yield* TicketBoard
      const ticket = yield* board.create("delegator-1", { title: "Fix the flicker", body: " in the sidebar " })
      yield* board.reply("delegator-1", ticket.id, { author: "user", text: "Any news?" })
      const summary = board.summary(Option.getOrThrow(yield* board.get("delegator-1", ` ${ticket.id} `)))
      const nudged = yield* board.takeUnanswered("delegator-1")

      yield* board.reply("delegator-1", ticket.id, { author: "user", text: "Still there?" })
      yield* board.reply("delegator-1", ticket.id, { author: "delegator", text: "On it." })
      return { summary, nudged, answered: yield* board.takeUnanswered("delegator-1") }
    }).pipe(Effect.provide(await boardLayer())))

    expect(summary).toMatchObject({ number: 1, title: "Fix the flicker", replyCount: 1 })
    expect(nudged.map(({ ticket, reasons }) => [ticket.number, reasons])).toEqual([[1, [{ kind: "user_reply" }]]])
    expect(answered).toEqual([])
  })
})
