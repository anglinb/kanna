import type { Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, click, openPalette, parkPointer, press, regions, rest } from "./_lib/helpers"

// The command palette (⌘K): its root list, search, every sub-page, and the
// actions that run from it. Driven by the keyboard, as it is used.

const desktop = { viewports: ["desktop" as const] }
const paletteRegions = regions("dialog")

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
    name: "palette-root",
    route: CHATS.units,
    regions: paletteRegions,
    covers: { keybindings: ["openCommandPalette"] },
    async run(context) {
      await openPalette(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "palette-root-on-home",
    route: "/home",
    ...desktop,
    regions: paletteRegions,
    covers: { keybindings: ["openCommandPalette"] },
    async run(context) {
      await openPalette(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "palette-keyboard-navigation",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    covers: { keybindings: ["openCommandPalette"] },
    async run(context) {
      await openPalette(context)
      await press(context, "ArrowDown")
      await press(context, "ArrowDown")
      await context.capture("third-row")
      await press(context, "End")
      await context.capture("last-row")
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    name: "palette-search-chats",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    async run(context) {
      await openPalette(context)
      await search(context, "tide")
      await context.capture("tide")
      await press(context, "Enter")
      await parkPointer(context)
      await context.capture("opened-chat")
    },
  }),
  defineScenario({
    name: "palette-search-no-results",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    async run(context) {
      await openPalette(context)
      await search(context, "zzzz nothing matches")
      await context.capture("empty")
    },
  }),
  defineScenario({
    // A GitHub URL typed at the root offers to clone it.
    name: "palette-search-repo-url",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    async run(context) {
      await openPalette(context)
      await search(context, "https://github.com/you/surf-log")
      await context.capture("clone-offer")
    },
  }),
  defineScenario({
    name: "palette-project-chats",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    async run(context) {
      await openPalette(context)
      await choose(context, "Chats in tidepool")
      await context.capture("page")
      await press(context, "Backspace")
      await context.capture("back-to-root")
    },
  }),
  defineScenario({
    name: "palette-new-chat-in",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    covers: { commands: ["chat.create"] },
    async run(context) {
      await openPalette(context)
      await choose(context, "New Chat in…")
      await context.capture("page")
      await choose(context, /^portfolio/)
      await parkPointer(context)
      await context.capture("new-chat")
    },
  }),
  defineScenario({
    name: "palette-new-chat-current-project",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer", "sidebar"),
    covers: { commands: ["chat.create"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^New Chat in tidepool/)
      await parkPointer(context)
      await context.capture("new-chat")
    },
  }),
  defineScenario({
    name: "palette-hide-project-page",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    async run(context) {
      await openPalette(context)
      await choose(context, "Hide")
      await context.capture("page")
    },
  }),
  defineScenario({
    name: "palette-hide-current-project",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "dialog"),
    covers: { commands: ["project.remove"] },
    async run(context) {
      await openPalette(context)
      await choose(context, "Hide tidepool")
      await parkPointer(context)
      await context.capture("hidden")
    },
  }),
  defineScenario({
    name: "palette-add-project",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    covers: { keybindings: ["openCommandPalette"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await context.capture("page")
    },
  }),
  defineScenario({
    // GitHub isn't signed in on the demo: the page asks for a repo URL.
    name: "palette-clone-github",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    covers: { commands: ["github.listRecentRepos"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await choose(context, "Clone from GitHub…")
      await context.capture("page")
      await search(context, "you/surf-log")
      await context.capture("typed-repo")
    },
  }),
  defineScenario({
    name: "palette-create-new-project",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog", "sidebar"),
    covers: { commands: ["project.create", "fs.list"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await choose(context, "Create New…")
      await context.capture("page")
      await search(context, "surf-log")
      await context.capture("named")
      await press(context, "Enter")
      await parkPointer(context)
      await context.capture("created")
    },
  }),
  defineScenario({
    // Choose Existing… browses the machine's folders (fs.list).
    name: "palette-browse-folders",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    covers: { commands: ["fs.list"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await choose(context, "Choose Existing…")
      await context.capture("home")
      await choose(context, /^Projects/)
      await context.capture("projects")
      await search(context, "tide")
      await context.capture("filtered")
    },
  }),
  defineScenario({
    name: "palette-browse-path",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    covers: { commands: ["fs.list"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await choose(context, "Choose Existing…")
      await search(context, "~/Projects/ledger-api/src")
      await context.capture("typed-path")
    },
  }),
  defineScenario({
    // An existing project from the Add Project page opens it.
    name: "palette-open-existing-project",
    route: "/home",
    ...desktop,
    regions: regions("sidebar", "composer"),
    covers: { commands: ["project.open"] },
    async run(context) {
      await openPalette(context)
      await choose(context, /^Add Project…/)
      await choose(context, /^portfolio/)
      await parkPointer(context)
      await context.capture("opened")
    },
  }),
  defineScenario({
    name: "palette-settings-page",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    async run(context) {
      await openPalette(context)
      await choose(context, "Settings…")
      await context.capture("page")
      await search(context, "scroll")
      await context.capture("filtered")
      await press(context, "Enter")
      await parkPointer(context)
      await context.capture("jumped")
    },
  }),
  defineScenario({
    name: "palette-usage-page",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    covers: { commands: ["usage.refresh"] },
    async run(context) {
      await openPalette(context)
      await choose(context, "Usage…")
      await context.capture("page")
    },
  }),
  defineScenario({
    name: "palette-theme-light",
    route: CHATS.units,
    ...desktop,
    covers: { commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      await openPalette(context)
      await choose(context, "Theme: Light")
      await parkPointer(context)
      await context.capture("light")
    },
  }),
  defineScenario({
    // The old sidebar, from the palette.
    name: "palette-disable-new-sidebar",
    route: CHATS.units,
    regions: regions("sidebar"),
    covers: { commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      await openPalette(context)
      await choose(context, "Disable New Sidebar")
      await parkPointer(context)
      await context.capture("old-sidebar")
    },
  }),
  defineScenario({
    name: "palette-show-widgets",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["browser.listLocalHttpServers"] },
    async run(context) {
      await openPalette(context)
      // No pointer parking: the open column polls (see quickClick in _lib).
      await choose(context, /^Show Widgets/)
      await context.capture("widgets")
    },
  }),
  defineScenario({
    name: "palette-open-in-page",
    route: CHATS.units,
    ...desktop,
    regions: paletteRegions,
    async run(context) {
      await openPalette(context)
      await choose(context, /^Open in…/)
      await context.capture("page")
    },
  }),
  defineScenario({
    name: "palette-models-page",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog", "composer"),
    async run(context) {
      await openPalette(context)
      await choose(context, "Change Model…")
      await context.capture("page")
      await choose(context, /^Sonnet/)
      await parkPointer(context)
      await context.capture("picked")
    },
  }),
  defineScenario({
    name: "palette-harness-page",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog", "composer"),
    async run(context) {
      await openPalette(context)
      await choose(context, "Switch Harness…")
      await context.capture("page")
      await choose(context, /^Codex/)
      await parkPointer(context)
      await context.capture("picked")
    },
  }),
  defineScenario({
    name: "palette-plan-and-fast-mode",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer"),
    async run(context) {
      await openPalette(context)
      await choose(context, "Switch to Plan Mode")
      await openPalette(context)
      await choose(context, "Switch to Fast Mode")
      await parkPointer(context)
      await context.capture("plan-and-fast")
    },
  }),
  defineScenario({
    name: "palette-chat-actions",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "navbar"),
    covers: { commands: ["chat.fork", "chat.archive"] },
    async run(context) {
      await openPalette(context)
      await choose(context, "Fork Chat")
      await parkPointer(context)
      await context.capture("forked")
      await openPalette(context)
      await choose(context, "Archive Chat")
      await parkPointer(context)
      await context.capture("archived")
    },
  }),
  defineScenario({
    // Pin and Done are found by search; Done moves the chat out of Review.
    name: "palette-pin-and-done",
    route: CHATS.safari,
    ...desktop,
    regions: regions("sidebar"),
    covers: { commands: ["chat.setPinned", "chat.setDone"] },
    async run(context) {
      await openPalette(context)
      await search(context, "pin")
      await press(context, "Enter")
      await parkPointer(context)
      await context.capture("pinned")
      await openPalette(context)
      await search(context, "done")
      await press(context, "Enter")
      await parkPointer(context)
      await context.capture("done")
    },
  }),
  defineScenario({
    name: "palette-focus-project",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    async run(context) {
      await openPalette(context)
      await choose(context, /^Focus tidepool/)
      await parkPointer(context)
      await context.capture("focused")
    },
  }),
  defineScenario({
    name: "palette-make-delegator",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog", "sidebar"),
    covers: { commands: ["chat.setDelegator"] },
    async run(context) {
      await openPalette(context)
      await search(context, "delegator")
      await context.capture("results")
      await choose(context, /^Make Delegator/)
      await parkPointer(context)
      await context.capture("made")
    },
  }),
  defineScenario({
    // A new delegator asks for its name first.
    name: "palette-new-delegator",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog", "sidebar"),
    covers: { commands: ["chat.create", "chat.rename"] },
    async run(context) {
      await openPalette(context)
      await search(context, "delegator")
      await choose(context, /^New Delegator in tidepool/)
      await context.capture("name-prompt")
      await context.page.getByPlaceholder("Name (optional)").fill("Release captain")
      await click(context, context.page.getByRole("button", { name: "Create" }))
      await parkPointer(context)
      await context.capture("created")
    },
  }),
]
