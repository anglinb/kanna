import { defineScenario, type Scenario } from "../scenario"

// The context window meter (src/foldkit/chat/contextWindowMeter.ts against
// ContextWindowMeter, which the composer shows): each state, and its
// tooltip on hover and on focus.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-context-meter",
    route: "/__gallery/chat-context-meter",
    async run({ page, capture }) {
      await capture("rest")
      await page.getByRole("button", { name: "Context window 42% used" }).hover()
      await capture("hover-share")
      await page.getByRole("button", { name: "Context window 1.3m tokens used" }).hover()
      await capture("hover-tokens")
      await page.mouse.move(700, 800)
      await page.keyboard.press("Tab")
      await capture("focus-first")
    },
  }),
]
