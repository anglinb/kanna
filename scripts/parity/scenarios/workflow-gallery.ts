import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { click, parkPointer, rest } from "./_lib/helpers"

// The workflows gallery (/workflows): every state of the Workflow and Tasks
// cards on made-up data. routes.ts captures its top; these scroll to the
// rest of it and use what responds there.

const route = "/workflows"
const desktop = { viewports: ["desktop" as const] }

/** Scrolls a section's heading to the top of the page's scroller. */
async function scrollToSection(context: ScenarioContext, title: string) {
  await context.page.getByRole("heading", { name: title, exact: true }).evaluate((heading) => heading.scrollIntoView({ block: "start" }))
  await parkPointer(context)
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "workflow-gallery-tasks",
    route,
    ...desktop,
    covers: { routes: [route] },
    async run(context) {
      await scrollToSection(context, "Tasks card")
      await context.capture("tasks")
    },
  }),
  defineScenario({
    name: "workflow-gallery-hover-cards",
    route,
    ...desktop,
    covers: { routes: [route] },
    async run(context) {
      await scrollToSection(context, "Hover cards, open")
      await context.capture("cards")
    },
  }),
  defineScenario({
    // The Log example has more than five rows: Show more reveals the rest.
    name: "workflow-gallery-show-more",
    route,
    ...desktop,
    covers: { routes: [route] },
    async run(context) {
      await scrollToSection(context, "Tasks card")
      await click(context, context.page.getByRole("button", { name: /^Show \d+ more|^Show more/ }).first())
      await parkPointer(context)
      await rest(context)
      await context.capture("expanded")
    },
  }),
]
