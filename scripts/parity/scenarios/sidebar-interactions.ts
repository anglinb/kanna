import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"

// The left sidebar (src/client/app/KannaSidebar.tsx, ported to
// src/foldkit/sidebar): collapsing it, its sections, the chat hover card,
// the right-click menus and the dialogs they open, the view switcher and
// its views, the keyboard's number jump, and the phone layout.
//
// Driven from /settings/general with the page beside the sidebar hidden, in
// both apps alike: the sidebar is the same there as anywhere, and its menus,
// dialogs and translucent hover card reach over that page. Hidden, it is not
// compared under them, and the sidebar's parity doesn't wait on the page's.
const ROUTE = "/settings/general"

const SIDEBAR = "[data-sidebar=open]"

/** Every child of the layout that is neither the sidebar nor fixed over it: the routed page. */
async function hidePage(page: Page) {
  await page.addStyleTag({
    content: "div.h-\\[100dvh\\].overflow-hidden > :not([data-sidebar]):not(:has([data-sidebar])):not(.fixed) { visibility: hidden !important }",
  })
}

/**
 * Until every menu and popover is gone, not fading: a capture freezes
 * animations, and Radix unmounts on its exit animation's end.
 */
async function overlaysGone(page: Page) {
  await page.locator("[role=menu], [role=dialog]:not([data-list-hover-card])").first().waitFor({ state: "detached" })
}

const REGIONS = {
  sidebar: SIDEBAR,
  menu: "[role=menu]",
  card: "[data-list-hover-card]",
  dialog: "[role=dialog]:not([data-list-hover-card])",
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "sidebar-collapse",
    route: ROUTE,
    viewports: ["desktop"],
    regions: {
      sidebar: SIDEBAR,
      expand: "div.fixed:has(> div > button[title='Expand sidebar'])",
    },

    async run({ page, capture, settle }) {
      await hidePage(page)
      await page.getByRole("button", { name: "Collapse sidebar" }).click()
      await settle()
      await capture("collapsed")
      await page.getByRole("button", { name: "Expand sidebar" }).click()
      await settle()
      await capture("expanded")
    },
  }),
  defineScenario({
    name: "sidebar-sections",
    route: ROUTE,
    viewports: ["desktop"],
    regions: { sidebar: SIDEBAR },
    async run({ page, capture, settle }) {
      await hidePage(page)
      const sidebar = page.locator(SIDEBAR)
      await sidebar.getByText("Yesterday", { exact: true }).click()
      await settle()
      await capture("yesterday-open")
      await sidebar.getByText("Relevant", { exact: true }).click()
      await settle()
      await capture("relevant-folded")
    },
  }),
  defineScenario({
    name: "sidebar-hover-card",
    route: ROUTE,
    viewports: ["desktop"],
    regions: REGIONS,
    covers: { commands: ["chat.getPreview", "chat.touchedFiles"] },
    async run({ page, capture, settle }) {
      await hidePage(page)
      const sidebar = page.locator(SIDEBAR)
      await sidebar.getByText("Set up deploys on push").hover()
      await settle()
      await capture("card")
      await sidebar.getByText("Fix blank tide chart", { exact: false }).hover()
      await settle()
      await capture("next-row")
      await page.mouse.move(900, 450)
      await settle()
      await capture("left")
    },
  }),
  defineScenario({
    name: "sidebar-chat-menu",
    route: ROUTE,
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      await hidePage(page)
      const row = page.locator(SIDEBAR).getByText("Set up deploys on push")
      // Pointed at first, as a hand does: the row's hover card is up before
      // the menu, not raised in the same instant as it.
      await row.hover()
      await settle()
      await row.click({ button: "right" })
      await settle()
      await capture("open")
      await page.keyboard.press("Escape")
      await overlaysGone(page)
      await settle()
      await capture("closed")
      await row.click({ button: "right" })
      await page.getByRole("menuitem", { name: "Rename" }).click()
      await settle()
      await capture("rename-dialog")
      await page.keyboard.press("Escape")
      await overlaysGone(page)
      await settle()
      await row.click({ button: "right" })
      await page.getByRole("menuitem", { name: "Delete Chat" }).click()
      await settle()
      await capture("delete-dialog")
    },
  }),
  defineScenario({
    name: "sidebar-section-menu",
    route: ROUTE,
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      await hidePage(page)
      await page.locator(SIDEBAR).getByText("Today", { exact: true }).click({ button: "right" })
      await settle()
      await capture("open")
    },
  }),
  defineScenario({
    name: "sidebar-views",
    route: ROUTE,
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      await hidePage(page)
      const switcher = page.locator(SIDEBAR).locator("button[aria-haspopup=dialog]").first()
      await switcher.click()
      await settle()
      await capture("switcher")
      await page.getByRole("button", { name: "Projects" }).last().click()
      await overlaysGone(page)
      await settle()
      await capture("projects")
      await switcher.click()
      await page.getByRole("button", { name: "Channels" }).click()
      await overlaysGone(page)
      await settle()
      await capture("channels")
      await switcher.click()
      await page.getByRole("button", { name: "Archived" }).click()
      await overlaysGone(page)
      await settle()
      await capture("archived")
    },
  }),
  defineScenario({
    name: "sidebar-projects-view",
    covers: { keybindings: ["jumpToSidebarChat"] },
    route: ROUTE,
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      await hidePage(page)
      const sidebar = page.locator(SIDEBAR)
      await sidebar.locator("button[aria-haspopup=dialog]").first().click()
      await page.getByRole("button", { name: "Projects" }).last().click()
      await overlaysGone(page)
      await settle()
      // Holding the number-jump modifier swaps each row's age for its keycap.
      await page.keyboard.down("Meta")
      await page.keyboard.down("Alt")
      await settle()
      await capture("number-hints")
      await page.keyboard.up("Alt")
      await page.keyboard.up("Meta")
      await settle()
      const header = sidebar.getByText("tidepool", { exact: true }).first()
      await header.click()
      await settle()
      await capture("folded")
      await header.click({ button: "right" })
      await settle()
      await capture("project-menu")
      await page.getByRole("menuitem", { name: "Show Archived" }).click()
      await settle()
      await capture("archived-dialog")
    },
  }),
  defineScenario({
    name: "sidebar-channels",
    route: ROUTE,
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      await hidePage(page)
      const sidebar = page.locator(SIDEBAR)
      await sidebar.locator("button[aria-haspopup=dialog]").first().click()
      await page.getByRole("button", { name: "Channels" }).click()
      await overlaysGone(page)
      await settle()
      await sidebar.locator("[data-channel-id]").first().hover()
      await settle()
      await capture("channel-card")
      await sidebar.locator("[data-channel-id]").first().click({ button: "right" })
      await settle()
      await capture("channel-menu")
    },
  }),
  defineScenario({
    name: "sidebar-mobile",
    route: "/",
    viewports: ["mobile"],
    regions: { sidebar: SIDEBAR },
    async run({ page, capture, settle }) {
      await capture("root")
      await page.locator(SIDEBAR).getByText("Yesterday", { exact: true }).click()
      await settle()
      await capture("yesterday-open")
    },
  }),
]
