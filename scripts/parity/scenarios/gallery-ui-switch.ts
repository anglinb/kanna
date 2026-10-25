import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/switch.ts against <Switch>: on, off, disabled; then a click
// turns one on, and the keyboard focus ring.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-switch",
    route: "/__gallery/ui-switch",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("states")
      await page.getByRole("switch", { name: "Sounds" }).click()
      await page.mouse.move(600, 600)
      await capture("toggled")
      await page.keyboard.press("Tab")
      await capture("focus-visible")
    },
  }),
]
