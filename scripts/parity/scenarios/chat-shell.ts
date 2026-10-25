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
  // Its button shows on a desktop only beside the open widget column; on a
  // phone it is always there and carries the "Open in…" destinations too.
  defineScenario({
    name: "chat-navbar-overflow-menu",
    route: "/chat/demo-chat-units",
    viewports: ["mobile"],
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
    // Choosing one sends `system.openExternal`, which the demo backend
    // doesn't answer: the list itself, then.
    async run({ page, capture }) {
      // Past the provider's open delay, so the tooltip is all the way in.
      await page.getByRole("button", { name: "Open in Cursor" }).hover()
      await page.waitForTimeout(900)
      await capture("primary-tooltip")
      await page.mouse.move(700, 600)
      await page.waitForTimeout(100)
      await page.mouse.move(720, 620)
      await page.getByRole("combobox", { name: "Choose open destination" }).click()
      await capture("open")
      await page.keyboard.press("ArrowDown")
      await capture("highlighted")
      await page.keyboard.press("Escape")
      await capture("closed")
    },
  }),
  defineScenario({
    name: "chat-pane-toggles",
    route: "/chat/demo-chat-units",
    viewports: ["desktop", "mobile"],
    regions: { navbar: NAVBAR },
    covers: { keybindings: ["toggleRightSidebar"] },
    async run({ page, viewport, capture }) {
      await page.getByRole("button", { name: "Show widgets" }).click()
      await capture("widgets-open")
      // On a phone the column is a sheet over the chat, navbar and all: its
      // backdrop, left of the sheet, closes it.
      if (viewport === "mobile") await page.getByRole("button", { name: "Close widgets" }).click({ position: { x: 12, y: 400 } })
      else await page.getByRole("button", { name: "Hide widgets" }).click()
      await capture("widgets-closed")
      await page.keyboard.press("Control+b")
      await capture("widgets-by-key")
      await page.keyboard.press("Control+b")
      await capture("widgets-closed-by-key")
    },
  }),
  defineScenario({
    name: "chat-terminal-toggle",
    route: "/chat/demo-chat-units",
    viewports: ["desktop", "mobile"],
    regions: { navbar: NAVBAR },
    covers: { keybindings: ["toggleEmbeddedTerminal"], commands: ["terminal.create"] },
    async run({ page, viewport, capture }) {
      // The terminal's toggle has no name of its own (its tooltip is a
      // hotkey), so by its shortcut, and on a phone from the overflow menu.
      const toggleTerminal = async () => {
        if (viewport === "mobile") {
          await page.getByRole("button", { name: "More actions" }).click()
          await page.getByRole("menuitem", { name: "Toggle Terminal" }).click()
        } else {
          await page.keyboard.press("Control+Backquote")
        }
      }
      await toggleTerminal()
      // The first terminal loads xterm, sizes itself once its pane has
      // opened, then creates its session: wait that out, so the capture has
      // it (an app with no terminal yet just waits the timeout).
      await page.locator(".xterm").first().waitFor({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(800)
      await capture("terminal-open")
      await toggleTerminal()
      await page.waitForTimeout(800)
      await capture("terminal-closed")
    },
  }),
]
