import { defineScenario, type Scenario } from "../scenario"
import { hover, parkPointer, press } from "./_lib/helpers"

// The context window meter (src/foldkit/chat/contextWindowMeter.ts against
// ContextWindowMeter, which the composer shows), on a gallery page: each
// state, and its tooltip on hover and on focus.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-context-meter",
    route: "/__gallery/chat-context-meter",
    async run(context) {
      const { page } = context
      await context.capture("rest")
      await hover(context, page.getByRole("button", { name: "Context window 42% used" }))
      await context.capture("hover-share")
      await hover(context, page.getByRole("button", { name: "Context window 1.3m tokens used" }))
      await context.capture("hover-tokens")
      await parkPointer(context)
      await press(context, "Tab")
      await context.capture("focus-first")
    },
  }),
]
