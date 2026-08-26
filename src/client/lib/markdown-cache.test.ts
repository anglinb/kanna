import { beforeEach, describe, expect, test } from "bun:test"
import { clearTranscriptMarkdownCache, getTranscriptMarkdownCacheStats, parseTranscriptMarkdown } from "./markdown-cache"

beforeEach(() => clearTranscriptMarkdownCache())

describe("parseTranscriptMarkdown", () => {
  test("returns the same tree for the same text and a fresh one for new text", () => {
    const a = parseTranscriptMarkdown("# Title\n\nSome **bold** text")
    expect(parseTranscriptMarkdown("# Title\n\nSome **bold** text")).toBe(a)
    expect(parseTranscriptMarkdown("other")).not.toBe(a)
    expect(getTranscriptMarkdownCacheStats().entries).toBe(2)
  })

  test("builds the tree react-markdown would: gfm, raw html as text, safe urls", () => {
    const tree = parseTranscriptMarkdown("| a |\n|---|\n| b |\n\n<b>raw</b>\n\n[x](javascript:alert(1))")
    const json = JSON.stringify(tree)
    expect(json).toContain('"tagName":"table"')
    // Inline html arrives as separate raw nodes per tag; each becomes text.
    expect(json).toContain('"type":"text","value":"<b>"')
    expect(json).toContain('"type":"text","value":"</b>"')
    expect(json).not.toContain('"type":"raw"')
    // react-markdown's default transform drops unsafe protocols.
    expect(json).toContain('"href":""')
  })

  test("evicts least recently used entries by character budget", () => {
    // Fill past the 8 MB budget with a handful of large texts.
    const big = (n: number) => `${"x".repeat(3 * 1024 * 1024)} ${n}`
    const first = parseTranscriptMarkdown(big(1))
    parseTranscriptMarkdown(big(2))
    // Touch the first so the second is the oldest.
    expect(parseTranscriptMarkdown(big(1))).toBe(first)
    parseTranscriptMarkdown(big(3))
    const stats = getTranscriptMarkdownCacheStats()
    expect(stats.entries).toBe(2)
    expect(stats.chars).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(parseTranscriptMarkdown(big(1))).toBe(first)
  })
})
