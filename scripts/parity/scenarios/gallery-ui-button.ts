import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/button.ts against <Button>: every variant and size, disabled,
// then the focus ring from the keyboard.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-button",
    route: "/__gallery/ui-button",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("states")
      await page.keyboard.press("Tab")
      await capture("focus-visible")
    },
  }),
]
