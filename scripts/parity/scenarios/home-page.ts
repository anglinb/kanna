import { defineScenario, type Scenario } from "../scenario"
import { countUuids } from "./_lib/helpers"

// The projects page (src/foldkit/home/ against LocalProjectsPage, LocalDev
// and ProjectsHome). Until the sidebar is ported the whole page differs, so
// each scenario also compares the page's own element (`main`), the list
// column inside it (`list`: on desktop its paint and aria compare without
// the sidebar, its pixels only with it, as the column centres on a half
// pixel) and the overlays it opens, which render at the end of <body>.

/** LocalProjectsPage's root: the element holding the Mac app's drag strip. */
const MAIN = "div:has(> [data-window-drag][aria-hidden])"
/** ProjectsHome's column. */
const LIST = `${MAIN} .max-w-3xl`
const POPPER = "[data-radix-popper-content-wrapper]"
const DIALOG = "[role=dialog]"

export const scenarios: Scenario[] = [
  defineScenario({
    name: "home-main",
    route: "/home",
    regions: { main: MAIN, list: LIST },
    covers: { routes: ["/home"], commands: ["github.listRecentRepos"] },
  }),
  defineScenario({
    // Desktop shows the page beside the sidebar at "/" too; phones show the
    // sidebar there instead.
    name: "home-root",
    route: "/",
    viewports: ["desktop"],
    regions: { main: MAIN, list: LIST },
    covers: { routes: ["/"] },
  }),
  defineScenario({
    name: "home-page-search",
    route: "/home",
    regions: { main: MAIN, list: LIST },
    async run({ page, capture }) {
      const search = page.locator(MAIN).getByRole("searchbox", { name: "Search projects" })
      await search.fill("ledger")
      await capture("one-match")
      await search.fill("nothing-here")
      await capture("nothing-matches")
      await page.locator(MAIN).getByRole("button", { name: "Clear search" }).click()
      await capture("cleared")
      await search.fill("tide")
      await search.press("Escape")
      await capture("escaped")
    },
  }),
  defineScenario({
    name: "home-tooltips",
    route: "/home",
    viewports: ["desktop"],
    regions: { main: MAIN, list: LIST, tooltip: POPPER },
    async run({ page, capture }) {
      await page.locator(MAIN).getByRole("button", { name: "Add project" }).hover()
      await page.getByRole("tooltip").waitFor()
      await capture("add-project")
      // Away in steps: a single jump leaves Radix waiting in its grace area.
      // Then past the 300ms skip delay, so the next one opens delayed.
      await page.mouse.move(1300, 800, { steps: 4 })
      await page.mouse.move(1310, 810)
      await page.getByRole("tooltip").waitFor({ state: "detached" })
      await page.waitForTimeout(400)
      await page.locator(MAIN).getByRole("button", { name: /^tidepool/ }).hover()
      await page.getByRole("tooltip").filter({ hasText: "tidepool" }).waitFor()
      await capture("project-row")
    },
  }),
  defineScenario({
    name: "home-page-project-menu",
    route: "/home",
    viewports: ["desktop"],
    regions: { main: MAIN, list: LIST, menu: "[role=menu]", dialog: DIALOG },
    async run({ page, capture }) {
      await page.locator(MAIN).getByRole("button", { name: /^tidepool/ }).click({ button: "right" })
      await page.getByRole("menu").waitFor()
      await capture("menu-open")
      await page.getByRole("menuitem", { name: "Show Archived" }).click()
      await page.getByRole("dialog").waitFor()
      await capture("archived-dialog")
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "detached" })
      await capture("dialog-closed")
    },
  }),
  defineScenario({
    name: "home-page-open-project",
    route: "/home",
    regions: { main: MAIN, list: LIST },
    covers: { commands: ["project.open"] },
    async run(context) {
      const { page, capture } = context
      // The new chat's id goes into the URL: counted, so runs agree.
      await countUuids(context)
      await page.locator(MAIN).getByRole("button", { name: /^ledger-api/ }).click()
      await capture("opened")
    },
  }),
  defineScenario({
    name: "home-add-project",
    route: "/home",
    viewports: ["desktop"],
    regions: { main: MAIN, list: LIST, dialog: DIALOG },
    async run({ page, capture }) {
      await page.locator(MAIN).getByRole("button", { name: "Add project" }).click()
      await capture("palette")
    },
  }),
  defineScenario({
    // LocalDev's states, through `?preview=`: the Mac app restarting, an
    // offline machine with its fleet, a sleeping dev box, the connecting
    // notice, and closing the preview. Not "local": its start command names
    // the page's port, which is each app's own server here.
    name: "home-preview",
    route: "/home?preview=mac",
    regions: { main: MAIN },
    async run({ page, capture }) {
      await capture("mac")
      for (const variant of ["cloud", "devbox", "connecting"]) {
        await page.locator(MAIN).getByRole("button", { name: variant, exact: true }).click()
        await capture(variant)
      }
      await page.locator(MAIN).getByRole("button", { name: "Close preview" }).click()
      await capture("closed")
    },
  }),
]
