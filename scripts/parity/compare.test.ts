import { describe, expect, test } from "bun:test"
import { compareAria, compareCommands, comparePaint, comparePixels, compareSubscriptions, normalizeIds, type PaintItem } from "./compare"

const item = (overrides: Partial<PaintItem> = {}): PaintItem => ({
  tag: "div",
  box: [10, 20, 100, 24],
  text: "Fix the build",
  style: { color: "rgb(255, 255, 255)", cursor: "pointer" },
  ...overrides,
})

describe("comparePaint", () => {
  test("ignores tag names and a 1px box wobble", () => {
    const result = comparePaint([item()], [item({ tag: "span", box: [11, 20, 100, 25] })])
    expect(result.status).toBe("identical")
  })

  test("reports a style change on a matched element", () => {
    const result = comparePaint([item()], [item({ style: { color: "rgb(255, 255, 255)", cursor: "default" } })])
    expect(result.status).toBe("different")
    expect(result.detail[0]).toContain("cursor pointer → default")
  })

  test("reports missing and extra elements", () => {
    const result = comparePaint([item()], [item({ box: [10, 40, 100, 24] })])
    expect(result.detail.some((line) => line.startsWith("missing in candidate"))).toBe(true)
    expect(result.detail.some((line) => line.startsWith("extra in candidate"))).toBe(true)
  })
})

describe("compareAria", () => {
  test("diffs by line", () => {
    const result = compareAria('- button "Send"\n- textbox "Prompt"', '- button "Send now"\n- textbox "Prompt"')
    expect(result.detail).toEqual(['- - button "Send"', '+ - button "Send now"'])
  })
})

describe("command logs", () => {
  test("generated ids compare by position, not value", () => {
    const a = [{ type: "terminal.create", terminalId: "f3a1c2d4-1111-4222-8333-944455556666" }]
    const b = [{ type: "terminal.create", terminalId: "0b9e8d7c-aaaa-4bbb-8ccc-ddddeeeeffff" }]
    expect(compareCommands(a, b).status).toBe("identical")
  })

  test("order matters for commands", () => {
    const a = [{ type: "chat.markRead" }, { type: "chat.setReadAnchor" }]
    expect(compareCommands(a, [...a].reverse()).status).toBe("different")
  })

  test("order does not matter for subscriptions", () => {
    const a = [{ type: "sidebar" }, { type: "chat", chatId: "c1" }]
    expect(compareSubscriptions(a, [...a].reverse()).status).toBe("identical")
  })

  test("normalizeIds keeps key order stable", () => {
    expect(normalizeIds([{ b: 1, a: 2 }])).toEqual(['{"a":2,"b":1}'])
  })
})

describe("comparePixels", () => {
  test("identical, tolerated, different", () => {
    expect(comparePixels(0, 100, 0).status).toBe("identical")
    expect(comparePixels(1, 10_000, 0.001).status).toBe("tolerated")
    expect(comparePixels(100, 10_000, 0.001).status).toBe("different")
  })
})
