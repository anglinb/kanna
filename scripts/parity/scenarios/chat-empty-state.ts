import { defineScenario, type Scenario } from "../scenario"
import { hover, parkPointer, press, rest } from "./_lib/helpers"

// The new chat page's project section (src/foldkit/chat/emptyState.ts and
// emptyStateProject.ts against EmptyStateProject), on a gallery page: in
// the app it is drawn inside the transcript (new-chat.ts covers it there).
// The picker and its tooltip, the project's chats under the palette's
// headings, a search that ranks them, one that finds nothing, and Escape
// clearing it.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-empty-state",
    route: "/__gallery/chat-empty-state",
    viewports: ["desktop", "mobile"],
    async run(context) {
      const { page } = context
      await context.capture("rest")
      await hover(context, page.getByRole("button", { name: /^Switch project/ }))
      await context.capture("picker-tooltip")
      await parkPointer(context)
      await hover(context, page.getByRole("button", { name: /Pick a chart library/ }))
      await context.capture("row-hover")
      const search = page.getByRole("searchbox", { name: "Search this project's chats" })
      await search.fill("tide")
      await rest(context)
      await context.capture("search")
      await search.fill("zzzz")
      await rest(context)
      await context.capture("no-match")
      await press(context, "Escape")
      await context.capture("cleared")
    },
  }),
]
