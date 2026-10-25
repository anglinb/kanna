import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/popover.ts against Radix's popover: opening by click (start,
// centre and end aligned, one near the right edge), focus moving in, Tab
// looping, Escape, an outside click, a trigger click toggling it shut, and a
// choice that closes it from the parent.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-popover",
    route: "/__gallery/ui-popover",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await page.getByRole("button", { name: "Filter projects" }).click()
      await capture("open-end-aligned")
      await page.getByRole("button", { name: "This Mac" }).click()
      await capture("chose-filter")
      await page.keyboard.press("Escape")
      await capture("escape")
      await page.getByRole("button", { name: "Details" }).click()
      await capture("open-with-field")
      await page.keyboard.press("Tab")
      await capture("tab-loops")
      await page.mouse.click(700, 600)
      await capture("outside-click")
      await page.getByRole("button", { name: "Opus" }).click()
      await capture("open-start-aligned")
      await page.getByRole("button", { name: "Opus" }).first().click()
      await capture("trigger-toggles-shut")
      await page.getByRole("button", { name: "Opus" }).click()
      await page.getByRole("button", { name: "Haiku" }).click()
      await capture("chose-model")
    },
  }),
]
