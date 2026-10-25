import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"
import { CHATS, click, contextClick, hover, parkPointer, press, quickClick, REGIONS, regions } from "./_lib/helpers"

// The chat page's own parts (src/foldkit/chat/) that chat-navbar.ts,
// keybindings.ts, mobile.ts and terminal.ts don't already reach: the
// title's right-click menu, the menus by keyboard, the "Open in…" button's
// tooltip, the widget column's Ctrl binding and a phone's backdrop. (The
// terminal's toggles are terminal.ts's: how many terminal.create a first
// terminal sends races its fit, React against React.)

const desktop = { viewports: ["desktop" as const] }
const mobile = { viewports: ["mobile" as const] }

function navbar(page: Page) {
  return page.locator(REGIONS.navbar)
}

export const scenarios: Scenario[] = [
  defineScenario({
    // A right click on the title opens the chat's sidebar-row menu, as the
    // Chat actions button does; Escape shuts it.
    name: "chat-navbar-title-context-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "menu"),
    async run(context) {
      await contextClick(context, navbar(context.page).getByRole("button", { name: "Add a feet/meters toggle" }))
      await context.capture("menu")
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // On a phone the More actions menu carries the "Open in…" destinations
    // too. Arrows move through it; Escape shuts it.
    name: "chat-navbar-overflow-keys",
    route: CHATS.units,
    ...mobile,
    regions: regions("navbar", "menu"),
    async run(context) {
      await click(context, navbar(context.page).getByRole("button", { name: "More actions" }))
      await press(context, "ArrowDown")
      await press(context, "ArrowDown")
      await context.capture("highlighted")
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // The split button's main half names its app in a tooltip; the list
    // opens on its other half and moves by arrows.
    name: "chat-open-external-keys",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar", "listbox", "tooltip"),
    async run(context) {
      await hover(context, navbar(context.page).getByRole("button", { name: "Open in Cursor" }))
      await context.capture("tooltip")
      await click(context, navbar(context.page).getByRole("combobox", { name: "Choose open destination" }))
      await press(context, "ArrowDown")
      await context.capture("highlighted")
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // The widget column's Ctrl binding beside its ⌘ one
    // (DEFAULT_KEYBINDINGS). Quick: the open column polls (see quickClick).
    name: "chat-widgets-ctrl-b",
    route: CHATS.units,
    ...desktop,
    regions: regions("navbar"),
    covers: { keybindings: ["toggleRightSidebar"] },
    async run(context) {
      const { page } = context
      await page.keyboard.press("Control+b")
      await context.settle()
      await context.capture("open")
      await page.keyboard.press("Control+b")
      await context.settle()
      await context.capture("closed")
    },
  }),
  defineScenario({
    // On a phone the widget column is a sheet over the chat, navbar and all:
    // its backdrop, left of the sheet, closes it.
    name: "chat-widgets-sheet-backdrop",
    route: CHATS.units,
    ...mobile,
    regions: regions("navbar"),
    async run(context) {
      const { page } = context
      await quickClick(context, navbar(page).getByRole("button", { name: "Show widgets" }))
      await page.getByRole("button", { name: "Close widgets" }).click({ position: { x: 12, y: 400 } })
      await context.settle()
      await context.capture("closed")
    },
  }),
]
