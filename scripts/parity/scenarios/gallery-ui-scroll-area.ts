import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/scroll-area.ts against <ScrollArea>: at rest, then scrolled
// by the wheel (no scrollbar either way).
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-scroll-area",
    route: "/__gallery/ui-scroll-area",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("top")
      await page.mouse.move(100, 80)
      await page.mouse.wheel(0, 200)
      await capture("scrolled")
    },
  }),
]
