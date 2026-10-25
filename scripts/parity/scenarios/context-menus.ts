import type { Locator, Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, contextClick, openWidgets, parkPointer, quickClick, REGIONS, regions } from "./_lib/helpers"

// Right-click menus not reached from a sidebar row, a project card or a chat
// tab (those live in sidebar.ts, home.ts and chat-tabs.ts): widget rows (a
// changed file, a background task, a schedule), the commit button, a local
// file link in the transcript, an installed skill. Each is also opened from
// the keyboard where the client offers that (Shift+F10 on a widget row).

const desktop = { viewports: ["desktop" as const] }

function column(page: Page) {
  return page.locator(REGIONS.widgets)
}

/**
 * Right-clicks a widget row and waits out its hover card's delay, without
 * the long rests of `contextClick`: the widget column polls on wall-clock
 * intervals (see quickClick in _lib/helpers.ts), so its scenarios capture
 * within the first few seconds of opening it.
 */
async function widgetContextClick(context: ScenarioContext, locator: Locator) {
  await locator.click({ button: "right" })
  await context.page.waitForTimeout(1000)
  await context.settle()
}

/** A widget row, by the key the client gives it. CSS: rows carry `data-row-key`, and only some have a role. */
function widgetRow(page: Page, key: string) {
  return column(page).locator(`[data-row-key="${key}"]`)
}

export const scenarios: Scenario[] = [
  defineScenario({
    // A changed file's row: Review, Open in…, Discard, Ignore, Copy path.
    name: "context-menu-widget-file-row",
    route: CHATS.units,
    ...desktop,
    regions: regions("menu", "widgets"),
    async run(context) {
      await openWidgets(context)
      await widgetContextClick(context, widgetRow(context.page, "src/lib/units.ts"))
      await context.capture("menu")
      await context.page.keyboard.press("Escape")
      await context.settle()
      await context.capture("closed")
    },
  }),
  defineScenario({
    // The same menu from the keyboard: Shift+F10 on a focused row.
    name: "context-menu-widget-row-keyboard",
    route: CHATS.units,
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await openWidgets(context)
      await widgetRow(context.page, "src/lib/units.ts").focus()
      await context.page.keyboard.press("Shift+F10")
      await context.page.waitForTimeout(300)
      await context.settle()
      await context.capture("menu")
    },
  }),
  defineScenario({
    // The commit button's own menu: commit and push, or commit only.
    name: "context-menu-commit-button",
    route: CHATS.units,
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await openWidgets(context)
      await widgetContextClick(context, column(context.page).getByRole("button", { name: "Generate & push to main" }))
      await context.capture("menu")
    },
  }),
  defineScenario({
    // A running monitor in the README chat's Tasks card: Jump to it, Stop it.
    name: "context-menu-task-row",
    route: CHATS.readme,
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await openWidgets(context)
      await widgetContextClick(context, widgetRow(context.page, "task-demo-dev-server"))
      await context.capture("menu")
    },
  }),
  defineScenario({
    name: "context-menu-schedule-row",
    route: CHATS.rateLimit,
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await openWidgets(context)
      await widgetContextClick(context, widgetRow(context.page, "schedule-demo-429s"))
      await context.capture("menu")
    },
  }),
  defineScenario({
    // A local file link in a reply: right-click offers where to open it.
    name: "context-menu-transcript-file-link",
    route: CHATS.rateLimit,
    ...desktop,
    regions: regions("menu", "transcript"),
    covers: { commands: ["system.openExternal"] },
    async run(context) {
      const { page } = context
      const link = page.locator(REGIONS.transcript).getByRole("link", { name: "src/middleware/rateLimit.ts" })
      await contextClick(context, link)
      await context.capture("menu")
      await quickClick(context, page.getByRole("menuitem").first())
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    // An installed skill's card: where it was added from, Reveal, Uninstall.
    name: "context-menu-skill-card",
    route: "/settings/skills",
    ...desktop,
    regions: regions("menu", "settings"),
    async run(context) {
      const { page } = context
      const card = page.locator(REGIONS.settings).getByText("frontend-design", { exact: true }).first()
      await contextClick(context, card)
      await context.capture("menu")
    },
  }),
]
