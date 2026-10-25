import type { Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { click, openPalette, parkPointer, press, rest } from "./_lib/helpers"

// The command palette over the projects page, each of its pages in turn:
// typing, the highlight across groups, the Add Project pages (clone, create,
// browse), the page stack and Escape, and opening it by clicking. The region
// is the palette's dialog alone; the projects page behind it is ported, so
// what shows through the dialog's box is compared too.

const desktop = { viewports: ["desktop" as const] }
const PALETTE = { palette: "[role=dialog]:has([cmdk-root])" }

function input(page: Page) {
  return page.getByRole("dialog", { name: "Command Palette" }).getByRole("combobox")
}

/** Types into the palette's search field. */
async function search(context: ScenarioContext, text: string) {
  await input(context.page).pressSequentially(text)
  await rest(context)
}

/** Picks a row by its visible name and waits for whatever it does. */
async function choose(context: ScenarioContext, name: string | RegExp) {
  await context.page.getByRole("dialog", { name: "Command Palette" }).getByRole("option", { name }).first().click()
  await rest(context)
}

export const scenarios: Scenario[] = [
  defineScenario({
    // Opened by clicking the sidebar's search button rather than the shortcut.
    name: "palette-home-click-open",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Search" }).first())
      await parkPointer(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    // Groups ranked by their best match: projects, all projects, settings.
    name: "palette-home-search-groups",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    async run(context) {
      await openPalette(context)
      await search(context, "port")
      await context.capture("port")
      await input(context.page).fill("")
      await search(context, "theme")
      await context.capture("theme")
    },
  }),
  defineScenario({
    // ⌥↓ steps a group at a time, ⌘↓ to the last row, ⌘↑ back to the first.
    name: "palette-home-group-keys",
    // The running chat's spinner rasterizes a few pixels differently run to
    // run, React against React (28 px at a highlight move).
    pixelTolerance: 0.0003,
    route: "/home",
    ...desktop,
    regions: PALETTE,
    async run(context) {
      await openPalette(context)
      await press(context, "Alt+ArrowDown")
      await press(context, "Alt+ArrowDown")
      await context.capture("two-groups-down")
      await press(context, "Meta+ArrowDown")
      await context.capture("last")
      await press(context, "Meta+ArrowUp")
      await context.capture("first")
    },
  }),
  defineScenario({
    name: "palette-home-new-chat-page",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    async run(context) {
      await openPalette(context)
      await choose(context, "New Chat in…")
      await parkPointer(context)
      await context.capture("page")
      await search(context, "tide")
      await context.capture("filtered")
    },
  }),
  defineScenario({
    name: "palette-home-hide-page",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    async run(context) {
      await openPalette(context)
      await choose(context, /^Hide$/)
      await parkPointer(context)
      await context.capture("page")
    },
  }),
  defineScenario({
    // A repo typed on the Add Project page offers to clone it; Backspace in the
    // emptied field walks back to the root.
    name: "palette-home-add-project-rows",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await parkPointer(context)
      await search(context, "you/surf-log")
      await context.capture("clone-row")
      await input(context.page).fill("")
      await rest(context)
      await search(context, "existing")
      await context.capture("filtered")
      await input(context.page).fill("")
      await press(context, "Backspace")
      await context.capture("back-at-root")
    },
  }),
  defineScenario({
    name: "palette-home-create-new",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    covers: { commands: ["fs.list"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await choose(context, "Create New…")
      await parkPointer(context)
      await context.capture("hint")
      await search(context, "a/b")
      await context.capture("invalid")
      await input(context.page).fill("")
      await search(context, "surf-log")
      await context.capture("named")
    },
  }),
  defineScenario({
    // Choose Existing… lists home; arrows move through folders; a typed path
    // jumps there, the missing tail left in the field.
    name: "palette-home-browse",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    covers: { commands: ["fs.list"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await choose(context, "Choose Existing…")
      await parkPointer(context)
      await context.capture("home")
      await press(context, "ArrowDown")
      await context.capture("next-folder")
      await search(context, "~/Projects/ledger-api/nowhere")
      await context.capture("typed-path")
      await press(context, "Enter")
      await context.capture("jumped")
    },
  }),
  defineScenario({
    // Escape pops one page at a time, then closes.
    name: "palette-home-escape",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    covers: { commands: ["github.listRecentRepos"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await choose(context, "Clone from GitHub…")
      await parkPointer(context)
      await context.capture("clone-page")
      await press(context, "Escape")
      await context.capture("add-project")
      await press(context, "Escape")
      await context.capture("root")
      await press(context, "Escape")
      await context.capture("closed")
    },
  }),
  defineScenario({
    name: "palette-home-usage",
    route: "/home",
    ...desktop,
    regions: PALETTE,
    covers: { commands: ["usage.refresh"] },
    async run(context) {
      await openPalette(context)
      await choose(context, "Usage…")
      await parkPointer(context)
      await context.capture("page")
    },
  }),
]
