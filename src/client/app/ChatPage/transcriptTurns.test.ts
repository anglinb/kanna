import { describe, expect, test } from "bun:test"
import type { ResolvedTranscriptRow } from "../KannaTranscript"
import {
  buildTranscriptTurns,
  getMagnifyFalloff,
  getMinimapCapacity,
  getTranscriptGutterWidth,
  isTurnInView,
  mergeTurnIndex,
  getVisibleRowRange,
  selectVisibleTurns,
  type TranscriptTurn,
} from "./transcriptTurns"

const TIMESTAMP = "2026-07-26T00:00:00.000Z"

function singleRow(id: string, message: Record<string, unknown>): ResolvedTranscriptRow {
  return {
    kind: "single",
    id,
    index: 0,
    isLoading: false,
    message: { id, timestamp: TIMESTAMP, ...message },
  } as unknown as ResolvedTranscriptRow
}

function toolGroupRow(id: string): ResolvedTranscriptRow {
  return {
    kind: "tool-group",
    id: `tool-group:${id}`,
    startIndex: 0,
    isLoading: false,
    messages: [{ id, kind: "unknown", json: "{}", timestamp: "2026-07-26T00:00:00.000Z" }],
  } as unknown as ResolvedTranscriptRow
}

const prompt = (id: string, content: string) => singleRow(id, { kind: "user_prompt", content })
const assistant = (id: string, text: string) => singleRow(id, { kind: "assistant_text", text })
const okResult = (id: string) => singleRow(id, { kind: "result", success: true, result: "" })
const errorResult = (id: string, result: string) =>
  singleRow(id, { kind: "result", success: false, result })
const cancelledResult = (id: string) =>
  singleRow(id, { kind: "result", success: false, cancelled: true, result: "" })

describe("buildTranscriptTurns", () => {
  test("opens a turn per user prompt and closes it at the next one", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "first question"),
      assistant("a1", "first answer"),
      toolGroupRow("t1"),
      prompt("p2", "second question"),
      assistant("a2", "second answer"),
    ])

    expect(turns).toEqual([
      { id: "p1", rowIndex: 0, endRowIndex: 2, prompt: "first question", response: "first answer", error: null, timestamp: TIMESTAMP, durationMs: null },
      { id: "p2", rowIndex: 3, endRowIndex: 4, prompt: "second question", response: "second answer", error: null, timestamp: TIMESTAMP, durationMs: null },
    ])
  })

  test("keeps the turn's last assistant message, not its first", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "q"),
      assistant("a1", "thinking out loud"),
      assistant("a2", "final word"),
    ])

    expect(turns[0]?.response).toBe("final word")
  })

  test("drops rows before the first prompt", () => {
    const turns = buildTranscriptTurns([
      singleRow("s1", { kind: "system_init", model: "m", tools: [], agents: [], slashCommands: [], mcpServers: [], provider: "claude" }),
      assistant("a0", "orphan tail from a restored session"),
      prompt("p1", "q"),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ id: "p1", rowIndex: 2, endRowIndex: 2 })
  })

  test("an in-flight turn has no response yet", () => {
    const turns = buildTranscriptTurns([prompt("p1", "q"), toolGroupRow("t1")])

    expect(turns[0]).toMatchObject({ response: null, endRowIndex: 1 })
  })

  test("returns nothing for an empty transcript", () => {
    expect(buildTranscriptTurns([])).toEqual([])
  })
})

describe("buildTranscriptTurns — timing", () => {
  test("takes the timestamp from the prompt that opened the turn", () => {
    const asked = "2026-07-26T09:15:00.000Z"
    const turns = buildTranscriptTurns([
      singleRow("p1", { kind: "user_prompt", content: "go", timestamp: asked }),
      singleRow("a1", { kind: "assistant_text", text: "done", timestamp: "2026-07-26T09:16:00.000Z" }),
    ])

    expect(turns[0]?.timestamp).toBe(asked)
  })

  test("takes the duration from the result", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      singleRow("r1", { kind: "result", success: true, result: "", durationMs: 12_000 }),
    ])

    expect(turns[0]?.durationMs).toBe(12_000)
  })

  // How long a turn ran before dying is worth as much as how long a good one took.
  test("keeps the duration of a failed turn", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      singleRow("r1", { kind: "result", success: false, result: "boom", durationMs: 400 }),
    ])

    expect(turns[0]).toMatchObject({ durationMs: 400, error: "boom" })
  })

  test("a running turn has no duration yet", () => {
    expect(buildTranscriptTurns([prompt("p1", "go")])[0]?.durationMs).toBeNull()
  })

  test("rejects a timestamp that is not a usable date", () => {
    const rows = [
      singleRow("p1", { kind: "user_prompt", content: "a", timestamp: "not a date" }),
      singleRow("p2", { kind: "user_prompt", content: "b", timestamp: undefined }),
    ]

    expect(buildTranscriptTurns(rows).map((turn) => turn.timestamp)).toEqual([null, null])
  })

  test("ignores a non-numeric duration", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      singleRow("r1", { kind: "result", success: true, result: "", durationMs: undefined }),
    ])

    expect(turns[0]?.durationMs).toBeNull()
  })
})

