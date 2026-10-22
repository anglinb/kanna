import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import type { ChatRecord } from "./events"
import { runTest } from "./effect/testing"
import {
  codexUsageLimitResetAt,
  dueUsageLimitResumes,
  isCodexUsageLimitFailure,
  resumeDueUsageLimitChats,
  startUsageLimitResumer,
} from "./usage-limit-resume"

const NOW = 1_900_000_000_000

function chat(id: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id, projectId: "p1", title: id, createdAt: 1, updatedAt: 1, unread: false, provider: "claude",
    planMode: false, autoPlan: false, sessionToken: "s", lastTurnOutcome: "failed", ...overrides,
  }
}

const stateOf = (chats: ChatRecord[]) => ({ chatsById: new Map(chats.map((entry) => [entry.id, entry])) })

describe("codexUsageLimitResetAt", () => {
  test("waits for every full window: the latest of their resets", () => {
    expect(codexUsageLimitResetAt({
      rateLimits: { primary: { usedPercent: 100, resetsAt: 1_000 }, secondary: { usedPercent: 100, resetsAt: 5_000 } },
      rateLimitsByLimitId: { other: { primary: { usedPercent: 10, resetsAt: 9_000 } } },
    }, 0)).toBe(5_000_000)
  })

  test("with no window reported full, the next reset ahead; with no resets, none", () => {
    expect(codexUsageLimitResetAt({ rateLimits: { primary: { usedPercent: 90, resetsAt: 3_000 }, secondary: { usedPercent: 50, resetsAt: 1 } } }, 2_000_000)).toBe(3_000_000)
    expect(codexUsageLimitResetAt({ rateLimits: { primary: { usedPercent: 100 } } }, 0)).toBeNull()
    expect(codexUsageLimitResetAt(null, 0)).toBeNull()
  })

  test("recognizes Codex's cause for running out", () => {
    expect(isCodexUsageLimitFailure("You've hit your usage limit.: usageLimitExceeded")).toBe(true)
    expect(isCodexUsageLimitFailure("stream disconnected: responseStreamDisconnected (HTTP 502)")).toBe(false)
  })
})

describe("the resumer", () => {
  test("picks marked chats that are due, soonest first, leaving archived and deleted ones", () => {
    const state = stateOf([
      chat("later", { usageLimitResume: { at: NOW + 1, provider: "claude" } }),
      chat("second", { usageLimitResume: { at: NOW - 10, provider: "codex" } }),
      chat("first", { usageLimitResume: { at: NOW - 20, provider: "claude" } }),
      chat("archived", { usageLimitResume: { at: NOW - 30, provider: "claude" }, archivedAt: 5 }),
      chat("deleted", { usageLimitResume: { at: NOW - 30, provider: "claude" }, deletedAt: 5 }),
      chat("unmarked"),
    ])
    expect(dueUsageLimitResumes(state, NOW).map((entry) => entry.id)).toEqual(["first", "second"])
  })

  test("one chat that fails to resume does not stop the next", async () => {
    const attempted: string[] = []
    const resumed = await runTest(resumeDueUsageLimitChats({
      state: () => stateOf([
        chat("broken", { usageLimitResume: { at: NOW - 20, provider: "claude" } }),
        chat("fine", { usageLimitResume: { at: NOW - 10, provider: "claude" } }),
      ]),
      resume: (chatId) => Effect.suspend(() => {
        attempted.push(chatId)
        return chatId === "broken" ? Effect.die(new Error("boom")) : Effect.succeed(true)
      }),
      now: () => NOW,
    }))
    expect(attempted).toEqual(["broken", "fine"])
    expect(resumed).toEqual(["fine"])
  })

  test("checks on start and then on every poll, until its scope closes", async () => {
    const chats = [chat("c1")]
    const attempted: string[] = []
    let clock = NOW
    await runTest(Effect.gen(function* () {
      const fiber = yield* startUsageLimitResumer({
        state: () => stateOf(chats),
        resume: (chatId) => Effect.sync(() => {
          attempted.push(chatId)
          delete chats[0]!.usageLimitResume
          return true
        }),
        now: () => clock,
      }, 1_000)
      yield* Effect.yieldNow
      expect(attempted).toEqual([])
      chats[0]!.usageLimitResume = { at: NOW + 500, provider: "claude" }
      clock = NOW + 600
      yield* TestClock.adjust(1_000)
      expect(attempted).toEqual(["c1"])
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(TestClock.layer())))
  })
})
