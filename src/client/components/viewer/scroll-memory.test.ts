import { describe, expect, test } from "bun:test"
import { restoreScroll, saveScroll } from "./scroll-memory"

describe("scroll memory", () => {
  test("a scroller made anew comes back where the last one with its key was left", () => {
    saveScroll("delegated:deleg-1:done", { scrollTop: 640, scrollLeft: 0 })
    const again = { scrollTop: 0, scrollLeft: 0 }
    expect(restoreScroll("delegated:deleg-1:done", again)).toBe(true)
    expect(again).toEqual({ scrollTop: 640, scrollLeft: 0 })
  })

  test("keeps across as well as down, for the expanded board's row of columns", () => {
    saveScroll("delegated:deleg-1:columns", { scrollTop: 0, scrollLeft: 220 })
    const again = { scrollTop: 0, scrollLeft: 0 }
    restoreScroll("delegated:deleg-1:columns", again)
    expect(again.scrollLeft).toBe(220)
  })

  test("leaves a scroller with nothing kept for it alone", () => {
    const fresh = { scrollTop: 12, scrollLeft: 0 }
    expect(restoreScroll("delegated:never-scrolled", fresh)).toBe(false)
    expect(fresh.scrollTop).toBe(12)
  })
})
