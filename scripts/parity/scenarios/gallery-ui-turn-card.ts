import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/turn-card.ts against the React turn-card parts: meta rows,
// a clickable and a plain message, timing rows; then selecting the message.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-turn-card",
    route: "/__gallery/ui-turn-card",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("states")
      await page.getByRole("button", { name: "Open the prompt" }).hover()
      await capture("hover")
      await page.getByRole("button", { name: "Open the prompt" }).click()
      await page.mouse.move(700, 700)
      await capture("selected")
    },
  }),
]
