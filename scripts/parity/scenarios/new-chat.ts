import type { Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, click, countUuids, hover, parkPointer, REGIONS, regions, rest } from "./_lib/helpers"

// A new chat's page before its first prompt (the project's empty state:
// switch project, search its chats, open one), and the transcript minimap
// of a chat with more than one turn.

const desktop = { viewports: ["desktop" as const] }

async function newChat(context: ScenarioContext) {
  await countUuids(context)
  await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "New Chat" }))
  await parkPointer(context)
}

function emptyState(page: Page) {
  return page.getByRole("searchbox", { name: "Search this project's chats" })
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "new-chat-empty-state",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript", "composer", "navbar"),
    covers: { commands: ["chat.create"] },
    async run(context) {
      await newChat(context)
      await context.capture("empty")
    },
  }),
  defineScenario({
    name: "new-chat-search-project-chats",
    route: CHATS.units,
    ...desktop,
    covers: { commands: ["chat.create"] },
    async run(context) {
      await newChat(context)
      await emptyState(context.page).fill("deploy")
      await rest(context)
      await context.capture("filtered")
      await emptyState(context.page).press("Escape")
      await rest(context)
      await context.capture("cleared")
    },
  }),
  defineScenario({
    name: "new-chat-open-listed-chat",
    route: CHATS.units,
    ...desktop,
    covers: { commands: ["chat.create"] },
    async run(context) {
      await newChat(context)
      await click(context, context.page.getByRole("button", { name: /Fix blank tide chart in Safari/ }).last())
      await parkPointer(context)
      await context.capture("opened")
    },
  }),
  defineScenario({
    name: "new-chat-switch-project",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog"),
    covers: { commands: ["chat.create"] },
    async run(context) {
      await newChat(context)
      await click(context, context.page.getByRole("button", { name: /^Switch project/ }))
      await context.capture("palette")
    },
  }),
  defineScenario({
    // Two turns: the minimap marks both; its marker's card jumps to the first prompt.
    name: "transcript-minimap",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript", "popover"),
    covers: { commands: ["chat.send"] },
    async run(context) {
      const { page } = context
      const composer = page.locator("textarea[data-chat-input]")
      await composer.click()
      await composer.pressSequentially("Show the swell direction as an arrow")
      await composer.press("Enter")
      await rest(context)
      await context.advance(30_000)
      await parkPointer(context)
      await context.capture("two-turns")
      const marker = page.getByRole("button", { name: /^Jump to: The forecast card/ })
      await hover(context, marker)
      await context.capture("marker-card")
      await click(context, marker)
      await parkPointer(context)
      await context.capture("jumped")
    },
  }),
]
