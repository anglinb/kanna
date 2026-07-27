import { describe, expect, test } from "bun:test"
import { CHAT_TURN_INDEX_LIMIT, CHAT_TURN_SUMMARY_TEXT_LIMIT, type TranscriptEntry } from "../shared/types"
import { appendTurnEntry, buildTurnIndex } from "./chat-turn-index"

let sequence = 0
function entry(partial: Record<string, unknown>): TranscriptEntry {
  sequence += 1
  return { _id: `e${sequence}`, createdAt: 1_700_000_000_000, ...partial } as unknown as TranscriptEntry
}

const prompt = (id: string, content: string, createdAt = 1_700_000_000_000) =>
  ({ _id: id, createdAt, kind: "user_prompt", content }) as unknown as TranscriptEntry
const assistant = (text: string) => entry({ kind: "assistant_text", text })
const result = (partial: Record<string, unknown>) =>
  entry({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "", ...partial })

describe("buildTurnIndex", () => {
  test("summarises a turn from its prompt, text and result", () => {
    const turns = buildTurnIndex([
      prompt("p1", "explain the codebase", 1_700_000_000_500),
      assistant("I'm mapping the repo first"),
      result({ durationMs: 12_000 }),
    ])

    expect(turns).toEqual([{
      id: "p1",
      prompt: "explain the codebase",
      response: "I'm mapping the repo first",
      error: null,
      createdAt: 1_700_000_000_500,
      durationMs: 12_000,
    }])
  })

  test("opens a new turn per prompt", () => {
    const turns = buildTurnIndex([
      prompt("p1", "first"),
      assistant("one"),
      prompt("p2", "second"),
      assistant("two"),
    ])

    expect(turns.map((turn) => [turn.id, turn.response])).toEqual([["p1", "one"], ["p2", "two"]])
  })

  test("keeps the turn's last assistant message", () => {
    const turns = buildTurnIndex([prompt("p1", "q"), assistant("thinking"), assistant("final")])
    expect(turns[0]?.response).toBe("final")
  })

  test("blank assistant text does not wipe a summary", () => {
    const turns = buildTurnIndex([prompt("p1", "q"), assistant("real"), assistant("   ")])
    expect(turns[0]?.response).toBe("real")
  })

  test("records an error and its duration", () => {
    const turns = buildTurnIndex([
      prompt("p1", "q"),
      result({ subtype: "error", isError: true, result: "Authentication required.", durationMs: 400 }),
    ])

    expect(turns[0]).toMatchObject({ error: "Authentication required.", durationMs: 400, response: null })
  })

  test("labels an error that carries no text", () => {
    const turns = buildTurnIndex([prompt("p1", "q"), result({ subtype: "error", isError: true, result: "" })])
    expect(turns[0]?.error).toBe("Turn failed")
  })

  test("does not mark a cancelled turn as failed", () => {
    const turns = buildTurnIndex([
      prompt("p1", "q"),
      assistant("partial"),
      result({ subtype: "cancelled", isError: true, result: "" }),
    ])

    expect(turns[0]).toMatchObject({ error: null, response: "partial" })
  })

  test("skips hidden entries", () => {
    const turns = buildTurnIndex([
      entry({ kind: "user_prompt", content: "visible" }),
      entry({ kind: "assistant_text", text: "hidden reply", hidden: true }),
      entry({ kind: "user_prompt", content: "hidden prompt", hidden: true }),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ prompt: "visible", response: null })
  })

  test("ignores entries before the first prompt", () => {
    const turns = buildTurnIndex([assistant("orphan tail"), result({}), prompt("p1", "q")])
    expect(turns.map((turn) => turn.id)).toEqual(["p1"])
  })

  test("truncates long text with an ellipsis", () => {
    const long = "x".repeat(CHAT_TURN_SUMMARY_TEXT_LIMIT + 50)
    const turns = buildTurnIndex([prompt("p1", long), assistant(long)])

    expect(turns[0]?.prompt).toHaveLength(CHAT_TURN_SUMMARY_TEXT_LIMIT)
    expect(turns[0]?.prompt.endsWith("…")).toBe(true)
    expect(turns[0]?.response).toHaveLength(CHAT_TURN_SUMMARY_TEXT_LIMIT)
  })

  test("leaves text at the limit untouched", () => {
    const exact = "x".repeat(CHAT_TURN_SUMMARY_TEXT_LIMIT)
    expect(buildTurnIndex([prompt("p1", exact)])[0]?.prompt).toBe(exact)
  })

  // The index is a payload sent to every subscribed client; it cannot grow
  // without bound just because a chat is long.
  test("keeps only the most recent turns", () => {
    const entries = Array.from({ length: CHAT_TURN_INDEX_LIMIT + 25 }, (_, index) =>
      prompt(`p${index}`, `turn ${index}`))

    const turns = buildTurnIndex(entries)

    expect(turns).toHaveLength(CHAT_TURN_INDEX_LIMIT)
    expect(turns[0]?.id).toBe("p25")
    expect(turns[turns.length - 1]?.id).toBe(`p${CHAT_TURN_INDEX_LIMIT + 24}`)
  })

  test("is empty for a transcript with no prompts", () => {
    expect(buildTurnIndex([])).toEqual([])
    expect(buildTurnIndex([assistant("hi")])).toEqual([])
  })
})

describe("appendTurnEntry", () => {
  // The cold build and the on-append extension share this fold, so appending
  // entry by entry must land exactly where a full rebuild would.
  test("extends an existing index the same way a rebuild would", () => {
    const entries = [
      prompt("p1", "first"),
      assistant("one"),
      result({ durationMs: 500 }),
      prompt("p2", "second"),
      assistant("two"),
    ]

    const incremental: ReturnType<typeof buildTurnIndex> = []
    for (const item of entries) appendTurnEntry(incremental, item)

    expect(incremental).toEqual(buildTurnIndex(entries))
  })
})
