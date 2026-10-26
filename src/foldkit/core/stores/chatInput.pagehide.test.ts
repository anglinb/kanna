import { afterEach, expect, test } from "bun:test"

// noteTypedDraft: a page left before the keystroke reached the store still
// keeps it (pagehide writes it over the last saved state).

function installWindow(stored: Record<string, string>) {
  const target = new EventTarget()
  const localStorage = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value
    },
    removeItem: (key: string) => {
      delete stored[key]
    },
  }
  ;(globalThis as { window?: unknown }).window = Object.assign(target, { localStorage })
  return target
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

test("text typed and not saved yet is written when the page goes", async () => {
  const stored: Record<string, string> = {
    "chat-input-drafts": JSON.stringify({ state: { drafts: { other: "kept" }, startedChats: {} }, version: 0 }),
  }
  const target = installWindow(stored)
  const { noteTypedDraft } = await import("./chatInput")
  noteTypedDraft("c1", "half a thought")
  target.dispatchEvent(new Event("pagehide"))
  const saved = JSON.parse(stored["chat-input-drafts"]!)
  expect(saved.state.drafts).toEqual({ other: "kept", c1: "half a thought" })
  expect(saved.state.startedChats).toEqual({})
  expect(saved.version).toBe(0)
})
