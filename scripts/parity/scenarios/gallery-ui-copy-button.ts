import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/copy-button.ts against <CopyButton>: ghost and plain, then
// the copied check after a click (title swaps where copiedTitle is set), and
// back to the copy icon two seconds later.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-copy-button",
    route: "/__gallery/ui-copy-button",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("idle")
      await page.getByRole("button", { name: "Copy code" }).click()
      await page.getByRole("button", { name: "Copy link" }).click()
      await page.mouse.move(700, 700)
      await capture("copied")
      await page.waitForTimeout(2500)
      await capture("reset")
    },
  }),
]
