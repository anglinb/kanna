import { describe, expect, test } from "bun:test"
import {
  formatReminderDelay,
  MAX_REMINDER_DELAY_MS,
  MAX_REMINDER_PROMPT_LENGTH,
  normalizeReminderPrompt,
  parseReminderDelay,
  resolveReminderDueAt,
} from "./reminders"

const NOW = 1_700_000_000_000

describe("parseReminderDelay", () => {
  test("reads a bare number as minutes", () => {
    expect(parseReminderDelay("30")).toBe(30 * 60_000)
    expect(parseReminderDelay(" 5 ")).toBe(5 * 60_000)
  })

  test("reads single units", () => {
    expect(parseReminderDelay("45s")).toBe(45_000)
    expect(parseReminderDelay("30m")).toBe(30 * 60_000)
    expect(parseReminderDelay("2h")).toBe(2 * 3_600_000)
    expect(parseReminderDelay("1d")).toBe(86_400_000)
  })

  test("reads compound units and ignores internal spacing", () => {
    expect(parseReminderDelay("1h30m")).toBe(90 * 60_000)
    expect(parseReminderDelay("1h 30m")).toBe(90 * 60_000)
    expect(parseReminderDelay("1d2h")).toBe(86_400_000 + 2 * 3_600_000)
  })

  test("is case-insensitive", () => {
    expect(parseReminderDelay("2H")).toBe(2 * 3_600_000)
  })

  test("rejects trailing junk rather than parsing the prefix", () => {
    expect(parseReminderDelay("30mx")).toBeNull()
    expect(parseReminderDelay("30 minutes")).toBeNull()
  })

  test("rejects what it cannot read", () => {
    expect(parseReminderDelay("")).toBeNull()
    expect(parseReminderDelay("soon")).toBeNull()
    expect(parseReminderDelay("m")).toBeNull()
  })
})

describe("formatReminderDelay", () => {
  test("renders sub-minute delays in seconds", () => {
    expect(formatReminderDelay(45_000)).toBe("45s")
  })

  test("renders compound delays", () => {
    expect(formatReminderDelay(90 * 60_000)).toBe("1h 30m")
    expect(formatReminderDelay(30 * 60_000)).toBe("30m")
    expect(formatReminderDelay(2 * 3_600_000)).toBe("2h")
    expect(formatReminderDelay(86_400_000)).toBe("1d")
  })
})

describe("resolveReminderDueAt", () => {
  test("resolves a relative delay against the caller's clock", () => {
    const result = resolveReminderDueAt({ now: NOW, in: "30m" })
    expect(result).toEqual({ ok: true, dueAt: NOW + 30 * 60_000 })
  })

  test("resolves an absolute ISO time", () => {
    const at = new Date(NOW + 3_600_000).toISOString()
    const result = resolveReminderDueAt({ now: NOW, at })
    expect(result).toEqual({ ok: true, dueAt: NOW + 3_600_000 })
  })

  test("accepts a precomputed dueAt from a client that did its own arithmetic", () => {
    const result = resolveReminderDueAt({ now: NOW, dueAt: NOW + 60_000 })
    expect(result).toEqual({ ok: true, dueAt: NOW + 60_000 })
  })

  test("requires exactly one of in/at/dueAt", () => {
    expect(resolveReminderDueAt({ now: NOW })).toEqual({
      ok: false,
      error: "Say when: --in <30m|2h|1d> or --at <time>.",
    })
    expect(resolveReminderDueAt({ now: NOW, in: "30m", at: "2030-01-01T00:00:00Z" })).toEqual({
      ok: false,
      error: "Pass only one of --in and --at.",
    })
  })

  test("rejects times in the past — including a delay that rounds to zero", () => {
    expect(resolveReminderDueAt({ now: NOW, dueAt: NOW - 1 }).ok).toBe(false)
    expect(resolveReminderDueAt({ now: NOW, dueAt: NOW }).ok).toBe(false)
    expect(resolveReminderDueAt({ now: NOW, in: "0m" }).ok).toBe(false)
  })

  test("rejects delays beyond the ceiling", () => {
    const result = resolveReminderDueAt({ now: NOW, dueAt: NOW + MAX_REMINDER_DELAY_MS + 1 })
    expect(result.ok).toBe(false)
  })

  test("allows a delay exactly at the ceiling", () => {
    const result = resolveReminderDueAt({ now: NOW, dueAt: NOW + MAX_REMINDER_DELAY_MS })
    expect(result.ok).toBe(true)
  })

  test("reports the input back when it cannot be read", () => {
    const result = resolveReminderDueAt({ now: NOW, in: "sometime" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("sometime")
  })

  test("rejects an unparseable absolute time", () => {
    expect(resolveReminderDueAt({ now: NOW, at: "next tuesday" }).ok).toBe(false)
  })
})

describe("normalizeReminderPrompt", () => {
  test("trims and drops empty prompts", () => {
    expect(normalizeReminderPrompt("  check metrics  ")).toBe("check metrics")
    expect(normalizeReminderPrompt("   ")).toBeUndefined()
    expect(normalizeReminderPrompt(null)).toBeUndefined()
    expect(normalizeReminderPrompt(undefined)).toBeUndefined()
  })

  test("bounds an overlong prompt", () => {
    const long = "x".repeat(MAX_REMINDER_PROMPT_LENGTH + 100)
    expect(normalizeReminderPrompt(long)?.length).toBe(MAX_REMINDER_PROMPT_LENGTH)
  })
})
