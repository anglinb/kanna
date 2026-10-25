import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/tooltip.ts against Radix's tooltip: open by hover on each
// side (and one that flips at the top edge), multi-line content, the default
// 700ms delay, the hotkey variant, a still one, keyboard focus, then Escape
// and the pointer leaving.
// Two moves, apart: Radix only checks the pointer against the grace area
// once a listener registered after the leave is in place, so a single jump
// away leaves the tooltip open.
async function away(page: Page) {
  await page.mouse.move(1400, 880)
  await page.waitForTimeout(100)
  await page.mouse.move(1435, 895)
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-tooltip",
    route: "/__gallery/ui-tooltip",
    viewports: ["desktop"],
    async run({ page, capture }) {
      for (const name of ["Top", "Right", "Fetch", "Left", "Edge", "Still"]) {
        await page.getByRole("button", { name }).hover()
        await capture(`hover-${name.toLowerCase()}`)
        await away(page)
      }
      await page.getByText("Usage", { exact: true }).hover()
      await capture("hover-usage")
      await away(page)
      await page.getByRole("button", { name: "Label" }).hover()
      await capture("hover-hotkey-label")
      await away(page)
      await page.waitForTimeout(400)
      await page.getByRole("button", { name: "Delayed" }).hover()
      await page.waitForTimeout(900)
      await capture("hover-delayed")
      await away(page)
      await page.waitForTimeout(400)
      await page.getByRole("button", { name: "Terminal" }).hover()
      await page.waitForTimeout(900)
      await capture("hover-hotkey-shortcut")
      await away(page)
      await capture("closed")
      await page.getByRole("button", { name: "Top" }).focus()
      await capture("focus")
      await page.keyboard.press("Escape")
      await capture("escape")
    },
  }),
]
