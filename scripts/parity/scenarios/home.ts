import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"
import { click, contextClick, countUuids, hover, parkPointer, regions, rest } from "./_lib/helpers"

// The projects page (/home): search, opening a project, a project's menu
// and what it leads to (rename, hide, archived chats), Add project.

const desktop = { viewports: ["desktop" as const] }

function projectRow(page: Page, title: string) {
  return page.getByRole("region", { name: "Recent" }).getByRole("button", { name: new RegExp(`^${title} `) })
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "home-search",
    route: "/home",
    regions: regions("sidebar"),
    covers: { routes: ["/home"] },
    async run(context) {
      const { page } = context
      await page.getByRole("searchbox", { name: "Search projects" }).fill("ledger")
      await rest(context)
      await context.capture("one-match")
      await page.getByRole("searchbox", { name: "Search projects" }).fill("nothing here")
      await rest(context)
      await context.capture("no-match")
      await click(context, page.getByRole("button", { name: "Clear search" }))
      await parkPointer(context)
      await context.capture("cleared")
    },
  }),
  defineScenario({
    name: "home-search-escape",
    route: "/home",
    ...desktop,
    async run(context) {
      const search = context.page.getByRole("searchbox", { name: "Search projects" })
      await search.fill("tide")
      await search.press("Escape")
      await rest(context)
      await context.capture("cleared")
    },
  }),
  defineScenario({
    // A project's row starts a new chat in it.
    name: "home-open-project",
    route: "/home",
    regions: regions("sidebar", "composer"),
    covers: { routes: ["/home"], commands: ["chat.create"] },
    async run(context) {
      await countUuids(context)
      await click(context, projectRow(context.page, "portfolio"))
      await parkPointer(context)
      await context.capture("new-chat")
    },
  }),
  defineScenario({
    name: "home-project-tooltip",
    route: "/home",
    ...desktop,
    regions: regions("tooltip"),
    async run(context) {
      await hover(context, projectRow(context.page, "tidepool"))
      await context.capture("path")
    },
  }),
  defineScenario({
    name: "home-project-menu",
    route: "/home",
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await contextClick(context, projectRow(context.page, "tidepool"))
      await context.capture("menu")
    },
  }),
  defineScenario({
    name: "home-project-rename",
    route: "/home",
    ...desktop,
    regions: regions("dialog", "sidebar"),
    covers: { commands: ["project.rename"] },
    async run(context) {
      const { page } = context
      await contextClick(context, projectRow(page, "tidepool"))
      await click(context, page.getByRole("menuitem", { name: "Rename" }))
      await context.capture("dialog")
      await page.getByRole("dialog").getByRole("textbox").fill("tidepool web")
      await click(context, page.getByRole("dialog").getByRole("button", { name: "Rename" }))
      await parkPointer(context)
      await context.capture("renamed")
    },
  }),
  defineScenario({
    name: "home-project-hide",
    route: "/home",
    ...desktop,
    regions: regions("sidebar", "dialog"),
    covers: { commands: ["project.remove"] },
    async run(context) {
      const { page } = context
      await contextClick(context, projectRow(page, "portfolio"))
      await click(context, page.getByRole("menuitem", { name: "Hide" }))
      await context.capture("confirm")
      const confirm = page.getByRole("dialog").getByRole("button", { name: "Hide" })
      if (await confirm.count()) await click(context, confirm)
      await parkPointer(context)
      await context.capture("hidden")
    },
  }),
  defineScenario({
    // The project's archived chats, after archiving one.
    name: "home-project-show-archived",
    route: "/home",
    ...desktop,
    regions: regions("dialog"),
    covers: { commands: ["chat.archive"] },
    async run(context) {
      const { page } = context
      await contextClick(context, page.locator("[data-sidebar=open] [data-chat-id=demo-chat-deploy]"))
      await click(context, page.getByRole("menuitem", { name: "Archive Chat" }))
      await contextClick(context, projectRow(page, "tidepool"))
      await click(context, page.getByRole("menuitem", { name: "Show Archived" }))
      await parkPointer(context)
      await context.capture("dialog")
    },
  }),
  defineScenario({
    name: "home-project-open-in-finder",
    route: "/home",
    ...desktop,
    covers: { commands: ["system.openExternal"] },
    async run(context) {
      const { page } = context
      await contextClick(context, projectRow(page, "ledger-api"))
      await click(context, page.getByRole("menuitem", { name: "Show in Finder" }))
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    name: "home-add-project-button",
    route: "/home",
    ...desktop,
    regions: regions("dialog"),
    covers: { commands: ["github.listRecentRepos"] },
    async run(context) {
      // The sidebar has an Add project button too; the page's comes after it.
      await click(context, context.page.getByRole("button", { name: "Add project" }).last())
      await context.capture("palette")
    },
  }),
]
