import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReminderDockCard } from "./ReminderDockCard"

const NOW = new Date(2026, 7, 26, 17, 15, 0).getTime()

function render(dueAt: number | null, nowMs: number = NOW) {
  return renderToStaticMarkup(
    <ReminderDockCard dueAt={dueAt} nowMs={nowMs} onClear={async () => {}} />,
  )
}

describe("ReminderDockCard", () => {
  test("renders nothing when the chat has no reminder", () => {
    expect(render(null)).toBe("")
  })

  test("counts down in minutes and names the clock time", () => {
    const markup = render(NOW + 25 * 60_000)
    expect(markup).toContain("Reminder in 25 minutes")
    // Both readings are present: how long, and when.
    expect(markup).toMatch(/5:40/)
  })

  test("uses the singular for one minute and one hour", () => {
    expect(render(NOW + 60_000)).toContain("Reminder in 1 minute")
    expect(render(NOW + 3_600_000)).toContain("Reminder in 1 hour")
  })

  test("switches to hours, then to days with a weekday", () => {
    expect(render(NOW + 3 * 3_600_000)).toContain("Reminder in 3 hours")
    const twoDays = render(NOW + 2 * 86_400_000)
    expect(twoDays).toContain("Reminder in 2 days")
    expect(twoDays).toContain("Friday")
  })

  test("never rounds a pending reminder down to zero minutes", () => {
    expect(render(NOW + 20_000)).toContain("Reminder in 1 minute")
  })

  test("reads calmly when due but not yet swept by the tick", () => {
    const markup = render(NOW - 5_000)
    expect(markup).toContain("any moment now")
    expect(markup).not.toContain("in 0")
    // A negative countdown is the failure this guards; bare hyphens are all
    // over the class names and SVG paths, so match the countdown shape.
    expect(markup).not.toMatch(/in -\d/)
  })

  test("offers a labelled cancel control", () => {
    expect(render(NOW + 60_000)).toContain("Cancel this reminder")
  })
})