describe("buildTranscriptTurns — errored turns", () => {
  // A provider that dies on startup emits no assistant text at all, so without
  // capturing the result the turn would read as blank in the hover card.
  test("uses the error result as the turn's outcome", () => {
    const message = "Authentication required. Please run 'agent login' first."
    const turns = buildTranscriptTurns([prompt("p1", "go"), errorResult("r1", message)])

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ rowIndex: 0, endRowIndex: 1, response: null, error: message })
  })

  test("keeps partial assistant text alongside the error", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      assistant("a1", "starting on it"),
      errorResult("r1", "provider crashed"),
    ])

    expect(turns[0]).toMatchObject({ response: "starting on it", error: "provider crashed" })
  })

  test("falls back to a label when the error carries no text", () => {
    const turns = buildTranscriptTurns([prompt("p1", "go"), errorResult("r1", "   ")])

    expect(turns[0]?.error).toBe("Turn failed")
  })

  test("does not mark a cancelled turn as failed", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      assistant("a1", "partial work"),
      cancelledResult("r1"),
    ])

    expect(turns[0]).toMatchObject({ error: null, response: "partial work" })
  })

  test("leaves a successful turn unmarked", () => {
    const turns = buildTranscriptTurns([prompt("p1", "go"), assistant("a1", "done"), okResult("r1")])

    expect(turns[0]).toMatchObject({ error: null, response: "done" })
  })

  // Two failure modes leave a turn with no rows but its own prompt: the server
  // throwing after the prompt was persisted (the error only reaches the
  // footer), and a steered turn whose `interrupted` entry is written hidden.
  test("a turn with no content rows spans only its prompt", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "first"),
      prompt("p2", "second"),
      assistant("a1", "answer"),
    ])

    expect(turns[0]).toMatchObject({ rowIndex: 0, endRowIndex: 0, response: null, error: null })
    expect(turns[1]).toMatchObject({ rowIndex: 1, endRowIndex: 2, response: "answer" })
  })

  test("a content-less turn still highlights while its prompt is on screen", () => {
    const [orphan] = buildTranscriptTurns([prompt("p1", "first"), prompt("p2", "second")])

    expect(orphan).toBeDefined()
    expect(isTurnInView(orphan!, 0, 0)).toBe(true)
    expect(isTurnInView(orphan!, 1, 1)).toBe(false)
  })

  // The transcript log is append-only and replays entries from older versions,
  // so these fields can be missing at runtime despite being typed as required.
  test("survives entries missing the text fields the types promise", () => {
    const rows = [
      singleRow("p1", { kind: "user_prompt" }),
      singleRow("a1", { kind: "assistant_text" }),
      singleRow("r1", { kind: "result", success: false }),
    ]

    expect(() => buildTranscriptTurns(rows)).not.toThrow()
    expect(buildTranscriptTurns(rows)[0]).toMatchObject({
      prompt: "",
      response: null,
      error: "Turn failed",
    })
  })

  test("blank assistant text does not wipe an existing summary", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      assistant("a1", "real summary"),
      assistant("a2", "   "),
    ])

    expect(turns[0]?.response).toBe("real summary")
  })

  test("an errored turn mid-transcript does not swallow the next turn", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "first"),
      errorResult("r1", "boom"),
      prompt("p2", "second"),
      assistant("a2", "recovered"),
      okResult("r2"),
    ])

    expect(turns.map((turn) => [turn.rowIndex, turn.endRowIndex])).toEqual([[0, 1], [2, 4]])
    expect(turns[1]?.error).toBeNull()
  })
})

