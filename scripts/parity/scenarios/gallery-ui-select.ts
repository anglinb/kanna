import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/select.ts against Radix's select: a placeholder, opening by
// mouse press (start- and end-aligned), the chosen item focused, keyboard
// moves, choosing by Enter and by click, Escape returning focus to the
// trigger, and a disabled select.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-select",
    route: "/__gallery/ui-select",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("closed")
      await page.getByRole("combobox", { name: "Follow-up mode" }).click()
      await capture("open-end-aligned")
      await page.keyboard.press("ArrowDown")
      await capture("arrow-down")
      await page.keyboard.press("ArrowDown")
      await capture("skips-disabled")
      await page.keyboard.press("Enter")
      await capture("chose-by-enter")
      await page.getByRole("combobox").first().click()
      await capture("open-placeholder")
      await page.getByRole("option", { name: "Public" }).hover()
      await capture("hover-item")
      await page.getByRole("option", { name: "Public" }).click()
      await capture("chose-by-click")
      await page.keyboard.press("Enter")
      await capture("open-by-keyboard")
      await page.keyboard.press("Escape")
      await capture("escape")
    },
  }),
]
