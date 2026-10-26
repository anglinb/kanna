import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/segmented-control.ts against <SegmentedControl>: icons,
// sizes, a disabled segment, stretched segments; then picking another
// segment moves the indicator.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-segmented-control",
    route: "/__gallery/ui-segmented-control",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("states")
      await page.getByRole("button", { name: "Box" }).click()
      await page.getByRole("button", { name: "SVG" }).first().click()
      await page.mouse.move(700, 700)
      await capture("moved")
    },
  }),
]
