import { describe, expect, test } from "bun:test"
import { formatReminderDue, nextMorning, REMINDER_PRESETS } from "./reminder-presets"

/** Local time, so the assertions read the same way the code computes them. */
function local(year: number, month: number, day: number, hour: number, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe("nextMorning", () => {
  test("an afternoon lands on the next day's 9am", () => {
    const now = local(2026, 3, 10, 14, 30)
    const morning = new Date(nextMorning(now))
    expect(morning.getDate()).toBe(11)
    expect(morning.getHours()).toBe(9)
    expect(morning.getMinutes()).toBe(0)
  })

  test("the small hours land on this morning, not tomorrow's", () => {
    const now = local(2026, 3, 10, 2, 15)
    const morning = new Date(nextMorning(now))
    expect(morning.getDate()).toBe(10)
    expect(morning.getHours()).toBe(9)
  })

  test("exactly 9am rolls forward rather than resolving to now", () => {
    const now = local(2026, 3, 10, 9)
    const morning = new Date(nextMorning(now))
    expect(morning.getDate()).toBe(11)
    expect(nextMorning(now)).toBeGreaterThan(now)
  })

  test("lands on the clock hour across a spring-forward boundary", () => {
    // US DST begins 2026-03-08. Asking on the 7th must still mean 9am local on
    // the 8th, which is not 24 hours later in zones that observe it.
    const now = local(2026, 3, 7, 20)
    const morning = new Date(nextMorning(now))
    expect(morning.getDate()).toBe(8)
    expect(morning.getHours()).toBe(9)
  })

  test("crosses a month boundary", () => {
    const now = local(2026, 3, 31, 22)
    const morning = new Date(nextMorning(now))
    expect(morning.getMonth()).toBe(3) // April, zero-based
    expect(morning.getDate()).toBe(1)
  })
})

describe("REMINDER_PRESETS", () => {
  test("every preset resolves into the future", () => {
    const now = local(2026, 3, 10, 14, 30)
    for (const preset of REMINDER_PRESETS) {
      expect(preset.resolve(now)).toBeGreaterThan(now)
    }
  })

  test("presets are offered in ascending order", () => {
    const now = local(2026, 3, 10, 14, 30)
    const resolved = REMINDER_PRESETS.map((preset) => preset.resolve(now))
    expect([...resolved].sort((a, b) => a - b)).toEqual(resolved)
  })
})

describe("formatReminderDue", () => {
  const now = 1_700_000_000_000

  test("renders minutes, hours and days", () => {
    expect(formatReminderDue(now + 12 * 60_000, now)).toBe("in 12m")
    expect(formatReminderDue(now + 3 * 3_600_000, now)).toBe("in 3h")
    expect(formatReminderDue(now + 2 * 86_400_000, now)).toBe("in 2d")
  })

  test("a due-but-unfired reminder reads as now rather than a negative", () => {
    expect(formatReminderDue(now - 5_000, now)).toBe("now")
    expect(formatReminderDue(now, now)).toBe("now")
  })

  test("never rounds a pending reminder down to zero minutes", () => {
    expect(formatReminderDue(now + 20_000, now)).toBe("in 1m")
  })
})
