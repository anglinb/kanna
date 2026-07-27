import { describe, expect, test } from "bun:test"
import type { ChatSnapshot, TranscriptEntry } from "../../shared/types"
import { applyIncrementalChatSnapshot } from "./snapshotEquality"

function entry(id: string): TranscriptEntry {
  return { _id: id, createdAt: 0, kind: "assistant_text", text: id } as TranscriptEntry
}

function snapshot(startIndex: number, ids: string[], incremental?: boolean): ChatSnapshot {
  return {
    runtime: {
      chatId: "chat-1",
      projectId: "project-1",
      localPath: "/tmp",
      title: "t",
      status: "idle",
      isDraining: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
    },
    queuedMessages: [],
    messages: ids.map(entry),
    startIndex,
    ...(incremental ? { incremental: true } : {}),
    history: { hasOlder: startIndex > 0, olderCursor: null, recentLimit: 200 },
    availableProviders: [],
    readAnchor: null,
  }
}

const ids = (value: ChatSnapshot | null) => value?.messages.map((message) => message._id)

describe("applyIncrementalChatSnapshot", () => {
  test("a non-incremental snapshot replaces what is held", () => {
    const current = snapshot(10, ["a", "b"])
    const next = applyIncrementalChatSnapshot(current, snapshot(20, ["c"]))
    expect(ids(next)).toEqual(["c"])
    expect(next?.startIndex).toBe(20)
  })

  test("an incremental snapshot appends at its absolute index", () => {
    const current = snapshot(10, ["a", "b"])
    const next = applyIncrementalChatSnapshot(current, snapshot(12, ["c", "d"], true))

    expect(ids(next)).toEqual(["a", "b", "c", "d"])
    // The merged window keeps the held start, and is no longer a fragment.
    expect(next?.startIndex).toBe(10)
    expect(next?.incremental).toBe(false)
  })

  test("an overlapping incremental body replaces the entries it covers", () => {
    // The server re-sends from a point it already sent when a turn's trailing
    // entry is rewritten; the later copy must win rather than duplicate.
    const current = snapshot(10, ["a", "b", "c"])
    const next = applyIncrementalChatSnapshot(current, snapshot(11, ["b2", "c2"], true))
    expect(ids(next)).toEqual(["a", "b2", "c2"])
  })

  test("a gap ahead of the held window is refused rather than papered over", () => {
    const current = snapshot(10, ["a", "b"])
    // startIndex 13 leaves index 12 missing.
    expect(applyIncrementalChatSnapshot(current, snapshot(13, ["e"], true))).toBeNull()
  })

  test("a body starting before the held window is refused", () => {
    const current = snapshot(10, ["a", "b"])
    expect(applyIncrementalChatSnapshot(current, snapshot(8, ["x"], true))).toBeNull()
  })

  test("an incremental body with nothing held is refused", () => {
    expect(applyIncrementalChatSnapshot(null, snapshot(4, ["a"], true))).toBeNull()
  })

  test("a null snapshot clears, incremental or not", () => {
    expect(applyIncrementalChatSnapshot(snapshot(0, ["a"]), null)).toBeNull()
  })
})
