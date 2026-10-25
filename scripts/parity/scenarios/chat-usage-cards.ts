import { defineScenario, type Scenario } from "../scenario"

// The usage cards on a phone's new chat page (src/foldkit/chat/usageCards.ts
// against Settings' collapsible ProviderCard): collapsed with the first
// window's meter in the header, its tooltip, then each card opened.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-usage-cards",
    route: "/__gallery/chat-usage-cards",
    viewports: ["desktop", "mobile"],
    async run({ page, capture }) {
      await capture("collapsed")
      await page.getByRole("button", { name: /Claude/ }).click()
      await capture("claude-open")
      await page.getByRole("button", { name: /Codex/ }).click()
      await capture("both-open")
      await page.getByRole("button", { name: /Codex/ }).click()
      await capture("codex-closed")
    },
  }),
]
