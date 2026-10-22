import { describe, expect, test } from "bun:test"
import { hasViewerLevelBelow, viewerLevelBelow } from "./viewer-levels"

const LIST = { kind: "delegated", chatId: "deleg" } as const
const FILE = { kind: "file", projectId: "p1", path: "README.md" } as const

describe("viewerLevelBelow on an ordinary chat", () => {
  test("a chat or a file opened from the transcript has the shut pane under it", () => {
    expect(viewerLevelBelow({ item: { kind: "chat", chatId: "a" } }, null)).toBe("closed")
    expect(viewerLevelBelow({ item: FILE }, null)).toBe("closed")
  })

  test("a file opened over a chat goes back to the chat", () => {
    const chat = { kind: "chat", chatId: "a" } as const
    expect(viewerLevelBelow({ item: FILE, returnTo: { item: chat } }, null))
      .toEqual({ item: chat })
  })

  test("a chat stepped to from another goes back to it", () => {
    expect(viewerLevelBelow({ item: { kind: "chat", chatId: "c", back: ["a", "b"] } }, null))
      .toEqual({ item: { kind: "chat", chatId: "b", back: ["a"] } })
    expect(viewerLevelBelow({ item: { kind: "chat", chatId: "b", back: ["a"] } }, null))
      .toEqual({ item: { kind: "chat", chatId: "a" } })
  })

  test("a chat picked from a delegator's list goes back to the list where there is no floor (a phone)", () => {
    expect(viewerLevelBelow({ item: { kind: "chat", chatId: "a", delegated: "deleg" } }, null)).toEqual({ item: LIST })
    expect(viewerLevelBelow({ item: LIST }, null)).toBe("closed")
  })
})

describe("viewerLevelBelow on a delegator, whose pane has a floor", () => {
  test("the list is the last thing in the pane: under it the pane is shut", () => {
    expect(viewerLevelBelow({ item: LIST }, LIST)).toBe("closed")
    expect(viewerLevelBelow({ item: LIST }, LIST)).toBe("closed")
  })

  test("anything opened from the transcript goes back to the list", () => {
    expect(viewerLevelBelow({ item: { kind: "chat", chatId: "a" } }, LIST)).toEqual({ item: LIST })
    // The pane's width is the pane's: a file leaves it as it found it.
    expect(viewerLevelBelow({ item: FILE }, LIST)).toEqual({ item: LIST })
  })

  test("something opened inside a previewed chat goes back to that chat first", () => {
    const chat = { kind: "chat", chatId: "b", back: ["a"] } as const
    expect(viewerLevelBelow({ item: FILE, returnTo: { item: chat } }, LIST)).toEqual({ item: chat })
    expect(viewerLevelBelow({ item: chat }, LIST)).toEqual({ item: { kind: "chat", chatId: "a" } })
    expect(viewerLevelBelow({ item: { kind: "chat", chatId: "a" } }, LIST)).toEqual({ item: LIST })
  })

  test("a file opened over the list goes back to the list", () => {
    expect(viewerLevelBelow({ item: FILE, returnTo: { item: LIST } }, LIST))
      .toEqual({ item: LIST })
  })

  test("another delegator's list is not this pane's floor", () => {
    expect(viewerLevelBelow({ item: { kind: "delegated", chatId: "other" } }, LIST)).toEqual({ item: LIST })
  })
})

describe("hasViewerLevelBelow", () => {
  test("is what decides whether there is a Back", () => {
    expect(hasViewerLevelBelow({ item: LIST }, LIST)).toBe(false)
    expect(hasViewerLevelBelow({ item: FILE }, LIST)).toBe(true)
    expect(hasViewerLevelBelow({ item: FILE }, null)).toBe(false)
    expect(hasViewerLevelBelow({ item: { kind: "chat", chatId: "b", back: ["a"] } }, null)).toBe(true)
  })
})
