import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, click, countUuids, hover, parkPointer, REGIONS, regions, rest } from "./_lib/helpers"

// A new chat's page before its first prompt, and the transcript minimap of
// a chat with more than one turn.

const desktop = { viewports: ["desktop" as const] }

async function newChat(context: ScenarioContext) {
  await countUuids(context)
  await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "New Chat" }))
  await parkPointer(context)
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
    // The chip under the hero names the project (its path in a tooltip) and
    // opens the palette's New Chat in… page.
    name: "new-chat-project-picker",
    route: CHATS.units,
    ...desktop,
    regions: regions("tooltip", "dialog"),
    covers: { commands: ["chat.create"] },
    async run(context) {
      await newChat(context)
      const picker = context.page.getByRole("button", { name: /^Switch project/ })
      await hover(context, picker)
      await context.capture("tooltip")
      await click(context, picker)
      await parkPointer(context)
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
