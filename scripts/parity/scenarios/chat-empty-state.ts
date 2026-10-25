import { defineScenario, type Scenario } from "../scenario"

// The new chat page's project section (src/foldkit/chat/emptyState.ts and
// emptyStateProject.ts against EmptyStateProject): the picker and its
// tooltip, the project's chats under the palette's headings, a search that
// ranks them, one that finds nothing, and Escape clearing it.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-empty-state",
    route: "/__gallery/chat-empty-state",
    viewports: ["desktop", "mobile"],
    async run({ page, capture }) {
      await capture("rest")
      await page.getByRole("button", { name: /^Switch project/ }).hover()
      await page.waitForTimeout(900)
      await capture("picker-tooltip")
      await page.mouse.move(5, 5)
      await page.waitForTimeout(100)
      await page.mouse.move(8, 8)
      await page.waitForTimeout(400)
      await page.getByRole("button", { name: /Pick a chart library/ }).hover()
      await capture("row-hover")
      await page.getByRole("searchbox", { name: "Search this project's chats" }).fill("tide")
      await capture("search")
      await page.getByRole("searchbox", { name: "Search this project's chats" }).fill("zzzz")
      await capture("no-match")
      await page.keyboard.press("Escape")
      await capture("cleared")
    },
  }),
]