describe("isTurnInView", () => {
  const turn = (rowIndex: number, endRowIndex: number) =>
    ({ id: "t", rowIndex, endRowIndex, prompt: "", response: null, error: null, timestamp: null, durationMs: null }) satisfies TranscriptTurn

  test("counts a turn that merely overlaps the window", () => {
    // Turn spans the whole viewport with neither edge inside it.
    expect(isTurnInView(turn(0, 100), 40, 50)).toBe(true)
    expect(isTurnInView(turn(45, 60), 40, 50)).toBe(true)
    expect(isTurnInView(turn(30, 45), 40, 50)).toBe(true)
  })

  test("excludes turns entirely above or below", () => {
    expect(isTurnInView(turn(0, 39), 40, 50)).toBe(false)
    expect(isTurnInView(turn(51, 80), 40, 50)).toBe(false)
  })

  test("includes turns touching the window edges", () => {
    expect(isTurnInView(turn(0, 40), 40, 50)).toBe(true)
    expect(isTurnInView(turn(50, 80), 40, 50)).toBe(true)
  })
})

describe("mergeTurnIndex", () => {
  const summary = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    prompt: `${id} question`,
    response: `${id} answer`,
    error: null,
    createdAt: 1_700_000_000_000,
    durationMs: null,
    ...overrides,
  })

  test("keeps turns the client has not loaded, with no row span", () => {
    const merged = mergeTurnIndex([summary("p1"), summary("p2")], [])

    expect(merged.map((turn) => turn.id)).toEqual(["p1", "p2"])
    expect(merged[0]).toMatchObject({ rowIndex: null, endRowIndex: null, prompt: "p1 question" })
  })

  test("a turn outside the loaded window is never in view", () => {
    const [unloaded] = mergeTurnIndex([summary("p1")], [])
    expect(isTurnInView(unloaded!, 0, 999)).toBe(false)
  })

  test("loaded turns supersede their summary, bringing row spans", () => {
    const loaded = buildTranscriptTurns([prompt("p2", "full question"), assistant("a1", "full answer")])
    const merged = mergeTurnIndex([summary("p1"), summary("p2")], loaded)

    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ id: "p1", rowIndex: null })
    expect(merged[1]).toMatchObject({ id: "p2", rowIndex: 0, endRowIndex: 1, prompt: "full question" })
  })

  test("converts the summary timestamp to an ISO string", () => {
    const [turn] = mergeTurnIndex([summary("p1", { createdAt: 1_700_000_000_500 })], [])
    expect(turn?.timestamp).toBe(new Date(1_700_000_000_500).toISOString())
  })

  test("carries a failed turn's error through", () => {
    const [turn] = mergeTurnIndex([summary("p1", { error: "boom", response: null })], [])
    expect(turn).toMatchObject({ error: "boom", response: null })
  })

  // An optimistic prompt exists only on the client until the server echoes it.
  test("appends loaded turns newer than anything the index knows", () => {
    const loaded = buildTranscriptTurns([
      prompt("p2", "known"),
      prompt("optimistic:new", "just sent"),
    ])
    const merged = mergeTurnIndex([summary("p1"), summary("p2")], loaded)

    expect(merged.map((turn) => turn.id)).toEqual(["p1", "p2", "optimistic:new"])
  })

  test("does not append loaded turns older than the index reaches", () => {
    // p0 predates the index window; appending it would put it out of order.
    const loaded = buildTranscriptTurns([prompt("p0", "ancient"), prompt("p2", "known")])
    const merged = mergeTurnIndex([summary("p2")], loaded)

    expect(merged.map((turn) => turn.id)).toEqual(["p2"])
  })

  test("falls back to the loaded turns when the index is empty", () => {
    const loaded = buildTranscriptTurns([prompt("p1", "q")])
    expect(mergeTurnIndex([], loaded)).toBe(loaded)
  })
})

