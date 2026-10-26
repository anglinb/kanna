import { defineScenario, type Scenario } from "../scenario"
import { click, parkPointer } from "./_lib/helpers"

// The usage cards on a phone's new chat page (src/foldkit/chat/usageCards.ts
// against Settings' collapsible ProviderCard), on a gallery page: collapsed
// with the first window's meter in the header, then each card opened.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-usage-cards",
    route: "/__gallery/chat-usage-cards",
    viewports: ["desktop", "mobile"],
    async run(context) {
      const { page } = context
      await context.capture("collapsed")
      await click(context, page.getByRole("button", { name: /Claude/ }))
      await parkPointer(context)
      await context.capture("claude-open")
      await click(context, page.getByRole("button", { name: /Codex/ }))
      await parkPointer(context)
      await context.capture("both-open")
      await click(context, page.getByRole("button", { name: /Codex/ }))
      await parkPointer(context)
      await context.capture("codex-closed")
    },
  }),
]
