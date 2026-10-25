import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/hover-card.ts against Radix's hover card: the 700ms open
// delay, staying open while the pointer travels into the card, the 300ms
// close delay, a zero-delay one on the right, and Escape.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-hover-card",
    route: "/__gallery/ui-hover-card",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await page.getByRole("link", { name: "feat/foldkit-ui" }).hover()
      await page.waitForTimeout(900)
      await capture("open")
      await page.getByText("3 commits ahead of main").hover()
      await page.waitForTimeout(500)
      await capture("pointer-in-card")
      await page.mouse.move(1400, 880)
      await page.waitForTimeout(600)
      await capture("closed")
      await page.getByText("Instant", { exact: true }).hover()
      await page.waitForTimeout(300)
      await capture("instant")
      await page.keyboard.press("Escape")
      await capture("escape")
    },
  }),
]
