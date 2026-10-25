import { defineScenario, type Scenario } from "../scenario"
import { click, parkPointer, regions, rest } from "./_lib/helpers"

// Settings → Skills: the installed list, filtering it, searching skills.sh,
// installing a result, a skill's menu and uninstalling.

const route = "/settings/skills"
const desktop = { viewports: ["desktop" as const] }

function searchBox(page: import("playwright").Page) {
  return page.getByRole("searchbox", { name: "Filter installed skills or search skills.sh" })
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "settings-skills",
    route,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["skills.listGlobal"] },
  }),
  defineScenario({
    name: "settings-skills-filter-installed",
    route,
    ...desktop,
    regions: regions("settings"),
    async run(context) {
      await searchBox(context.page).fill("front")
      await rest(context)
      await context.capture("filtered")
      await click(context, context.page.getByRole("button", { name: "Clear skills search" }))
      await parkPointer(context)
      await context.capture("cleared")
    },
  }),
  defineScenario({
    name: "settings-skills-search-and-install",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["skills.search", "skills.install"] },
    async run(context) {
      const { page } = context
      await searchBox(page).fill("anthropics")
      await rest(context)
      await context.capture("results")
      await click(context, page.getByRole("button", { name: "Get" }).first())
      await parkPointer(context)
      await context.capture("installed")
    },
  }),
  defineScenario({
    name: "settings-skills-search-empty",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["skills.search"] },
    async run(context) {
      await searchBox(context.page).fill("nothing-like-this")
      await rest(context)
      await context.capture("no-results")
    },
  }),
  defineScenario({
    name: "settings-skills-menu-and-uninstall",
    route,
    ...desktop,
    regions: regions("settings", "menu"),
    covers: { routes: [route], commands: ["skills.uninstall"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Open actions for release-notes" }))
      await context.capture("menu")
      await click(context, page.getByRole("menuitem", { name: "Uninstall" }))
      await parkPointer(context)
      await context.capture("uninstalled")
    },
  }),
]
