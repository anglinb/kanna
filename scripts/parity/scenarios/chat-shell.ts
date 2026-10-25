import { defineScenario, type Scenario } from "../scenario"

// The chat page's own parts (src/foldkit/chat/), apart from what its
// sub-slices draw inside them: the navbar over the chat, its menus, the
// split "Open in…" button, and the pane toggles. The navbar is the one
// `group/navbar` element on a chat page.

const NAVBAR = '[class*="group/navbar"]'
const MENU = '[role="menu"]'
const LISTBOX = '[role="listbox"]'

export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-navbar",
    route: "/chat/demo-chat-units",
    viewports: ["desktop", "mobile"],
    regions: { navbar: NAVBAR },
    covers: { routes: ["/chat/:chatId"] },
  }),
  defineScenario({
    name: "chat-navbar-overflow-menu",
    route: "/chat/demo-chat-units",
    viewports: ["desktop", "mobile"],
    regions: { navbar: NAVBAR, menu: MENU },
    async run({ page, capture }) {
      await page.getByRole("button", { name: "More actions" }).click()
      await capture("open")
      await page.keyboard.press("ArrowDown")
      await capture("highlighted")
      await page.keyboard.press("Escape")
      await capture("closed")
    },
  }),
  defineScenario({
    name: "chat-navbar-title-menu",
    route: "/chat/demo-chat-units",
    viewports: ["desktop"],
    regions: { navbar: NAVBAR, menu: MENU },
    async run({ page, capture }) {
      await page.getByRole("button", { name: "Chat actions" }).click()
      await capture("from-button")
      await page.keyboard.press("Escape")
      await page.getByTitle("Rename").click({ button: "right" })
      await capture("from-right-click")
      await page.keyboard.press("Escape")
      await capture("closed")
    },
  }),
  defineScenario({
    name: "chat-navbar-title-rename",
    route: "/chat/demo-chat-units",
    viewports: ["desktop"],
    regions: { navbar: NAVBAR },
    covers: { commands: ["chat.rename"] },
    async run({ page, capture }) {
      await page.getByTitle("Rename").click()
      await capture("editing")
      await page.getByRole("textbox", { name: "Chat title" }).fill("Feet and meters")
      await page.keyboard.press("Enter")
      await capture("renamed")
      await page.getByTitle("Rename").click()
      await page.keyboard.press("Escape")
      await capture("escaped")
    },
  }),
  defineScenario({
    name: "chat-open-external-menu",
    route: "/chat/demo-chat-units",
    viewports: ["desktop"],
    regions: { navbar: NAVBAR, listbox: LISTBOX },
    covers: { commands: ["system.openExternal"] },
    async run({ page, capture }) {
      await page.getByRole("combobox", { name: "Choose open destination" }).click()
      await capture("open")
      await page.getByRole("option", { name: "Finder" }).click()
      await capture("chose-finder")
      await page.getByRole("button", { name: "Open in Finder" }).click()
      await capture("opened-again")
    },
  }),
  defineScenario({
    name: "chat-pane-toggles",
    route: "/chat/demo-chat-units",
    viewports: ["desktop", "mobile"],
    regions: { navbar: NAVBAR },
    async run({ page, viewport, capture }) {
      await page.getByRole("button", { name: "Show widgets" }).click()
      await capture("widgets-open")
      // On a phone the column is a sheet over the chat, navbar and all: its
      // backdrop, left of the sheet, closes it.
      if (viewport === "mobile") await page.getByRole("button", { name: "Close widgets" }).click({ position: { x: 12, y: 400 } })
      else await page.getByRole("button", { name: "Hide widgets" }).click()
      await capture("widgets-closed")
      await page.getByRole("button", { name: "More actions" }).click()
      await page.getByRole("menuitem", { name: "Toggle Terminal" }).click()
      await capture("terminal-open")
      await page.getByRole("button", { name: "More actions" }).click()
      await page.getByRole("menuitem", { name: "Toggle Terminal" }).click()
      await capture("terminal-closed")
    },
  }),
]
