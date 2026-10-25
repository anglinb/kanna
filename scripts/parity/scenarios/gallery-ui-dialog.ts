import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/dialog.ts against Radix's dialog: three sizes, focus moving
// in and Tab looping, the page hidden and inert behind it, a scrolling body,
// and closing by Escape, the X, an overlay click and a footer button.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-dialog",
    route: "/__gallery/ui-dialog",
    viewports: ["desktop", "mobile"],
    async run({ page, capture }) {
      await page.getByRole("button", { name: "Pair device" }).click()
      await capture("open-md")
      await page.keyboard.press("Tab")
      await page.keyboard.press("Tab")
      await page.keyboard.press("Tab")
      await capture("tab-loops")
      await page.keyboard.press("Escape")
      await capture("escape")
      await page.getByRole("button", { name: "Small" }).click()
      await capture("open-sm")
      await page.getByRole("button", { name: "Close" }).click()
      await capture("closed-by-x")
      await page.getByRole("button", { name: "Large" }).click()
      await capture("open-lg")
      await page.mouse.click(5, 5)
      await capture("closed-by-overlay")
      await page.getByRole("button", { name: "Pair device" }).click()
      await page.getByRole("button", { name: "Pair", exact: true }).click()
      await capture("closed-by-footer")
    },
  }),
]
