import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/context-menu.ts against Radix's context menu: a right click
// opens it at the pointer, the pointer and the arrows focus items, Escape
// closes it, a right click near the right edge flips it, and choosing an
// item closes it at once.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-context-menu",
    route: "/__gallery/ui-context-menu",
    viewports: ["desktop"],
    async run({ page, capture }) {
      const row = page.getByText("Port the shared UI primitives")
      await row.click({ button: "right", position: { x: 40, y: 10 } })
      await capture("open")
      await page.getByRole("menuitem", { name: "Rename" }).hover()
      await capture("hover-item")
      await page.keyboard.press("ArrowDown")
      await page.keyboard.press("ArrowDown")
      await capture("arrows-skip-disabled")
      await page.keyboard.press("Escape")
      await capture("escape")
      await row.click({ button: "right", position: { x: 300, y: 20 } })
      await capture("open-elsewhere")
      await page.getByRole("menuitem", { name: "Archive" }).click()
      await capture("chose-item")
    },
  }),
]
