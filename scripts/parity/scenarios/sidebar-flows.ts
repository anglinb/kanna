import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"

// The left sidebar's flows that change what it holds: archiving a chat and
// restoring it from the Archived view, focus mode by its shortcut and its
// pill, resizing by the handle and the keyboard, and the peek of a
// collapsed sidebar at the window's edge. As in sidebar-interactions.ts,
// from /settings/general with the page beside the sidebar hidden in both apps.

const ROUTE = "/settings/general"
const SIDEBAR = "[data-sidebar=open]"

async function hidePage(page: Page) {
  await page.addStyleTag({
    content: "div.h-\\[100dvh\\].overflow-hidden > :not([data-sidebar]):not(:has([data-sidebar])):not(.fixed) { visibility: hidden !important }",
  })
}

async function overlaysGone(page: Page) {
  await page.locator("[role=menu], [role=dialog]:not([data-list-hover-card])").first().waitFor({ state: "detached" })
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "sidebar-archive-restore",
    route: ROUTE,
    viewports: ["desktop"],
    regions: { sidebar: SIDEBAR },
    covers: { commands: ["chat.archive", "chat.unarchive"] },
    async run({ page, capture, settle }) {
      await hidePage(page)
      const sidebar = page.locator(SIDEBAR)
      const row = sidebar.locator("[data-chat-id]", { hasText: "Set up deploys on push" })
      await row.hover()
      await row.getByRole("button", { name: "Archive chat" }).click()
      await settle()
      await capture("archived-chat")
      await sidebar.locator("button[aria-haspopup=dialog]").first().click()
      await page.getByRole("button", { name: "Archived" }).click()
      await overlaysGone(page)
      await settle()
      await capture("archived-view")
      const archivedRow = sidebar.locator("[data-chat-id]", { hasText: "Set up deploys on push" })
      await archivedRow.hover()
      await archivedRow.getByRole("button", { name: "Restore chat" }).click()
      await settle()
      await capture("restored")
    },
  }),
  defineScenario({
    name: "sidebar-focus-mode",
    route: ROUTE,
    viewports: ["desktop"],
    regions: { sidebar: SIDEBAR },
    covers: { keybindings: ["toggleFocusMode"] },
    async run({ page, capture, settle }) {
      await hidePage(page)
      await page.keyboard.press("Control+Shift+F")
      await settle()
      await capture("focused")
      await page.getByRole("button", { name: /^Exit focus mode/ }).click()
      await settle()
      await capture("left-by-pill")
      await page.keyboard.press("Control+Shift+F")
      await settle()
      await page.mouse.click(900, 450)
      await page.keyboard.press("Escape")
      await settle()
      await capture("left-by-escape")
    },
  }),
  defineScenario({
    name: "sidebar-resize",
    route: ROUTE,
    viewports: ["desktop"],
    regions: { sidebar: SIDEBAR },
    async run({ page, capture, settle }) {
      await hidePage(page)
      const handle = page.getByRole("separator", { name: "Resize sidebar" })
      const box = await handle.boundingBox()
      if (!box) throw new Error("no resize handle")
      await page.mouse.move(box.x + box.width / 2, box.y + 200)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + 200, { steps: 4 })
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + 200, { steps: 4 })
      await page.mouse.up()
      await settle()
      await capture("dragged")
      await handle.focus()
      await page.keyboard.press("ArrowLeft")
      await page.keyboard.press("ArrowLeft")
      await settle()
      await capture("keyed")
      await handle.dblclick()
      await settle()
      await capture("reset")
    },
  }),
  defineScenario({
    name: "sidebar-peek",
    route: ROUTE,
    viewports: ["desktop"],
    regions: { sidebar: SIDEBAR },
    async run({ page, capture, settle }) {
      await hidePage(page)
      await page.getByRole("button", { name: "Collapse sidebar" }).click()
      await settle()
      await page.mouse.move(600, 400)
      await page.mouse.move(2, 400, { steps: 6 })
      await settle()
      await capture("peeking")
      await page.mouse.move(800, 400, { steps: 6 })
      await settle()
      await capture("left")
    },
  }),
]