describe("getVisibleRowRange", () => {
  /** `count` rows of uniform `size`, laid out end to end from 0. */
  const uniform = (count: number, size = 100) => ({
    count,
    positionAtIndex: (index: number) => index * size,
    sizeAtIndex: () => size,
  })

  test("finds the rows overlapping the band", () => {
    // Band 250-450 touches rows 2 (200-300), 3 (300-400) and 4 (400-500).
    expect(getVisibleRowRange(uniform(10), 250, 450)).toEqual({ start: 2, end: 4 })
  })

  test("includes a row that only partly overlaps each edge", () => {
    expect(getVisibleRowRange(uniform(10), 299, 301)).toEqual({ start: 2, end: 3 })
  })

  test("handles the first and last rows", () => {
    expect(getVisibleRowRange(uniform(10), 0, 150)).toEqual({ start: 0, end: 1 })
    expect(getVisibleRowRange(uniform(10), 950, 1000)).toEqual({ start: 9, end: 9 })
  })

  test("returns a single row when the band sits inside one", () => {
    expect(getVisibleRowRange(uniform(10), 320, 380)).toEqual({ start: 3, end: 3 })
  })

  test("returns null when the band is past the end of the content", () => {
    expect(getVisibleRowRange(uniform(10), 2000, 2100)).toBeNull()
  })

  test("returns null for an empty or degenerate list", () => {
    expect(getVisibleRowRange(uniform(0), 0, 100)).toBeNull()
    expect(getVisibleRowRange(uniform(10), 100, 100)).toBeNull()
    expect(getVisibleRowRange(uniform(10), 400, 200)).toBeNull()
  })

  test("copes with rows of differing heights", () => {
    // Tops at 0, 10, 510, 530 — a tall row 1 spans most of the band.
    const sizes = [10, 500, 20, 40]
    const tops = [0, 10, 510, 530]
    const metrics = {
      count: 4,
      positionAtIndex: (index: number) => tops[index]!,
      sizeAtIndex: (index: number) => sizes[index]!,
    }

    expect(getVisibleRowRange(metrics, 200, 300)).toEqual({ start: 1, end: 1 })
    expect(getVisibleRowRange(metrics, 0, 5)).toEqual({ start: 0, end: 0 })
    expect(getVisibleRowRange(metrics, 505, 560)).toEqual({ start: 1, end: 3 })
  })
})

describe("getMinimapCapacity", () => {
  test("fits as many ticks as the height allows", () => {
    expect(getMinimapCapacity(140, 14, 40)).toBe(10)
    expect(getMinimapCapacity(145, 14, 40)).toBe(10)
  })

  test("caps at the tick maximum on a tall window", () => {
    expect(getMinimapCapacity(2000, 14, 40)).toBe(40)
  })

  test("returns zero before measurement lands", () => {
    expect(getMinimapCapacity(0, 14, 40)).toBe(0)
    expect(getMinimapCapacity(-20, 14, 40)).toBe(0)
    expect(getMinimapCapacity(Number.NaN, 14, 40)).toBe(0)
  })
})

describe("selectVisibleTurns", () => {
  const turns = Array.from({ length: 5 }, (_, index) => (
    { id: `t${index}`, rowIndex: index, endRowIndex: index, prompt: "", response: null, error: null, timestamp: null, durationMs: null }
  ))

  test("keeps the most recent turns when over capacity", () => {
    expect(selectVisibleTurns(turns, 2).map((turn) => turn.id)).toEqual(["t3", "t4"])
  })

  test("passes everything through when under capacity", () => {
    expect(selectVisibleTurns(turns, 10)).toEqual(turns)
  })

  test("shows nothing at zero capacity", () => {
    expect(selectVisibleTurns(turns, 0)).toEqual([])
  })
})

describe("getMagnifyFalloff", () => {
  test("peaks under the cursor and dies at the radius", () => {
    expect(getMagnifyFalloff(0, 56)).toBe(1)
    expect(getMagnifyFalloff(56, 56)).toBe(0)
    expect(getMagnifyFalloff(200, 56)).toBe(0)
  })

  test("is symmetric and monotonic between", () => {
    const near = getMagnifyFalloff(14, 56)
    const far = getMagnifyFalloff(42, 56)
    expect(near).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(0)
    expect(getMagnifyFalloff(-14, 56)).toBeCloseTo(near)
  })

  test("degrades safely with no radius", () => {
    expect(getMagnifyFalloff(10, 0)).toBe(0)
  })
})

describe("getTranscriptGutterWidth", () => {
  test("splits the leftover width either side of the column", () => {
    expect(getTranscriptGutterWidth(1224, 800, 24)).toBe(200)
  })

  test("is zero once the column fills the pane", () => {
    expect(getTranscriptGutterWidth(800, 800, 24)).toBe(0)
    expect(getTranscriptGutterWidth(390, 800, 24)).toBe(0)
  })

  test("is zero before measurement lands", () => {
    expect(getTranscriptGutterWidth(0, 800, 24)).toBe(0)
  })
})
