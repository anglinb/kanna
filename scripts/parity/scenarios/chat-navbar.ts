import { defineScenario, type Scenario } from "../scenario"
import { CHATS, click, hover, openWidgets, parkPointer, quickClick, REGIONS, regions, rest } from "./_lib/helpers"

// The chat's title bar: the chat actions menu, the title (renames inline),
// the project and branch, Open in…, terminal, share and widgets buttons.

const desktop = { viewports: ["desktop" as const] }

function navbar(context: { page: import("playwright").Page }) {
  return context.page.locator(REGIONS.navbar)
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "navbar-chat-actions-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "menu"),
    async run(context) {
      await click(context, navbar(context).getByRole("button", { name: "Chat actions" }))
      await context.capture("open")
    },
  }),
  defineScenario({
    // The menu on a chat that is waiting on a question.
    name: "navbar-chat-actions-menu-waiting",
    route: CHATS.deploy,
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await click(context, navbar(context).getByRole("button", { name: "Chat actions" }))
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "navbar-pin-from-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "sidebar"),
    covers: { commands: ["chat.setPinned"] },
    async run(context) {
      await click(context, navbar(context).getByRole("button", { name: "Chat actions" }))
      await click(context, context.page.getByRole("menuitem", { name: "Pin" }))
      await parkPointer(context)
      await context.capture("pinned")
    },
  }),
  defineScenario({
    name: "navbar-make-delegator",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "sidebar", "composer"),
    covers: { commands: ["chat.setDelegator"] },
    async run(context) {
      await click(context, navbar(context).getByRole("button", { name: "Chat actions" }))
      await click(context, context.page.getByRole("menuitem", { name: "Make Delegator" }))
      await parkPointer(context)
      await context.capture("delegator")
      await click(context, navbar(context).getByRole("button", { name: "Chat actions" }))
      await context.capture("menu-on-delegator")
    },
  }),
  // Share (the menu's Share, the Share chat button) has no scenario yet:
  // chat.exportStandalone carries window.location.origin, and the runner
  // serves the two apps on different ports, so their command logs can't
  // match until compareCommands normalizes origins as the url check does.
  defineScenario({
    // Clicking the title turns it into a field; Enter saves.
    name: "navbar-rename-inline",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "sidebar"),
    covers: { commands: ["chat.rename"] },
    async run(context) {
      await click(context, navbar(context).getByRole("button", { name: "Add a feet/meters toggle" }))
      await context.capture("editing")
      const field = context.page.getByRole("textbox", { name: "Chat title" })
      await field.fill("Feet or meters, remembered")
      await field.press("Enter")
      await parkPointer(context)
      await context.capture("renamed")
    },
  }),
  defineScenario({
    // Escape leaves the title as it was.
    name: "navbar-rename-inline-escape",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar"),
    async run(context) {
      await click(context, navbar(context).getByRole("button", { name: "Add a feet/meters toggle" }))
      const field = context.page.getByRole("textbox", { name: "Chat title" })
      await field.fill("Something else")
      await field.press("Escape")
      await parkPointer(context)
      await context.capture("unchanged")
    },
  }),
  defineScenario({
    // The project name opens Finder; the demo answers that it needs the real machine.
    name: "navbar-open-project-in-finder",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "transcript"),
    covers: { commands: ["system.openExternal"] },
    async run(context) {
      await click(context, navbar(context).getByRole("button", { name: "tidepool" }))
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    name: "navbar-open-in-editor",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "transcript"),
    covers: { commands: ["system.openExternal"] },
    async run(context) {
      await click(context, navbar(context).getByRole("button", { name: "Open in Cursor" }))
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    name: "navbar-open-destination-list",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "listbox"),
    async run(context) {
      await click(context, navbar(context).getByRole("combobox", { name: "Choose open destination" }))
      await context.capture("open")
    },
  }),
  defineScenario({
    // Picking another app makes it the button's default and opens in it.
    name: "navbar-open-destination-pick",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar"),
    covers: { commands: ["system.openExternal"] },
    async run(context) {
      await click(context, navbar(context).getByRole("combobox", { name: "Choose open destination" }))
      await click(context, context.page.getByRole("option", { name: "Zed" }))
      await parkPointer(context)
      await context.capture("picked")
    },
  }),
  defineScenario({
    // Quick: the open column polls (see quickClick).
    name: "navbar-widgets-open",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["browser.listLocalHttpServers", "usage.refresh"] },
    async run(context) {
      await openWidgets(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "navbar-widgets-close",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar"),
    async run(context) {
      await openWidgets(context)
      await quickClick(context, navbar(context).getByRole("button", { name: "Hide widgets" }))
      await context.capture("closed")
    },
  }),
  defineScenario({
    // With the widgets open the terminal and share buttons fold into More actions.
    name: "navbar-more-actions-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await openWidgets(context)
      await quickClick(context, navbar(context).getByRole("button", { name: "More actions" }))
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "navbar-widgets-tooltip",
    route: CHATS.units,
    ...desktop,
    regions: regions("tooltip"),
    async run(context) {
      await hover(context, navbar(context).getByRole("button", { name: "Show widgets" }))
      await context.capture("tooltip")
    },
  }),
  defineScenario({
    name: "navbar-context-meter-tooltip",
    route: CHATS.units,
    ...desktop,
    regions: regions("tooltip"),
    async run(context) {
      await hover(context, context.page.getByRole("button", { name: /^Context window/ }))
      await context.capture("tooltip")
    },
  }),
  defineScenario({
    // The search button opens the palette (it shows on phones and with the old sidebar).
    name: "navbar-collapsed-sidebar",
    route: CHATS.safari,
    ...desktop,
    regions: regions("navbar"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Collapse sidebar" }))
      await parkPointer(context)
      await context.capture("collapsed")
      await hover(context, navbar(context).getByRole("button", { name: "Expand sidebar" }))
      await context.capture("expand-hover")
      await rest(context)
    },
  }),
]
