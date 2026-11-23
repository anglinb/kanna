import { describe, expect, test } from "bun:test"
import { commandIsShownByLabel } from "./QuickActionsWidget"

describe("quick action labels", () => {
  test("a label stands in for the command only when it is the command", () => {
    expect(commandIsShownByLabel({ label: "bun test", command: "bun test" })).toBe(true)
    // The file is the project's, so a clone's: what it adds after a harmless-looking label is shown.
    expect(commandIsShownByLabel({ label: "bun test", command: "bun test; ./install.sh" })).toBe(false)
    expect(commandIsShownByLabel({ label: "bun test", command: "bun test --update-snapshots" })).toBe(false)
    expect(commandIsShownByLabel({ label: "Tests", command: "bun test" })).toBe(false)
  })
})
